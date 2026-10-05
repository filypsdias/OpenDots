import { spawn, type ChildProcess } from 'node:child_process';
import {
  HARNESS_LABELS,
  HARNESS_PROVIDERS,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProvider,
  type HarnessProviderStatus,
} from '../../shared/harness.js';
import type { AccountSnapshot, HarnessStore } from './store.js';
import {
  deleteProfile,
  ensureProfile,
  profileDirectory,
  scrubbedVariables,
} from './environment.js';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  defaultVault,
  parseCodexAuth,
  systemReaders,
  type CredentialVault,
  type SystemReaders,
} from './credentials.js';
import {
  childEnvironment,
  COPILOT_TOKEN_VARIABLE,
  missingCredential,
  prepareRuntime,
  type TurnCredential,
} from './runtime.js';
import { CopilotClient } from '@github/copilot-sdk';
import { HarnessTurnError } from './errors.js';
import {
  copilotClientOptions,
  copilotNativeLogin,
  type CopilotTextConfig,
} from './copilot-adapter.js';

type CopilotProbe = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    authType?: string;
    host?: string;
    login?: string;
  }>;
  listModels(): Promise<Array<{ id: string; name?: string }>>;
};

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type Exec = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
  signal?: AbortSignal,
) => Promise<ExecResult>;
export type Launch = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcess;

const EXECUTABLE: Record<HarnessProvider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  copilot: 'copilot',
};

export const defaultExec: Exec = (command, args, env, timeoutMs, cwd, signal) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env,
      cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    child.stdout.on(
      'data',
      (chunk) => (stdout = (stdout + chunk).slice(-200_000)),
    );
    child.stderr.on(
      'data',
      (chunk) => (stderr = (stderr + chunk).slice(-20_000)),
    );
    child.on('error', () => resolve({ exitCode: 127, stdout, stderr }));
    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });

const defaultLaunch: Launch = (command, args, env) =>
  spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

/** Static examples; discovery and custom IDs extend these. */
export const HARNESS_CATALOG: Record<HarnessProvider, HarnessModel[]> = {
  'claude-code': [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', source: 'catalog' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'catalog' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', source: 'catalog' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'catalog' },
  ],
  codex: [{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', source: 'catalog' }],
  copilot: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'catalog' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', source: 'catalog' },
  ],
};

/** Parses `codex debug models` JSON, keeping listed models only. */
export function parseCodexModels(stdout: string): HarnessModel[] {
  const parsed = JSON.parse(stdout) as { models?: unknown };
  if (!Array.isArray(parsed.models)) return [];
  return parsed.models.flatMap((model) =>
    model &&
    typeof model === 'object' &&
    'slug' in model &&
    typeof model.slug === 'string' &&
    (!('visibility' in model) || model.visibility === 'list')
      ? [
          {
            id: model.slug,
            label:
              'display_name' in model && typeof model.display_name === 'string'
                ? model.display_name
                : model.slug,
            source: 'discovered' as const,
          },
        ]
      : [],
  );
}

/** Extracts only a login URL and device code from native login output. */
export function loginPrompt(output: string) {
  const url = output.match(
    /https:\/\/(?:github\.com\/login\/device|claude\.ai\/[^\s"'<>]*|console\.anthropic\.com\/[^\s"'<>]*|auth\.openai\.com\/[^\s"'<>]*)/,
  )?.[0];
  const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  return url || code ? { url: url ?? null, code: code ?? null } : null;
}

/** Claude's long-lived subscription token printed by `claude setup-token`. */
export const CLAUDE_SETUP_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

const LOGIN_TIMEOUT_MS = 10 * 60_000;

type LoginEntry = {
  child: ChildProcess;
  prompt: ReturnType<typeof loginPrompt>;
  cancelled: boolean;
  scratch: string | null;
};

/**
 * Owns OpenDots accounts. Managed accounts sign in through each provider's
 * native flow into scratch or private profiles, and OpenDots keeps only the
 * resulting credential (Keychain under an OpenDots-only service, or the
 * account's private 0700 profile for Codex). The System default reads the
 * ordinary CLI login read-only; OpenDots never writes, refreshes or signs it
 * out, and never loads its configuration.
 */
export class AccountManager {
  private inUse = new Map<string, number>();
  private logins = new Map<string, LoginEntry>();
  private versions = new Map<HarnessProvider, string | null>();
  readonly vault: CredentialVault;
  private readers: SystemReaders;
  readonly createCopilotClient?: CopilotTextConfig['createClient'];
  private exec: Exec;
  private launch: Launch;
  constructor(
    readonly store: HarnessStore,
    readonly root: string,
    options: {
      exec?: Exec;
      launch?: Launch;
      vault?: CredentialVault;
      readers?: SystemReaders;
      createCopilotClient?: CopilotTextConfig['createClient'];
    } = {},
  ) {
    this.createCopilotClient = options.createCopilotClient;
    this.exec = options.exec ?? defaultExec;
    this.launch = options.launch ?? defaultLaunch;
    this.vault = options.vault ?? defaultVault(root);
    this.readers = options.readers ?? systemReaders(this.baseEnvironment());
  }

  /**
   * Marks an account as used by an in-flight turn. Re-auth, sign-out and
   * removal are refused until every turn using its credentials has finished.
   * Changing the global selection stays allowed.
   */
  acquire(id: string): () => void {
    // A turn never snapshots a credential while re-authentication may replace it.
    if (this.logins.has(id) || this.committing.has(id))
      throw new HarnessTurnError(
        'auth',
        'This account is signing in again. Finish or cancel sign-in in Settings, then continue.',
      );
    this.inUse.set(id, (this.inUse.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.inUse.get(id) ?? 1) - 1;
      if (count > 0) this.inUse.set(id, count);
      else this.inUse.delete(id);
    };
  }

  private requireIdle(id: string) {
    if (this.inUse.get(id))
      throw new Error(
        'Account is in use by a running turn. Wait for it to finish, then retry.',
      );
  }

  /** Inherited environment with every credential and profile override removed. */
  baseEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of scrubbedVariables('codex')) delete env[key];
    return env;
  }

  private require(id: string) {
    const snapshot = this.store.snapshot(id);
    if (!snapshot) throw new Error('Account not found.');
    return snapshot;
  }

  /** The only credential a turn receives. Throws an auth error when absent. */
  async credential(snapshot: AccountSnapshot): Promise<TurnCredential> {
    const { provider } = snapshot;
    // Never read an intermediate value while a commit or rollback settles.
    await this.chains.get(snapshot.id)?.catch(() => undefined);
    if (snapshot.kind === 'system') {
      if (provider === 'copilot') {
        const nativeState = this.readers.copilotState?.() ?? null;
        if (!nativeState) throw missingCredential(provider, 'missing');
        return { provider, githubToken: null, nativeState };
      }
      const found = await this.readers.read(provider);
      if (!found.ok) throw missingCredential(provider, found.reason);
      return provider === 'claude-code'
        ? { provider, oauthToken: found.secret }
        : { provider: 'codex', authJson: found.secret, refreshable: false };
    }
    if (provider === 'codex') {
      let text: string;
      try {
        text = readFileSync(
          join(profileDirectory(this.root, snapshot), 'auth.json'),
          'utf8',
        );
      } catch {
        throw missingCredential(provider, 'missing');
      }
      const found = parseCodexAuth(text, Date.now(), false);
      if (!found.ok) throw missingCredential(provider, found.reason);
      return { provider, authJson: text, refreshable: true };
    }
    const secret = await this.vault.get(snapshot.id);
    if (!secret) throw missingCredential(provider, 'missing');
    return provider === 'claude-code'
      ? { provider, oauthToken: secret }
      : { provider, githubToken: secret };
  }

  /** Keeps a managed Codex account's refreshed tokens; never the ordinary login. */
  /**
   * Keeps a managed Codex account's refreshed tokens, never the ordinary
   * login. Compare-and-swap: only replaces the exact auth the turn started
   * from, so a late refresh never overwrites a newer login or refresh.
   */
  persistCodexRefresh(
    snapshot: AccountSnapshot,
    original: string,
    refreshed: string,
  ): Promise<boolean> {
    if (snapshot.kind !== 'managed' || snapshot.provider !== 'codex')
      return Promise.resolve(false);
    return this.serialize(snapshot.id, async () => {
      if (!this.store.snapshot(snapshot.id)) return false;
      const path = join(profileDirectory(this.root, snapshot), 'auth.json');
      let current: string;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        return false;
      }
      if (current !== original) return false;
      writeFileSync(path, refreshed, { mode: 0o600 });
      return true;
    });
  }

  /** Reads/writes the stored managed credential (Codex: profile auth file). */
  private async storedSecret(
    snapshot: AccountSnapshot,
  ): Promise<string | null> {
    if (snapshot.provider !== 'codex') return this.vault.get(snapshot.id);
    try {
      return readFileSync(
        join(profileDirectory(this.root, snapshot), 'auth.json'),
        'utf8',
      );
    } catch {
      return null;
    }
  }
  private async storeSecret(snapshot: AccountSnapshot, secret: string | null) {
    if (snapshot.provider !== 'codex')
      return secret === null
        ? this.vault.delete(snapshot.id)
        : this.vault.set(snapshot.id, secret);
    const path = join(profileDirectory(this.root, snapshot), 'auth.json');
    if (secret === null) rmSync(path, { force: true });
    else writeFileSync(path, secret, { mode: 0o600 });
  }

  /** Accounts with a credential commit or rollback in flight. */
  private committing = new Set<string>();

  /** Credential writes for one account (login commit, refresh, sign-out, removal) run one at a time. */
  private chains = new Map<string, Promise<unknown>>();
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.chains.set(id, next);
    void next
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  async providers(): Promise<HarnessProviderStatus[]> {
    return Promise.all(
      HARNESS_PROVIDERS.map(async (provider) => {
        if (!this.versions.has(provider)) {
          const result = await this.exec(
            EXECUTABLE[provider],
            ['--version'],
            this.baseEnvironment(),
            10_000,
          );
          this.versions.set(
            provider,
            result.exitCode === 0
              ? result.stdout.trim().split('\n')[0].slice(0, 80)
              : null,
          );
        }
        const version = this.versions.get(provider) ?? null;
        return {
          provider,
          label: HARNESS_LABELS[provider],
          installed: version !== null,
          version,
          activeAccountId: this.store.activeAccountId(provider),
        };
      }),
    );
  }

  add(provider: HarnessProvider, label: string): HarnessAccount {
    const snapshot = this.store.createAccount(provider, label);
    ensureProfile(this.root, snapshot);
    return this.store.account(snapshot.id)!;
  }

  /**
   * Runs `fn` against a Copilot SDK client started exactly as a turn would
   * be (same credential, isolated runtime home), then stops it.
   */
  private async withCopilot<T>(
    snapshot: AccountSnapshot,
    fn: (
      client: CopilotProbe,
      expected: { host: string; login: string } | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    const credential = await this.credential(snapshot);
    if (credential.provider !== 'copilot') throw new Error('Not Copilot.');
    const runtime = prepareRuntime(this.root, credential);
    const { [COPILOT_TOKEN_VARIABLE]: _token, ...env } = runtime.env;
    void _token;
    const options = copilotClientOptions({
      cwd: runtime.home,
      home: runtime.home,
      env: childEnvironment({ env, scrub: runtime.scrub }),
      githubToken: credential.githubToken,
    });
    const client = (this.createCopilotClient?.(options) ??
      new CopilotClient(options)) as unknown as CopilotProbe;
    try {
      await client.start();
      return await fn(client, credential.nativeState?.lastLoggedInUser);
    } finally {
      await client.stop().catch(() => undefined);
      runtime.dispose();
    }
  }

  /** Status comes from the credential OpenDots would actually use. */
  async refresh(id: string): Promise<HarnessAccount> {
    const snapshot = this.require(id);
    if (this.logins.has(id)) return this.store.account(id)!;
    if (snapshot.provider === 'copilot') {
      try {
        let expected: { host: string; login: string } | undefined;
        const status = await this.withCopilot(snapshot, (client, user) => {
          expected = user;
          return client.getAuthStatus();
        });
        // Only the account's own Copilot login counts: a GitHub CLI
        // fallback would be a different identity and quota.
        const ready =
          snapshot.kind === 'system'
            ? copilotNativeLogin(status, expected)
            : status.isAuthenticated;
        this.store.setStatus(
          id,
          ready ? 'ready' : 'login_required',
          ready ? (status.login ?? null) : null,
        );
      } catch {
        this.store.setStatus(id, 'login_required', null);
      }
      return this.store.account(id)!;
    }
    try {
      await this.credential(snapshot);
      const identity =
        snapshot.provider === 'codex' && snapshot.kind === 'system'
          ? await this.readers
              .read('codex')
              .then((found) => (found.ok ? found.identity : null))
          : undefined;
      this.store.setStatus(id, 'ready', identity);
    } catch {
      this.store.setStatus(id, 'login_required', null);
    }
    return this.store.account(id)!;
  }

  private loginCommand(snapshot: AccountSnapshot, scratch: string | null) {
    const env = this.baseEnvironment();
    if (snapshot.provider === 'claude-code')
      // setup-token is interactive; `script` gives it a pseudo-terminal. Its
      // throwaway config dir keeps the ordinary Claude profile untouched.
      return {
        command: 'script',
        args: ['-q', '/dev/null', 'claude', 'setup-token'],
        env: { ...env, CLAUDE_CONFIG_DIR: scratch! },
      };
    if (snapshot.provider === 'codex')
      return {
        command: 'codex',
        // File storage in a throwaway home (never the shared keyring); the
        // result is promoted into the private profile only if still current.
        args: ['-c', 'cli_auth_credentials_store="file"', 'login'],
        env: { ...env, CODEX_HOME: scratch! },
      };
    return {
      command: 'gh',
      args: [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--insecure-storage',
        '--skip-ssh-key',
      ],
      env: { ...env, GH_CONFIG_DIR: scratch!, GH_PROMPT_DISABLED: '1' },
    };
  }

  /** Starts the provider's native login for a managed account. */
  login(id: string): {
    account: HarnessAccount;
    prompt: ReturnType<typeof loginPrompt>;
  } {
    const snapshot = this.require(id);
    if (snapshot.kind === 'system')
      throw new Error(
        'Sign in to the system default account with the CLI itself; OpenDots never changes it.',
      );
    const pending = this.logins.get(id);
    if (pending)
      return { account: this.store.account(id)!, prompt: pending.prompt };
    this.requireIdle(id);
    ensureProfile(this.root, snapshot);
    const scratch = mkdtempSync(join(tmpdir(), 'opendots-login-'));
    const { command, args, env } = this.loginCommand(snapshot, scratch);
    const child = this.launch(command, args, env);
    const entry: LoginEntry = {
      child,
      prompt: null,
      cancelled: false,
      scratch,
    };
    let output = '';
    let token: string | null = null;
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      entry.prompt = loginPrompt(output) ?? entry.prompt;
      token = output.match(CLAUDE_SETUP_TOKEN)?.[0] ?? token;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      entry.cancelled = true;
      child.kill();
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    // Only this login generation may commit, and only while it is current.
    const current = () =>
      !entry.cancelled &&
      this.logins.get(id) === entry &&
      !!this.store.account(id);
    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0 || !current()) return;
        let secret: string | null = null;
        if (snapshot.provider === 'claude-code') secret = token;
        if (snapshot.provider === 'codex') {
          try {
            const text = readFileSync(join(scratch, 'auth.json'), 'utf8');
            if (parseCodexAuth(text, Date.now(), false).ok) secret = text;
          } catch {
            secret = null;
          }
        }
        if (snapshot.provider === 'copilot') {
          const result = await this.exec(
            'gh',
            ['auth', 'token', '--hostname', 'github.com'],
            { ...this.baseEnvironment(), GH_CONFIG_DIR: scratch },
            15_000,
          );
          if (result.exitCode === 0) secret = result.stdout.trim() || null;
        }
        if (!secret || !current()) return;
        this.committing.add(id);
        try {
          await this.serialize(id, async () => {
            // Re-check after every await: a cancel, removal or newer login
            // during the exchange must never be overwritten or resurrected.
            if (!current()) return;
            const previous = await this.storedSecret(snapshot);
            if (!current()) return;
            await this.storeSecret(snapshot, secret);
            if (!this.store.account(id)) await this.storeSecret(snapshot, null);
            else if (!current()) await this.storeSecret(snapshot, previous);
          });
        } finally {
          this.committing.delete(id);
        }
      } catch {
        // Status below reflects whatever credential is actually present.
      } finally {
        rmSync(scratch, { recursive: true, force: true });
        if (this.logins.get(id) === entry) this.logins.delete(id);
        if (this.store.account(id))
          await this.refresh(id).catch(() => undefined);
      }
    };
    // `gh auth login --web` waits for Enter before opening the browser.
    if (snapshot.provider === 'copilot') child.stdin?.write('\n');
    child.on('error', () => void finish(1));
    child.on('close', (code) => void finish(code));
    this.logins.set(id, entry);
    this.store.setStatus(id, 'login_pending');
    return { account: this.store.account(id)!, prompt: entry.prompt };
  }

  /** Sends a one-time code the native login asks the user to paste. */
  submitLoginCode(id: string, code: string) {
    const entry = this.logins.get(id);
    if (!entry) throw new Error('Account sign-in is not waiting for a code.');
    if (!/^[\w#.-]{4,512}$/.test(code))
      throw new Error('Account sign-in code has an unexpected format.');
    entry.child.stdin?.write(`${code}\n`);
  }

  loginPrompt(id: string) {
    return this.logins.get(id)?.prompt ?? null;
  }

  cancelLogin(id: string) {
    const entry = this.logins.get(id);
    if (!entry) return;
    entry.cancelled = true;
    this.logins.delete(id);
    entry.child.kill();
    if (entry.scratch) rmSync(entry.scratch, { recursive: true, force: true });
    if (this.store.account(id)) void this.refresh(id).catch(() => undefined);
  }

  /** Removes the private credential, so new turns cannot use it. */
  async logout(id: string): Promise<HarnessAccount> {
    const snapshot = this.require(id);
    if (snapshot.kind === 'system')
      throw new Error('OpenDots never signs out the system default account.');
    this.requireIdle(id);
    this.cancelLogin(id);
    await this.serialize(id, async () => {
      await this.vault.delete(id);
      rmSync(join(profileDirectory(this.root, snapshot), 'auth.json'), {
        force: true,
      });
    });
    this.store.setStatus(id, 'login_required', null);
    return this.store.account(id)!;
  }

  async remove(id: string) {
    const snapshot = this.require(id);
    this.requireIdle(id);
    if (snapshot.kind === 'managed') await this.logout(id);
    await this.serialize(id, async () => {
      this.store.removeAccount(id);
      deleteProfile(this.root, snapshot);
      // A commit queued before removal deletes what it wrote (see login).
      await this.vault.delete(id);
    });
  }

  /** Catalog plus machine-readable discovery where the CLI supports it. */
  async models(
    provider: HarnessProvider,
    refresh = false,
  ): Promise<{
    models: HarnessModel[];
    discovered: boolean;
    fetchedAt: number | null;
  }> {
    const accountId = this.store.activeAccountId(provider);
    const snapshot = accountId ? this.store.snapshot(accountId) : undefined;
    const cached = accountId
      ? this.store.cachedModels(provider, accountId)
      : undefined;
    let discovered = cached?.models ?? [];
    let fetchedAt = cached?.fetchedAt ?? null;
    const stale =
      refresh || !cached || Date.now() - cached.fetchedAt > 6 * 3600_000;
    if (provider === 'copilot' && snapshot && stale) {
      try {
        const listed = await this.withCopilot(
          snapshot,
          async (client, user) => {
            if (
              snapshot.kind === 'system' &&
              !copilotNativeLogin(await client.getAuthStatus(), user)
            )
              throw new Error('Copilot login is not the account’s own login.');
            return client.listModels();
          },
        );
        discovered = listed.map((model) => ({
          id: model.id,
          label: model.name ?? model.id,
          source: 'discovered' as const,
        }));
        this.store.cacheModels(provider, snapshot.id, discovered);
        fetchedAt = Date.now();
      } catch {
        // Catalog and custom IDs remain available.
      }
    }
    if (
      provider === 'codex' &&
      snapshot &&
      (refresh || !cached || Date.now() - cached.fetchedAt > 6 * 3600_000)
    ) {
      const credential = await this.credential(snapshot).catch(() => null);
      if (credential) {
        const runtime = prepareRuntime(this.root, credential);
        try {
          const result = await this.exec(
            'codex',
            ['debug', 'models'],
            childEnvironment(runtime),
            20_000,
            runtime.home,
          );
          if (result.exitCode === 0) {
            discovered = parseCodexModels(result.stdout);
            this.store.cacheModels(provider, snapshot.id, discovered);
            fetchedAt = Date.now();
          }
        } catch {
          // Keep the cached list; the catalog and custom IDs remain available.
        } finally {
          // Discovery may refresh managed tokens too; keep them safely.
          const refreshed = runtime.refreshedCodexAuth();
          if (refreshed)
            await this.persistCodexRefresh(
              snapshot,
              refreshed.original,
              refreshed.refreshed,
            ).catch(() => false);
          runtime.dispose();
        }
      }
    }
    const seen = new Set(discovered.map((model) => model.id));
    return {
      models: [
        ...discovered,
        ...HARNESS_CATALOG[provider].filter((model) => !seen.has(model.id)),
      ],
      discovered: discovered.length > 0,
      fetchedAt,
    };
  }
}
