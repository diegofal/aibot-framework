import type { Tool } from './types';
import type { ProductionsService } from '../productions/service';

export function createProductionLogTool(
  productionsService: ProductionsService,
): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_production_log',
        description:
          'Read your production changelog and evaluations. Use to learn from past work, review feedback on your outputs, and improve future productions.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max entries to return (default 20)',
            },
            status: {
              type: 'string',
              enum: ['approved', 'rejected', 'unreviewed', 'all'],
              description: 'Filter by evaluation status (default: all)',
            },
          },
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

      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const status = typeof args.status === 'string' && args.status !== 'all'
        ? args.status
        : undefined;

      try {
        const entries = productionsService.getChangelog(botId, { limit, status });
        const stats = productionsService.getStats(botId);

        const summary = [
          `## Production Stats`,
          `Total: ${stats.total} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Unreviewed: ${stats.unreviewed}`,
          stats.avgRating != null ? `Average Rating: ${stats.avgRating}/5` : '',
          '',
          `## Recent Productions (${entries.length} entries)`,
        ].filter(Boolean).join('\n');

        if (entries.length === 0) {
          return { success: true, content: summary + '\nNo entries found.' };
        }

        const lines = entries.map((e) => {
          const evalStr = e.evaluation
            ? `[${e.evaluation.status.toUpperCase()}${e.evaluation.rating ? ` ${e.evaluation.rating}/5` : ''}]${e.evaluation.feedback ? ` "${e.evaluation.feedback}"` : ''}`
            : '[UNREVIEWED]';
          return `- ${e.timestamp.slice(0, 16)} | ${e.action} | ${e.path} | ${evalStr}`;
        });

        return { success: true, content: summary + '\n' + lines.join('\n') };
      } catch (err) {
        logger.error({ err, botId }, 'Failed to read production log');
        return { success: false, content: `Error reading production log: ${err}` };
      }
    },
  };
}
