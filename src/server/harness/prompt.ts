import type { TextOptions } from '@tanstack/ai';

export const messageText = (content: unknown) =>
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
  // CLIs receive one text prompt per turn, so earlier tool activity is kept
  // as text: what was called with which arguments, and what it returned.
  const names = new Map<string, string>();
  const prior = messages.slice(0, -1).flatMap((message) => {
    const value = message as {
      role: string;
      content: unknown;
      toolCalls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
      toolCallId?: string;
    };
    const text = messageText(value.content).trim();
    if (value.role === 'user') return text ? [`User: ${text}`] : [];
    if (value.role === 'assistant')
      return [
        ...(text ? [`Assistant: ${text}`] : []),
        ...(value.toolCalls ?? []).map((call) => {
          names.set(call.id, call.function.name);
          return `Assistant called tool ${call.function.name} with ${call.function.arguments.slice(0, 2000)}`;
        }),
      ];
    if (value.role === 'tool')
      return [
        `Tool result (${names.get(value.toolCallId ?? '') ?? 'tool'}): ${text.slice(0, 4000)}`,
      ];
    return [];
  });
  return prior.length
    ? `Previous conversation:\n${prior.join('\n')}\n\n${latest}`
    : latest;
}
