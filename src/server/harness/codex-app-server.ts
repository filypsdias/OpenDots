import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { EventType, normalizeSystemPrompts } from '@tanstack/ai';
import type { AdapterYieldChunk, TextOptions, Tool } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import { conversationPrompt } from './prompt.js';
import { sanitizeChunk } from './errors.js';
import { combinedSignal } from './copilot-adapter.js';

// Codex runs through its app-server protocol, not `codex exec`: a thread with
// `environments: []` has no environment, so the shell, apply_patch, file and
// image tools are never planned. OpenDots tools are offered as dynamic tools
// and executed here, inside the OpenDots server process.

/** `-c` overrides for the app-server process; also applied per thread. */
export const CODEX_LOCKDOWN_CONFIG: Record<string, unknown> = {
  'features.stable_environment_tools': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.tool_suggest': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.image_generation': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.computer_use': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.code_mode_host': false,
  'features.memories': false,
  'features.sleep_tool': false,
  'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  web_search: 'disabled',
  mcp_servers: {},
  plugins: {},
  hooks: {},
  notify: [],
  // The ChatGPT subscription provider only; never a configured custom endpoint.
  model_provider: 'openai',
  project_doc_max_bytes: 0,
};

/** Native item types that must never appear in an OpenDots Codex turn. */
export const CODEX_NATIVE_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
]);

const toml = (value: unknown): string =>
  typeof value === 'string'
    ? JSON.stringify(value)
    : typeof value === 'boolean' || typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? JSON.stringify(value)
        : value && typeof value === 'object' && !Object.keys(value).length
          ? '{}'
          : JSON.stringify(value);

export function codexAppServerArgs(): string[] {
  return [
    'app-server',
    ...Object.entries(CODEX_LOCKDOWN_CONFIG).flatMap(([key, value]) => [
      '-c',
      `${key}=${toml(value)}`,
    ]),
  ];
}

export const MIN_CODEX_VERSION = [0, 160, 0];

/** Capability gate: an unknown or older app-server is refused, never trusted. */
export function codexVersionSupported(userAgent: unknown): boolean {
  const match =
    typeof userAgent === 'string'
      ? userAgent.match(/(\d+)\.(\d+)\.(\d+)/)
      : null;
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index++)
    if (version[index] !== MIN_CODEX_VERSION[index])
      return version[index] > MIN_CODEX_VERSION[index];
  return true;
}

const QUOTA_CODES = new Set([
  'usageLimitExceeded',
  'rateLimitExceeded',
  'sessionBudgetExceeded',
]);

/** Converts a typed Codex error into text for server-side classification. */
export function codexErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Codex turn failed.';
  const value = error as { message?: unknown; codexErrorInfo?: unknown };
  const info = value.codexErrorInfo;
  const code =
    typeof info === 'string'
      ? info
      : info && typeof info === 'object'
        ? Object.keys(info)[0]
        : '';
  const prefix = QUOTA_CODES.has(code)
    ? 'usage limit: '
    : code === 'unauthorized'
      ? 'unauthorized: '
      : '';
  return `${prefix}${typeof value.message === 'string' ? value.message : 'Codex turn failed.'}`;
}

export function dynamicToolSpecs(tools: ReadonlyArray<Tool>) {
  return tools
    .filter((tool) => typeof tool.execute === 'function')
    .map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema:
        tool.inputSchema &&
        typeof tool.inputSchema === 'object' &&
        'safeParse' in tool.inputSchema
          ? z.toJSONSchema(tool.inputSchema as z.ZodType)
          : (tool.inputSchema ?? { type: 'object', properties: {} }),
    }));
}

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

export interface CodexAppServerConfig {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executable?: string;
  spawnProcess?: typeof spawn;
  /** Outer turn cancellation (owner stop, pause, permission change). */
  signal?: AbortSignal;
}

export class CodexAppServerAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  readonly ['text'],
  never,
  ReadonlyArray<string>,
  unknown,
  never
> {
  readonly name = 'codex';
  constructor(
    private readonly settings: CodexAppServerConfig,
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
    // Never spawn Codex for a turn that is already cancelled.
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
    const queue: AdapterYieldChunk[] = [];
    let wake: (() => void) | undefined;
    const push = (chunk: AdapterYieldChunk) => {
      queue.push(chunk);
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
    const child = (this.settings.spawnProcess ?? spawn)(
      this.settings.executable ?? 'codex',
      codexAppServerArgs(),
      {
        cwd: this.settings.cwd,
        env: this.settings.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const send = (message: Record<string, unknown>) => {
      if (!child.stdin.destroyed)
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`,
        );
    };
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    const tools = new Map(
      (options.tools ?? [])
        .filter((tool) => typeof tool.execute === 'function')
        .map((tool) => [tool.name, tool]),
    );
    const text = new Map<string, number>();
    const openTools = new Set<string>();
    let codexThread: string | undefined;
    let turnId: string | undefined;
    const interrupt = () => {
      if (codexThread && turnId)
        void request('turn/interrupt', { threadId: codexThread, turnId }).catch(
          () => undefined,
        );
    };
    const emitText = (itemId: string, delta: string) => {
      if (!text.has(itemId)) {
        text.set(itemId, 0);
        push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: itemId,
          model,
          timestamp: now(),
          role: 'assistant',
        } as AdapterYieldChunk);
      }
      if (!delta) return;
      text.set(itemId, text.get(itemId)! + delta.length);
      push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: itemId,
        model,
        timestamp: now(),
        delta,
      } as AdapterYieldChunk);
    };
    const endText = (itemId: string, full?: string) => {
      if (full !== undefined && full.length > (text.get(itemId) ?? 0))
        emitText(itemId, full.slice(text.get(itemId) ?? 0));
      if (text.has(itemId) && text.get(itemId)! >= 0) {
        text.set(itemId, -1);
        push({
          type: EventType.TEXT_MESSAGE_END,
          messageId: itemId,
          model,
          timestamp: now(),
        } as AdapterYieldChunk);
      }
    };
    const seenCalls = new Set<string>();
    let completed = false;
    const protocolFailure = (reason: string) => {
      interrupt();
      finish(`Codex protocol violation: ${reason}`);
    };
    const callTool = async (
      id: number | string,
      params: Record<string, unknown>,
    ) => {
      const callId = String(params.callId ?? '');
      const name = String(params.tool ?? '');
      const refuse = (reason: string) => {
        send({
          id,
          error: { code: -32602, message: 'Not permitted by OpenDots.' },
        });
        protocolFailure(reason);
      };
      // Only calls for this exact thread and turn, never after cancellation,
      // and never a repeated call ID (which could replay an action).
      if (signal?.aborted || finished) return refuse('aborted');
      if (
        !callId ||
        params.threadId !== codexThread ||
        params.turnId !== turnId
      )
        return refuse('Codex tool call does not belong to this turn.');
      if (seenCalls.has(callId))
        return refuse('Codex repeated a tool call ID.');
      seenCalls.add(callId);
      const input = params.arguments ?? {};
      const args = JSON.stringify(input);
      openTools.add(callId);
      push({
        type: EventType.TOOL_CALL_START,
        toolCallId: callId,
        toolCallName: name,
        toolName: name,
        model,
        timestamp: now(),
      } as AdapterYieldChunk);
      push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        model,
        timestamp: now(),
        delta: args,
        args,
      } as AdapterYieldChunk);
      push({
        type: EventType.TOOL_CALL_END,
        toolCallId: callId,
        toolCallName: name,
        toolName: name,
        model,
        timestamp: now(),
        input,
      } as AdapterYieldChunk);
      let output: string;
      let success = true;
      const tool = tools.get(name);
      try {
        // Only OpenDots tools offered for this turn exist; validate their input.
        if (!tool?.execute || params.namespace)
          throw new Error(`Unknown tool: ${name}`);
        const schema = tool.inputSchema as
          | {
              safeParse?: (value: unknown) => {
                success: boolean;
                data?: unknown;
              };
            }
          | undefined;
        const parsed = schema?.safeParse
          ? schema.safeParse(input)
          : { success: true, data: input };
        if (!parsed.success)
          throw new Error('Tool input did not match its schema.');
        const result = await tool.execute(parsed.data, {
          toolCallId: callId,
          abortSignal: signal,
          context: options.context,
          emitCustomEvent: () => undefined,
        } as never);
        output = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        success = false;
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
      } as AdapterYieldChunk);
      send({
        id,
        result: {
          contentItems: [{ type: 'inputText', text: output }],
          success,
        },
      });
    };
    const onMessage = (message: Message) => {
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(Number(message.id));
        pending.delete(Number(message.id));
        if (message.error)
          entry?.reject(
            new Error(message.error.message ?? 'Codex request failed.'),
          );
        else entry?.resolve(message.result);
        return;
      }
      const params = message.params ?? {};
      if (message.id !== undefined) {
        if (message.method === 'item/tool/call')
          void callTool(message.id, params);
        // Approvals, user input, elicitations and token refresh are refused:
        // OpenDots never grants native capabilities to a Codex turn.
        else
          send({
            id: message.id,
            error: { code: -32601, message: 'Not permitted by OpenDots.' },
          });
        return;
      }
      // Every turn-scoped notification must name this thread and turn.
      if (
        codexThread &&
        typeof params.threadId === 'string' &&
        params.threadId !== codexThread
      )
        return protocolFailure('notification for another thread.');
      if (
        turnId &&
        typeof params.turnId === 'string' &&
        params.turnId !== turnId
      )
        return protocolFailure('notification for another turn.');
      switch (message.method) {
        case 'item/agentMessage/delta':
          emitText(String(params.itemId), String(params.delta ?? ''));
          break;
        case 'item/started':
        case 'item/completed': {
          const item = (params.item ?? {}) as Record<string, unknown>;
          if (CODEX_NATIVE_ITEMS.has(String(item.type))) {
            interrupt();
            finish(
              'Codex attempted a native tool that OpenDots does not permit.',
            );
          } else if (
            message.method === 'item/completed' &&
            item.type === 'agentMessage'
          )
            endText(
              String(item.id),
              typeof item.text === 'string' ? item.text : undefined,
            );
          break;
        }
        case 'model/rerouted':
          interrupt();
          finish('model unavailable: Codex rerouted the requested model.');
          break;
        case 'error':
          if (!params.willRetry) failure = codexErrorText(params.error);
          break;
        case 'turn/completed': {
          const turn = (params.turn ?? {}) as {
            id?: string;
            status?: string;
            error?: unknown;
          };
          if (turnId && turn.id && turn.id !== turnId)
            return protocolFailure('completion for another turn.');
          completed = true;
          finish(
            turn.status === 'completed'
              ? undefined
              : turn.error
                ? codexErrorText(turn.error)
                : (failure ?? `Codex turn ${turn.status ?? 'failed'}.`),
          );
          break;
        }
      }
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        onMessage(JSON.parse(line) as Message);
      } catch {
        // Ignore non-protocol output; it is never forwarded.
      }
    });
    let stderr = '';
    child.stderr.on(
      'data',
      (chunk) => (stderr = (stderr + chunk).slice(-4000)),
    );
    child.on('error', (error) => finish(`${error.message} (exit code 127)`));
    child.on('close', (code) => {
      for (const entry of pending.values())
        entry.reject(new Error('Codex app-server exited.'));
      pending.clear();
      // Exiting before turn/completed is never a successful turn.
      finish(
        completed
          ? undefined
          : code === 127
            ? 'Codex app-server exited with code 127.'
            : `Codex app-server exited before the turn completed. ${stderr}`,
      );
    });
    const abort = () => {
      interrupt();
      child.kill('SIGTERM');
      finish('aborted');
    };
    signal?.addEventListener('abort', abort, { once: true });
    push({
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: now(),
    } as AdapterYieldChunk);
    const cancelled = () => finished || !!signal?.aborted;
    const checkpoint = () => {
      // Cancellation during initialization must never reach turn/start.
      if (cancelled()) throw new Error('aborted');
    };
    void (async () => {
      try {
        const init = (await request('initialize', {
          clientInfo: { name: 'opendots', title: 'OpenDots', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        })) as { userAgent?: unknown };
        // `environments: []` and dynamic tools were verified against 0.160.0.
        if (!codexVersionSupported(init?.userAgent))
          throw new Error(
            `Codex CLI must be updated: ${MIN_CODEX_VERSION.join('.')} or newer is required.`,
          );
        checkpoint();
        send({ method: 'initialized' });
        const developerInstructions = normalizeSystemPrompts(
          options.systemPrompts,
        )
          .map((prompt) => prompt.content)
          .filter((content) => content.trim())
          .join('\n\n');
        checkpoint();
        const started = (await request('thread/start', {
          model,
          cwd: this.settings.cwd,
          ephemeral: true,
          environments: [],
          dynamicTools: dynamicToolSpecs([...tools.values()]),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          allowProviderModelFallback: false,
          developerInstructions: developerInstructions || null,
          config: CODEX_LOCKDOWN_CONFIG,
        })) as {
          thread?: { id?: string; environments?: unknown };
          model?: unknown;
        };
        // The server must confirm that no environment is selected; unknown or
        // non-empty selection could expose native shell and file tools.
        if (
          !Array.isArray(started.thread?.environments) ||
          started.thread.environments.length !== 0
        )
          throw new Error(
            'Codex did not confirm an environment-free thread; refusing to run.',
          );
        if (typeof started.model === 'string' && started.model !== model)
          throw new Error(
            'model unavailable: Codex selected a different model.',
          );
        codexThread = started.thread?.id;
        if (!codexThread) throw new Error('Codex did not start a thread.');
        checkpoint();
        const turn = (await request('turn/start', {
          threadId: codexThread,
          environments: [],
          input: [
            {
              type: 'text',
              text: conversationPrompt(options.messages),
              text_elements: [],
            },
          ],
        })) as { turn?: { id?: string } };
        turnId = turn.turn?.id;
        if (!turnId) throw new Error('Codex did not start a turn.');
      } catch (error) {
        finish(
          error instanceof Error ? error.message : 'Codex request failed.',
        );
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
      for (const entry of pending.values())
        entry.reject(new Error('Codex turn ended.'));
      pending.clear();
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(
      new Error('Codex harness does not support one-shot structured output.'),
    );
  }
}
