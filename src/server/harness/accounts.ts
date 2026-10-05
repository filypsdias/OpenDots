import { spawn, type ChildProcess } from 'node:child_process';
import {
  HARNESS_LABELS,
  HARNESS_PROVIDERS,
  type AccountAuthStatus,
  type HarnessAccount,
  type HarnessModel,
  type HarnessProvider,
  type HarnessProviderStatus,
} from '../../shared/harness.js';
import type { AccountSnapshot, HarnessStore } from './store.js';
import {
  accountVariables,
  deleteProfile,
  ensureProfile,
  scrubbedVariables,
} from './environment.js';

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
  spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

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

export function parseAuthStatus(
  provider: HarnessProvider,
  result: ExecResult,
): { status: AccountAuthStatus; identity: string | null } {
  if (result.exitCode === 127) return { status: 'unknown', identity: null };
  if (provider === 'claude-code') {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      const ready =
        result.exitCode === 0 &&
        value.loggedIn === true &&
        value.authMethod === 'claude.ai';
      return {
        status: ready ? 'ready' : 'login_required',
        identity: ready && typeof value.email === 'string' ? value.email : null,
      };
    } catch {
      return { status: 'login_required', identity: null };
    }
  }
  if (provider === 'codex')
    return {
      status:
        result.exitCode === 0 &&
        /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)
          ? 'ready'
          : 'login_required',
      identity: null,
    };
  // Copilot CLI has no machine-readable auth status command.
  return { status: 'unknown', identity: null };
}

/**
 * Only Claude Code can run the ordinary CLI login with ambient configuration
 * provably excluded (`--setting-sources project`, `--strict-mcp-config`,
 * `--tools ""`). Codex and Copilot load user hooks, plugins, MCP servers and
 * profiles from their default home, so OpenDots runs them only with managed
 * profiles it controls.
 */
export function systemDefaultSupported(snapshot: {
  kind: string;
  provider: HarnessProvider;
}) {
  return snapshot.kind !== 'system' || snapshot.provider === 'claude-code';
}

/**
 * Owns OpenDots-managed CLI profiles. Native login flows run with the account's
 * private profile; the system default profile is only ever read.
 */
export class AccountManager {
  private inUse = new Map<string, number>();
  private logins = new Map<
    string,
    { child: ChildProcess; prompt: ReturnType<typeof loginPrompt> }
  >();
  private versions = new Map<HarnessProvider, string | null>();
  constructor(
    readonly store: HarnessStore,
    readonly root: string,
    private exec: Exec = defaultExec,
    private launch: Launch = defaultLaunch,
  ) {}

  /**
   * Marks an account as used by an in-flight turn. Re-auth, sign-out and
   * removal are refused until every turn using its credentials has finished.
   */
  acquire(id: string): () => void {
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

  /** Child environment for a provider and account; secrets scrubbed. */
  environment(snapshot: AccountSnapshot): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of scrubbedVariables(snapshot.provider)) delete env[key];
    return { ...env, ...accountVariables(this.root, snapshot) };
  }

  async providers(): Promise<HarnessProviderStatus[]> {
    return Promise.all(
      HARNESS_PROVIDERS.map(async (provider) => {
        if (!this.versions.has(provider)) {
          const result = await this.exec(
            EXECUTABLE[provider],
            ['--version'],
            this.environment({
              id: `system:${provider}`,
              provider,
              label: '',
              kind: 'system',
              profileKey: null,
            }),
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

  private require(id: string) {
    const snapshot = this.store.snapshot(id);
    if (!snapshot) throw new Error('Account not found.');
    return snapshot;
  }

  async refresh(id: string): Promise<HarnessAccount> {
    const snapshot = this.require(id);
    if (this.logins.has(id)) return this.store.account(id)!;
    if (!systemDefaultSupported(snapshot)) {
      this.store.setStatus(id, 'unsupported', null);
      return this.store.account(id)!;
    }
    if (snapshot.provider === 'copilot') return this.store.account(id)!;
    const result = await this.exec(
      EXECUTABLE[snapshot.provider],
      snapshot.provider === 'claude-code'
        ? ['auth', 'status', '--json']
        : ['login', 'status'],
      this.environment(snapshot),
      10_000,
    );
    const parsed = parseAuthStatus(snapshot.provider, result);
    this.store.setStatus(id, parsed.status, parsed.identity);
    return this.store.account(id)!;
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
    if (!pending) this.requireIdle(id);
    if (pending)
      return { account: this.store.account(id)!, prompt: pending.prompt };
    ensureProfile(this.root, snapshot);
    const args =
      snapshot.provider === 'claude-code'
        ? ['auth', 'login', '--claudeai']
        : ['login'];
    const child = this.launch(
      EXECUTABLE[snapshot.provider],
      args,
      this.environment(snapshot),
    );
    const entry = { child, prompt: null as ReturnType<typeof loginPrompt> };
    let output = '';
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      entry.prompt = loginPrompt(output) ?? entry.prompt;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    timer.unref?.();
    child.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      this.logins.delete(id);
      if (!this.store.account(id)) return;
      if (snapshot.provider === 'copilot')
        this.store.setStatus(id, code === 0 ? 'ready' : 'login_required');
      else void this.refresh(id).catch(() => undefined);
    });
    this.logins.set(id, entry);
    this.store.setStatus(id, 'login_pending');
    return { account: this.store.account(id)!, prompt: entry.prompt };
  }

  loginPrompt(id: string) {
    return this.logins.get(id)?.prompt ?? null;
  }

  cancelLogin(id: string) {
    this.logins.get(id)?.child.kill();
    this.logins.delete(id);
  }

  async logout(id: string): Promise<HarnessAccount> {
    const snapshot = this.require(id);
    if (snapshot.kind === 'system')
      throw new Error('OpenDots never signs out the system default account.');
    this.requireIdle(id);
    this.cancelLogin(id);
    if (snapshot.provider !== 'copilot')
      await this.exec(
        EXECUTABLE[snapshot.provider],
        snapshot.provider === 'claude-code' ? ['auth', 'logout'] : ['logout'],
        this.environment(snapshot),
        15_000,
      );
    this.store.setStatus(id, 'login_required', null);
    return this.store.account(id)!;
  }

  async remove(id: string) {
    const snapshot = this.require(id);
    this.requireIdle(id);
    if (snapshot.kind === 'managed')
      await this.logout(id).catch(() => undefined);
    this.store.removeAccount(id);
    deleteProfile(this.root, snapshot);
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
    if (
      provider === 'codex' &&
      snapshot &&
      (refresh || !cached || Date.now() - cached.fetchedAt > 6 * 3600_000)
    ) {
      const result = await this.exec(
        'codex',
        ['debug', 'models'],
        this.environment(snapshot),
        20_000,
      );
      if (result.exitCode === 0) {
        try {
          discovered = parseCodexModels(result.stdout);
          this.store.cacheModels(provider, snapshot.id, discovered);
          fetchedAt = Date.now();
        } catch {
          // Keep the cached list; the catalog and custom IDs remain available.
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
