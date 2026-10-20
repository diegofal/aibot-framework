/**
 * A WhatsApp export the operator sent as a document: extract (zip or text),
 * parse, store, and build the conversation turn. The turn never carries the
 * raw messages — the model reads them through `whatsapp_export_summary`, so
 * they stay out of the session transcript.
 */
import { MediaError, type MediaResult } from '../media';
import { groupNameFromFileName, looksLikeWhatsAppExport, parseWhatsAppExport } from './parser';
import type { WhatsAppExportStore } from './store';
import { SUMMARY_GUIDE, WHATSAPP_SUMMARY_TOOL, formatStamp, plural } from './summary';
import { ZipError, extractChatText } from './zip';

export { isWhatsAppExportFileName as isWhatsAppExportDocument } from './parser';

/** `group: 3B Padres` / `grupo: 3B Padres` in the caption names an export whose file does not. */
const CAPTION_GROUP_RE = /^\s*(?:group|grupo)\s*:\s*(.+?)\s*$/im;

const UNNAMED_EXPORT =
  'This export does not say which group it is (the file is just "_chat.txt"). Send it again with the caption "group: <group name>", or send the .zip exactly as WhatsApp made it (its name carries the group).';

/**
 * The group an export belongs to: the file name WhatsApp gave it, else a
 * `group:` caption. Never a shared fallback: two unnamed exports of different
 * groups used to land in one store, mixing their messages and cursors.
 */
export function exportGroupName(fileName?: string, caption?: string): string | undefined {
  return (
    groupNameFromFileName(fileName) ?? caption?.match(CAPTION_GROUP_RE)?.[1]?.trim() ?? undefined
  );
}

export interface IntakeInput {
  botId: string;
  fileName?: string;
  caption?: string;
  buffer: Buffer;
  store: WhatsAppExportStore;
  nowMs: number;
}

function chatText(fileName: string | undefined, buffer: Buffer): string {
  if (fileName?.toLowerCase().endsWith('.zip')) {
    try {
      return extractChatText(buffer);
    } catch (err) {
      if (err instanceof ZipError)
        throw new MediaError(`Could not read the export: ${err.message}`);
      throw err;
    }
  }
  return buffer.toString('utf-8');
}

export async function intakeWhatsAppExport(input: IntakeInput): Promise<MediaResult> {
  const text = chatText(input.fileName, input.buffer);
  if (!looksLikeWhatsAppExport(text)) {
    throw new MediaError(
      'This does not look like a WhatsApp chat export. In WhatsApp: open the group → ⋮ / group name → More → Export chat → Without media, and send me that file.'
    );
  }
  const group = exportGroupName(input.fileName, input.caption);
  if (!group) throw new MediaError(UNNAMED_EXPORT);
  const parsed = parseWhatsAppExport(text);
  const r = input.store.ingest(input.botId, group, parsed.messages, {
    nowMs: input.nowMs,
    fileName: input.fileName ?? 'export.txt',
  });

  let status: string;
  if (r.newCount === 0) {
    status = `No new messages since the previous export${r.previousLastMessageAt ? ` (last message ${formatStamp(r.previousLastMessageAt)})` : ''}. Tell the operator so, in one line.`;
  } else {
    const range = r.from && r.to ? ` (${formatStamp(r.from)} → ${formatStamp(r.to)})` : '';
    status = r.firstExport
      ? `First export of this group: ${plural(r.newCount, 'new message')} from the last 30 days${range}.`
      : `${plural(r.newCount, 'new message')} since the previous export${range}.`;
    status += ` The messages are not in this turn: call ${WHATSAPP_SUMMARY_TOOL} with group "${r.group}" (and every part it announces) to read them, then write the summary. ${SUMMARY_GUIDE}`;
  }

  const caption = input.caption?.trim();
  const body = `[WhatsApp export received — group "${r.group}"]\n${status}`;
  return {
    text: caption ? `${caption}\n\n${body}` : body,
    sessionText: `[WhatsApp export: ${r.group} — ${plural(r.newCount, 'new message')}]${caption ? ` ${caption}` : ''}`,
  };
}
