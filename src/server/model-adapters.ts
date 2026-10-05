import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { PlatformConfig } from './platform-config.js';
import {
  parseClaudePermissionMode,
  resolveModel,
  type ResolvedModel,
} from './models.js';
import {
  assertHarnessRuntime,
  harnessEnvironment,
  HarnessSetupError,
} from './harness-runtime.js';
import type { SandboxHandle } from '@tanstack/ai-sandbox';
export type { ResolvedModel };
import type { HarnessProvider } from '../shared/harness.js';
import type { AccountSnapshot } from './harness/store.js';
import { accountVariables, scrubbedVariables } from './harness/environment.js';
import {
  CLAUDE_ADAPTER_POLICY,
  CLAUDE_WRAPPER,
  claudeWrapperScript,
} from './harness/policy.js';
import { CodexAppServerAdapter } from './harness/codex-app-server.js';
import { copilotText } from './harness/copilot-adapter.js';
import { defaultExec, parseAuthStatus } from './harness/accounts.js';

export function resolveActiveModel(config: PlatformConfig): ResolvedModel {
  return resolveModel({
    provider: config.modelProvider ?? 'openai',
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    anthropicKey: config.anthropicKey,
    anthropicModel: config.anthropicModel,
    anthropicBaseUrl: config.anthropicBaseUrl,
    clineKey: config.clineKey,
    clineModel: config.clineModel,
    clineBaseUrl: config.clineBaseUrl,
    claudeAuthMode: config.claudeAuthMode,
    claudeModel: config.claudeModel,
    claudeCwd: config.claudeCwd,
    claudePermissionMode: config.claudePermissionMode,
    codexAuthMode: config.codexAuthMode,
    codexModel: config.codexModel,
    codexCwd: config.codexCwd,
    modelFallbacks: config.modelFallbacks,
  });
}

export function httpAdapterFor(resolved: ResolvedModel) {
  if (resolved.harness)
    throw new Error(`Model ${resolved.model} needs a harness adapter.`);
  return openaiCompatibleText(resolved.model, {
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    api: 'chat-completions',
    maxRetries: 1,
    ...(resolved.provider === 'anthropic'
      ? {
          defaultHeaders: {
            Authorization: null,
            'x-api-key': resolved.apiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      : {}),
  });
}

/** Legacy helper kept for callers that only need the secret scrub list. */
export function harnessScrubbedEnvironment(): string[] {
  return scrubbedVariables('claude-code');
}

export interface HarnessTurn {
  harness: HarnessProvider;
  model: string;
  account: AccountSnapshot;
  /** Base directory for per-thread scratch directories. */
  cwd: string;
  profileRoot: string;
  /** Claude permission mode is fixed by policy; kept for legacy config validation. */
  claudePermissionMode?: string;
}

const LOGIN_GUIDANCE: Record<
  HarnessProvider,
  { missing: string; login: string }
> = {
  'claude-code': {
    missing:
      'Claude CLI is unavailable. Install Claude Code, run claude auth login on this machine, then retry.',
    login:
      'Claude subscription login is required. Run claude auth login on this machine (or sign in the selected account in Settings), then retry. API-key login is not a subscription.',
  },
  codex: {
    missing:
      'Codex CLI is unavailable. Install Codex, run codex login on this machine, then retry.',
    login:
      'ChatGPT subscription login is required. Run codex login on this machine (or sign in the selected account in Settings), then retry. API-key login is not a subscription.',
  },
  copilot: {
    missing: 'GitHub Copilot CLI is unavailable. Install it, then retry.',
    login:
      'GitHub Copilot login is required. Sign in the selected account in Settings, then retry.',
  },
};

function requireLogin(
  provider: HarnessProvider,
  result: { exitCode: number; stdout: string; stderr: string },
) {
  if (result.exitCode === 127)
    throw new HarnessSetupError(LOGIN_GUIDANCE[provider].missing);
  if (parseAuthStatus(provider, result).status !== 'ready')
    throw new HarnessSetupError(LOGIN_GUIDANCE[provider].login);
}

async function sandboxLogin(
  handle: SandboxHandle,
  provider: 'claude-code',
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  const statusSignal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(signal ? [signal] : []),
  ]);
  // local-process exec subscribes to future aborts only; refuse an already
  // aborted probe before it spawns and never accept partial output after abort.
  statusSignal.throwIfAborted();
  const result = await handle.process
    .exec('claude auth status --json', {
      signal: statusSignal,
      env: {
        ...env,
        ...(process.platform === 'win32' &&
        !process.env.HOME &&
        process.env.USERPROFILE
          ? { HOME: process.env.USERPROFILE }
          : {}),
      },
    })
    .catch(() => {
      throw new HarnessSetupError(
        'The CLI subscription login check could not finish. Check the installed CLI and login on this machine, then retry.',
      );
    });
  statusSignal.throwIfAborted();
  requireLogin(provider, result);
}

function scopeDirectory(
  turn: HarnessTurn,
  scope: { dotId: string; threadId: string },
) {
  const scopeId = createHash('sha256')
    .update(JSON.stringify([turn.harness, scope.dotId, scope.threadId]))
    .digest('hex');
  return { scopeId, dir: join(resolve(turn.cwd), scopeId) };
}

/**
 * Builds the adapter for one harness turn. The account snapshot decides the
 * child profile; the parent's credentials and profile overrides are scrubbed.
 */
export async function harnessAdapterFor(
  turn: HarnessTurn,
  scope: { dotId: string; threadId: string; signal?: AbortSignal },
) {
  assertHarnessRuntime({ provider: turn.harness, ...harnessEnvironment() });
  const managed = turn.account.kind === 'managed';
  const accountEnv = accountVariables(turn.profileRoot, turn.account);
  const scrub = scrubbedVariables(turn.harness, process.env, managed);
  const { scopeId, dir } = scopeDirectory(turn, scope);
  // The SDK serializes thrown errors into events. Keep safe setup guidance
  // separately so no provider error payload needs to be trusted or forwarded.
  let setupError: HarnessSetupError | undefined;
  if (turn.harness === 'codex') {
    scope.signal?.throwIfAborted();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of scrub) delete env[key];
    Object.assign(env, accountEnv);
    const signal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(scope.signal ? [scope.signal] : []),
    ]);
    const result = await Promise.race([
      defaultExec(
        'codex',
        ['login', 'status'],
        { ...env, PWD: dir },
        10_000,
        dir,
        signal,
      ),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
    signal.throwIfAborted();
    requireLogin('codex', result);
    return {
      kind: 'codex' as const,
      adapter: new CodexAppServerAdapter({ cwd: dir, env }, turn.model),
      middleware: [],
      setupError: () => setupError,
    };
  }
  const { defineSandbox, withSandbox } = await import('@tanstack/ai-sandbox');
  const { localProcessSandbox } =
    await import('@tanstack/ai-sandbox-local-process');
  const definition = defineSandbox({
    id: `opendots-${turn.harness}-${scopeId}`,
    workspace: { source: { type: 'none' }, root: '/workspace' },
    provider: localProcessSandbox({
      dir,
      removeOnDestroy: false,
      scrubEnv: scrub,
    }),
    lifecycle: { reuse: 'none', snapshot: 'none', destroyOnComplete: true },
    fileEvents: false,
    hooks: {
      onReady: async (handle) => {
        try {
          if (turn.harness === 'claude-code') {
            await sandboxLogin(handle, 'claude-code', accountEnv, scope.signal);
            await handle.fs.write(
              `/workspace/${CLAUDE_WRAPPER}`,
              claudeWrapperScript(),
            );
            await handle.process.exec(`chmod 700 ${CLAUDE_WRAPPER}`);
          }
        } catch (error) {
          if (error instanceof HarnessSetupError) setupError = error;
          throw error;
        }
      },
    },
  });
  const middleware = [withSandbox(definition)];
  if (turn.harness === 'claude-code') {
    const mod = await import('@tanstack/ai-claude-code');
    return {
      kind: 'claude-code' as const,
      adapter: mod.claudeCodeText(turn.model, {
        cwd: '/workspace',
        authMode: 'host',
        claudeExecutable: `./${CLAUDE_WRAPPER}`,
        env: accountEnv,
        ...CLAUDE_ADAPTER_POLICY,
      }),
      middleware,
      setupError: () => setupError,
    };
  }
  return {
    kind: 'copilot' as const,
    adapter: copilotText(turn.model, { cwd: '/workspace', env: accountEnv }),
    middleware,
    setupError: () => setupError,
  };
}

/** Legacy permission-mode validation is still applied to project config. */
export { parseClaudePermissionMode };
