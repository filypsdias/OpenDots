import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { defineTool } from '@copilotkit/runtime/v2';
import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { setupStatus } from '../src/server/platform-config.js';
import { resolveTurnRoute } from '../src/server/harness/routing.js';
import {
  ensureProfile,
  profileDirectory,
  profileRoot,
  scrubbedVariables,
} from '../src/server/harness/environment.js';
import {
  AccountManager,
  loginPrompt,
  parseCodexModels,
  type Exec,
} from '../src/server/harness/accounts.js';
import {
  fileVault,
  parseClaudeKeychain,
  parseCopilotState,
  parseCodexAuth,
  snapshotCodexAuth,
  type CredentialVault,
} from '../src/server/harness/credentials.js';
import { prepareRuntime } from '../src/server/harness/runtime.js';
import {
  classifyHarnessFailure,
  safeTurnMessage,
  sanitizeChunk,
  sanitizedDebug,
} from '../src/server/harness/errors.js';
import {
  copilotErrorText,
  copilotNativeLogin,
  copilotSessionConfig,
} from '../src/server/harness/copilot-adapter.js';
import {
  codexAppServerArgs,
  codexErrorText,
  codexVersionSupported,
  dynamicToolSpecs,
} from '../src/server/harness/codex-app-server.js';
import { conversationPrompt } from '../src/server/harness/prompt.js';
import {
  journaledTools,
  MUTATING_TOOLS,
  UnknownToolOutcomeError,
} from '../src/server/harness/journal.js';
import { continueConversation, createLatest } from '../src/client/HarnessRoute';
import { systemAccountId } from '../src/shared/harness.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-routing-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const httpConfig: PlatformConfig = {
  intelligenceKey: 'synthetic-intelligence',
  apiKey: 'synthetic-key',
  model: 'gpt-project',
  modelProvider: 'openai',
  baseUrl: 'https://api.example.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: '',
};

function workspace(path = ':memory:') {
  const root = join(temp(), 'profiles');
  vi.stubEnv('OPENDOTS_PROFILE_ROOT', root);
  const ws = new WorkspaceStore(path, 'owner');
  ws.useAccountManager(
    new AccountManager(ws.harness, root, { vault: fileVault(root) }),
  );
  cleanup.push(() => ws.close());
  return ws;
}

function legacyDatabase() {
  const path = join(temp(), 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO spaces VALUES ('s1', 'Everyday', '', 1);
    INSERT INTO dots VALUES ('d1', 's1', 'Dot', 'Be helpful.', 1, 1, 1);
    INSERT INTO thread_bindings VALUES ('t1', 'd1', 'owner', 'Old thread', 1);`);
  legacy.close();
  return path;
}

describe('persistence and migration', () => {
  it('keeps HTTP-provider Dots and conversations on the project model', () => {
    const ws = workspace(legacyDatabase());
    new Platform(new Store(':memory:'), ws, httpConfig);
    expect(ws.dot('d1')).toMatchObject({ harness: null, model: null });
    expect(resolveTurnRoute(ws, httpConfig, 't1')).toMatchObject({
      kind: 'http',
      model: 'gpt-project',
    });
  });

  it('seeds legacy local-harness routes once and freezes them', () => {
    const ws = workspace(legacyDatabase());
    const legacy = {
      ...httpConfig,
      modelProvider: 'codex' as const,
      codexModel: 'gpt-legacy',
    };
    new Platform(new Store(':memory:'), ws, legacy);
    expect(ws.dot('d1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-legacy',
    });
    expect(ws.requireThread('t1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-legacy',
    });
    // Later project or Dot default changes never move the conversation.
    const dot = ws.dot('d1')!;
    ws.updateDot('d1', { ...dot, harness: null, model: null });
    new Platform(new Store(':memory:'), ws, {
      ...httpConfig,
      modelProvider: 'claude-code',
      claudeModel: 'claude-x',
    });
    expect(ws.requireThread('t1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-legacy',
    });
    // Frozen harness conversations stay runnable when no Dot routes to a
    // harness and the project HTTP config is missing.
    const broken = { ...httpConfig, apiKey: undefined };
    expect(
      new Platform(new Store(':memory:'), ws, broken).setup().missing,
    ).toEqual([]);
  });

  it('does not mark an invalid harness project config as seeded', () => {
    const ws = workspace(legacyDatabase());
    new Platform(new Store(':memory:'), ws, {
      ...httpConfig,
      modelProvider: 'codex',
    });
    expect(ws.harness.meta('legacy_routes_seeded')).toBeNull();
  });

  it('copies Dot defaults at conversation creation; model changes stay in one conversation', () => {
    const ws = workspace();
    const base = ws.dots()[0];
    ws.updateDot(base.id, { ...base, harness: 'codex', model: 'gpt-a' });
    ws.bindThread('t1', base.id, 'First');
    ws.updateDot(base.id, {
      ...base,
      harness: 'claude-code',
      model: 'claude-x',
    });
    ws.bindThread('t2', base.id, 'Second');
    ws.setConversationModel('t1', 'gpt-b');
    expect(ws.requireThread('t1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-b',
    });
    expect(ws.requireThread('t2')).toMatchObject({
      harness: 'claude-code',
      model: 'claude-x',
    });
  });

  it('recovers turns left running by a previous server process', () => {
    const path = join(temp(), 'restart.sqlite');
    const first = workspace(path);
    first.bindThread('t', first.dots()[0].id, 'T');
    const id = first.harness.startReceipt({
      threadId: 't',
      runId: 'r',
      harness: 'codex',
      model: 'm',
      account: null,
      continuation: false,
      promptId: 'u1',
    });
    first.harness.journalStart({
      threadId: 't',
      promptId: 'u1',
      fingerprint: 'f',
      occurrence: 0,
      tool: 'create_space_page',
      receiptId: id,
    });
    const second = new WorkspaceStore(path, 'owner');
    cleanup.push(() => second.close());
    expect(second.harness.receipts('t')[0]).toMatchObject({
      outcome: 'failed',
      errorKind: 'unknown',
    });
    // The interrupted action stays unknown, so it can never be replayed.
    expect(second.harness.journalEntry('t', 'u1', 'f', 0)?.status).toBe(
      'started',
    );
  });

  it('binds continuation to the original prompt and keeps one per conversation', () => {
    const ws = workspace();
    ws.bindThread('t', ws.dots()[0].id, 'T');
    const id = ws.harness.startReceipt({
      threadId: 't',
      runId: 'r',
      harness: 'codex',
      model: 'm',
      account: null,
      continuation: false,
      promptId: 'u1',
    });
    ws.harness.finishReceipt(id, 'failed', 'quota');
    ws.harness.armContinuation('t', id);
    expect(ws.harness.takeContinuation('t', 'u2')).toBeNull();
    expect(ws.harness.continuation('t')).toBeNull();
    ws.harness.armContinuation('t', id);
    expect(ws.harness.takeContinuation('t', 'u1')).toBe(id);
    expect(ws.harness.takeContinuation('t', 'u1')).toBeNull();
    const release = ws.harness.lockTurn('t');
    expect(() => ws.harness.lockTurn('t')).toThrow(/already running/);
    release();
    ws.harness.lockTurn('t')();
  });
});

describe('route resolution never falls back', () => {
  it.each([
    [
      'missing model',
      (ws: WorkspaceStore) => ws.requireConversationModel('t'),
      /Choose a Codex model/,
    ],
    [
      'removed active account',
      async (ws: WorkspaceStore) => {
        const a = ws.accounts.add('codex', 'A');
        ws.harness.activate('codex', a.id);
        await ws.accounts.remove(a.id);
      },
      /No Codex account is selected/,
    ],
  ] as const)('%s', async (_name, arrange, message) => {
    const ws = workspace();
    const base = ws.dots()[0];
    ws.updateDot(base.id, { ...base, harness: 'codex', model: 'gpt-a' });
    ws.bindThread('t', base.id, 'T');
    await arrange(ws);
    expect(() => resolveTurnRoute(ws, httpConfig, 't')).toThrow(message);
  });

  it('allows the System default for every provider and snapshots the account', () => {
    const ws = workspace();
    const base = ws.dots()[0];
    for (const provider of ['claude-code', 'codex', 'copilot'] as const) {
      ws.updateDot(base.id, { ...base, harness: provider, model: 'm' });
      ws.bindThread(provider, base.id, 'T');
      expect(resolveTurnRoute(ws, httpConfig, provider)).toMatchObject({
        kind: 'harness',
        account: { id: systemAccountId(provider), kind: 'system' },
      });
    }
    const a = ws.accounts.add('copilot', 'A');
    ws.harness.activate('copilot', a.id);
    const route = resolveTurnRoute(ws, httpConfig, 'copilot');
    ws.harness.activate('copilot', systemAccountId('copilot'));
    expect(route.kind === 'harness' && route.account.id).toBe(a.id);
  });
});

describe('profile and environment isolation', () => {
  it('keeps profiles outside the repository with private permissions', () => {
    expect(() =>
      profileRoot({ OPENDOTS_PROFILE_ROOT: join(process.cwd(), 'data') }),
    ).toThrow(/outside the OpenDots repository/);
    expect(profileRoot({}, 'darwin', '/Users/someone', '/repo')).toBe(
      '/Users/someone/Library/Application Support/OpenDots/harness-profiles',
    );
    const root = join(temp(), 'profiles');
    const ws = workspace();
    const dir = ensureProfile(root, ws.harness.createAccount('codex', 'A'));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(dirname(dirname(realpathSync(dir)))).toBe(realpathSync(root));
  });

  it('scrubs credentials, profile overrides, Orca/agent sessions, telemetry export and shell hooks', () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/orca/claude',
      CODEX_HOME: '/orca/codex',
      COPILOT_HOME: '/orca/copilot',
      GH_CONFIG_DIR: '/orca/gh',
      GH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      COPILOT_PROVIDER_BASE_URL: 'x',
      OPENAI_BASE_URL: 'x',
      ORCA_TERMINAL_HANDLE: 'x',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'x',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDECODE: '1',
      BASH_ENV: '/x',
      PATH: '/bin',
      HOME: '/Users/x',
    };
    const scrub = scrubbedVariables('codex', env);
    for (const key of Object.keys(env).filter(
      (key) => !['PATH', 'HOME'].includes(key),
    ))
      expect(scrub).toContain(key);
    expect(scrub).not.toContain('PATH');
    expect(scrub).not.toContain('HOME');
  });

  it('builds a fresh runtime home per turn and never keeps a system Codex refresh token', () => {
    const root = join(temp(), 'profiles');
    const auth = JSON.stringify({
      tokens: { access_token: 'a', refresh_token: 'r' },
      last_refresh: new Date().toISOString(),
    });
    const system = prepareRuntime(
      root,
      { provider: 'codex', authJson: auth, refreshable: false },
      { CODEX_HOME: '/orca', PATH: '/bin' },
    );
    expect(system.env.CODEX_HOME).toBe(system.home);
    expect(system.scrub).not.toContain('CODEX_HOME');
    expect(
      JSON.parse(readFileSync(join(system.home, 'auth.json'), 'utf8')).tokens
        .refresh_token,
    ).toBe('');
    expect(system.refreshedCodexAuth()).toBeNull();
    system.dispose();
    expect(existsSync(system.home)).toBe(false);
    const claude = prepareRuntime(root, {
      provider: 'claude-code',
      oauthToken: 'tok',
    });
    expect(claude.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CONFIG_DIR: claude.home,
      DISABLE_TELEMETRY: '1',
    });
    claude.dispose();
  });
});

describe('credentials', () => {
  it('parses ordinary logins read-only and rejects stale or expired ones', () => {
    const now = Date.parse('2026-10-05T00:00:00Z');
    const fresh = JSON.stringify({
      tokens: {
        access_token: 'a',
        id_token: 'x.eyJlbWFpbCI6Im1lQGV4YW1wbGUuaW52YWxpZCJ9.y',
      },
      last_refresh: '2026-10-04T00:00:00Z',
    });
    expect(parseCodexAuth(fresh, now)).toMatchObject({
      ok: true,
      identity: 'me@example.invalid',
    });
    expect(
      parseCodexAuth(fresh.replace('2026-10-04', '2026-09-01'), now),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(parseCodexAuth('{}', now)).toEqual({ ok: false, reason: 'missing' });
    expect(
      snapshotCodexAuth(
        JSON.stringify({ tokens: { refresh_token: 'r', access_token: 'a' } }),
      ),
    ).toBe('{"tokens":{"refresh_token":"","access_token":"a"}}');
    expect(
      parseClaudeKeychain(
        JSON.stringify({
          claudeAiOauth: { accessToken: 't', expiresAt: now + 3600_000 },
        }),
        now,
      ),
    ).toMatchObject({ ok: true, secret: 't' });
    expect(
      parseClaudeKeychain(
        JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: now } }),
        now,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('stores managed secrets privately and refuses unexpected formats', async () => {
    const root = join(temp(), 'profiles');
    const vault = fileVault(root);
    const id = '11111111-2222-3333-4444-555555555555';
    await vault.set(id, 'gho_secret_value');
    expect(statSync(join(root, 'credentials', id)).mode & 0o777).toBe(0o600);
    expect(await vault.get(id)).toBe('gho_secret_value');
    await expect(vault.set(id, 'has space')).rejects.toThrow(
      /unexpected format/,
    );
    await vault.delete(id);
    expect(await vault.get(id)).toBeNull();
  });
});

describe('account manager', () => {
  function manager(options: { exec?: Exec; vault?: CredentialVault } = {}) {
    const ws = workspace();
    const launched: Array<{
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      child: EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill(): void;
      };
    }> = [];
    const launch = (
      command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
    ) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => child.emit('close', null),
      });
      launched.push({ command, args, env, child });
      return child as never;
    };
    const root = join(temp(), 'profiles');
    const vault = options.vault ?? fileVault(root);
    const exec: Exec =
      options.exec ??
      (async () => ({
        exitCode: 0,
        stdout: 'gho_from_isolated_gh',
        stderr: '',
      }));
    const accounts = new AccountManager(ws.harness, root, {
      exec,
      launch,
      vault,
      readers: { read: async () => ({ ok: false, reason: 'missing' }) },
      createCopilotClient: (() => ({
        start: async () => undefined,
        stop: async () => undefined,
        getAuthStatus: async () => ({
          isAuthenticated: true,
          login: 'octo',
          authType: 'token',
        }),
        listModels: async () => [{ id: 'gpt-y', name: 'GPT Y' }],
      })) as never,
    });
    ws.useAccountManager(accounts);
    return { ws, accounts, launched, vault };
  }

  it('signs Claude in with setup-token in a throwaway profile and stores only the token', async () => {
    const { ws, accounts, launched } = manager();
    const account = accounts.add('claude-code', 'Work');
    accounts.login(account.id);
    const [login] = launched;
    expect(login.command).toBe('script');
    expect(login.args).toEqual(['-q', '/dev/null', 'claude', 'setup-token']);
    const scratch = login.env.CLAUDE_CONFIG_DIR!;
    expect(scratch).toMatch(/opendots-login-/);
    login.child.stdout.write(
      'Visit https://claude.ai/oauth/authorize?code=1\nYour OAuth token: sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n',
    );
    expect(accounts.loginPrompt(account.id)).toEqual({
      url: 'https://claude.ai/oauth/authorize?code=1',
      code: null,
    });
    accounts.submitLoginCode(account.id, 'pasted-code#1');
    login.child.emit('close', 0);
    await vi.waitFor(() =>
      expect(ws.harness.account(account.id)?.status).toBe('ready'),
    );
    expect(await accounts.vault.get(account.id)).toBe(
      'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(existsSync(scratch)).toBe(false);
  });

  it('signs Copilot in with an isolated gh profile, never the ordinary gh config', async () => {
    const calls: Array<{ args: string[]; dir?: string }> = [];
    const { ws, accounts, launched } = manager({
      exec: async (_command, args, env) => {
        calls.push({ args, dir: env.GH_CONFIG_DIR });
        return { exitCode: 0, stdout: 'gho_from_isolated_gh', stderr: '' };
      },
    });
    const account = accounts.add('copilot', 'Work');
    accounts.login(account.id);
    const [login] = launched;
    expect(login.args).toEqual(
      expect.arrayContaining(['auth', 'login', '--web', '--insecure-storage']),
    );
    expect(login.env.GH_CONFIG_DIR).toMatch(/opendots-login-/);
    login.child.emit('close', 0);
    await vi.waitFor(() =>
      expect(ws.harness.account(account.id)?.status).toBe('ready'),
    );
    expect(calls[0]).toMatchObject({
      args: ['auth', 'token', '--hostname', 'github.com'],
      dir: login.env.GH_CONFIG_DIR,
    });
    expect(await accounts.vault.get(account.id)).toBe('gho_from_isolated_gh');
    expect(ws.harness.account(account.id)?.identity).toBe('octo');
  });

  it.each(['error', 'cancel', 'timeout', 'removed'] as const)(
    'stores nothing when the login %s',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { ws, accounts, launched } = manager();
      const account = accounts.add('claude-code', 'Work');
      accounts.login(account.id);
      const [login] = launched;
      login.child.stdout.write(
        'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345\n',
      );
      if (outcome === 'error')
        login.child.emit('error', new Error('spawn failed'));
      if (outcome === 'cancel') accounts.cancelLogin(account.id);
      if (outcome === 'timeout') vi.advanceTimersByTime(10 * 60_000 + 1);
      if (outcome === 'removed') {
        accounts.cancelLogin(account.id);
        await accounts.remove(account.id);
      }
      login.child.emit('close', 0);
      vi.useRealTimers();
      await new Promise((done) => setTimeout(done, 20));
      expect(await accounts.vault.get(account.id)).toBeNull();
      if (outcome !== 'removed')
        expect(ws.harness.account(account.id)?.status).toBe('login_required');
      else expect(ws.harness.account(account.id)).toBeUndefined();
    },
  );

  it('never signs in or out the System default, and reports a failed credential deletion', async () => {
    const failing: CredentialVault = {
      get: async () => 'secret-value',
      set: async () => undefined,
      delete: async () => {
        throw new Error(
          'Account credential could not be removed from Keychain.',
        );
      },
    };
    const { accounts } = manager({ vault: failing });
    expect(() => accounts.login(systemAccountId('codex'))).toThrow(
      /never changes it/,
    );
    await expect(
      accounts.logout(systemAccountId('claude-code')),
    ).rejects.toThrow(/never signs out/);
    const account = accounts.add('copilot', 'Work');
    await expect(accounts.logout(account.id)).rejects.toThrow(
      /could not be removed/,
    );
  });

  it('discovers Codex and Copilot models through supported machine-readable APIs', async () => {
    const { ws, accounts } = manager({
      exec: async (_command, args, env) =>
        args[0] === 'debug'
          ? {
              exitCode: env.CODEX_HOME ? 0 : 1,
              stdout: JSON.stringify({
                models: [
                  { slug: 'gpt-x', display_name: 'GPT X', visibility: 'list' },
                  { slug: 'hidden', visibility: 'hide' },
                ],
              }),
              stderr: '',
            }
          : { exitCode: 1, stdout: '', stderr: '' },
    });
    const codex = accounts.add('codex', 'Work');
    ensureProfile(accounts.root, ws.harness.snapshot(codex.id)!);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(
        profileDirectory(accounts.root, ws.harness.snapshot(codex.id)!),
        'auth.json',
      ),
      JSON.stringify({
        tokens: { access_token: 'a' },
        last_refresh: new Date().toISOString(),
      }),
    );
    ws.harness.activate('codex', codex.id);
    const listed = await accounts.models('codex');
    expect(listed.models[0]).toEqual({
      id: 'gpt-x',
      label: 'GPT X',
      source: 'discovered',
    });
    expect(listed.models.some((model) => model.id === 'hidden')).toBe(false);
    const copilot = accounts.add('copilot', 'Work');
    await accounts.vault.set(copilot.id, 'gho_token_value');
    ws.harness.activate('copilot', copilot.id);
    expect((await accounts.models('copilot')).models[0]).toEqual({
      id: 'gpt-y',
      label: 'GPT Y',
      source: 'discovered',
    });
    expect(parseCodexModels('{"models":[]}')).toEqual([]);
  });
});

describe('tool journal', () => {
  function journal(
    execute: (input: { title: string; spaceId?: string }) => unknown,
    authorize = (_name: string, _input: unknown) => undefined,
  ) {
    const ws = workspace();
    ws.bindThread('t', ws.dots()[0].id, 'T');
    const make = () =>
      journaledTools(
        [
          defineTool({
            name: 'create_space_page',
            description: 'create',
            parameters: z.object({
              title: z.string(),
              spaceId: z.string().optional(),
            }),
            execute: async (input) => execute(input),
          }),
          defineTool({
            name: 'read_space_page',
            description: 'read',
            parameters: z.object({ id: z.string() }),
            execute: async () => 'live read',
          }),
        ],
        {
          store: ws.harness,
          threadId: 't',
          promptId: 'u1',
          receiptId: () => null,
          authorize,
        },
      );
    return { ws, make };
  }
  const run = (
    tools: ReturnType<typeof journaledTools>,
    name: string,
    input: unknown,
  ) =>
    (
      tools.find((tool) => tool.name === name)!.execute as (
        input: unknown,
      ) => Promise<unknown>
    )(input);

  it('journals only mutating tools', () => {
    expect([...MUTATING_TOOLS]).toEqual(
      expect.arrayContaining([
        'create_space_page',
        'edit_space_page',
        'computer_exec',
        'computer_files_write',
      ]),
    );
    expect(MUTATING_TOOLS.has('list_my_jira_issues')).toBe(false);
  });

  it('returns the stored result for a repeated mutation in the same answer and across attempts', async () => {
    let count = 0;
    const { make } = journal(() => ({ id: `page-${++count}` }));
    const first = make();
    expect(await run(first, 'create_space_page', { title: 'A' })).toEqual({
      id: 'page-1',
    });
    expect(await run(first, 'create_space_page', { title: 'A' })).toEqual({
      id: 'page-1',
    });
    // A continuation (new tool instances) still sees the stored result.
    expect(await run(make(), 'create_space_page', { title: 'A' })).toEqual({
      id: 'page-1',
    });
    expect(count).toBe(1);
    expect(await run(make(), 'read_space_page', { id: 'x' })).toBe('live read');
  });

  it('never replays a mutation that threw after it may have taken effect', async () => {
    let count = 0;
    const { make } = journal(() => {
      count += 1;
      throw new Error('network failed after write');
    });
    await expect(
      run(make(), 'create_space_page', { title: 'A' }),
    ).rejects.toThrow(/network failed/);
    await expect(
      run(make(), 'create_space_page', { title: 'A' }),
    ).rejects.toThrow(UnknownToolOutcomeError);
    expect(count).toBe(1);
  });

  it('rechecks current permission before returning a stored result', async () => {
    let allowed = true;
    const { make } = journal(
      () => ({ id: 'page-1' }),
      () => {
        if (!allowed)
          throw new Error('Space access has been revoked or was not granted.');
      },
    );
    await run(make(), 'create_space_page', { title: 'A' });
    allowed = false;
    await expect(
      run(make(), 'create_space_page', { title: 'A' }),
    ).rejects.toThrow(/revoked/);
  });
});

describe('error privacy', () => {
  it.each([
    ['You have hit your usage limit.', 'quota'],
    ['429 Too Many Requests', 'quota'],
    ['harness-error:model', 'model'],
    ['model_not_found', 'model'],
    ['Not logged in · Please run /login', 'auth'],
    ['spawn copilot ENOENT', 'missing_cli'],
    ['Codex CLI must be updated', 'missing_cli'],
    ['segfault', 'unknown'],
  ] as const)('%s → %s', (text, kind) => {
    expect(classifyHarnessFailure(text)).toBe(kind);
  });

  it('replaces raw adapter errors with a machine-readable kind before any logging', () => {
    const raw = {
      type: 'RUN_ERROR',
      model: 'm',
      message: 'quota exceeded for me@example.invalid token=abc /Users/me',
    };
    const clean = sanitizeChunk(raw);
    expect(clean).toMatchObject({
      type: 'RUN_ERROR',
      code: 'quota',
      message: 'harness-error:quota',
    });
    expect(JSON.stringify(clean)).not.toMatch(
      /example\.invalid|token=|\/Users/,
    );
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sanitizedDebug('codex').logger.error('chatStream fatal', {
      error: new Error('401 for me@example.invalid'),
    });
    expect(JSON.stringify(logs.mock.calls)).toBe(
      '[["[opendots] codex turn error: auth"]]',
    );
    logs.mockRestore();
    for (const kind of [
      'quota',
      'auth',
      'model',
      'missing_cli',
      'unknown',
    ] as const)
      expect(safeTurnMessage(kind, 'copilot')).not.toMatch(
        /@|token|\/Users|profile/i,
      );
    expect(
      codexErrorText({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }),
    ).toMatch(/^usage limit/);
    expect(copilotErrorText({ errorType: 'rate_limit' })).toBe(
      'harness-error:quota',
    );
    expect(copilotErrorText({ errorType: 'authentication' })).toBe(
      'harness-error:auth',
    );
  });

  it('extracts only login URLs and codes', () => {
    expect(
      loginPrompt(
        'token: ghp_secret\nVisit https://github.com/login/device and enter 1A2B-3C4D',
      ),
    ).toEqual({
      url: 'https://github.com/login/device',
      code: '1A2B-3C4D',
    });
    expect(loginPrompt('nothing here')).toBeNull();
  });
});

describe('protocol configuration', () => {
  it('generates the Codex lockdown and dynamic tool specs from real tool definitions', () => {
    const args = codexAppServerArgs();
    expect(args[0]).toBe('app-server');
    expect(args).toEqual(
      expect.arrayContaining([
        'features.stable_environment_tools=false',
        'notify=[]',
        'hooks={}',
        'plugins={}',
      ]),
    );
    const tool = toolDefinition({
      name: 'read_space_page',
      description: 'Read',
      inputSchema: z.object({ id: z.string() }),
    }).server(async () => 'ok');
    const clientOnly = {
      name: 'review',
      description: 'client',
      inputSchema: z.object({}),
    };
    expect(dynamicToolSpecs([tool, clientOnly as never])).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'read_space_page',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: ['id'],
        }),
      }),
    ]);
    expect(codexVersionSupported('codex_cli_rs/0.160.0 (Mac OS)')).toBe(true);
    expect(codexVersionSupported('codex_cli_rs/0.159.9')).toBe(false);
    expect(codexVersionSupported(undefined)).toBe(false);
  });

  it('builds a Copilot SDK session that exposes only OpenDots tools', async () => {
    const tool = toolDefinition({
      name: 'create_space_page',
      description: 'Create',
      inputSchema: z.object({ title: z.string() }),
    }).server(async () => 'ok');
    const calls: string[] = [];
    const config = copilotSessionConfig(
      'm',
      { cwd: '/w', home: '/h' },
      [tool],
      'Be brief.',
      async (item, _args, id) => {
        calls.push(`${item.name}:${id}`);
        return 'done';
      },
    ) as unknown as Record<string, unknown> & {
      tools: Array<{
        name: string;
        handler: (a: unknown, i: { toolCallId: string }) => Promise<string>;
        skipPermission?: boolean;
      }>;
    };
    expect(config.availableTools).toEqual(['create_space_page']);
    expect(config.tools[0].skipPermission).toBe(true);
    expect(
      await config.tools[0].handler({ title: 'x' }, { toolCallId: 'c1' }),
    ).toBe('done');
    expect(calls).toEqual(['create_space_page:c1']);
    expect(config).toMatchObject({
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableSkills: false,
      enableFileHooks: false,
      configDirectory: '/h',
      systemMessage: { mode: 'append', content: 'Be brief.' },
    });
  });

  it('keeps tool calls and results in harness conversation text', () => {
    const text = conversationPrompt([
      { role: 'user', content: 'Make a page' },
      {
        role: 'assistant',
        content: 'On it',
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'create_space_page', arguments: '{"title":"A"}' },
          },
        ],
      },
      { role: 'tool', content: '{"id":"p1"}', toolCallId: 'c1' },
      { role: 'user', content: 'Thanks' },
    ] as never);
    expect(text).toBe(
      'Previous conversation:\nUser: Make a page\nAssistant: On it\nAssistant called tool create_space_page with {"title":"A"}\nTool result (create_space_page): {"id":"p1"}\n\nThanks',
    );
  });
});

describe('owner API', () => {
  function api() {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('OPENDOTS_CONTAINER', 'false');
    const store = new Store(':memory:');
    const ws = workspace();
    cleanup.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
    const platform = new Platform(store, ws, {
      ...httpConfig,
      intelligenceKey: undefined,
    });
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    });
    const call = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { ws, call };
  }

  it('manages accounts without exposing credentials or profile paths and refuses cross-origin mutation', async () => {
    const { ws, call } = api();
    const created = await call('/api/harness/accounts', 'POST', {
      provider: 'copilot',
      label: 'Work',
    });
    expect(created.status).toBe(201);
    const account = await created.json();
    const texts = [
      JSON.stringify(account),
      await (await call(`/api/harness/accounts/${account.id}/login`)).text(),
      await (await call('/api/harness')).text(),
    ];
    for (const text of texts)
      expect(text).not.toMatch(
        /profileKey|harness-profiles|profiles|credential/,
      );
    expect(
      (
        await call(
          '/api/harness/active',
          'POST',
          { provider: 'copilot', accountId: account.id },
          { Origin: 'https://evil.invalid' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/api/harness/active', 'POST', {
          provider: 'copilot',
          accountId: account.id,
        })
      ).status,
    ).toBe(200);
    expect(ws.harness.activeAccountId('copilot')).toBe(account.id);
    const code = await call(
      `/api/harness/accounts/${account.id}/login/code`,
      'POST',
      { code: 'ABCD-1234' },
    );
    expect(code.status).toBe(503);
    expect(await code.json()).toEqual({
      error: 'Account sign-in is not waiting for a code.',
    });
  });

  it.each([
    { HOST: '0.0.0.0', NODE_ENV: 'development', OPENDOTS_CONTAINER: 'false' },
    { HOST: '127.0.0.1', NODE_ENV: 'development', OPENDOTS_CONTAINER: 'true' },
  ])(
    'refuses local account and model management outside this machine (%j)',
    async (environment) => {
      const { call } = api();
      for (const [key, value] of Object.entries(environment))
        vi.stubEnv(key, value);
      for (const [path, method, body] of [
        ['/api/harness', 'GET', undefined],
        ['/api/harness/accounts', 'POST', { provider: 'codex', label: 'x' }],
        ['/api/harness/models/codex', 'GET', undefined],
        [
          '/api/harness/active',
          'POST',
          { provider: 'codex', accountId: 'system:codex' },
        ],
      ] as const) {
        const response = await call(path, method, body);
        expect(response.status).toBe(403);
        expect((await response.json()).error).toMatch(
          /only for OpenDots running on this machine/,
        );
      }
    },
  );

  it('continues with the latest global account even after a switch made elsewhere', async () => {
    const { ws, call } = api();
    const dot = ws.dots()[0];
    const body = {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: true,
    };
    expect(
      (await call(`/api/dots/${dot.id}`, 'PUT', { ...body, harness: 'codex' }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(`/api/dots/${dot.id}`, 'PUT', {
          ...body,
          harness: 'codex',
          model: 'gpt-a',
        })
      ).status,
    ).toBe(200);
    ws.bindThread('t', dot.id, 'T');
    expect(
      (await call('/api/conversations/t/model', 'PUT', { model: 'bad model' }))
        .status,
    ).toBe(400);
    const a = ws.accounts.add('codex', 'A');
    ws.harness.activate('codex', a.id);
    const receipt = ws.harness.startReceipt({
      threadId: 't',
      runId: 'r',
      harness: 'codex',
      model: 'gpt-a',
      account: ws.harness.snapshot(a.id)!,
      continuation: false,
      promptId: 'u1',
    });
    ws.harness.recordTools(receipt, [
      { id: '1', name: 'create_space_page', status: 'completed' },
      { id: '2', name: 'edit_space_page', status: 'unknown' },
    ]);
    ws.harness.finishReceipt(receipt, 'failed', 'quota');
    // Settings (or another tab) switches the global account afterwards.
    const b = ws.accounts.add('codex', 'B');
    await call('/api/harness/active', 'POST', {
      provider: 'codex',
      accountId: b.id,
    });
    const requests: Array<{ path: string; body: unknown }> = [];
    const armed = await continueConversation('t', receipt, (async (
      path: string,
      _method?: string,
      value?: unknown,
    ) => {
      requests.push({ path, body: value });
      return (await call(`/api${path}`, 'POST', value)).json();
    }) as never);
    expect(requests).toEqual([
      { path: '/conversations/t/continue', body: { receiptId: receipt } },
    ]);
    expect(armed.activeAccount?.id).toBe(b.id);
    expect(armed.recovery).toMatchObject({
      kind: 'quota',
      armed: true,
      completedTools: ['create_space_page'],
      unknownTools: ['edit_space_page'],
    });
    expect(JSON.stringify(armed)).not.toMatch(/profileKey|profiles/);
    // A turn without an unanswered prompt cannot be continued.
    const orphan = ws.harness.startReceipt({
      threadId: 't',
      runId: 'r2',
      harness: 'codex',
      model: 'gpt-a',
      account: null,
      continuation: false,
    });
    ws.harness.finishReceipt(orphan, 'failed', 'quota');
    expect(
      (
        await call('/api/conversations/t/continue', 'POST', {
          receiptId: orphan,
        })
      ).status,
    ).toBe(409);
  });

  it('keeps setup readiness per conversation when Dots route to local harnesses', () => {
    const broken = { ...httpConfig, apiKey: undefined };
    expect(setupStatus(broken).missing).toContain(
      'Set OPENAI_API_KEY and OPENAI_MODEL.',
    );
    expect(setupStatus(broken, 'not_configured', false, true)).toMatchObject({
      missing: [],
      model: true,
    });
  });
});

describe('round-2 regressions', () => {
  it('never turns an HTTP conversation into a hidden harness route; new conversations persist the project harness', () => {
    const ws = workspace();
    const dot = ws.dots()[0];
    new Platform(new Store(':memory:'), ws, httpConfig);
    ws.bindThread('http-thread', dot.id, 'HTTP');
    const codexProject = {
      ...httpConfig,
      modelProvider: 'codex' as const,
      codexModel: 'gpt-project',
    };
    expect(() => resolveTurnRoute(ws, codexProject, 'http-thread')).toThrow(
      /project HTTP model/,
    );
    new Platform(new Store(':memory:'), ws, codexProject);
    ws.bindThread('new-thread', dot.id, 'New');
    expect(ws.requireThread('new-thread')).toMatchObject({
      harness: 'codex',
      model: 'gpt-project',
    });
    expect(ws.requireThread('http-thread').harness).toBeNull();
  });

  it('guards stale and overlapping route loads', () => {
    const latest = createLatest();
    const first = latest.begin('t1');
    const second = latest.begin('t1');
    expect(latest.isCurrent(first, 't1')).toBe(false);
    expect(latest.isCurrent(second, 't1')).toBe(true);
    expect(latest.isCurrent(second, 't2')).toBe(false);
    latest.unmount();
    expect(latest.isCurrent(second, 't1')).toBe(false);
    // StrictMode re-runs mount effects after a simulated unmount.
    latest.mount();
    expect(latest.isCurrent(latest.begin('t1'), 't1')).toBe(true);
  });

  it.each(['cancel', 'remove', 'supersede'] as const)(
    'never stores a credential when the login is %sd during the token exchange',
    async (race) => {
      const ws = workspace();
      const root = join(temp(), 'profiles');
      const vault = fileVault(root);
      let releaseToken: (value: string) => void = () => undefined;
      const exec: Exec = (_command, args) =>
        args[1] === 'token'
          ? new Promise(
              (done) =>
                (releaseToken = (stdout) =>
                  done({ exitCode: 0, stdout, stderr: '' })),
            )
          : Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      const children: Array<EventEmitter & { kill(): void }> = [];
      const accounts = new AccountManager(ws.harness, root, {
        exec,
        vault,
        launch: () => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            stdin: new PassThrough(),
            kill: () => undefined,
          });
          children.push(child);
          return child as never;
        },
        createCopilotClient: (() => ({
          start: async () => undefined,
          stop: async () => undefined,
          getAuthStatus: async () => ({ isAuthenticated: false }),
          listModels: async () => [],
        })) as never,
      });
      const account = accounts.add('copilot', 'Work');
      await vault.set(account.id, 'gho_previous_token');
      accounts.login(account.id);
      // A turn cannot snapshot the credential while sign-in is pending.
      expect(() => accounts.acquire(account.id)).toThrow(/signing in again/);
      children[0].emit('close', 0);
      await vi.waitFor(() => expect(children).toHaveLength(1));
      if (race === 'cancel') accounts.cancelLogin(account.id);
      if (race === 'remove') {
        accounts.cancelLogin(account.id);
        await accounts.remove(account.id);
      }
      if (race === 'supersede') {
        accounts.cancelLogin(account.id);
        accounts.login(account.id);
      }
      releaseToken('gho_late_token');
      await new Promise((done) => setTimeout(done, 30));
      const stored = await vault.get(account.id);
      expect(stored).not.toBe('gho_late_token');
      if (race === 'remove') expect(stored).toBeNull();
      else expect(stored).toBe('gho_previous_token');
    },
  );

  it('persists a managed Codex refresh from model discovery by compare-and-swap only', async () => {
    const ws = workspace();
    const root = join(temp(), 'profiles');
    const original = JSON.stringify({
      tokens: { access_token: 'a', refresh_token: 'r1' },
      last_refresh: new Date().toISOString(),
    });
    const refreshed = original.replace('r1', 'r2');
    const exec: Exec = async (_command, _args, env) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(env.CODEX_HOME!, 'auth.json'), refreshed);
      return { exitCode: 0, stdout: '{"models":[]}', stderr: '' };
    };
    const accounts = new AccountManager(ws.harness, root, {
      exec,
      vault: fileVault(root),
    });
    const account = accounts.add('codex', 'Work');
    const snapshot = ws.harness.snapshot(account.id)!;
    const path = join(profileDirectory(root, snapshot), 'auth.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, original);
    ws.harness.activate('codex', account.id);
    await accounts.models('codex', true);
    expect(readFileSync(path, 'utf8')).toBe(refreshed);
    // A late refresh from an older credential never overwrites a newer one.
    expect(
      await accounts.persistCodexRefresh(snapshot, original, 'stale'),
    ).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(refreshed);
    // The ordinary login is never written.
    expect(
      await accounts.persistCodexRefresh(
        ws.harness.snapshot(systemAccountId('codex'))!,
        original,
        refreshed,
      ),
    ).toBe(false);
  });

  it('rejects a Continue request that tries to choose an account', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const ws = workspace();
    const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform: new Platform(store, ws, {
        ...httpConfig,
        intelligenceKey: undefined,
      }),
    });
    const response = await app.request('/api/conversations/t/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId: 'r', accountId: 'system:codex' }),
    });
    expect(response.status).toBe(400);
  });
});

it('does not accept a GitHub CLI fallback as the Copilot System default identity', async () => {
  const ws = workspace();
  const root = join(temp(), 'profiles');
  const seen: Array<Record<string, unknown>> = [];
  const status = {
    isAuthenticated: true,
    login: 'gh-user',
    authType: 'gh-cli',
  };
  const accounts = new AccountManager(ws.harness, root, {
    vault: fileVault(root),
    readers: {
      read: async () => ({ ok: false, reason: 'missing' }),
      copilotState: () => ({
        lastLoggedInUser: { host: 'https://github.com', login: 'copilot-user' },
        loggedInUsers: [{ host: 'https://github.com', login: 'copilot-user' }],
      }),
    },
    createCopilotClient: ((options: Record<string, unknown>) => {
      seen.push(options);
      return {
        start: async () => undefined,
        stop: async () => undefined,
        getAuthStatus: async () => status,
        listModels: async () => [],
      };
    }) as never,
  });
  const system = systemAccountId('copilot');
  expect(await accounts.refresh(system)).toMatchObject({
    status: 'login_required',
    identity: null,
  });
  const env = seen[0].env as Record<string, string>;
  expect(seen[0]).toMatchObject({ useLoggedInUser: true });
  expect(env.GH_CONFIG_DIR).toMatch(/runtime\/copilot-.*\/gh$/);
  status.authType = 'user';
  status.login = 'copilot-user';
  expect(await accounts.refresh(system)).toMatchObject({
    status: 'ready',
    identity: 'copilot-user',
  });
});

describe('login commit races', () => {
  function setup(vault: CredentialVault) {
    const ws = workspace();
    const root = join(temp(), 'profiles');
    const children: Array<EventEmitter & { kill(): void }> = [];
    const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const accounts = new AccountManager(ws.harness, root, {
      vault,
      exec: async () => ({ exitCode: 0, stdout: 'gho_new_token', stderr: '' }),
      launch: (_command, args, env) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          stdin: new PassThrough(),
          kill: () => undefined,
        });
        children.push(child);
        launches.push({ args, env });
        return child as never;
      },
      createCopilotClient: (() => ({
        start: async () => undefined,
        stop: async () => undefined,
        getAuthStatus: async () => ({
          isAuthenticated: true,
          authType: 'token',
        }),
        listModels: async () => [],
      })) as never,
    });
    return { ws, root, accounts, children, launches };
  }

  it('rechecks after reading the previous credential and never writes after cancellation', async () => {
    const values = new Map<string, string>();
    let releaseGet: () => void = () => undefined;
    let gate = false;
    const vault: CredentialVault = {
      get: async (id) => {
        if (gate) await new Promise<void>((done) => (releaseGet = done));
        return values.get(id) ?? null;
      },
      set: async (id, secret) => void values.set(id, secret),
      delete: async (id) => void values.delete(id),
    };
    const { accounts, children } = setup(vault);
    const account = accounts.add('copilot', 'Work');
    values.set(account.id, 'gho_previous_token');
    accounts.login(account.id);
    gate = true;
    children[0].emit('close', 0);
    await vi.waitFor(() =>
      expect(() => accounts.acquire(account.id)).toThrow(/signing in again/),
    );
    accounts.cancelLogin(account.id);
    gate = false;
    releaseGet();
    await new Promise((done) => setTimeout(done, 20));
    expect(values.get(account.id)).toBe('gho_previous_token');
  });

  it('makes credential reads wait until an in-flight commit settles', async () => {
    const values = new Map<string, string>();
    let releaseSet: () => void = () => undefined;
    const vault: CredentialVault = {
      get: async (id) => values.get(id) ?? null,
      set: async (id, secret) => {
        await new Promise<void>((done) => (releaseSet = done));
        values.set(id, secret);
      },
      delete: async (id) => void values.delete(id),
    };
    const { ws, accounts, children } = setup(vault);
    const account = accounts.add('copilot', 'Work');
    accounts.login(account.id);
    children[0].emit('close', 0);
    await new Promise((done) => setTimeout(done, 10));
    expect(() => accounts.acquire(account.id)).toThrow(/signing in again/);
    let read: string | null | undefined;
    const pending = accounts
      .credential(ws.harness.snapshot(account.id)!)
      .then(
        (value) =>
          (read = value.provider === 'copilot' ? value.githubToken : null),
      );
    await new Promise((done) => setTimeout(done, 10));
    expect(read).toBeUndefined();
    releaseSet();
    await pending;
    expect(read).toBe('gho_new_token');
  });

  it('signs Codex in to a throwaway home and promotes only a current login', async () => {
    const { ws, accounts, children, launches } = setup(
      fileVault(join(temp(), 'v')),
    );
    const account = accounts.add('codex', 'Work');
    const profile = join(
      profileDirectory(accounts.root, ws.harness.snapshot(account.id)!),
      'auth.json',
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(profile, 'previous');
    const good = JSON.stringify({
      tokens: { access_token: 'a' },
      last_refresh: new Date().toISOString(),
    });
    // Cancelled login: the profile keeps the previous credential.
    accounts.login(account.id);
    expect(launches[0].env.CODEX_HOME).toMatch(/opendots-login-/);
    expect(launches[0].env.CODEX_HOME).not.toBe(dirname(profile));
    writeFileSync(join(launches[0].env.CODEX_HOME!, 'auth.json'), good);
    accounts.cancelLogin(account.id);
    children[0].emit('close', 0);
    await new Promise((done) => setTimeout(done, 20));
    expect(readFileSync(profile, 'utf8')).toBe('previous');
    // A current login is promoted.
    accounts.login(account.id);
    writeFileSync(join(launches[1].env.CODEX_HOME!, 'auth.json'), good);
    children[1].emit('close', 0);
    await vi.waitFor(() => expect(readFileSync(profile, 'utf8')).toBe(good));
    expect(existsSync(launches[1].env.CODEX_HOME!)).toBe(false);
  });
});

it('refuses a Copilot System default turn served by a GitHub CLI fallback before any session', async () => {
  const { CopilotTextAdapter } =
    await import('../src/server/harness/copilot-adapter.js');
  const calls: string[] = [];
  const client = {
    start: async () => void calls.push('start'),
    getAuthStatus: async () => ({ isAuthenticated: true, authType: 'gh-cli' }),
    createSession: async () => {
      calls.push('createSession');
      throw new Error('must not be called');
    },
    stop: async () => void calls.push('stop'),
  };
  const chunks: Array<{ type: string; message?: string }> = [];
  for await (const chunk of new CopilotTextAdapter(
    {
      cwd: tmpdir(),
      home: tmpdir(),
      env: {},
      githubToken: null,
      createClient: () => client as never,
    },
    'm',
  ).chatStream({ messages: [{ role: 'user', content: 'hi' }] } as never))
    chunks.push(chunk as never);
  expect(calls).toEqual(['start', 'stop']);
  expect(chunks.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    message: 'harness-error:auth',
  });
});

it('projects only the ordinary active Copilot identity from JSONC state, never tokens', () => {
  const state = parseCopilotState(`// User settings belong in settings.json.
// This file is managed automatically.
{
  "lastLoggedInUser": { "host": "https://github.com", "login": "bob" },
  "loggedInUsers": [{ "host": "https://github.com", "login": "bob" }, { "host": "https://github.com", "login": "bob2" }],
  "copilotTokens": { "https://github.com:bob": "t1", "https://github.com:bob2": "t2" },
  "installedPlugins": [{ "name": "evil" }],
  "trustedFolders": ["/"]
}`);
  expect(state).toEqual({
    lastLoggedInUser: { host: 'https://github.com', login: 'bob' },
    loggedInUsers: [{ host: 'https://github.com', login: 'bob' }],
  });
  expect(parseCopilotState('{"installedPlugins":[]}')).toBeNull();
  expect(parseCopilotState('not json')).toBeNull();
});

it.each([
  [
    {
      isAuthenticated: true,
      authType: 'user',
      login: 'bob',
      host: 'https://github.com',
    },
    true,
  ],
  [
    {
      isAuthenticated: true,
      authType: 'user',
      login: 'bob',
      host: 'github.com',
    },
    true,
  ],
  [
    {
      isAuthenticated: true,
      authType: 'user',
      login: 'bob2',
      host: 'https://github.com',
    },
    false,
  ],
  [
    {
      isAuthenticated: true,
      authType: 'user',
      login: 'bob',
      host: 'https://ghe.example.com',
    },
    false,
  ],
  [
    {
      isAuthenticated: true,
      authType: 'gh-cli',
      login: 'bob',
      host: 'https://github.com',
    },
    false,
  ],
  [{ isAuthenticated: true, authType: 'env', login: 'bob' }, false],
  [{ isAuthenticated: false, authType: 'user', login: 'bob' }, false],
] as const)(
  'accepts only the exact projected Copilot identity: %j → %s',
  (status, ok) => {
    expect(
      copilotNativeLogin(status, { host: 'https://github.com', login: 'bob' }),
    ).toBe(ok);
  },
);
