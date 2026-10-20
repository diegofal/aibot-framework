/**
 * What a parent-group summary contains, and how new messages are shown to
 * the model (formatted lines, cut into parts).
 */
import type { WaMessage } from './parser';

export const WHATSAPP_SUMMARY_TOOL = 'whatsapp_export_summary';

/** Shared by the intake hint and the tool description. */
export const SUMMARY_GUIDE = [
  "Summarize for a parent, in the operator's language, only what matters:",
  'dates and events (with day and time); things to bring, buy or do, and by when;',
  'money to pay or collect (amount, to whom, deadline); schedule changes and cancellations;',
  'requests addressed to the operator or their child; decisions the group took.',
  'Skip greetings, thanks, jokes, stickers and chit-chat. Group items by day or topic, say who',
  'asked when it matters, and end with what the operator has to do. If nothing matters, say so',
  'in one line. Do not save these messages to memory unless the operator asks.',
].join(' ');

/** Characters of message lines per part. */
export const PART_CHARS = 12_000;

const stamp = (ts: string) => `${ts.slice(0, 10)} ${ts.slice(11, 16)}`;

export function formatMessage(m: WaMessage): string {
  return `[${stamp(m.ts)}] ${m.author}: ${m.text.replace(/\n/g, '\n  ')}`;
}

/** Formatted lines split into parts of at most `maxChars` (a line is never split). */
export function chunkMessages(messages: WaMessage[], maxChars = PART_CHARS): string[] {
  const parts: string[] = [];
  let current = '';
  for (const m of messages) {
    const line = formatMessage(m);
    if (current && current.length + line.length + 1 > maxChars) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export { stamp as formatStamp };
