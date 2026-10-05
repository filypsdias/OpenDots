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
import { realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { harnessAdapterFor } from '../src/server/model-adapters.js';
import { assertHarnessRuntime } from '../src/server/harness-runtime.js';
import { profileDirectory } from '../src/server/harness/environment.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import {
  systemAccountId,
  type HarnessProvider,
} from '../src/shared/harness.js';

type Receipt = {
  provider: HarnessProvider;
  phase: 'auth' | 'turn';
  args: string[];
  cwd: string;
  pid: number;
  homePresent: boolean;
  home?: string;
  present: string[];
  profile: string | null;
  threadStart?: {
    environments: unknown;
    dynamicTools: string[];
    config: Record<string, unknown>;
    approvalPolicy: string;
    allowProviderModelFallback: boolean;
    model: string;
    ephemeral: boolean;
  };
  turnStart?: { environments: unknown };
};
const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
const controllers: Array<{ abortRun(): void }> = [];
const scrubKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'INTELLIGENCE_API_KEY',
  'SLACK_BOT_TOKEN',
  'OPENDOTS_OWNER_TOKEN',
  'BROWSER_SECRET',
  'VARLOCK_TEST',
  '__VARLOCK_ENV',
  '__VARLOCK_RUN',
  'DMNO_TEST',
  'NODE_OPTIONS',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
];

afterEach(async () => {
  controllers.splice(0).forEach((agent) => agent.abortRun());
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllEnvs();
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

async function fixture(
  provider: HarnessProvider,
  options: {
    auth?: 'subscription' | 'api-key' | 'logged-out' | 'missing' | 'hang';
    turn?:
      'complete' | 'error' | 'hang' | 'tools' | 'quota' | 'native' | 'reroute';
    account?: 'system' | 'managed';
    codexVersion?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opendots-harness-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await Promise.all([mkdir(bin), mkdir(home)]);
  const receipts = join(root, 'receipts.jsonl');
  const heartbeat = join(root, 'heartbeat');
  const configFile = join(root, 'fixture.json');
  const bridgeReceipts = join(root, 'bridge.json');
  await writeFile(
    configFile,
    JSON.stringify({
      receipts,
      heartbeat,
      scrubKeys,
      testHome: home,
      bridgeReceipts,
      auth: options.auth ?? 'subscription',
      turn: options.turn ?? 'complete',
      codexVersion: options.codexVersion,
    }),
  );
  const cli = fileURLToPath(
    new URL('./fixtures/fake-harness-cli.mjs', import.meta.url),
  );
  for (const [name, kind] of [
    ['claude', 'claude-code'],
    ['codex', 'codex'],
    ['copilot', 'copilot'],
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
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  // The parent process may itself run under a managed CLI profile (Orca).
  vi.stubEnv('CODEX_HOME', join(root, 'parent-codex-home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'parent-claude-home'));
  vi.stubEnv('COPILOT_HOME', join(root, 'parent-copilot-home'));
  for (const key of scrubKeys)
    vi.stubEnv(
      key,
      key === 'NODE_OPTIONS' ? '--no-warnings' : 'synthetic-secret-for-test',
    );
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const base = workspace.dots()[0];
  const dot = workspace.updateDot(base.id, {
    ...base,
    harness: provider,
    model: MODEL[provider],
  });
  const threadId = '../outside/thread';
  workspace.bindThread(threadId, dot.id, 'Harness fixture');
  const accountMode =
    options.account ?? (provider === 'claude-code' ? 'system' : 'managed');
  const account =
    accountMode === 'managed'
      ? workspace.accounts.add(provider, 'Fixture account')
      : workspace.harness.account(systemAccountId(provider))!;
  workspace.harness.activate(provider, account.id);
  const config: PlatformConfig = {
    intelligenceKey: 'synthetic-intelligence-key',
    apiKey: 'synthetic-api-key',
    model: 'gpt-project-model',
    anthropicKey: 'synthetic-anthropic-key',
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
      { id: 'user', role: 'user', content: 'Reply with a short sentence.' },
    ],
  };
  const readReceipts = async (): Promise<Receipt[]> => {
    const text = await readFile(receipts, 'utf8').catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  };
  const cwdBase = join(root, 'workspaces');
  return {
    root,
    cwdBase,
    bridgeReceipts,
    heartbeat,
    agent,
    store,
    workspace,
    dot,
    account,
    input,
    config,
    readReceipts,
    run: (extra: Partial<RunAgentInput> = {}) =>
      lastValueFrom(agent.run({ ...input, ...extra }).pipe(toArray())),
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

describe.each<HarnessProvider>(['claude-code', 'codex', 'copilot'])(
  '%s local harness subprocess',
  (provider) => {
    it('streams a turn through the conversation route with scrubbed secrets and the selected account', async () => {
      const f = await fixture(provider);
      const events = await f.run();
      expect(errorsOf(events)).toEqual([]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: EventType.RUN_STARTED }),
          expect.objectContaining({ type: EventType.RUN_FINISHED }),
        ]),
      );
      expect(
        events
          .filter(
            (event) =>
              event.type === EventType.TEXT_MESSAGE_CHUNK ||
              event.type === EventType.TEXT_MESSAGE_CONTENT,
          )
          .map((event) => ('delta' in event ? event.delta : ''))
          .join(''),
      ).toBe('Local subscription turn completed.');
      const receipts = (await f.readReceipts()).filter(
        (row) => (row.phase as string) !== 'protocol',
      );
      expect(receipts.map((row) => row.phase)).toEqual(
        provider === 'copilot' ? ['turn'] : ['auth', 'turn'],
      );
      const snapshot = f.workspace.harness.snapshot(f.account.id)!;
      for (const row of receipts) {
        expect(row.present).toEqual([]);
        // System default never inherits the parent's profile override;
        // managed accounts get exactly their private profile.
        expect(row.profile).toBe(
          snapshot.kind === 'managed'
            ? profileDirectory(f.workspace.accounts.root, snapshot)
            : null,
        );
        expect(dirname(realpathSync(row.cwd))).toBe(realpathSync(f.cwdBase));
        expect(row.cwd.slice(-64)).toMatch(/^[a-f0-9]{64}$/);
        await vi.waitFor(() => expect(alive(row.pid)).toBe(false), {
          timeout: 4000,
          interval: 50,
        });
      }
      const [receipt] = f.workspace.harness.receipts(f.input.threadId);
      expect(receipt).toMatchObject({
        harness: provider,
        model: MODEL[provider],
        accountId: f.account.id,
        outcome: 'completed',
        errorKind: null,
      });
      expect(JSON.stringify(events)).not.toMatch(
        /synthetic-secret-for-test|Fixture account|system:|profiles/,
      );
    }, 20_000);

    it('exposes only OpenDots tools and denies native capabilities in the generated CLI configuration', async () => {
      const f = await fixture(provider);
      await f.run();
      const turn = turnsOf(await f.readReceipts())[0];
      if (provider === 'claude-code') {
        expect(turn.args.slice(0, 4)).toEqual([
          '--tools',
          '',
          '--strict-mcp-config',
          '--disable-slash-commands',
        ]);
        expect(turn.args).toEqual(
          expect.arrayContaining([
            '--setting-sources',
            'project',
            '--permission-mode',
            'default',
            '--allowedTools',
            'mcp__tanstack',
            '--model',
            MODEL[provider],
          ]),
        );
        expect(turn.args.join(' ')).not.toMatch(
          /bypassPermissions|acceptEdits|--add-dir|user,project/,
        );
      } else if (provider === 'codex') {
        expect(turn.args[0]).toBe('app-server');
        expect(turn.args).toEqual(
          expect.arrayContaining([
            'features.stable_environment_tools=false',
            'features.shell_tool=false',
            'features.apps=false',
            'features.plugins=false',
            'features.multi_agent=false',
            'mcp_servers={}',
            'web_search="disabled"',
            'model_provider="openai"',
          ]),
        );
        const start = (await f.readReceipts()).find(
          (row) => row.threadStart,
        )!.threadStart!;
        expect(start.environments).toEqual([]);
        expect(start.allowProviderModelFallback).toBe(false);
        expect(start.ephemeral).toBe(true);
        expect(start.approvalPolicy).toBe('never');
        expect(start.model).toBe(MODEL.codex);
        expect(start.config).toMatchObject({
          'features.stable_environment_tools': false,
          mcp_servers: {},
        });
        expect(start.dynamicTools).toEqual(
          expect.arrayContaining(['create_space_page', 'read_space_page']),
        );
        expect(
          (await f.readReceipts()).find((row) => row.turnStart)!.turnStart!
            .environments,
        ).toEqual([]);
      } else {
        const available = turn.args.find((arg) =>
          arg.startsWith('--available-tools='),
        )!;
        expect(
          available
            .split('=')[1]
            .split(',')
            .every((name) => name.startsWith('tanstack-')),
        ).toBe(true);
        expect(available).toContain('tanstack-create_space_page');
        expect(turn.args).toEqual(
          expect.arrayContaining([
            '--disable-builtin-mcps',
            '--no-custom-instructions',
            '--no-ask-user',
            '--allow-tool=tanstack',
            '--deny-tool=shell',
            '--output-format',
            'json',
            '--model',
            MODEL.copilot,
          ]),
        );
        expect(turn.args.join(' ')).not.toMatch(
          /--allow-all|--yolo|--allow-all-tools/,
        );
        // Managed Copilot homes start with all hooks disabled.
        const snapshot = f.workspace.harness.snapshot(f.account.id)!;
        expect(
          JSON.parse(
            await readFile(
              join(
                profileDirectory(f.workspace.accounts.root, snapshot),
                'config.json',
              ),
              'utf8',
            ),
          ),
        ).toEqual({ disableAllHooks: true });
      }
    }, 20_000);

    it('executes authorized page tools inside OpenDots and refuses a foreign Space', async () => {
      const f = await fixture(provider, { turn: 'tools' });
      const events = await f.run();
      expect(errorsOf(events)).toEqual([]);
      expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Bridge-created page',
            content: '# From a real CLI subprocess',
          }),
        ]),
      );
      expect(
        f.workspace.pages
          .list(f.dot.spaceId)
          .some((page) => page.title === 'Forbidden page'),
      ).toBe(false);
      const bridge = JSON.parse(await readFile(f.bridgeReceipts, 'utf8'));
      expect(JSON.stringify(bridge.denied)).toMatch(/revoked|not.*granted/i);
      if (provider === 'codex') {
        expect(bridge.denied.success).toBe(false);
        expect(bridge.allowed.success).toBe(true);
        // Native capability requests are refused by the adapter.
        expect(bridge.nativeApproval.error.message).toMatch(/Not permitted/);
      } else {
        expect(bridge.denied.result).toMatchObject({ isError: true });
        expect(bridge.allowed.result.isError).not.toBe(true);
      }
    }, 20_000);

    it('classifies a quota failure, keeps the receipt and never leaks provider output', async () => {
      const f = await fixture(provider, { turn: 'quota' });
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
        message: expect.stringMatching(
          /usage or quota limit.*Choose an account and continue/,
        ),
      });
      expect(JSON.stringify(events)).not.toMatch(
        /synthetic-api-key|synthetic-secret/,
      );
      expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject({
        outcome: 'failed',
        errorKind: 'quota',
        accountId: f.account.id,
      });
    }, 20_000);

    it('surfaces a generic failed turn without leaking server credentials', async () => {
      const f = await fixture(provider, { turn: 'error' });
      const events = await f.run();
      const errors = errorsOf(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        threadId: f.input.threadId,
        runId: f.input.runId,
        message: expect.stringContaining('subscription CLI could not complete'),
      });
      expect(JSON.stringify(events)).not.toContain('synthetic-secret-for-test');
      expect(JSON.stringify(events)).not.toContain('synthetic-api-key');
      for (const row of await f.readReceipts())
        await vi.waitFor(() => expect(alive(row.pid)).toBe(false), {
          timeout: 4000,
          interval: 50,
        });
    }, 20_000);

    it.each(['pause', 'cancel'] as const)(
      'kills the actual CLI subprocess when the owner requests %s',
      async (action) => {
        const f = await fixture(provider, { turn: 'hang' });
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
        void finished.catch(() => undefined);
        await vi.waitFor(
          async () =>
            expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
          { timeout: 8000, interval: 50 },
        );
        const child = turnsOf(await f.readReceipts())[0];
        expect(alive(child.pid)).toBe(true);
        if (action === 'pause') f.store.updateSettings({ paused: true });
        else f.agent.abortRun();
        await finished;
        await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
          timeout: 5000,
          interval: 50,
        });
        const stopped = await readFile(f.heartbeat, 'utf8');
        await new Promise((done) => setTimeout(done, 120));
        expect(await readFile(f.heartbeat, 'utf8')).toBe(stopped);
        expect(f.workspace.harness.receipts(f.input.threadId)[0].outcome).toBe(
          'cancelled',
        );
      },
      20_000,
    );

    it('keeps the launch account when the global selection changes mid-turn, and uses the new one next turn', async () => {
      const f = await fixture(provider, { turn: 'hang', account: 'managed' });
      const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      void finished.catch(() => undefined);
      await vi.waitFor(
        async () =>
          expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
        { timeout: 8000, interval: 50 },
      );
      const second = f.workspace.accounts.add(provider, 'Second account');
      f.workspace.harness.activate(provider, second.id);
      // The in-flight account cannot be signed out or removed under the turn.
      await expect(f.workspace.accounts.remove(f.account.id)).rejects.toThrow(
        /in use/,
      );
      expect(() => f.workspace.accounts.login(f.account.id)).toThrow(/in use/);
      f.agent.abortRun();
      await finished;
      expect(f.workspace.harness.receipts(f.input.threadId)[0].accountId).toBe(
        f.account.id,
      );
      await f.workspace.accounts.remove(f.account.id);
      expect(f.workspace.harness.activeAccountId(provider)).toBe(second.id);
    }, 20_000);
  },
);

describe.each<'claude-code' | 'codex'>(['claude-code', 'codex'])(
  '%s login preflight',
  (provider) => {
    it('never launches CLI auth after the owner already cancelled', async () => {
      const f = await fixture(provider);
      const controller = new AbortController();
      controller.abort();
      const snapshot = f.workspace.harness.snapshot(f.account.id)!;
      const start = async () => {
        const runtime = await harnessAdapterFor(
          {
            harness: provider,
            model: MODEL[provider],
            account: snapshot,
            cwd: join(f.root, 'workspaces'),
            profileRoot: f.workspace.accounts.root,
          },
          {
            dotId: f.dot.id,
            threadId: f.input.threadId,
            signal: controller.signal,
          },
        );
        if (runtime.kind === 'claude-code') {
          const { chat } = await import('@tanstack/ai');
          for await (const event of chat({
            adapter: runtime.adapter,
            middleware: runtime.middleware,
            messages: [{ role: 'user', content: 'Never launch auth.' }],
          }))
            void event;
        }
      };
      await expect(start()).rejects.toThrow(/abort/i);
      expect(await f.readReceipts()).toEqual([]);
    }, 15_000);

    it.each(['api-key', 'logged-out'] as const)(
      'refuses native %s login even when server API keys are configured',
      async (auth) => {
        const f = await fixture(provider, { auth });
        const events = await f.run();
        expect(errorsOf(events)).toEqual([
          expect.objectContaining({
            message: expect.stringMatching(
              /subscription login is required.*(?:claude auth login|codex login)/i,
            ),
          }),
        ]);
        expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
          'auth',
        ]);
        expect(JSON.stringify(events)).not.toMatch(
          /synthetic-secret|synthetic-api-key/,
        );
        expect(
          f.workspace.harness.receipts(f.input.threadId)[0].errorKind,
        ).toBe('auth');
      },
      15_000,
    );

    it('reports an unavailable native CLI with installation guidance before starting a turn', async () => {
      const f = await fixture(provider, { auth: 'missing' });
      const events = await f.run();
      expect(errorsOf(events)).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/install/i),
        }),
      ]);
      expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
        'auth',
      ]);
      expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
        'missing_cli',
      );
    }, 15_000);

    it('promptly kills a stalled auth preflight when the owner cancels', async () => {
      const f = await fixture(provider, { auth: 'hang' });
      const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
      void finished.catch(() => undefined);
      await vi.waitFor(
        async () =>
          expect(await readFile(f.heartbeat, 'utf8')).toMatch(/^\d+$/),
        { timeout: 8000, interval: 50 },
      );
      const child = (await f.readReceipts())[0];
      f.agent.abortRun();
      await vi.waitFor(() => expect(alive(child.pid)).toBe(false), {
        timeout: 4000,
        interval: 50,
      });
      const events = await finished;
      expect((await f.readReceipts()).map((row) => row.phase)).toEqual([
        'auth',
      ]);
      for (const event of errorsOf(events))
        expect(JSON.stringify(event)).not.toMatch(/synthetic/);
    }, 15_000);
  },
);

describe('codex app-server boundary', () => {
  it('stops the turn when Codex attempts a native tool', async () => {
    const f = await fixture('codex', { turn: 'native' });
    const events = await f.run();
    expect(errorsOf(events)).toHaveLength(1);
    expect(f.workspace.harness.receipts(f.input.threadId)[0]).toMatchObject({
      outcome: 'failed',
    });
  }, 15_000);

  it('treats a model reroute as a model error and requires a new model choice', async () => {
    const f = await fixture('codex', { turn: 'reroute' });
    const events = await f.run();
    expect(errorsOf(events)[0]).toMatchObject({
      message: expect.stringMatching(/Choose a model/),
    });
    expect(f.workspace.requireThread(f.input.threadId).modelRequired).toBe(
      true,
    );
    // The next turn refuses to run until the owner picks a model.
    const next = await f.run({ runId: 'second' });
    expect(errorsOf(next)[0]).toMatchObject({
      message: expect.stringMatching(/Choose a Codex model/),
    });
    expect(turnsOf(await f.readReceipts())).toHaveLength(1);
    f.workspace.setConversationModel(f.input.threadId, 'gpt-other');
    expect(f.workspace.requireThread(f.input.threadId)).toMatchObject({
      model: 'gpt-other',
      modelRequired: false,
      harness: 'codex',
    });
  }, 15_000);

  it('refuses an app-server older than the verified no-environment protocol', async () => {
    const f = await fixture('codex', { codexVersion: '0.120.3' });
    const events = await f.run();
    expect(errorsOf(events)[0]).toMatchObject({
      message: expect.stringMatching(/install or update/i),
    });
    expect((await f.readReceipts()).some((row) => row.threadStart)).toBe(false);
  }, 15_000);
});

describe('copilot model substitution', () => {
  it('stops instead of accepting a silently substituted model', async () => {
    const f = await fixture('copilot', { turn: 'reroute' });
    const events = await f.run();
    expect(errorsOf(events)[0]).toMatchObject({
      message: expect.stringMatching(/Choose a model/),
    });
    expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
      'model',
    );
  }, 15_000);
});

describe('system default account isolation', () => {
  it.each<'codex' | 'copilot'>(['codex', 'copilot'])(
    'refuses the %s system profile instead of loading ambient plugins and hooks',
    async (provider) => {
      const f = await fixture(provider, { account: 'system' });
      const events = await f.run();
      expect(errorsOf(events)[0]).toMatchObject({
        message: expect.stringMatching(/OpenDots-managed account/),
      });
      expect(turnsOf(await f.readReceipts())).toEqual([]);
    },
    15_000,
  );

  it('fails closed when the active account was removed, without falling back', async () => {
    const f = await fixture('codex');
    await f.workspace.accounts.remove(f.account.id);
    const events = await f.run();
    expect(errorsOf(events)[0]).toMatchObject({
      message: expect.stringMatching(/No Codex account is selected/),
    });
    expect(await f.readReceipts()).toEqual([]);
    expect(f.workspace.harness.receipts(f.input.threadId)[0].errorKind).toBe(
      'auth',
    );
  }, 15_000);
});

describe('continuation after quota', () => {
  it('continues once on the newly selected account without duplicating the prompt', async () => {
    const f = await fixture('codex', { turn: 'quota' });
    await f.run();
    const [failed] = f.workspace.harness.receipts(f.input.threadId);
    const next = f.workspace.accounts.add('codex', 'Fresh account');
    f.workspace.harness.activate('codex', next.id);
    f.workspace.harness.armContinuation(f.input.threadId, failed.id);
    await writeFile(
      JSON.parse(
        await readFile(process.env.OPENDOTS_TEST_HARNESS_FIXTURE!, 'utf8'),
      ).receipts,
      '',
    );
    const config = JSON.parse(
      await readFile(process.env.OPENDOTS_TEST_HARNESS_FIXTURE!, 'utf8'),
    );
    await writeFile(
      process.env.OPENDOTS_TEST_HARNESS_FIXTURE!,
      JSON.stringify({ ...config, turn: 'complete' }),
    );
    const events = await f.run({
      runId: 'continued',
      messages: [
        ...f.input.messages,
        { id: 'partial', role: 'assistant', content: 'Half an ans' },
      ],
    });
    expect(errorsOf(events)).toEqual([]);
    const [latest] = f.workspace.harness.receipts(f.input.threadId);
    expect(latest).toMatchObject({
      continuation: true,
      accountId: next.id,
      outcome: 'completed',
    });
    expect(f.workspace.harness.continuation(f.input.threadId)).toBeNull();
    // A second run is an ordinary turn, never another continuation.
    await f.run({ runId: 'third' });
    expect(f.workspace.harness.receipts(f.input.threadId)[0].continuation).toBe(
      false,
    );
  }, 20_000);
});

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
  // Credentials stay server-side: neither the tool list nor the process sees them.
  expect(JSON.stringify(await f.readReceipts())).not.toContain(
    'synthetic-jira-token',
  );
}, 15_000);
