import type { Message } from '@ag-ui/core';
import type { TurnReceipt } from '../../shared/harness.js';

const text = (content: unknown) =>
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

/**
 * Transient instruction for an owner-approved continuation. It is added only
 * to the provider request, never to the canonical thread, so the user's
 * message is not duplicated. Completed tool results are restated (harness CLIs
 * receive text only) so they are not executed again; tools whose outcome is
 * unknown are named so the model asks before retrying them. No account,
 * profile or routing detail is included.
 */
export function continuationNote(
  messages: Message[],
  receipt: TurnReceipt,
): string {
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  const after = messages.slice(lastUser + 1);
  const partial = after
    .filter((message) => message.role === 'assistant')
    .map((message) => text(message.content).trim())
    .filter(Boolean)
    .join('\n')
    .slice(-6000);
  const results = after
    .filter((message) => message.role === 'tool')
    .map((message) => {
      const id = 'toolCallId' in message ? message.toolCallId : '';
      const name = receipt.tools.find((tool) => tool.id === id)?.name ?? 'tool';
      return `- ${name}: ${text(message.content).slice(0, 2000)}`;
    });
  const completed = receipt.tools
    .filter((tool) => tool.status === 'completed')
    .map((tool) => tool.name);
  const unknown = receipt.tools
    .filter((tool) => tool.status !== 'completed')
    .map((tool) => tool.name);
  return [
    'The previous reply to my last message was interrupted before it finished. Continue it now; do not repeat text that was already sent and do not treat this note as a new request.',
    partial ? `Already sent:\n${partial}` : '',
    completed.length || results.length
      ? `These tools already completed; use their results and do not call them again for the same action:\n${results.length ? results.join('\n') : completed.map((name) => `- ${name}`).join('\n')}`
      : '',
    unknown.length
      ? `These tool calls were interrupted and their outcome is unknown: ${[...new Set(unknown)].join(', ')}. Do not retry them; tell me they may or may not have taken effect and ask before repeating any of them.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
