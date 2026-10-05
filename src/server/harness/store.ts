import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_LABELS,
  isHarnessProvider,
  systemAccountId,
  type AccountAuthStatus,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProvider,
  type TurnErrorKind,
  type TurnReceipt,
  type TurnToolRecord,
} from '../../shared/harness.js';

/** Server-only account reference. `profileKey` never leaves the server. */
export interface AccountSnapshot {
  id: string;
  provider: HarnessProvider;
  label: string;
  kind: 'system' | 'managed';
  profileKey: string | null;
}

type ReceiptRow = Omit<TurnReceipt, 'tools' | 'continuation'> & {
  tools: string;
  continuation: number;
};

// Local routing state: accounts, the active account per provider, per-turn
// receipts and model caches. Nothing here is forwarded to CopilotKit.
export class HarnessStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS harness_accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, profileKey TEXT NOT NULL UNIQUE, status TEXT NOT NULL, identity TEXT, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_active(provider TEXT PRIMARY KEY, accountId TEXT);
      CREATE TABLE IF NOT EXISTS harness_system_status(provider TEXT PRIMARY KEY, status TEXT NOT NULL, identity TEXT);
      CREATE TABLE IF NOT EXISTS harness_receipts(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, runId TEXT NOT NULL, harness TEXT, model TEXT NOT NULL, accountId TEXT, accountLabel TEXT, outcome TEXT NOT NULL, errorKind TEXT, continuation INTEGER NOT NULL DEFAULT 0, tools TEXT NOT NULL DEFAULT '[]', startedAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX IF NOT EXISTS harness_receipts_thread ON harness_receipts(threadId, startedAt);
      CREATE TABLE IF NOT EXISTS harness_continuations(threadId TEXT PRIMARY KEY, receiptId TEXT NOT NULL, armedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_models(provider TEXT NOT NULL, accountId TEXT NOT NULL, models TEXT NOT NULL, fetchedAt INTEGER NOT NULL, PRIMARY KEY(provider, accountId));`);
  }

  private systemAccount(provider: HarnessProvider): HarnessAccount {
    const row = this.db
      .prepare(
        'SELECT status, identity FROM harness_system_status WHERE provider=?',
      )
      .get(provider);
    return {
      id: systemAccountId(provider),
      provider,
      label: `System default (${HARNESS_LABELS[provider]})`,
      kind: 'system',
      status: (row?.status as AccountAuthStatus | undefined) ?? 'unknown',
      identity: typeof row?.identity === 'string' ? row.identity : null,
      createdAt: 0,
    };
  }

  accounts(provider?: HarnessProvider): HarnessAccount[] {
    const providers = provider
      ? [provider]
      : (['claude-code', 'codex', 'copilot'] as const);
    return providers.flatMap((item) => [
      this.systemAccount(item),
      ...this.db
        .prepare(
          'SELECT id, provider, label, status, identity, createdAt FROM harness_accounts WHERE provider=? ORDER BY createdAt',
        )
        .all(item)
        .map(
          (row) =>
            ({
              ...row,
              kind: 'managed',
              identity: typeof row.identity === 'string' ? row.identity : null,
            }) as unknown as HarnessAccount,
        ),
    ]);
  }

  account(id: string): HarnessAccount | undefined {
    const system = id.match(/^system:(.+)$/);
    if (system) {
      return isHarnessProvider(system[1])
        ? this.systemAccount(system[1])
        : undefined;
    }
    return this.accounts().find((account) => account.id === id);
  }

  /** Server-only lookup, including the private profile reference. */
  snapshot(id: string): AccountSnapshot | undefined {
    const account = this.account(id);
    if (!account) return undefined;
    const row =
      account.kind === 'managed'
        ? this.db
            .prepare('SELECT profileKey FROM harness_accounts WHERE id=?')
            .get(id)
        : undefined;
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      kind: account.kind,
      profileKey: typeof row?.profileKey === 'string' ? row.profileKey : null,
    };
  }

  createAccount(provider: HarnessProvider, label: string): AccountSnapshot {
    const id = randomUUID();
    const profileKey = randomUUID();
    this.db
      .prepare(
        "INSERT INTO harness_accounts VALUES (?, ?, ?, ?, 'login_required', NULL, ?)",
      )
      .run(id, provider, label, profileKey, Date.now());
    return this.snapshot(id)!;
  }

  setStatus(id: string, status: AccountAuthStatus, identity?: string | null) {
    const account = this.account(id);
    if (!account) throw new Error('Account not found.');
    if (account.kind === 'system')
      this.db
        .prepare(
          'INSERT INTO harness_system_status VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET status=excluded.status, identity=excluded.identity',
        )
        .run(
          account.provider,
          status,
          identity === undefined ? account.identity : identity,
        );
    else
      this.db
        .prepare('UPDATE harness_accounts SET status=?, identity=? WHERE id=?')
        .run(status, identity === undefined ? account.identity : identity, id);
  }

  /** Removes a managed account. An active account leaves no selection. */
  removeAccount(id: string): AccountSnapshot {
    const snapshot = this.snapshot(id);
    if (!snapshot) throw new Error('Account not found.');
    if (snapshot.kind === 'system')
      throw new Error('The system default account cannot be removed.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM harness_accounts WHERE id=?').run(id);
      this.db
        .prepare('UPDATE harness_active SET accountId=NULL WHERE accountId=?')
        .run(id);
      this.db.prepare('DELETE FROM harness_models WHERE accountId=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return snapshot;
  }

  /** One active account per provider, globally. Never falls back silently. */
  activeAccountId(provider: HarnessProvider): string | null {
    const row = this.db
      .prepare('SELECT accountId FROM harness_active WHERE provider=?')
      .get(provider);
    if (!row) return systemAccountId(provider);
    return typeof row.accountId === 'string' ? row.accountId : null;
  }

  activate(provider: HarnessProvider, accountId: string) {
    const account = this.account(accountId);
    if (!account || account.provider !== provider)
      throw new Error('Account does not belong to this provider.');
    this.db
      .prepare(
        'INSERT INTO harness_active VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET accountId=excluded.accountId',
      )
      .run(provider, accountId);
    return account;
  }

  startReceipt(value: {
    threadId: string;
    runId: string;
    harness: HarnessProvider | null;
    model: string;
    account: AccountSnapshot | null;
    continuation: boolean;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO harness_receipts VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, '[]', ?, NULL)",
      )
      .run(
        id,
        value.threadId,
        value.runId,
        value.harness,
        value.model,
        value.account?.id ?? null,
        value.account?.label ?? null,
        +value.continuation,
        Date.now(),
      );
    return id;
  }

  recordTools(id: string, tools: TurnToolRecord[]) {
    this.db
      .prepare('UPDATE harness_receipts SET tools=? WHERE id=?')
      .run(JSON.stringify(tools.slice(0, 100)), id);
  }

  finishReceipt(
    id: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    errorKind: TurnErrorKind | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE harness_receipts SET outcome=?, errorKind=?, finishedAt=? WHERE id=? AND outcome='running'",
      )
      .run(outcome, errorKind, Date.now(), id);
  }

  receipts(threadId: string, limit = 50): TurnReceipt[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM harness_receipts WHERE threadId=? ORDER BY startedAt DESC, rowid DESC LIMIT ?',
        )
        .all(threadId, limit) as unknown as ReceiptRow[]
    ).map((row) => ({
      ...row,
      continuation: !!row.continuation,
      tools: JSON.parse(row.tools) as TurnToolRecord[],
    }));
  }

  receipt(id: string): TurnReceipt | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM harness_receipts WHERE id=?')
      .get(id);
    if (typeof row?.threadId !== 'string') return undefined;
    return this.receipts(row.threadId, 500).find((item) => item.id === id);
  }

  /** Arms one explicit continuation. Re-arming the same failure is idempotent. */
  armContinuation(threadId: string, receiptId: string) {
    this.db
      .prepare(
        'INSERT INTO harness_continuations VALUES (?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET receiptId=excluded.receiptId, armedAt=excluded.armedAt',
      )
      .run(threadId, receiptId, Date.now());
  }

  continuation(threadId: string): string | null {
    const row = this.db
      .prepare('SELECT receiptId FROM harness_continuations WHERE threadId=?')
      .get(threadId);
    return typeof row?.receiptId === 'string' ? row.receiptId : null;
  }

  /** Atomically consumes an armed continuation so it can start only once. */
  takeContinuation(threadId: string): string | null {
    const row = this.db
      .prepare(
        'DELETE FROM harness_continuations WHERE threadId=? RETURNING receiptId',
      )
      .get(threadId);
    return typeof row?.receiptId === 'string' ? row.receiptId : null;
  }

  cachedModels(
    provider: HarnessProvider,
    accountId: string,
  ): { models: HarnessModel[]; fetchedAt: number } | undefined {
    const row = this.db
      .prepare(
        'SELECT models, fetchedAt FROM harness_models WHERE provider=? AND accountId=?',
      )
      .get(provider, accountId);
    return typeof row?.models === 'string'
      ? {
          models: JSON.parse(row.models) as HarnessModel[],
          fetchedAt: Number(row.fetchedAt),
        }
      : undefined;
  }

  cacheModels(
    provider: HarnessProvider,
    accountId: string,
    models: HarnessModel[],
  ) {
    this.db
      .prepare(
        'INSERT INTO harness_models VALUES (?, ?, ?, ?) ON CONFLICT(provider, accountId) DO UPDATE SET models=excluded.models, fetchedAt=excluded.fetchedAt',
      )
      .run(provider, accountId, JSON.stringify(models), Date.now());
  }
}
