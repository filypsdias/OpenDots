import {
  HARNESS_LABELS,
  type HarnessProvider,
  type TurnErrorKind,
} from '../../shared/harness.js';

// Only application-authored text reaches the chat. Raw CLI output can contain
// account emails, paths or tokens, so it is classified and then discarded.
export class HarnessTurnError extends Error {
  constructor(
    readonly kind: TurnErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const PATTERNS: Array<[TurnErrorKind, RegExp]> = [
  [
    'missing_cli',
    /command not found|\bENOENT\b|exit(?:ed)? (?:with )?code 127|is not installed|must be updated/i,
  ],
  [
    'quota',
    /rate.?limit|usage.?limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|out of (?:credits|usage)|insufficient_quota|(?:weekly|daily|session|monthly) limit|premium requests|credits? (?:exhausted|remaining: 0)/i,
  ],
  [
    'model',
    /model\b.*\b(?:not (?:found|available|supported|allowed)|unavailable|does not exist|no access|not enabled)|(?:invalid|unknown|unsupported) model|from --model flag is not available|model_not_found/i,
  ],
  [
    'auth',
    /not logged in|log ?in (?:is )?required|unauthori[sz]ed|\b401\b|\b403\b|authenticat|expired (?:token|session|credentials)|invalid (?:api key|token|credentials)|run .{0,30}login|re-?auth|oauth/i,
  ],
];

const MARKER = /^harness-error:(quota|auth|model|missing_cli|unknown)$/;

export function classifyHarnessFailure(text: string): TurnErrorKind {
  const marked = text.match(MARKER)?.[1] as TurnErrorKind | undefined;
  if (marked) return marked;
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
  return 'unknown';
}

export function safeTurnMessage(
  kind: TurnErrorKind,
  provider: HarnessProvider | null,
): string {
  const name = provider ? HARNESS_LABELS[provider] : 'The model provider';
  switch (kind) {
    case 'quota':
      return `${name} reported a usage or quota limit for the active account. Your conversation and partial work are saved. Choose an account and continue.`;
    case 'auth':
      return `${name} needs you to sign in again, or no account is selected. Open Settings › Local harnesses to sign in or choose an account, then continue.`;
    case 'model':
      return `${name} cannot use the selected model with the active account. Choose a model for this conversation, then continue.`;
    case 'missing_cli':
      return `${name} is not installed on this machine, or is too old. Install or update it, then retry.`;
    default:
      return `The subscription CLI could not complete this turn (${name}). Check its local login and permissions, then retry.`;
  }
}

/** Provider-neutral error kind for an arbitrary thrown value. */
export function kindOf(value: unknown): TurnErrorKind {
  if (value instanceof HarnessTurnError) return value.kind;
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'message' in value
          ? String((value as { message: unknown }).message)
          : '';
  return classifyHarnessFailure(text);
}

/**
 * TanStack logs adapter errors (with the raw provider payload) through its
 * logger. This logger keeps only the category and the classified kind, so CLI
 * output with tokens, emails or paths never reaches server logs.
 */
export function sanitizedDebug(provider: HarnessProvider | null) {
  const name = provider ?? 'http';
  const line = (
    level: 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    const kind = kindOf(meta?.error ?? message);
    console[level](`[opendots] ${name} turn ${level}: ${kind}`);
  };
  return {
    errors: true,
    provider: false,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    request: false,
    sandbox: false,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) =>
        line('warn', message, meta),
      error: (message: string, meta?: Record<string, unknown>) =>
        line('error', message, meta),
    },
  };
}

/**
 * Replaces a raw provider error chunk with a machine-readable kind before it
 * leaves the adapter (and before any engine or app logging). Raw CLI output
 * can contain tokens, account emails and private paths.
 */
export function sanitizeChunk<T>(chunk: T): T {
  const value = chunk as { type?: unknown; message?: unknown; error?: unknown };
  if (value?.type !== 'RUN_ERROR') return chunk;
  const kind = kindOf(
    typeof value.message === 'string' ? value.message : value.error,
  );
  const message = `harness-error:${kind}`;
  return {
    type: 'RUN_ERROR',
    model: (chunk as { model?: unknown }).model,
    timestamp: Date.now(),
    message,
    code: kind,
    error: { message, code: kind },
  } as T;
}

/** Wraps a third-party harness adapter so its error chunks are sanitized. */
export function sanitizedAdapter<
  T extends { chatStream: (options: never) => AsyncIterable<unknown> },
>(adapter: T): T {
  const original = adapter.chatStream.bind(adapter);
  adapter.chatStream = async function* (options: never) {
    for await (const chunk of original(options)) yield sanitizeChunk(chunk);
  } as T['chatStream'];
  return adapter;
}
