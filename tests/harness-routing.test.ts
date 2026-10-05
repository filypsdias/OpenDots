import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { setupStatus } from '../src/server/platform-config.js';
import { resolveTurnRoute } from '../src/server/harness/routing.js';
import {
  accountVariables,
  ensureProfile,
  profileDirectory,
  profileRoot,
  scrubbedVariables,
} from '../src/server/harness/environment.js';
import {
  AccountManager,
  loginPrompt,
  parseAuthStatus,
  parseCodexModels,
  type Exec,
} from '../src/server/harness/accounts.js';
import {
  classifyHarnessFailure,
  safeTurnMessage,
} from '../src/server/harness/errors.js';
import { translateCopilotEvents } from '../src/server/harness/copilot-adapter.js';
import {
  codexAppServerArgs,
  codexErrorText,
  codexVersionSupported,
  dynamicToolSpecs,
} from '../src/server/harness/codex-app-server.js';
import { continuationNote } from '../src/server/harness/continuation.js';
import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { systemAccountId } from '../src/shared/harness.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllEnvs();
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

function workspace() {
  vi.stubEnv('OPENDOTS_PROFILE_ROOT', join(temp(), 'profiles'));
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => ws.close());
  return ws;
}

describe('persistence and migration', () => {
  it('migrates an existing database without breaking HTTP-provider Dots and conversations', () => {
    const path = join(temp(), 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('s1', 'Everyday', '', 1);
      INSERT INTO dots VALUES ('d1', 's1', 'Dot', 'Be helpful.', 1, 1, 1);
      INSERT INTO thread_bindings VALUES ('t1', 'd1', 'owner', 'Old thread', 1);`);
    legacy.close();
    const ws = new WorkspaceStore(path, 'owner');
    cleanup.push(() => ws.close());
    expect(ws.dot('d1')).toMatchObject({ harness: null, model: null });
    expect(ws.requireThread('t1')).toMatchObject({
      harness: null,
      model: null,
      modelRequired: false,
    });
    expect(resolveTurnRoute(ws, httpConfig, 't1')).toMatchObject({
      kind: 'http',
      model: 'gpt-project',
    });
    // Legacy project harness config is honoured through the same resolver.
    expect(
      resolveTurnRoute(
        ws,
        {
          ...httpConfig,
          modelProvider: 'claude-code',
          claudeModel: 'claude-opus-5-5',
        },
        't1',
      ),
    ).toMatchObject({
      kind: 'harness',
      harness: 'claude-code',
      model: 'claude-opus-5-5',
      account: { id: systemAccountId('claude-code'), kind: 'system' },
    });
  });

  it('copies Dot defaults at conversation creation and never moves the harness afterwards', () => {
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
    expect(ws.requireThread('t1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-a',
    });
    expect(ws.requireThread('t2')).toMatchObject({
      harness: 'claude-code',
      model: 'claude-x',
    });
    ws.setConversationModel('t1', 'gpt-b');
    expect(ws.requireThread('t1')).toMatchObject({
      harness: 'codex',
      model: 'gpt-b',
    });
    expect(ws.requireThread('t2').model).toBe('claude-x');
    expect(ws.dot(base.id)).toMatchObject({
      harness: 'claude-code',
      model: 'claude-x',
    });
  });

  it('keeps one active account per provider and clears it when the active account is removed', async () => {
    const ws = workspace();
    expect(ws.harness.activeAccountId('codex')).toBe('system:codex');
    const a = ws.accounts.add('codex', 'Work');
    const b = ws.accounts.add('codex', 'Personal');
    ws.harness.activate('codex', a.id);
    expect(() => ws.harness.activate('claude-code', b.id)).toThrow(/provider/);
    await ws.accounts.remove(a.id);
    expect(ws.harness.activeAccountId('codex')).toBeNull();
    expect(ws.harness.account(b.id)).toBeDefined();
    expect(() => ws.harness.removeAccount(systemAccountId('codex'))).toThrow(
      /cannot be removed/,
    );
  });

  it('records receipts and consumes an armed continuation exactly once', () => {
    const ws = workspace();
    ws.bindThread('t', ws.dots()[0].id, 'T');
    const id = ws.harness.startReceipt({
      threadId: 't',
      runId: 'r',
      harness: 'codex',
      model: 'm',
      account: ws.harness.snapshot('system:codex')!,
      continuation: false,
    });
    ws.harness.recordTools(id, [
      { id: 'c1', name: 'create_space_page', status: 'started' },
    ]);
    ws.harness.finishReceipt(id, 'failed', 'quota');
    ws.harness.finishReceipt(id, 'completed');
    expect(ws.harness.receipts('t')[0]).toMatchObject({
      outcome: 'failed',
      errorKind: 'quota',
    });
    ws.harness.armContinuation('t', id);
    ws.harness.armContinuation('t', id);
    expect(ws.harness.takeContinuation('t')).toBe(id);
    expect(ws.harness.takeContinuation('t')).toBeNull();
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
      'no active account',
      (ws: WorkspaceStore) => {
        const a = ws.accounts.add('codex', 'A');
        ws.harness.activate('codex', a.id);
        ws.harness.removeAccount(a.id);
      },
      /No Codex account is selected/,
    ],
    ['system profile for codex', () => undefined, /OpenDots-managed account/],
  ] as const)('%s', (_name, arrange, message) => {
    const ws = workspace();
    const base = ws.dots()[0];
    ws.updateDot(base.id, { ...base, harness: 'codex', model: 'gpt-a' });
    ws.bindThread('t', base.id, 'T');
    arrange(ws);
    expect(() => resolveTurnRoute(ws, httpConfig, 't')).toThrow(message);
  });

  it('snapshots the account at resolution time', () => {
    const ws = workspace();
    const base = ws.dots()[0];
    ws.updateDot(base.id, { ...base, harness: 'copilot', model: 'm' });
    ws.bindThread('t', base.id, 'T');
    const a = ws.accounts.add('copilot', 'A');
    const b = ws.accounts.add('copilot', 'B');
    ws.harness.activate('copilot', a.id);
    const route = resolveTurnRoute(ws, httpConfig, 't');
    ws.harness.activate('copilot', b.id);
    expect(route.kind === 'harness' && route.account.id).toBe(a.id);
    const next = resolveTurnRoute(ws, httpConfig, 't');
    expect(next.kind === 'harness' && next.account.id).toBe(b.id);
  });
});

describe('profile environment isolation', () => {
  it('keeps profiles outside the repository with private permissions', () => {
    expect(() =>
      profileRoot({ OPENDOTS_PROFILE_ROOT: join(process.cwd(), 'data') }),
    ).toThrow(/outside the OpenDots repository/);
    expect(profileRoot({}, 'darwin', '/Users/someone', '/repo')).toBe(
      '/Users/someone/Library/Application Support/OpenDots/harness-profiles',
    );
    const root = join(temp(), 'profiles');
    const ws = workspace();
    const snapshot = ws.harness.createAccount('codex', 'A');
    const dir = ensureProfile(root, snapshot);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(dirname(dirname(realpathSync(dir)))).toBe(realpathSync(root));
  });

  it('scrubs every provider profile and auth override, then binds only the managed profile', () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/orca/claude',
      CODEX_HOME: '/orca/codex',
      COPILOT_HOME: '/orca/copilot',
      GH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      COPILOT_PROVIDER_BASE_URL: 'x',
      OPENAI_BASE_URL: 'x',
      PATH: '/bin',
    };
    const system = scrubbedVariables('codex', env);
    expect(system).toEqual(
      expect.arrayContaining([
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'COPILOT_HOME',
        'GH_TOKEN',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'COPILOT_PROVIDER_BASE_URL',
        'OPENAI_BASE_URL',
      ]),
    );
    expect(system).not.toContain('PATH');
    expect(scrubbedVariables('codex', env, true)).not.toContain('CODEX_HOME');
    const ws = workspace();
    const managed = ws.harness.createAccount('codex', 'A');
    expect(accountVariables('/root', managed)).toEqual({
      CODEX_HOME: profileDirectory('/root', managed),
    });
    expect(
      accountVariables('/root', ws.harness.snapshot('system:codex')!),
    ).toEqual({});
  });
});

describe('account manager uses native flows with the account environment', () => {
  function manager(
    results: Record<
      string,
      { exitCode: number; stdout?: string; stderr?: string }
    >,
  ) {
    const ws = workspace();
    const calls: Array<{ command: string; args: string[]; profile?: string }> =
      [];
    const exec: Exec = async (command, args, env) => {
      calls.push({
        command,
        args,
        profile: env.CODEX_HOME ?? env.CLAUDE_CONFIG_DIR ?? env.COPILOT_HOME,
      });
      const result = results[`${command} ${args.join(' ')}`] ?? { exitCode: 1 };
      return { stdout: '', stderr: '', ...result };
    };
    const launched: Array<{
      args: string[];
      profile?: string;
      child: EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill(): void;
      };
    }> = [];
    const launch = (
      _command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
    ) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => child.emit('close', 1),
      });
      launched.push({
        args,
        profile: env.CODEX_HOME ?? env.CLAUDE_CONFIG_DIR ?? env.COPILOT_HOME,
        child,
      });
      return child as never;
    };
    const accounts = new AccountManager(
      ws.harness,
      join(temp(), 'profiles'),
      exec,
      launch,
    );
    return { ws, accounts, calls, launched };
  }

  it('logs a managed account in with its private profile and surfaces only URL and code', async () => {
    const { ws, accounts, launched, calls } = manager({
      'codex login status': { exitCode: 0, stderr: 'Logged in using ChatGPT' },
    });
    const account = accounts.add('codex', 'Work');
    const snapshot = ws.harness.snapshot(account.id)!;
    const started = accounts.login(account.id);
    expect(started.account.status).toBe('login_pending');
    expect(launched[0].args).toEqual(['login']);
    expect(launched[0].profile).toBe(profileDirectory(accounts.root, snapshot));
    launched[0].child.stdout.write(
      'Open https://auth.openai.com/oauth/authorize?x=1 and enter ABCD-1234 token=secret-value\n',
    );
    expect(accounts.loginPrompt(account.id)).toEqual({
      url: 'https://auth.openai.com/oauth/authorize?x=1',
      code: 'ABCD-1234',
    });
    launched[0].child.emit('close', 0);
    await vi.waitFor(() =>
      expect(ws.harness.account(account.id)?.status).toBe('ready'),
    );
    expect(calls.at(-1)?.profile).toBe(
      profileDirectory(accounts.root, snapshot),
    );
    expect(() => accounts.login(systemAccountId('codex'))).toThrow(
      /never changes it/,
    );
    await expect(
      accounts.logout(systemAccountId('claude-code')),
    ).rejects.toThrow(/never signs out/);
  });

  it('reads system Claude status without a profile override and marks Codex/Copilot system profiles unsupported', async () => {
    const { ws, accounts, calls } = manager({
      'claude auth status --json': {
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'me@example.invalid',
        }),
      },
    });
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/orca/managed');
    expect(await accounts.refresh('system:claude-code')).toMatchObject({
      status: 'ready',
      identity: 'me@example.invalid',
    });
    expect(calls[0].profile).toBeUndefined();
    expect((await accounts.refresh('system:codex')).status).toBe('unsupported');
    expect((await accounts.refresh('system:copilot')).status).toBe(
      'unsupported',
    );
    expect(ws.harness.account('system:codex')?.status).toBe('unsupported');
  });

  it('discovers Codex models through the machine-readable catalog and caches them per account', async () => {
    const { ws, accounts, calls } = manager({
      'codex debug models': {
        exitCode: 0,
        stdout: JSON.stringify({
          models: [
            { slug: 'gpt-x', display_name: 'GPT X', visibility: 'list' },
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
          ],
        }),
      },
    });
    const account = accounts.add('codex', 'Work');
    ws.harness.activate('codex', account.id);
    const first = await accounts.models('codex');
    expect(first.models[0]).toEqual({
      id: 'gpt-x',
      label: 'GPT X',
      source: 'discovered',
    });
    expect(first.models.some((model) => model.id === 'hidden')).toBe(false);
    await accounts.models('codex');
    expect(calls.filter((call) => call.args[0] === 'debug')).toHaveLength(1);
    expect((await accounts.models('copilot')).discovered).toBe(false);
  });
});

describe('error normalization and redaction', () => {
  it.each([
    ['You have hit your usage limit. Try again later.', 'quota'],
    ['429 Too Many Requests', 'quota'],
    ['usage limit: x', 'quota'],
    ['Model "x" from --model flag is not available.', 'model'],
    ['model_not_found', 'model'],
    ['Not logged in · Please run /login', 'auth'],
    ['unauthorized: token expired', 'auth'],
    ['spawn copilot ENOENT', 'missing_cli'],
    ['Codex CLI must be updated', 'missing_cli'],
    ['segfault', 'unknown'],
  ] as const)('%s → %s', (text, kind) => {
    expect(classifyHarnessFailure(text)).toBe(kind);
  });

  it('produces application-authored messages only', () => {
    for (const kind of [
      'quota',
      'auth',
      'model',
      'missing_cli',
      'unknown',
    ] as const) {
      const message = safeTurnMessage(kind, 'copilot');
      expect(message).not.toMatch(/@|token|\/Users|profile/i);
      expect(message.length).toBeLessThan(300);
    }
    expect(
      codexErrorText({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }),
    ).toMatch(/^usage limit/);
    expect(
      codexErrorText({ message: 'x', codexErrorInfo: 'unauthorized' }),
    ).toMatch(/^unauthorized/);
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
    expect(
      parseAuthStatus('claude-code', {
        exitCode: 0,
        stdout: '{"loggedIn":true,"authMethod":"api_key"}',
        stderr: '',
      }).status,
    ).toBe('login_required');
    expect(parseCodexModels('{"models":[]}')).toEqual([]);
  });
});

describe('protocol translation', () => {
  const ctx = {
    model: 'm',
    runId: 'r',
    threadId: 't',
    genId: (() => {
      let n = 0;
      return () => `g${n++}`;
    })(),
    now: () => 1,
  };
  async function collect(
    events: Array<{ type: string; data?: Record<string, unknown> }>,
  ) {
    const out = [];
    async function* source() {
      yield* events;
    }
    for await (const chunk of translateCopilotEvents(source(), ctx))
      out.push(chunk);
    return out;
  }

  it('maps Copilot JSONL to text and bridged tool events, marking interrupted tools', async () => {
    const out = await collect([
      {
        type: 'assistant.message_delta',
        data: { messageId: 'a', deltaContent: 'Hel' },
      },
      { type: 'assistant.message', data: { messageId: 'a', content: 'Hello' } },
      {
        type: 'tool.execution_start',
        data: {
          toolCallId: 'x',
          toolName: 'tanstack-create_space_page',
          arguments: {},
        },
      },
    ]);
    expect(out.map((chunk) => chunk.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
    expect(out.find((chunk) => chunk.type === 'TOOL_CALL_START')).toMatchObject(
      { toolCallName: 'create_space_page' },
    );
    expect(
      out.find((chunk) => chunk.type === 'TOOL_CALL_RESULT'),
    ).toMatchObject({ content: '{"status":"interrupted"}' });
  });

  it('treats a Copilot model substitution as a model error', async () => {
    const out = await collect([
      {
        type: 'session.error',
        data: { errorType: 'model', message: 'Using "y" instead.' },
      },
      {
        type: 'assistant.message',
        data: { messageId: 'a', content: 'from another model' },
      },
    ]);
    expect(out.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
    expect(
      classifyHarnessFailure(
        String((out.at(-1) as { message?: string }).message),
      ),
    ).toBe('model');
    expect(out.some((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT')).toBe(
      false,
    );
  });

  it('generates the Codex lockdown and dynamic tool specs from real tool definitions', () => {
    const args = codexAppServerArgs();
    expect(args[0]).toBe('app-server');
    expect(args).toContain('features.stable_environment_tools=false');
    expect(args).toContain('notify=[]');
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
    const specs = dynamicToolSpecs([tool, clientOnly as never]);
    expect(specs).toEqual([
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
    expect(codexVersionSupported('codex_cli_rs/1.0.0')).toBe(true);
    expect(codexVersionSupported(undefined)).toBe(false);
  });

  it('builds a continuation note without account details or duplicate requests', () => {
    const note = continuationNote(
      [
        { id: 'u', role: 'user', content: 'Make a page' },
        { id: 'a', role: 'assistant', content: 'Working on' },
        { id: 't', role: 'tool', toolCallId: 'c1', content: '{"pageId":"p1"}' },
      ],
      {
        id: 'r',
        threadId: 't',
        runId: 'x',
        harness: 'codex',
        model: 'm',
        accountId: 'secret-account-id',
        accountLabel: 'Work account',
        outcome: 'failed',
        errorKind: 'quota',
        continuation: false,
        tools: [
          { id: 'c1', name: 'create_space_page', status: 'completed' },
          { id: 'c2', name: 'update_space_page', status: 'unknown' },
        ],
        startedAt: 1,
        finishedAt: 2,
      },
    );
    expect(note).toContain('Working on');
    expect(note).toContain('create_space_page: {"pageId":"p1"}');
    expect(note).toMatch(/outcome is unknown: update_space_page/);
    expect(note).not.toMatch(/secret-account-id|Work account|Make a page/);
  });
});

describe('owner API', () => {
  function api() {
    vi.stubEnv('OPENDOTS_PROFILE_ROOT', join(temp(), 'profiles'));
    const store = new Store(':memory:');
    const ws = new WorkspaceStore(':memory:', 'owner');
    cleanup.push(() => {
      store.close();
      ws.close();
    });
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

  it('manages accounts without exposing profile paths and refuses cross-origin mutation', async () => {
    const { ws, call } = api();
    const created = await call('/api/harness/accounts', 'POST', {
      provider: 'copilot',
      label: 'Work',
    });
    expect(created.status).toBe(201);
    const account = await created.json();
    const listing = JSON.stringify(
      await (
        await call('/api/harness/accounts/' + account.id + '/login')
      ).json(),
    );
    const all = await (await call('/api/harness')).text();
    for (const text of [JSON.stringify(account), listing, all]) {
      expect(text).not.toMatch(/profileKey|harness-profiles|profiles/);
    }
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
  });

  it('validates Dot routing, conversation model changes and explicit continuation', async () => {
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
    const changed = await (
      await call('/api/conversations/t/model', 'PUT', { model: 'gpt-b' })
    ).json();
    expect(changed).toMatchObject({
      harness: 'codex',
      model: 'gpt-b',
      recovery: null,
    });
    expect(
      (
        await call('/api/conversations/t/continue', 'POST', {
          receiptId: 'none',
        })
      ).status,
    ).toBe(409);
    const managed = ws.accounts.add('codex', 'A');
    const receipt = ws.harness.startReceipt({
      threadId: 't',
      runId: 'r',
      harness: 'codex',
      model: 'gpt-b',
      account: ws.harness.snapshot(managed.id)!,
      continuation: false,
    });
    ws.harness.recordTools(receipt, [
      { id: '1', name: 'create_space_page', status: 'completed' },
      { id: '2', name: 'update_space_page', status: 'unknown' },
    ]);
    ws.harness.finishReceipt(receipt, 'failed', 'quota');
    const next = ws.accounts.add('codex', 'B');
    const armed = await (
      await call('/api/conversations/t/continue', 'POST', {
        receiptId: receipt,
        accountId: next.id,
      })
    ).json();
    expect(armed.recovery).toMatchObject({
      kind: 'quota',
      armed: true,
      completedTools: ['create_space_page'],
      unknownTools: ['update_space_page'],
    });
    expect(armed.activeAccount.id).toBe(next.id);
    expect(JSON.stringify(armed)).not.toMatch(/profileKey|profiles/);
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
