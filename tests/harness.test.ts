import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { assertHarnessRuntime } from '../src/server/harness-runtime.js';
import { AccountManager } from '../src/server/harness/accounts.js';
import { fileVault } from '../src/server/harness/credentials.js';
import { profileDirectory } from '../src/server/harness/environment.js';
import type { SdkEvent } from '../src/server/harness/copilot-adapter.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import {
  systemAccountId,
  type HarnessProvider,
} from '../src/shared/harness.js';

type Receipt = {
  provider: HarnessProvider;
  phase: 'turn' | 'protocol';
  args: string[];
  cwd: string;
  pid: number;
  present: string[];
  profile: string | null;
  profileFiles: string[];
  codexRefreshToken: boolean | null;
  claudeToken: boolean | null;
  quiet: string[];
  threadStart?: {
    environments: unknown;
    dynamicTools: string[];
    config: Record<string, unknown>;
    approvalPolicy: string;
    allowProviderModelFallback: boolean;
    model: string;
    ephemeral: boolean;
  };
  turnStart?: { environments: unknown; text: string };
};
type Mode =
  | 'complete'
  | 'error'
  | 'hang'
  | 'tools'
  | 'quota'
  | 'native'
  | 'reroute'
  | 'environment'
  | 'no-environments'
  | 'early-exit'
  | 'early-exit-start'
  | 'mismatch'
  | 'duplicate'
  | 'create-then-quota'
  | 'create-twice';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
const controllers: Array<{ abortRun(): void }> = [];
const SECRET = 'synthetic-secret-for-test';
const CLAUDE_TOKEN = 'sk-ant-oat01-fixturetokenvalue000000000000';
const COPILOT_TOKEN = 'gho_fixture_token_0000000000';
const scrubKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'INTELLIGENCE_API_KEY',
  'SLACK_BOT_TOKEN',
  'BROWSER_SECRET',
  'ORCA_TERMINAL_HANDLE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'COPILOT_AGENT_SESSION_ID',
  'GH_CONFIG_DIR',
  'BASH_ENV',
  '__VARLOCK_ENV',
  'NODE_OPTIONS',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
];

afterEach(async () => {
  controllers.splice(0).forEach((agent) => agent.abortRun());
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (dirname(realpathSync(root)) !== realpathSync(tmpdir()))
      throw new Error('Unexpected test temp directory');
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

function shellQuote(value: string) {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

const MODEL: Record<HarnessProvider, string> = {
  'claude-code': 'fixture-claude-model',
  codex: 'fixture-codex-model',
  copilot: 'fixture-copilot-model',
};

function codexAuth(refreshedDaysAgo = 0) {
  return JSON.stringify({
    tokens: {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      id_token: 'x.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuaW52YWxpZCJ9.y',
    },
    last_refresh: new Date(
      Date.now() - refreshedDaysAgo * 86400_000,
    ).toISOString(),
  });
}

/** In-process fake of the documented @github/copilot-sdk client surface. */
function fakeCopilot(record: Record<string, unknown>, mode: () => Mode) {
  return (options: unknown) => {
    record.options = options;
    return {
      start: async () => undefined,
      stop: async () => {
        record.stopped = true;
      },
      getAuthStatus: async () => ({
        isAuthenticated: true,
        login: 'octo',
        authType: 'token',
      }),
      listModels: async () => [{ id: 'gpt-x', name: 'GPT X' }],
      createSession: async (config: Record<string, unknown>) => {
        record.config = config;
        const handlers: Array<(event: SdkEvent) => void> = [];
        const emit = (type: string, data: Record<string, unknown> = {}) =>
          handlers.forEach((handler) => handler({ type, data }));
        return {
          on: (handler: (event: SdkEvent) => void) => {
            handlers.push(handler);
            return () => undefined;
          },
          send: async ({ prompt }: { prompt: string }) => {
            record.prompt = prompt;
            setTimeout(async () => {
              const current = mode();
              const tools = config.tools as Array<{
                name: string;
                handler: (
                  args: unknown,
                  invocation: { toolCallId: string },
                ) => Promise<string>;
              }>;
              if (current === 'tools') {
                const create = tools.find(
                  (tool) => tool.name === 'create_space_page',
                )!;
                record.denied = await create.handler(
                  {
                    title: 'Forbidden page',
                    content: 'Forbidden',
                    spaceId: 'unowned-space',
                  },
                  { toolCallId: 't1' },
                );
                record.allowed = await create.handler(
                  {
                    title: 'Bridge-created page',
                    content: '# From a real CLI subprocess',
                  },
                  { toolCallId: 't2' },
                );
              }
              if (current === 'quota')
                return emit('session.error', {
                  errorType: 'quota',
                  message: `quota ${SECRET}`,
                });
              if (current === 'error')
                return emit('session.error', {
                  errorType: 'query',
                  message: `boom ${SECRET}`,
                });
              if (current === 'reroute')
                return emit('session.model_change', {
                  newModel: 'other-model',
                });
              if (current === 'hang') return;
              emit('assistant.message_delta', {
                messageId: 'm1',
                deltaContent: 'Local subscription ',
              });
              emit('assistant.message', {
                messageId: 'm1',
                content: 'Local subscription turn completed.',
              });
              emit('session.idle');
            }, 5);
            return 'message-id';
          },
          abort: async () => {
            record.aborted = true;
          },
          disconnect: async () => undefined,
        };
      },
    };
  };
}

async function fixture(
  provider: HarnessProvider,
  options: {
    turn?: Mode;
    account?: 'system' | 'managed';
    codexVersion?: string;
    codexRefresh?: string;
    systemCodexAuth?: string | null;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opendots-harness-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const receipts = join(root, 'receipts.jsonl');
  const heartbeat = join(root, 'heartbeat');
  const configFile = join(root, 'fixture.json');
  const bridgeReceipts = join(root, 'bridge.json');
  const state = {
    receipts,
    heartbeat,
    scrubKeys,
    bridgeReceipts,
    turn: options.turn ?? ('complete' as Mode),
    codexVersion: options.codexVersion,
    codexRefresh: options.codexRefresh,
    claudeToken: CLAUDE_TOKEN,
  };
  const writeState = (patch: Partial<typeof state>) =>
    writeFile(configFile, JSON.stringify(Object.assign(state, patch)));
  await writeState({});
  const cli = fileURLToPath(
    new URL('./fixtures/fake-harness-cli.mjs', import.meta.url),
  );
  for (const [name, kind] of [
    ['claude', 'claude-code'],
    ['codex', 'codex'],
  ]) {
    const shim = join(bin, name);
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} ${kind} "$@"\n`,
    );
    await chmod(shim, 0o755);
  }
  vi.stubEnv(
    'PATH',
    [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
  );
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('OPENDOTS_CONTAINER', 'false');
  vi.stubEnv('OPENDOTS_TEST_HARNESS_FIXTURE', configFile);
  vi.stubEnv('OPENDOTS_PROFILE_ROOT', join(root, 'profiles'));
  // The parent may itself run under Orca/agent-managed CLI profiles.
  vi.stubEnv('CODEX_HOME', join(root, 'parent-codex-home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'parent-claude-home'));
  vi.stubEnv('COPILOT_HOME', join(root, 'parent-copilot-home'));
  for (const key of scrubKeys)
    vi.stubEnv(key, key === 'NODE_OPTIONS' ? '--no-warnings' : SECRET);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const copilot: Record<string, unknown> = {};
  const profiles = join(root, 'profiles');
  const accounts = new AccountManager(workspace.harness, profiles, {
    vault: fileVault(profiles),
    readers: {
      read: async (which) =>
        which === 'claude-code'
          ? { ok: true, secret: CLAUDE_TOKEN, identity: null }
          : which === 'codex' && options.systemCodexAuth !== null
            ? {
                ok: true,
                secret: options.systemCodexAuth ?? codexAuth(),
                identity: null,
              }
            : { ok: false, reason: 'missing' },
    },
    createCopilotClient: fakeCopilot(copilot, () => state.turn) as never,
  });
  workspace.useAccountManager(accounts);
  const base = workspace.dots()[0];
  const dot = workspace.updateDot(base.id, {
    ...base,
    harness: provider,
    model: MODEL[provider],
  });
  const threadId = '../outside/thread';
  workspace.bindThread(threadId, dot.id, 'Harness fixture');
  const mode = options.account ?? 'managed';
  const account =
    mode === 'managed'
      ? accounts.add(provider, 'Fixture account')
      : workspace.harness.account(systemAccountId(provider))!;
  const snapshot = workspace.harness.snapshot(account.id)!;
  if (mode === 'managed') {
    if (provider === 'claude-code')
      await accounts.vault.set(account.id, CLAUDE_TOKEN);
    if (provider === 'copilot')
      await accounts.vault.set(account.id, COPILOT_TOKEN);
    if (provider === 'codex')
      await writeFile(
        join(profileDirectory(profiles, snapshot), 'auth.json'),
        codexAuth(),
        { mode: 0o600 },
      );
  }
  workspace.harness.activate(provider, account.id);
  const config: PlatformConfig = {
    intelligenceKey: 'synthetic-intelligence-key',
    apiKey: 'synthetic-api-key',
    model: 'gpt-project-model',
    modelProvider: 'openai',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    claudeCwd: join(root, 'workspaces'),
    codexCwd: join(root, 'workspaces'),
    copilotCwd: join(root, 'workspaces'),
  };
  const agent = new DotAgent(store, workspace, config, dot.id);
  controllers.push(agent);
  const input: RunAgentInput = {
    threadId,
    runId: 'fixture-run',
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [
      { id: 'user-1', role: 'user', content: 'Reply with a short sentence.' },
    ],
  };
  const readReceipts = async (): Promise<Receipt[]> => {
    const text = await readFile(receipts, 'utf8').catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return {
    root,
    profiles,
    bridgeReceipts,
    heartbeat,
    agent,
    store,
    workspace,
    accounts,
    dot,
    account,
    snapshot,
    copilot,
    input,
    config,
    readReceipts,
    setTurn: (turn: Mode) => writeState({ turn }),
    run: (extra: Partial<RunAgentInput> = {}, runner = agent) =>
      lastValueFrom(runner.run({ ...input, ...extra }).pipe(toArray())),
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const turnsOf = (rows: Receipt[]) => rows.filter((row) => row.phase === 'turn');
const errorsOf = (events: BaseEvent[]) =>
  events.filter((event) => event.type === EventType.RUN_ERROR);
const textOf = (events: BaseEvent[]) =>
  events
    .filter(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CHUNK ||
        event.type === EventType.TEXT_MESSAGE_CONTENT,
    )
    .map((event) => ('delta' in event ? event.delta : ''))
    .join('');
const runtimeDirs = (f: { profiles: string }) =>
  existsSync(join(f.profiles, 'runtime'))
    ? readdirSync(join(f.profiles, 'runtime'))
    : [];

describe.each<HarnessProvider>(['claude-code', 'codex', 'copilot'])(
  '%s local harness',
  (provider) => {
    it.each(['managed', 'system'] as const)(
      'streams a %s-account turn in an isolated runtime home with only the account credential',
      async (account) => {
        const f = await fixture(provider, { account });
        const logs = vi
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);
        const events = await f.run();
        expect(errorsOf(events)).toEqual([]);
        expect(textOf(events)).toBe('Local subscription turn completed.');
        expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject(
          {
            harness: provider,
            model: MODEL[provider],
            accountId: f.account.id,
            outcome: 'completed',
            promptId: 'user-1',
          },
        );
        // The turn's private runtime home is removed afterwards.
        expect(runtimeDirs(f)).toEqual([]);
        expect(JSON.stringify(events)).not.toMatch(
          /synthetic-secret|fixture-access|sk-ant|gho_/,
        );
        expect(JSON.stringify(logs.mock.calls)).not.toMatch(
          /synthetic-secret|sk-ant|gho_/,
        );
        if (provider === 'copilot') {
          const options = f.copilot.options as Record<string, unknown>;
          const env = options.env as Record<string, string | undefined>;
          // No inherited value survives; GH_CONFIG_DIR is the empty runtime one.
          expect(
            scrubKeys.filter(
              (key) => env[key] === SECRET || env[key] === '--no-warnings',
            ),
          ).toEqual([]);
          expect(env.GH_CONFIG_DIR).toMatch(/runtime\/copilot-.*\/gh$/);
          expect(env.COPILOT_HOME).toBeDefined();
          expect(options.baseDirectory).toMatch(/runtime\/copilot-/);
          if (account === 'managed')
            expect(options).toMatchObject({
              gitHubToken: COPILOT_TOKEN,
              useLoggedInUser: false,
            });
          else {
            expect(options).toMatchObject({ useLoggedInUser: true });
            expect(options).not.toHaveProperty('gitHubToken');
          }
          return;
        }
        const rows = turnsOf(await f.readReceipts());
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row.present).toEqual([]);
        // Never the parent's (Orca) profile; a fresh empty runtime home.
        expect(row.profile).toMatch(new RegExp(`runtime/${provider}-`));
        expect(row.quiet).toContain('DISABLE_TELEMETRY');
        if (provider === 'claude-code') {
          expect(row.claudeToken).toBe(true);
          expect(row.quiet).toContain('CLAUDE_CODE_DISABLE_CLAUDE_MDS');
          expect(row.profileFiles).toEqual([]);
        } else {
          expect(row.profileFiles).toEqual(['auth.json']);
          // System default snapshots cannot refresh (rotate) the ordinary login.
          expect(row.codexRefreshToken).toBe(account === 'managed');
        }
        expect(dirname(realpathSync(row.cwd))).toBe(
          realpathSync(join(f.root, 'workspaces')),
        );
        await vi.waitFor(() => expect(alive(row.pid)).toBe(false), {
          timeout: 4000,
          interval: 50,
        });
      },
      20_000,
    );

    it('exposes only OpenDots tools and denies ambient configuration in the generated harness configuration', async () => {
      const f = await fixture(provider);
      await f.run();
      if (provider === 'claude-code') {
        const [row] = turnsOf(await f.readReceipts());
        expect(row.args.slice(0, 4)).toEqual([
          '--tools',
          '',
          '--strict-mcp-config',
          '--disable-slash-commands',
        ]);
        const sources = row.args.indexOf('--setting-sources');
        // No user, project or local settings: ancestor hooks cannot load.
        expect(row.args[sources + 1]).toBe('');
        expect(row.args).toEqual(
          expect.arrayContaining([
            '--permission-mode',
            'default',
            '--allowedTools',
            'mcp__tanstack',
            '--model',
            MODEL[provider],
          ]),
        );
        expect(row.args.join(' ')).not.toMatch(
          /bypassPermissions|acceptEdits|--add-dir/,
        );
      } else if (provider === 'codex') {
        const rows = await f.readReceipts();
        const [row] = turnsOf(rows);
        expect(row.args).toEqual(
          expect.arrayContaining([
            'app-server',
            'features.stable_environment_tools=false',
            'features.shell_tool=false',
            'features.apps=false',
            'features.plugins=false',
            'features.multi_agent=false',
            'mcp_servers={}',
            'hooks={}',
            'web_search="disabled"',
            'model_provider="openai"',
          ]),
        );
        const start = rows.find((item) => item.threadStart)!.threadStart!;
        expect(start).toMatchObject({
          environments: [],
          allowProviderModelFallback: false,
          ephemeral: true,
          approvalPolicy: 'never',
          model: MODEL.codex,
        });
        expect(start.dynamicTools).toEqual(
          expect.arrayContaining(['create_space_page', 'read_space_page']),
        );
        expect(
          rows.find((item) => item.turnStart)!.turnStart!.environments,
        ).toEqual([]);
      } else {
        const config = f.copilot.config as Record<string, unknown>;
        const tools = config.tools as Array<{ name: string }>;
        expect(config.availableTools).toEqual(tools.map((tool) => tool.name));
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(['create_space_page', 'read_space_page']),
        );
        expect(config).toMatchObject({
          model: MODEL.copilot,
          enableConfigDiscovery: false,
          skipCustomInstructions: true,
          enableSkills: false,
          enableFileHooks: false,
          enableSessionTelemetry: false,
          enableHostGitOperations: false,
          mcpServers: {},
          mcpOAuthTokenStorage: 'in-memory',
        });
        const deny = (config.onPermissionRequest as () => { kind: string })();
        expect(deny.kind).toBe('denied-by-rules');
      }
    }, 20_000);

    it('executes authorized page tools inside OpenDots and refuses a foreign Space', async () => {
      const f = await fixture(provider, { turn: 'tools' });
      const events = await f.run();
      expect(errorsOf(events)).toEqual([]);
      const pages = f.workspace.pages.list(f.dot.spaceId);
      expect(
        pages.filter((page) => page.title === 'Bridge-created page'),
      ).toHaveLength(1);
      expect(pages.some((page) => page.title === 'Forbidden page')).toBe(false);
      const denied =
        provider === 'copilot'
          ? f.copilot.denied
          : JSON.parse(await readFile(f.bridgeReceipts, 'utf8')).denied;
      expect(JSON.stringify(denied)).toMatch(/revoked|not.*granted/i);
      if (provider === 'codex')
        expect(
          JSON.parse(await readFile(f.bridgeReceipts, 'utf8')).nativeApproval
            .error.message,
        ).toMatch(/Not permitted/);
    }, 20_000);

    it('classifies a quota failure at the adapter boundary without leaking provider text', async () => {
      const f = await fixture(provider, { turn: 'quota' });
      const logs = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const warns = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const events = await f.run();
      const errors = errorsOf(events);
      expect(errors).toHaveLength(1);
      expect(Object.keys(errors[0]).sort()).toEqual([
        'message',
        'runId',
        'threadId',
        'type',
      ]);
      expect(errors[0]).toMatchObject({
        message: expect.stringMatching(/usage or quota limit/),
      });
      const captured = JSON.stringify([
        events,
        logs.mock.calls,
        warns.mock.calls,
      ]);
      expect(captured).not.toMatch(
        /synthetic-api-key|synthetic-secret|usage limit synthetic/,
      );
      expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject({
        outcome: 'failed',
        errorKind: 'quota',
      });
    }, 20_000);

    it('surfaces a generic failure without leaking credentials', async () => {
      const f = await fixture(provider, { turn: 'error' });
      const logs = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const events = await f.run();
      expect(errorsOf(events)).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(
            'subscription CLI could not complete',
          ),
        }),
      ]);
      expect(JSON.stringify([events, logs.mock.calls])).not.toMatch(
        /synthetic-secret|synthetic-api-key/,
      );
    }, 20_000);

    it('keeps the launch account when the global selection changes mid-turn and protects it from removal', async () => {
      const f = await fixture(provider, { turn: 'hang' });
      const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      void finished.catch(() => undefined);
      await vi.waitFor(
        () => expect(f.workspace.harness.isLive(f.input.threadId)).toBe(true),
        { timeout: 8000, interval: 20 },
      );
      if (provider !== 'copilot')
        await vi.waitFor(
          async () => expect(turnsOf(await f.readReceipts())).toHaveLength(1),
          { timeout: 8000, interval: 50 },
        );
      else
        await vi.waitFor(() => expect(f.copilot.prompt).toBeDefined(), {
          timeout: 8000,
          interval: 20,
        });
      const second = f.accounts.add(provider, 'Second account');
      f.workspace.harness.activate(provider, second.id);
      await expect(f.accounts.remove(f.account.id)).rejects.toThrow(/in use/);
      await expect(f.accounts.logout(f.account.id)).rejects.toThrow(/in use/);
      expect(() => f.accounts.login(f.account.id)).toThrow(/in use/);
      // One live turn per conversation, for every entry point.
      const concurrent = await f.run({ runId: 'concurrent' }, f.agent.clone());
      expect(errorsOf(concurrent)[0]).toMatchObject({
        message: expect.stringMatching(/already running/),
      });
      f.agent.abortRun();
      await finished;
      expect(
        f.workspace.harness
          .receipts(f.input.threadId)
          .find((receipt) => receipt.runId === 'fixture-run'),
      ).toMatchObject({ accountId: f.account.id, outcome: 'cancelled' });
      if (provider !== 'copilot')
        for (const row of turnsOf(await f.readReceipts()))
          await vi.waitFor(() => expect(alive(row.pid)).toBe(false), {
            timeout: 5000,
            interval: 50,
          });
      else expect(f.copilot.aborted).toBe(true);
      await f.accounts.remove(f.account.id);
      expect(f.workspace.harness.activeAccountId(provider)).toBe(second.id);
    }, 20_000);

    it('fails closed with sign-in guidance after sign-out, and refresh never resurrects it', async () => {
      const f = await fixture(provider);
      await f.accounts.logout(f.account.id);
      const events = await f.run();
      expect(errorsOf(events)[0]).toMatchObject({
        message: expect.stringMatching(/sign.in/i),
      });
      expect(turnsOf(await f.readReceipts())).toEqual([]);
      expect(f.copilot.prompt).toBeUndefined();
      expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
        'auth',
      );
      expect((await f.accounts.refresh(f.account.id)).status).toBe(
        'login_required',
      );
    }, 15_000);
  },
);

describe('codex app-server boundary', () => {
  it.each(['environment', 'no-environments'] as const)(
    'refuses to run when the thread does not confirm an empty environment list (%s)',
    async (turn) => {
      const f = await fixture('codex', { turn });
      expect(errorsOf(await f.run())).toHaveLength(1);
      expect((await f.readReceipts()).some((row) => row.turnStart)).toBe(false);
    },
    15_000,
  );

  it.each(['early-exit', 'early-exit-start'] as const)(
    'treats a zero exit before turn completion as failure (%s)',
    async (turn) => {
      const f = await fixture('codex', { turn });
      const events = await f.run();
      expect(errorsOf(events)).toHaveLength(1);
      expect(
        events.some((event) => event.type === EventType.RUN_FINISHED),
      ).toBe(false);
      expect(f.workspace.harness.receipts(f.input.threadId)[0].outcome).toBe(
        'failed',
      );
    },
    15_000,
  );

  it('rejects notifications for another thread', async () => {
    const f = await fixture('codex', { turn: 'mismatch' });
    const events = await f.run();
    expect(errorsOf(events)).toHaveLength(1);
    expect(textOf(events)).not.toContain('leak');
  }, 15_000);

  it('refuses a repeated tool call ID, executing the action once', async () => {
    const f = await fixture('codex', { turn: 'duplicate' });
    expect(errorsOf(await f.run())).toHaveLength(1);
    expect(
      f.workspace.pages
        .list(f.dot.spaceId)
        .filter((page) => page.title === 'Bridge-created page'),
    ).toHaveLength(1);
  }, 15_000);

  it('stops the turn when Codex attempts a native tool', async () => {
    const f = await fixture('codex', { turn: 'native' });
    expect(errorsOf(await f.run())).toHaveLength(1);
  }, 15_000);

  it('treats a model reroute as a model error and requires a new model choice', async () => {
    const f = await fixture('codex', { turn: 'reroute' });
    expect(errorsOf(await f.run())[0]).toMatchObject({
      message: expect.stringMatching(/Choose a model/),
    });
    expect(f.workspace.requireThread(f.input.threadId).modelRequired).toBe(
      true,
    );
    const next = await f.run({ runId: 'second' });
    expect(errorsOf(next)[0]).toMatchObject({
      message: expect.stringMatching(/Choose a Codex model/),
    });
    f.workspace.setConversationModel(f.input.threadId, 'gpt-other');
    expect(f.workspace.requireThread(f.input.threadId)).toMatchObject({
      model: 'gpt-other',
      modelRequired: false,
      harness: 'codex',
    });
  }, 15_000);

  it('refuses an app-server older than the verified protocol', async () => {
    const f = await fixture('codex', { codexVersion: '0.120.3' });
    expect(errorsOf(await f.run())[0]).toMatchObject({
      message: expect.stringMatching(/install or update/i),
    });
    expect((await f.readReceipts()).some((row) => row.threadStart)).toBe(false);
  }, 15_000);

  it('persists refreshed tokens for managed accounts only', async () => {
    const refreshed = codexAuth().replace('fixture-access', 'refreshed-access');
    const managed = await fixture('codex', { codexRefresh: refreshed });
    await managed.run();
    expect(
      await readFile(
        join(profileDirectory(managed.profiles, managed.snapshot), 'auth.json'),
        'utf8',
      ),
    ).toBe(refreshed);
    const system = await fixture('codex', {
      account: 'system',
      codexRefresh: refreshed,
    });
    await system.run();
    expect(existsSync(join(system.profiles, 'codex'))).toBe(false);
  }, 20_000);

  it('asks for sign-in instead of running without an ordinary login', async () => {
    const f = await fixture('codex', {
      account: 'system',
      systemCodexAuth: null,
    });
    expect(errorsOf(await f.run())[0]).toMatchObject({
      message: expect.stringMatching(/sign.in/i),
    });
    expect(turnsOf(await f.readReceipts())).toEqual([]);
  }, 15_000);

  it('keeps tool activity in the next turn prompt', async () => {
    const f = await fixture('codex');
    await f.run({
      runId: 'later',
      messages: [
        { id: 'u1', role: 'user', content: 'Make a page' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'create_space_page',
                arguments: '{"title":"Plan"}',
              },
            },
          ],
        },
        {
          id: 't1',
          role: 'tool',
          toolCallId: 'call-1',
          content: '{"id":"page-42"}',
        },
        { id: 'a2', role: 'assistant', content: 'Created it.' },
        { id: 'u2', role: 'user', content: 'Now link it' },
      ],
    });
    const text = (await f.readReceipts()).find((row) => row.turnStart)!
      .turnStart!.text;
    expect(text).toContain(
      'Assistant called tool create_space_page with {"title":"Plan"}',
    );
    expect(text).toContain('Tool result (create_space_page): {"id":"page-42"}');
    expect(text).toMatch(/Now link it$/);
  }, 15_000);
});

describe('copilot model substitution', () => {
  it('stops instead of accepting a model the owner did not choose', async () => {
    const f = await fixture('copilot', { turn: 'reroute' });
    expect(errorsOf(await f.run())[0]).toMatchObject({
      message: expect.stringMatching(/Choose a model/),
    });
    expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
      'model',
    );
  }, 15_000);
});

describe('durable tool journal across quota switch-and-continue', () => {
  it('never repeats a completed mutation and binds continuation to the unanswered message', async () => {
    const f = await fixture('codex', { turn: 'create-then-quota' });
    const first = await f.run();
    expect(errorsOf(first)[0]).toMatchObject({
      message: expect.stringMatching(/quota/),
    });
    const [failed] = f.workspace.harness.receipts(f.input.threadId);
    expect(failed).toMatchObject({ errorKind: 'quota', promptId: 'user-1' });
    const next = f.accounts.add('codex', 'Fresh account');
    await writeFile(
      join(
        profileDirectory(f.profiles, f.workspace.harness.snapshot(next.id)!),
        'auth.json',
      ),
      codexAuth(),
    );
    f.workspace.harness.activate('codex', next.id);
    f.workspace.harness.armContinuation(f.input.threadId, failed.id);
    // After the switch the model tries the same create twice.
    await f.setTurn('create-twice');
    const continued = await f.run({ runId: 'continued' });
    expect(errorsOf(continued)).toEqual([]);
    const pages = f.workspace.pages
      .list(f.dot.spaceId)
      .filter((page) => page.title === 'Bridge-created page');
    expect(pages).toHaveLength(1);
    const results = (await readFile(f.bridgeReceipts, 'utf8'))
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line));
    const ids = results.map(
      (call: { result: { contentItems: Array<{ text: string }> } }) =>
        JSON.parse(call.result.contentItems[0].text).id,
    );
    expect(new Set(ids)).toEqual(new Set([pages[0].id]));
    expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject({
      continuation: true,
      accountId: next.id,
      outcome: 'completed',
    });
    expect(f.workspace.harness.continuation(f.input.threadId)).toBeNull();
  }, 30_000);

  it('discards a stale continuation when a new user message arrives', async () => {
    const f = await fixture('codex', { turn: 'quota' });
    await f.run();
    const [failed] = f.workspace.harness.receipts(f.input.threadId);
    f.workspace.harness.armContinuation(f.input.threadId, failed.id);
    await f.setTurn('complete');
    await f.run({
      runId: 'new-message',
      messages: [
        ...f.input.messages,
        { id: 'user-2', role: 'user', content: 'Something else' },
      ],
    });
    expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject({
      continuation: false,
      promptId: 'user-2',
    });
    expect(f.workspace.harness.continuation(f.input.threadId)).toBeNull();
  }, 20_000);

  it('keeps an armed continuation when the retry fails before the provider starts', async () => {
    const f = await fixture('codex', { turn: 'quota' });
    await f.run();
    const [failed] = f.workspace.harness.receipts(f.input.threadId);
    f.workspace.harness.armContinuation(f.input.threadId, failed.id);
    await f.accounts.logout(f.account.id);
    await f.run({ runId: 'auth-failure' });
    expect(f.workspace.harness.continuation(f.input.threadId)).toMatchObject({
      receiptId: failed.id,
    });
  }, 20_000);
});

it('keeps the read-only Jira tool available to harness Dots that are granted Jira', async () => {
  const f = await fixture('codex');
  const agent = new DotAgent(
    f.store,
    f.workspace,
    {
      ...f.config,
      jiraCloudId: 'cloud',
      jiraEmail: 'owner@example.invalid',
      jiraApiToken: 'synthetic-jira-token',
      jiraSiteUrl: 'https://example.atlassian.net',
      jiraDotId: f.dot.id,
    },
    f.dot.id,
  );
  controllers.push(agent);
  await lastValueFrom(agent.run(f.input).pipe(toArray()));
  const start = (await f.readReceipts()).find(
    (row) => row.threadStart,
  )!.threadStart!;
  expect(start.dynamicTools).toContain('list_my_jira_issues');
  expect(JSON.stringify(await f.readReceipts())).not.toContain(
    'synthetic-jira-token',
  );
}, 15_000);

it.each([
  {
    nodeEnv: 'production',
    host: '127.0.0.1',
    container: false,
    platform: 'linux',
  },
  {
    nodeEnv: 'development',
    host: '0.0.0.0',
    container: false,
    platform: 'darwin',
  },
  {
    nodeEnv: 'production',
    host: '127.0.0.1',
    container: true,
    platform: 'darwin',
  },
] as const)('rejects unsafe harness runtime %j', (environment) => {
  for (const provider of ['claude-code', 'codex', 'copilot'] as const)
    expect(() => assertHarnessRuntime({ provider, ...environment })).toThrow(
      /loopback host/,
    );
  expect(() =>
    assertHarnessRuntime({ provider: 'openai', ...environment }),
  ).not.toThrow();
});

it('allows the built app on macOS loopback outside containers', () => {
  expect(() =>
    assertHarnessRuntime({
      provider: 'codex',
      nodeEnv: 'production',
      host: '127.0.0.1',
      container: false,
      platform: 'darwin',
    }),
  ).not.toThrow();
});

describe('cancellation and isolation regressions', () => {
  it('keeps different Dots and threads in distinct scratch directories even with path traversal IDs', async () => {
    const f = await fixture('codex');
    await f.run();
    const secondThread = '../../outside/second';
    f.workspace.bindThread(secondThread, f.dot.id, 'Second thread');
    await f.run({ threadId: secondThread, runId: 'run-2' });
    const rows = turnsOf(await f.readReceipts());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.cwd)).size).toBe(2);
    for (const row of rows) {
      expect(dirname(realpathSync(row.cwd))).toBe(
        realpathSync(join(f.root, 'workspaces')),
      );
      expect(row.cwd.slice(-64)).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 20_000);

  it('kills the Codex app-server when the owner pauses all Dots', async () => {
    const f = await fixture('codex', { turn: 'hang' });
    const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    void finished.catch(() => undefined);
    await vi.waitFor(
      async () => expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
      { timeout: 8000, interval: 50 },
    );
    const [child] = turnsOf(await f.readReceipts());
    f.store.updateSettings({ paused: true });
    await finished;
    await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
      timeout: 5000,
      interval: 50,
    });
  }, 20_000);

  it('stops during Codex initialization without ever starting a turn', async () => {
    const f = await fixture('codex', { turn: 'hang-initialize' as Mode });
    const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    void finished.catch(() => undefined);
    await vi.waitFor(
      async () =>
        expect(
          (await f.readReceipts()).some(
            (row) => (row as { initializeOnly?: boolean }).initializeOnly,
          ),
        ).toBe(true),
      { timeout: 8000, interval: 50 },
    );
    const [child] = turnsOf(await f.readReceipts());
    f.agent.abortRun();
    await finished;
    await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
      timeout: 5000,
      interval: 50,
    });
    expect((await f.readReceipts()).some((row) => row.threadStart)).toBe(false);
  }, 20_000);

  it('reports a missing Codex CLI with installation guidance', async () => {
    const f = await fixture('codex');
    vi.stubEnv(
      'PATH',
      [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    );
    const events = await f.run();
    expect(errorsOf(events)[0]).toMatchObject({
      message: expect.stringMatching(/not installed/),
    });
    expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
      'missing_cli',
    );
  }, 15_000);

  it('never spawns Codex or starts Copilot for an already-cancelled turn', async () => {
    const { CodexAppServerAdapter } =
      await import('../src/server/harness/codex-app-server.js');
    const { CopilotTextAdapter } =
      await import('../src/server/harness/copilot-adapter.js');
    const controller = new AbortController();
    controller.abort();
    const spawnProcess = vi.fn();
    const createClient = vi.fn();
    const drain = async (stream: AsyncIterable<{ type: string }>) => {
      const types: string[] = [];
      for await (const chunk of stream) types.push(chunk.type);
      return types;
    };
    const options = {
      messages: [{ role: 'user', content: 'hi' }],
      abortController: controller,
    } as never;
    expect(
      await drain(
        new CodexAppServerAdapter(
          { cwd: tmpdir(), env: {}, spawnProcess: spawnProcess as never },
          'm',
        ).chatStream(options),
      ),
    ).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(
      await drain(
        new CopilotTextAdapter(
          {
            cwd: tmpdir(),
            home: tmpdir(),
            env: {},
            githubToken: 't',
            createClient,
          },
          'm',
        ).chatStream(options),
      ),
    ).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('never creates a Copilot session or sends after cancellation during startup, and ignores idle before send', async () => {
    const { CopilotTextAdapter } =
      await import('../src/server/harness/copilot-adapter.js');
    let releaseStart: () => void = () => undefined;
    const calls: string[] = [];
    const client = {
      start: () => {
        calls.push('start');
        return new Promise<void>((done) => (releaseStart = done));
      },
      createSession: async () => {
        calls.push('createSession');
        throw new Error('must not be called');
      },
      stop: async () => calls.push('stop'),
    };
    const controller = new AbortController();
    const stream = new CopilotTextAdapter(
      {
        cwd: tmpdir(),
        home: tmpdir(),
        env: {},
        githubToken: 't',
        createClient: () => client as never,
      },
      'm',
    ).chatStream({
      messages: [{ role: 'user', content: 'hi' }],
      abortController: controller,
    } as never);
    const types: string[] = [];
    const done = (async () => {
      for await (const chunk of stream) types.push(chunk.type);
    })();
    await vi.waitFor(() => expect(calls).toContain('start'));
    controller.abort();
    releaseStart();
    await done;
    expect(calls).toEqual(['start', 'stop']);
    expect(types.at(-1)).toBe('RUN_ERROR');

    // A session that reports idle before the prompt is sent is not a success.
    const events: string[] = [];
    let sent = false;
    const idleFirst = {
      start: async () => undefined,
      stop: async () => undefined,
      createSession: async () => {
        const handlers: Array<(event: SdkEvent) => void> = [];
        return {
          on: (handler: (event: SdkEvent) => void) => {
            handlers.push(handler);
            handler({ type: 'session.idle' });
            return () => undefined;
          },
          send: async () => {
            sent = true;
            setTimeout(() => {
              handlers.forEach((h) =>
                h({
                  type: 'assistant.message',
                  data: { messageId: 'a', content: 'ok' },
                }),
              );
              handlers.forEach((h) => h({ type: 'session.idle' }));
            }, 5);
            return 'id';
          },
          abort: async () => undefined,
          disconnect: async () => undefined,
        };
      },
    };
    for await (const chunk of new CopilotTextAdapter(
      {
        cwd: tmpdir(),
        home: tmpdir(),
        env: {},
        githubToken: 't',
        createClient: () => idleFirst as never,
      },
      'm',
    ).chatStream({ messages: [{ role: 'user', content: 'hi' }] } as never))
      events.push(chunk.type);
    expect(sent).toBe(true);
    expect(events).toContain('TEXT_MESSAGE_CONTENT');
    expect(events.at(-1)).toBe('RUN_FINISHED');
  });

  it('starts the Copilot runtime with remote export disabled', async () => {
    const f = await fixture('copilot');
    await f.run();
    const options = f.copilot.options as {
      connection: { kind: string; args: string[] };
    };
    expect(options.connection).toMatchObject({ kind: 'stdio' });
    expect(options.connection.args).toContain('--no-remote-export');
  }, 15_000);
});
