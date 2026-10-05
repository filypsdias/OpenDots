import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import type { HarnessStore } from './store.js';

/** Stable JSON: object keys sorted so equal arguments fingerprint equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function toolFingerprint(name: string, input: unknown) {
  return createHash('sha256')
    .update(`${name}\n${canonicalJson(input)}`)
    .digest('hex');
}

export class UnknownToolOutcomeError extends Error {
  constructor(tool: string) {
    super(
      `${tool} was interrupted earlier and its outcome is unknown. OpenDots will not repeat it automatically; ask the user to check and confirm before trying again.`,
    );
  }
}

/** OpenDots tools with side effects. Reads always execute live. */
export const MUTATING_TOOLS = new Set([
  'create_space_page',
  'edit_space_page',
  'computer_navigate',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_files_write',
  'computer_exec',
]);

/**
 * Durable execution journal for side-effecting OpenDots tools while answering
 * one user message. Before a mutation runs, its validated name and normalized
 * arguments are recorded as started; afterwards the full result is stored.
 * For the rest of that answer — including explicit continuations after a
 * failure — an identical mutation returns the stored result instead of
 * running again, and one whose outcome is unknown (interrupted, crashed or
 * threw) is refused. Only a new user message authorizes it again. Current
 * permissions for the resolved resource are checked before any stored result
 * is returned. Read-only tools are not journaled and always run live.
 */
export function journaledTools(
  tools: ToolDefinition[],
  options: {
    store: HarnessStore;
    threadId: string;
    promptId: string | null;
    receiptId: () => string | null;
    /** Re-validates current permission for the resolved resource and action. */
    authorize: (name: string, input: unknown) => void;
  },
): ToolDefinition[] {
  return tools.map((tool) => {
    if (!tool.execute || !options.promptId || !MUTATING_TOOLS.has(tool.name))
      return tool;
    const execute = tool.execute;
    const promptId = options.promptId;
    return {
      ...tool,
      execute: async (input: unknown, context?: unknown) => {
        // Typed pre-execution failures: nothing has run yet.
        const checked = await tool.parameters['~standard'].validate(input);
        if (checked.issues) throw new Error(`Invalid input for ${tool.name}.`);
        options.authorize(tool.name, checked.value);
        const fingerprint = toolFingerprint(tool.name, checked.value);
        const key = {
          threadId: options.threadId,
          promptId,
          fingerprint,
          occurrence: 0,
        };
        const previous = options.store.journalEntry(
          key.threadId,
          promptId,
          fingerprint,
          0,
        );
        if (previous?.status === 'completed' && previous.result !== null)
          return JSON.parse(previous.result) as unknown;
        if (previous) throw new UnknownToolOutcomeError(tool.name);
        if (
          !options.store.journalStart({
            ...key,
            tool: tool.name,
            receiptId: options.receiptId(),
          })
        )
          throw new UnknownToolOutcomeError(tool.name);
        // Any throw from here on may follow a partial side effect (for
        // example a network failure after the write landed), so the intent
        // stays recorded as started: its outcome is unknown.
        const result = await (execute as (a: unknown, c?: unknown) => unknown)(
          checked.value,
          context,
        );
        options.store.journalFinish(key, JSON.stringify(result ?? null));
        return result;
      },
    } as ToolDefinition;
  });
}
