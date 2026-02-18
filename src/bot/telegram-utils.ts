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
