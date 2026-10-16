/**
 * whatsapp_export_summary — the new messages of the latest WhatsApp export
 * the operator sent (src/whatsapp-export/), so the conversation model can
 * summarize them. Operator only, and only inside a conversation: these are
 * other parents' and children's messages.
 */
import type { WhatsAppExportStore } from '../whatsapp-export/store';
import {
  SUMMARY_GUIDE,
  WHATSAPP_SUMMARY_TOOL,
  chunkMessages,
  formatStamp,
  plural,
} from '../whatsapp-export/summary';
import { requireOperator } from './operator-gate';
import { type Tool, type ToolResult, wrapExternalContent } from './types';

export interface WhatsAppExportSummaryDeps {
  store: WhatsAppExportStore;
  now?: () => number;
}

const refuse = (content: string): ToolResult => ({
  success: false,
  content,
  failureKind: 'policy',
});

export function createWhatsAppExportSummaryTool(deps: WhatsAppExportSummaryDeps): Tool {
  const now = deps.now ?? Date.now;
  return {
    definition: {
      type: 'function',
      function: {
        name: WHATSAPP_SUMMARY_TOOL,
        description: `Read the new messages of a WhatsApp group chat export the operator sent you (only messages newer than the previous export of that group), to summarize them. Large exports come in parts: read every part before writing. ${SUMMARY_GUIDE}`,
        parameters: {
          type: 'object',
          properties: {
            group: {
              type: 'string',
              description: 'Group name (or part of it). Omit for the most recent export.',
            },
            part: { type: 'number', description: 'Part to read, starting at 1 (default 1).' },
          },
        },
      },
    },

    async execute(args): Promise<ToolResult> {
      const gate = requireOperator(args);
      if (gate) return gate;
      if (!args._requester) {
        return refuse('Only available in a conversation with the operator.');
      }
      const botId = String(args._botId ?? '');
      const query = typeof args.group === 'string' ? args.group : undefined;
      const nowMs = now();

      const rec = deps.store.find(botId, query, nowMs);
      if (!rec) {
        const known = deps.store.list(botId).map((g) => `"${g.group}"`);
        if (known.length === 0) {
          return {
            success: true,
            content:
              'No WhatsApp exports yet. Ask the operator to export the group (WhatsApp → group → More → Export chat → Without media) and send the file here.',
          };
        }
        return {
          success: false,
          content: `No export for group "${query}". Known groups: ${known.join(', ')}.`,
        };
      }

      const at = rec.lastExport?.at;
      const fresh = at ? rec.messages.filter((m) => m.seenAt === at) : [];
      const header = `WhatsApp group "${rec.group}" — export received ${at ? formatStamp(at) : '?'} UTC.`;
      if (fresh.length === 0) {
        return {
          success: true,
          content: `${header} The latest export has no new messages since the previous one (or they are past the 30-day retention).`,
        };
      }

      const parts = chunkMessages(fresh);
      const part = Math.max(1, Math.floor(Number(args.part ?? 1)) || 1);
      if (part > parts.length) {
        return {
          success: false,
          content: `${header} There are only ${parts.length} part(s).`,
        };
      }
      const range = `${formatStamp(fresh[0].ts)} → ${formatStamp(fresh[fresh.length - 1].ts)}`;
      const next =
        part < parts.length
          ? `\nRead the rest before summarizing: call ${WHATSAPP_SUMMARY_TOOL} again with part: ${part + 1}.`
          : '';
      return {
        success: true,
        content: `${header}\n${plural(fresh.length, 'new message')} since the previous export (${range}). Part ${part} of ${parts.length}.${next}\n${wrapExternalContent(parts[part - 1])}`,
      };
    },
  };
}
