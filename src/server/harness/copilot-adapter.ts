import { EventType, normalizeSystemPrompts } from '@tanstack/ai';
import type { AdapterYieldChunk, TextOptions, Tool } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import {
  CopilotClient,
  RuntimeConnection,
  defineTool,
  type SessionConfig,
  type CopilotClientOptions,
} from '@github/copilot-sdk';
import { z } from 'zod';
import { conversationPrompt } from './prompt.js';
import { sanitizeChunk } from './errors.js';

/**
 * GitHub Copilot runs through the official @github/copilot-sdk over the
 * locally installed `copilot` executable. The SDK's documented session
 * options replace undocumented CLI flags and JSONL parsing:
 * - auth: explicit `gitHubToken` with `useLoggedInUser: false`, so stored
 *   logins, the keychain and gh fallback are never consulted;
 * - tools: OpenDots tools are SDK custom tools whose handlers run here, and
 *   `availableTools` lists only them, so no built-in tool is visible;
 * - ambient state: config discovery, custom instructions, skills, file hooks,
 *   MCP servers, session store, telemetry and host git operations are off.
 */
export interface CopilotTextConfig {
  cwd: string;
  /** Private runtime home (COPILOT_HOME / configDirectory). */
  home: string;
  env: Record<string, string | undefined>;
  /** Managed: explicit token. null: Copilot's own logged-in user (System). */
  githubToken: string | null;
  executable?: string;
  /** Test seam: a fake SDK client implementing the same surface. */
  createClient?: (options: CopilotClientOptions) => SdkClient;
  /** Outer turn cancellation (owner stop, pause, permission change). */
  signal?: AbortSignal;
  /** System default: the projected ordinary active user that must answer. */
  expectedUser?: { host: string; login: string };
}

export type SdkEvent = { type: string; data?: Record<string, unknown> };
export type SdkSession = {
  on(handler: (event: SdkEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};
export type SdkClient = {
  start(): Promise<void>;
  getAuthStatus?(): Promise<{ isAuthenticated: boolean; authType?: string }>;
  createSession(config: SessionConfig): Promise<SdkSession>;
  stop(): Promise<unknown>;
};

/** Copilot SDK client options for one turn. */
export function copilotClientOptions(
  config: CopilotTextConfig,
): CopilotClientOptions {
  return {
    connection: RuntimeConnection.forStdio({
      path: config.executable ?? 'copilot',
      // The SDK adds --headless/--no-auto-update; remote export is separate.
      args: ['--no-remote-export'],
    }),
    // Managed: only this token (no stored login, keychain or gh fallback).
    // System default: Copilot resolves its own ordinary login read-only.
    ...(config.githubToken
      ? { gitHubToken: config.githubToken, useLoggedInUser: false }
      : { useLoggedInUser: true }),
    logLevel: 'none',
    workingDirectory: config.cwd,
    baseDirectory: config.home,
    env: config.env,
  };
}

/** Session configuration exposing only OpenDots tools. */
export function copilotSessionConfig(
  model: string,
  config: Pick<CopilotTextConfig, 'cwd' | 'home'>,
  tools: ReadonlyArray<Tool>,
  systemMessage: string,
  execute: (tool: Tool, args: unknown, callId: string) => Promise<string>,
): SessionConfig {
  const custom = tools
    .filter((tool) => typeof tool.execute === 'function')
    .map((tool) =>
      defineTool(tool.name, {
        description: tool.description ?? tool.name,
        parameters:
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          'safeParse' in tool.inputSchema
            ? (z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<
                string,
                unknown
              >)
            : ((tool.inputSchema as Record<string, unknown> | undefined) ?? {
                type: 'object',
              }),
        // OpenDots enforces its own permissions inside the tool.
        skipPermission: true,
        handler: (args, invocation) =>
          execute(tool, args, invocation.toolCallId),
      }),
    );
  return {
    model,
    tools: custom,
    availableTools: custom.map((tool) => tool.name),
    streaming: true,
    workingDirectory: config.cwd,
    configDirectory: config.home,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableSkills: false,
    enableFileHooks: false,
    enableSessionTelemetry: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableMcpApps: false,
    enableOnDemandInstructionDiscovery: false,
    mcpServers: {},
    mcpOAuthTokenStorage: 'in-memory',
    infiniteSessions: { enabled: false },
    ...(systemMessage
      ? { systemMessage: { mode: 'append' as const, content: systemMessage } }
      : {}),
    // Anything that is not an OpenDots tool is denied; nobody is asked.
    onPermissionRequest: () =>
      ({ kind: 'denied-by-rules', rules: [] }) as never,
    onUserInputRequest: () => {
      throw new Error('User input is not available to this turn.');
    },
  } as SessionConfig;
}

/** Maps a typed Copilot session error to a classifiable marker. */
export function copilotErrorText(data: Record<string, unknown> = {}) {
  const type = String(data.errorType ?? '');
  if (/quota|rate_limit/.test(type)) return 'harness-error:quota';
  if (/authentication|authorization/.test(type)) return 'harness-error:auth';
  if (type === 'model') return 'harness-error:model';
  return 'harness-error:unknown';
}

export class CopilotTextAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  readonly ['text'],
  never,
  ReadonlyArray<string>,
  unknown,
  never
> {
  readonly name = 'copilot';
  constructor(
    private readonly settings: CopilotTextConfig,
    model: string,
  ) {
    super({}, model);
  }

  /** Provider errors leave the adapter only as a sanitized kind. */
  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    for await (const chunk of this.rawStream(options))
      yield sanitizeChunk(chunk);
  }

  private async *rawStream(
    options: TextOptions,
  ): AsyncIterable<AdapterYieldChunk> {
    const model = this.model;
    const runId = options.runId ?? this.generateId();
    const threadId = options.threadId ?? this.generateId();
    const now = () => Date.now();
    const signal = combinedSignal(
      options.abortController?.signal ??
        (options as { request?: { signal?: AbortSignal } }).request?.signal,
      this.settings.signal,
    );
    const queue: AdapterYieldChunk[] = [];
    let wake: (() => void) | undefined;
    const push = (chunk: object) => {
      queue.push(chunk as AdapterYieldChunk);
      wake?.();
    };
    let finished = false;
    let failure: string | undefined;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      failure = error;
      wake?.();
    };
    const text = new Map<string, number>();
    const openTools = new Set<string>();
    const seenCalls = new Set<string>();
    const emitText = (messageId: string, delta: string) => {
      if (!text.has(messageId)) {
        text.set(messageId, 0);
        push({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          model,
          timestamp: now(),
          role: 'assistant',
        });
      }
      if (!delta || text.get(messageId)! < 0) return;
      text.set(messageId, text.get(messageId)! + delta.length);
      push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        model,
        timestamp: now(),
        delta,
      });
    };
    const endText = (messageId: string, full: string) => {
      const sent = text.get(messageId) ?? 0;
      if (sent >= 0 && full.length > sent)
        emitText(messageId, full.slice(sent));
      if (text.has(messageId) && text.get(messageId)! >= 0) {
        text.set(messageId, -1);
        push({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          model,
          timestamp: now(),
        });
      }
    };
    const execute = async (tool: Tool, args: unknown, callId: string) => {
      // Never after cancellation, and never a repeated call ID.
      if (signal?.aborted || finished || !callId || seenCalls.has(callId))
        throw new Error('Not permitted by OpenDots.');
      seenCalls.add(callId);
      const input = args ?? {};
      const json = JSON.stringify(input);
      openTools.add(callId);
      push({
        type: EventType.TOOL_CALL_START,
        toolCallId: callId,
        toolCallName: tool.name,
        toolName: tool.name,
        model,
        timestamp: now(),
      });
      push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        model,
        timestamp: now(),
        delta: json,
        args: json,
      });
      push({
        type: EventType.TOOL_CALL_END,
        toolCallId: callId,
        toolCallName: tool.name,
        toolName: tool.name,
        model,
        timestamp: now(),
        input,
      });
      let output: string;
      try {
        const result = await tool.execute!(input, {
          toolCallId: callId,
          abortSignal: signal,
          context: options.context,
          emitCustomEvent: () => undefined,
        } as never);
        output = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        output = `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      openTools.delete(callId);
      push({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: callId,
        messageId: `${callId}-result`,
        model,
        timestamp: now(),
        content: output,
      });
      return output;
    };
    const systemMessage = normalizeSystemPrompts(options.systemPrompts)
      .map((prompt) => prompt.content)
      .filter((content) => content.trim())
      .join('\n\n');
    // Never start a client for a turn that is already cancelled.
    if (signal?.aborted) {
      yield {
        type: EventType.RUN_STARTED,
        runId,
        threadId,
        model,
        timestamp: now(),
      } as AdapterYieldChunk;
      yield {
        type: EventType.RUN_ERROR,
        model,
        timestamp: now(),
        message: 'aborted',
        error: { message: 'aborted' },
      } as AdapterYieldChunk;
      return;
    }
    const client = (
      this.settings.createClient ??
      ((value) => new CopilotClient(value) as unknown as SdkClient)
    )(copilotClientOptions(this.settings));
    let session: SdkSession | undefined;
    let sent = false;
    const abort = () => {
      void session?.abort().catch(() => undefined);
      finish('aborted');
    };
    signal?.addEventListener('abort', abort, { once: true });
    const cancelled = () => finished || !!signal?.aborted;
    push({
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: now(),
    });
    const lifecycle = (async () => {
      try {
        await client.start();
        // Cancellation during startup must never lead to inference.
        if (cancelled()) return;
        // System default: only Copilot's own login may run the turn. A GitHub
        // CLI fallback (another identity and quota) is refused before any
        // session exists. Managed accounts use their explicit token only.
        if (!this.settings.githubToken) {
          const status = await client.getAuthStatus?.();
          if (cancelled()) return;
          if (!copilotNativeLogin(status)) return finish('harness-error:auth');
        }
        session = await client.createSession(
          copilotSessionConfig(
            model,
            this.settings,
            options.tools ?? [],
            systemMessage,
            execute,
          ),
        );
        session.on((event) => {
          const data = event.data ?? {};
          switch (event.type) {
            case 'assistant.message_delta':
              emitText(
                String(data.messageId ?? 'copilot'),
                String(data.deltaContent ?? ''),
              );
              break;
            case 'assistant.message':
              endText(
                String(data.messageId ?? 'copilot'),
                typeof data.content === 'string' ? data.content : '',
              );
              break;
            case 'session.model_change':
              // Never accept a model the owner did not choose.
              if (data.newModel && data.newModel !== model) {
                void session?.abort().catch(() => undefined);
                finish('harness-error:model');
              }
              break;
            case 'session.error':
              void session?.abort().catch(() => undefined);
              finish(copilotErrorText(data));
              break;
            case 'session.idle':
              // Idle before the prompt was sent is not a completed turn.
              if (sent) finish();
              break;
          }
        });
        if (cancelled()) return;
        sent = true;
        await session.send({ prompt: conversationPrompt(options.messages) });
      } catch (error) {
        finish(error instanceof Error ? error.message : 'Copilot failed.');
      }
    })();
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
      while (queue.length) yield queue.shift()!;
      for (const toolCallId of openTools)
        yield {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: `${toolCallId}-result`,
          model,
          timestamp: now(),
          content: JSON.stringify({ status: 'interrupted' }),
        } as AdapterYieldChunk;
      for (const [messageId, count] of text)
        if (count >= 0)
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
            model,
            timestamp: now(),
          } as AdapterYieldChunk;
      if (failure)
        yield {
          type: EventType.RUN_ERROR,
          model,
          timestamp: now(),
          message: failure,
          error: { message: failure },
        } as AdapterYieldChunk;
      else
        yield {
          type: EventType.RUN_FINISHED,
          runId,
          threadId,
          model,
          timestamp: now(),
          finishReason: 'stop',
        } as AdapterYieldChunk;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!finished) finish('aborted');
      // Wait for startup to settle so a late session is always closed.
      await lifecycle.catch(() => undefined);
      if (failure !== undefined) await session?.abort().catch(() => undefined);
      await session?.disconnect().catch(() => undefined);
      await client.stop().catch(() => undefined);
    }
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(
      new Error('Copilot harness does not support one-shot structured output.'),
    );
  }
}

export function copilotText(model: string, config: CopilotTextConfig) {
  return new CopilotTextAdapter(config, model);
}

/** Aborts when either the engine or the outer turn is cancelled. */
export function combinedSignal(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((value): value is AbortSignal => !!value);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/**
 * True only for Copilot's own stored login (`authType: "user"`): never a
 * GitHub CLI fallback, environment token or other identity.
 */
export function copilotNativeLogin(
  status:
    | {
        isAuthenticated: boolean;
        authType?: string;
        host?: string;
        login?: string;
      }
    | undefined,
  expected?: { host: string; login: string },
) {
  return (
    !!status?.isAuthenticated &&
    status.authType === 'user' &&
    // The resolved identity must be exactly the projected active user.
    (!expected ||
      (status.login === expected.login &&
        (!status.host || sameHost(status.host, expected.host))))
  );
}

const sameHost = (a: string, b: string) => {
  const name = (value: string) => {
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).host;
    } catch {
      return value;
    }
  };
  return name(a) === name(b);
};
