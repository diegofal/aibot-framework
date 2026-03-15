import type { LLMClient } from '../core/llm-client';
import type { ChatMessage } from '../ollama';
import type { A2AMessage, A2APart, TextPart } from './types';

/**
 * Headless executor: processes A2A messages through LLM without any channel dependency.
 */
export interface ExecutorDeps {
  getLLMClient: (botId: string) => LLMClient;
  getSystemPrompt: (botId: string) => Promise<string>;
}

export async function executeA2AMessage(
  botId: string,
  messages: A2AMessage[],
  deps: ExecutorDeps
): Promise<A2AMessage> {
  const client = deps.getLLMClient(botId);
  const systemPrompt = await deps.getSystemPrompt(botId);

  // Convert A2A messages to ChatMessage format
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: extractText(m.parts),
    })),
  ];

  const response = await client.chat(chatMessages);

  return {
    role: 'agent',
    parts: [{ type: 'text', text: response.text }],
  };
}

function extractText(parts: A2APart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
