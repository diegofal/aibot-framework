const TELEGRAM_MAX_LENGTH = 4096;

export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const cutAt = remaining.lastIndexOf('\n', maxLength);
    const splitPos = cutAt > 0 ? cutAt : maxLength;
    chunks.push(remaining.slice(0, splitPos));
    remaining = remaining.slice(splitPos + 1);
  }
  return chunks;
}

export async function sendLongMessage(
  send: (text: string) => Promise<unknown>,
  text: string
): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await send(chunk);
  }
}

/**
 * Stream LLM output to Telegram using edit-message-text.
 * Sends an initial placeholder, then progressively edits it as tokens arrive.
 * Throttled by `editIntervalMs` and `minChunkChars` to respect Telegram rate limits.
 *
 * @param sendMessage  Send a new message, returns its message_id.
 * @param editMessage  Edit an existing message by id.
 * @param stream       Async generator yielding token chunks.
 * @param editIntervalMs  Minimum ms between edits (default 800).
 * @param minChunkChars   Minimum new chars before an edit is sent (default 50).
 * @returns The final complete text.
 */
export async function streamToChannel(
  sendMessage: (text: string) => Promise<number>,
  editMessage: (messageId: number, text: string) => Promise<void>,
  stream: AsyncGenerator<string>,
  editIntervalMs = 800,
  minChunkChars = 50
): Promise<string> {
  let text = '';
  let messageId: number | undefined;
  let lastEditTime = 0;
  let lastEditLength = 0;

  for await (const chunk of stream) {
    text += chunk;

    const now = Date.now();
    if (!messageId) {
      // Send initial message with first chunk
      messageId = await sendMessage(text || '...');
      lastEditTime = now;
      lastEditLength = text.length;
      continue;
    }

    // Throttle edits: respect interval AND minimum chars accumulated
    if (now - lastEditTime >= editIntervalMs && text.length - lastEditLength >= minChunkChars) {
      try {
        await editMessage(messageId, text);
        lastEditTime = now;
        lastEditLength = text.length;
      } catch {
        /* edit may fail if text is unchanged or message deleted */
      }
    }
  }

  // Final edit with complete text
  if (messageId && text && text.length !== lastEditLength) {
    try {
      await editMessage(messageId, text);
    } catch {
      /* already up to date */
    }
  }

  return text;
}
