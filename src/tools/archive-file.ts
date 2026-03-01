import type { ProductionsService } from '../productions/service';
import type { Tool } from './types';

export function createArchiveFileTool(productionsService: ProductionsService): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'archive_file',
        description:
          'Move a production file to archived/ with a reason. Use when a file is superseded, stale, or duplicated. NEVER delete production files — always archive with a reason.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Relative path of the file to archive (e.g. "old_report.md" or "outreach/draft_v1.md")',
            },
            reason: {
              type: 'string',
              description:
                'Why this file is being archived (e.g. "Superseded by pipeline_tracker.md")',
            },
          },
          required: ['path', 'reason'],
        },
      },
    },
    async execute(args, logger) {
      const botId = args._botId as string;
      if (!botId) {
        return { success: false, content: 'Missing bot context (_botId)' };
      }

      if (!productionsService.isEnabled(botId)) {
        return { success: false, content: 'Productions are not enabled for this bot' };
      }

      const path = args.path as string;
      const reason = args.reason as string;

      if (!path || !reason) {
        return { success: false, content: 'Both "path" and "reason" are required' };
      }

      try {
        const ok = productionsService.archiveFile(botId, path, reason);
        if (!ok) {
          return {
            success: false,
            content: `Failed to archive "${path}" — file not found or move failed`,
          };
        }
        return {
          success: true,
          content: `Archived "${path}" → archived/${path.split('/').pop()}\nReason: ${reason}`,
        };
      } catch (err) {
        logger.error({ err, botId, path }, 'Failed to archive file');
        return { success: false, content: `Error archiving file: ${err}` };
      }
    },
  };
}
