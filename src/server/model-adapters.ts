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
import { assertHarnessRuntime, harnessEnvironment } from './harness-runtime.js';
export type { ResolvedModel };
import type { HarnessProvider } from '../shared/harness.js';
import type { AccountSnapshot } from './harness/store.js';
import { scrubbedVariables } from './harness/environment.js';
import {
  CLAUDE_ADAPTER_POLICY,
  CLAUDE_WRAPPER,
  claudeWrapperScript,
} from './harness/policy.js';
import { CodexAppServerAdapter } from './harness/codex-app-server.js';
import {
  copilotText,
  type CopilotTextConfig,
} from './harness/copilot-adapter.js';
import {
  childEnvironment,
  COPILOT_TOKEN_VARIABLE,
  prepareRuntime,
  type TurnCredential,
} from './harness/runtime.js';
import { sanitizedAdapter } from './harness/errors.js';

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
  /** Resolves the account's credential (never the ambient machine login). */
  credential: () => Promise<TurnCredential>;
  /** Persists refreshed managed Codex tokens (compare-and-swap). */
  onCodexRefresh?: (original: string, refreshed: string) => void;
  /** Test seam for the Copilot SDK client. */
  createCopilotClient?: CopilotTextConfig['createClient'];
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
 * Builds the adapter for one harness turn. Each turn runs with a fresh,
 * empty runtime home and only the account's credential, so no ordinary or
 * Orca profile configuration, plugin, hook, MCP server or instruction loads.
 */
export async function harnessAdapterFor(
  turn: HarnessTurn,
  scope: { dotId: string; threadId: string; signal?: AbortSignal },
) {
  assertHarnessRuntime({ provider: turn.harness, ...harnessEnvironment() });
  scope.signal?.throwIfAborted();
  const credential = await turn.credential();
  scope.signal?.throwIfAborted();
  const runtime = prepareRuntime(turn.profileRoot, credential);
  const dispose = () => {
    const refreshed = runtime.refreshedCodexAuth();
    if (refreshed)
      turn.onCodexRefresh?.(refreshed.original, refreshed.refreshed);
    runtime.dispose();
  };
  const { scopeId, dir } = scopeDirectory(turn, scope);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (credential.provider === 'copilot') {
    const { [COPILOT_TOKEN_VARIABLE]: _token, ...env } = runtime.env;
    void _token;
    return {
      kind: 'copilot' as const,
      adapter: copilotText(turn.model, {
        cwd: dir,
        home: runtime.home,
        // The SDK passes the token to the CLI itself.
        env: childEnvironment({ env, scrub: runtime.scrub }),
        githubToken: credential.githubToken,
        createClient: turn.createCopilotClient,
        signal: scope.signal,
        expectedUser: credential.nativeState?.lastLoggedInUser,
      }),
      middleware: [],
      dispose,
    };
  }
  if (turn.harness === 'codex')
    return {
      kind: 'codex' as const,
      adapter: new CodexAppServerAdapter(
        { cwd: dir, env: childEnvironment(runtime), signal: scope.signal },
        turn.model,
      ),
      middleware: [],
      dispose,
    };
  const { defineSandbox, withSandbox } = await import('@tanstack/ai-sandbox');
  const { localProcessSandbox } =
    await import('@tanstack/ai-sandbox-local-process');
  const definition = defineSandbox({
    id: `opendots-${turn.harness}-${scopeId}`,
    workspace: { source: { type: 'none' }, root: '/workspace' },
    provider: localProcessSandbox({
      dir,
      removeOnDestroy: false,
      scrubEnv: runtime.scrub,
    }),
    lifecycle: { reuse: 'none', snapshot: 'none', destroyOnComplete: true },
    fileEvents: false,
    hooks: {
      onReady: async (handle) => {
        if (turn.harness === 'claude-code') {
          await handle.fs.write(
            `/workspace/${CLAUDE_WRAPPER}`,
            claudeWrapperScript(),
          );
          await handle.process.exec(`chmod 700 ${CLAUDE_WRAPPER}`);
        }
      },
    },
  });
  const middleware = [withSandbox(definition)];
  if (turn.harness === 'claude-code') {
    const mod = await import('@tanstack/ai-claude-code');
    return {
      kind: 'claude-code' as const,
      adapter: sanitizedAdapter(
        mod.claudeCodeText(turn.model, {
          cwd: '/workspace',
          authMode: 'host',
          claudeExecutable: `./${CLAUDE_WRAPPER}`,
          env: runtime.env,
          ...CLAUDE_ADAPTER_POLICY,
        }),
      ),
      middleware,
      dispose,
    };
  }
  throw new Error('Unsupported harness.');
}

/** Legacy permission-mode validation is still applied to project config. */
export { parseClaudePermissionMode };
