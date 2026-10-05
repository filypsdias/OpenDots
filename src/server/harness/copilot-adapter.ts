import { EventType, normalizeSystemPrompts } from '@tanstack/ai';
import type { AdapterYieldChunk, TextOptions } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import {
  SandboxCapability,
  createRunScopedIdGen,
  encodeRunId,
  getSandbox,
  nodeHttpBridgeProvisioner,
  spawnNdjson,
} from '@tanstack/ai-sandbox';
import { BRIDGE_SERVER, copilotPolicyArgs, shellQuote } from './policy.js';

export interface CopilotTextConfig {
  cwd?: string;
  env?: Record<string, string>;
  executable?: string;
}

type CopilotEvent = { type?: unknown; data?: Record<string, unknown> };

const messageText = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === 'object' && 'text' in part
              ? String(part.text)
              : '',
          )
          .join('')
      : '';

/** Conversation text for a CLI that receives one prompt per turn. */
export function conversationPrompt(messages: TextOptions['messages']) {
  const last = messages.at(-1);
  const latest = last?.role === 'user' ? messageText(last.content).trim() : '';
  if (!latest)
    throw new Error('Harness adapter requires a trailing user message.');
  const prior = messages
    .slice(0, -1)
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        messageText(message.content).trim(),
    )
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${messageText(message.content).trim()}`,
    );
  return prior.length
    ? `Previous conversation:\n${prior.join('\n')}\n\n${latest}`
    : latest;
}

/** Copilot has no system prompt flag; instructions precede the conversation. */
export function copilotPrompt(
  messages: TextOptions['messages'],
  systemPrompts: TextOptions['systemPrompts'],
) {
  const system = normalizeSystemPrompts(systemPrompts)
    .map((prompt) => prompt.content)
    .filter((content) => content.trim());
  return [
    ...(system.length ? [system.join('\n\n')] : []),
    conversationPrompt(messages),
  ].join('\n\n');
}

/**
 * GitHub Copilot CLI harness adapter. Runs `copilot -p` with JSONL output in
 * the TanStack sandbox and serves OpenDots tools over the loopback MCP bridge.
 * Copilot silently substitutes another model when --model is unavailable;
 * that substitution is treated as a model error and the run stops.
 */
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
  readonly requires = [SandboxCapability] as const;
  constructor(
    private readonly settings: CopilotTextConfig,
    model: string,
  ) {
    super({}, model);
  }

  buildCommand(
    promptFile: string,
    mcpFile: string | undefined,
    tools: string[],
  ) {
    const args = [
      '-p',
      `"$(cat ${shellQuote(promptFile)})"`,
      '--output-format',
      'json',
      '--stream',
      'on',
      '--model',
      shellQuote(this.model),
      ...copilotPolicyArgs(tools).map(shellQuote),
      ...(mcpFile
        ? ['--additional-mcp-config', shellQuote(`@${mcpFile}`)]
        : []),
    ];
    return `${this.settings.executable ?? 'copilot'} ${args.join(' ')}`;
  }

  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? this.generateId();
    const threadId = options.threadId ?? this.generateId();
    const genId = createRunScopedIdGen(runId);
    const model = this.model;
    const now = () => Date.now();
    const cwd = this.settings.cwd ?? '/workspace';
    const temp: string[] = [];
    let bridge:
      | { name: string; url: string; token: string; close(): Promise<void> }
      | undefined;
    let sandbox: ReturnType<typeof getSandbox> | undefined;
    let started = false;
    const open = new Set<string>();
    try {
      if (!options.capabilities)
        throw new Error('Copilot adapter requires a sandbox.');
      sandbox = getSandbox(options.capabilities);
      const tools = options.tools ?? [];
      if (tools.length)
        bridge = (await nodeHttpBridgeProvisioner.provision(tools, {
          provider: sandbox.provider,
          context: options.context,
          ...(options.abortController?.signal
            ? { signal: options.abortController.signal }
            : {}),
        })) as typeof bridge;
      const segment = encodeRunId(runId);
      const promptFile = `.opendots-copilot-prompt-${segment}`;
      await sandbox.fs.write(
        `${cwd}/${promptFile}`,
        copilotPrompt(options.messages, options.systemPrompts),
      );
      temp.push(`${cwd}/${promptFile}`);
      let mcpFile: string | undefined;
      if (bridge) {
        mcpFile = `.opendots-copilot-mcp-${segment}.json`;
        await sandbox.fs.write(
          `${cwd}/${mcpFile}`,
          JSON.stringify({
            mcpServers: {
              [BRIDGE_SERVER]: {
                type: 'http',
                url: bridge.url,
                headers: { Authorization: `Bearer ${bridge.token}` },
                tools: ['*'],
              },
            },
          }),
        );
        temp.push(`${cwd}/${mcpFile}`);
      }
      const events = spawnNdjson(
        sandbox,
        this.buildCommand(
          promptFile,
          mcpFile,
          tools.map((tool) => tool.name),
        ),
        {
          cwd,
          ...(this.settings.env ? { env: this.settings.env } : {}),
          ...(options.abortController?.signal
            ? { signal: options.abortController.signal }
            : {}),
        },
      );
      yield* translateCopilotEvents(
        events as AsyncIterable<CopilotEvent>,
        { model, runId, threadId, genId, now },
        { open, onStart: () => (started = true) },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Copilot failed.';
      if (!started)
        yield {
          type: EventType.RUN_STARTED,
          runId,
          threadId,
          model,
          timestamp: now(),
        };
      for (const toolCallId of open)
        yield {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: genId(),
          model,
          timestamp: now(),
          content: JSON.stringify({ status: 'interrupted' }),
        };
      yield {
        type: EventType.RUN_ERROR,
        model,
        timestamp: now(),
        message,
        error: { message },
      } as AdapterYieldChunk;
    } finally {
      await bridge?.close();
      for (const path of temp)
        await sandbox?.fs.remove(path).catch(() => undefined);
    }
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(
      new Error('Copilot harness does not support one-shot structured output.'),
    );
  }
}

/** Translate Copilot JSONL session events into AG-UI chunks. */
export async function* translateCopilotEvents(
  events: AsyncIterable<CopilotEvent>,
  ctx: {
    model: string;
    runId: string;
    threadId: string;
    genId: () => string;
    now: () => number;
  },
  state: { open: Set<string>; onStart?: () => void } = { open: new Set() },
): AsyncIterable<AdapterYieldChunk> {
  const { model, runId, threadId, genId, now } = ctx;
  let started = false;
  let failed: string | undefined;
  const text = new Map<string, number>();
  const start = function* () {
    if (started) return;
    started = true;
    state.onStart?.();
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: now(),
    } as AdapterYieldChunk;
  };
  const emitText = function* (
    messageId: string,
    content: string,
    complete: boolean,
  ) {
    if (!text.has(messageId)) {
      text.set(messageId, 0);
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        model,
        timestamp: now(),
        role: 'assistant',
      } as AdapterYieldChunk;
    }
    const emitted = text.get(messageId)!;
    if (complete ? content.length > emitted : content.length > 0) {
      const delta = complete ? content.slice(emitted) : content;
      text.set(messageId, complete ? content.length : emitted + delta.length);
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        model,
        timestamp: now(),
        delta,
      } as AdapterYieldChunk;
    }
    if (complete) {
      text.set(messageId, Number.MAX_SAFE_INTEGER);
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: now(),
      } as AdapterYieldChunk;
    }
  };
  for await (const event of events) {
    const type = typeof event?.type === 'string' ? event.type : '';
    const data = (event?.data ?? {}) as Record<string, unknown>;
    yield* start();
    if (type === 'assistant.message_delta') {
      const id = String(data.messageId ?? 'copilot-message');
      const delta = String(data.deltaContent ?? '');
      if ((text.get(id) ?? 0) !== Number.MAX_SAFE_INTEGER)
        yield* emitText(id, delta, false);
    } else if (type === 'assistant.message') {
      const id = String(data.messageId ?? genId());
      const content = typeof data.content === 'string' ? data.content : '';
      if (content && (text.get(id) ?? 0) !== Number.MAX_SAFE_INTEGER)
        yield* emitText(id, content, true);
    } else if (type === 'tool.execution_start') {
      const id = String(data.toolCallId ?? genId());
      const raw = String(data.toolName ?? 'tool');
      const name = raw.startsWith(`${BRIDGE_SERVER}-`)
        ? raw.slice(BRIDGE_SERVER.length + 1)
        : raw;
      const input = data.arguments ?? {};
      const args = JSON.stringify(input);
      state.open.add(id);
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: name,
        toolName: name,
        model,
        timestamp: now(),
      } as AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: id,
        model,
        timestamp: now(),
        delta: args,
        args,
      } as AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: id,
        toolCallName: name,
        toolName: name,
        model,
        timestamp: now(),
        input,
      } as AdapterYieldChunk;
    } else if (type === 'tool.execution_complete') {
      const id = String(data.toolCallId ?? '');
      if (!state.open.delete(id)) continue;
      const result = (data.result ?? {}) as Record<string, unknown>;
      yield {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: id,
        messageId: genId(),
        model,
        timestamp: now(),
        content:
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify({ status: data.success ? 'completed' : 'failed' }),
      } as AdapterYieldChunk;
    } else if (type === 'session.error') {
      // errorType "model" includes Copilot's silent model substitution.
      const kind = String(data.errorType ?? '');
      failed =
        kind === 'model'
          ? 'Copilot model is not available: from --model flag is not available'
          : String(data.message ?? 'Copilot session error');
      break;
    }
  }
  yield* start();
  for (const toolCallId of state.open)
    yield {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: genId(),
      model,
      timestamp: now(),
      content: JSON.stringify({ status: 'interrupted' }),
    } as AdapterYieldChunk;
  state.open.clear();
  for (const [messageId, emitted] of text)
    if (emitted !== Number.MAX_SAFE_INTEGER)
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        model,
        timestamp: now(),
      } as AdapterYieldChunk;
  if (failed)
    yield {
      type: EventType.RUN_ERROR,
      model,
      timestamp: now(),
      message: failed,
      error: { message: failed },
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
}

export function copilotText(model: string, config: CopilotTextConfig = {}) {
  return new CopilotTextAdapter(config, model);
}
