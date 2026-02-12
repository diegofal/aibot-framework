import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';

interface DatetimeToolConfig {
  timezone: string;
  locale: string;
}

export function createDatetimeTool(config: DatetimeToolConfig): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_datetime',
        description:
          'Get the current date and time. Returns a human-readable date, time, day of week, timezone, and ISO 8601 timestamp.',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                'IANA timezone override (e.g. "America/New_York", "Asia/Tokyo"). ' +
                'Omit to use the default timezone.',
            },
          },
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      logger: Logger,
    ): Promise<ToolResult> {
      try {
        const tz = typeof args.timezone === 'string' && args.timezone.trim()
          ? args.timezone.trim()
          : config.timezone;
        const locale = config.locale;

        const now = new Date();

        // Validate timezone by attempting to format with it
        let formatted: string;
        try {
          formatted = now.toLocaleString(locale, { timeZone: tz });
        } catch {
          return {
            success: false,
            content: `Invalid timezone: "${tz}". Use IANA format (e.g. "America/New_York").`,
          };
        }

        const dayOfWeek = now.toLocaleDateString(locale, { weekday: 'long', timeZone: tz });
        const date = now.toLocaleDateString(locale, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: tz,
        });
        const time = now.toLocaleTimeString(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: tz,
        });
        const iso = now.toISOString();

        const result = [
          `Date: ${date}`,
          `Time: ${time}`,
          `Day: ${dayOfWeek}`,
          `Timezone: ${tz}`,
          `ISO 8601: ${iso}`,
        ].join('\n');

        logger.info({ timezone: tz }, 'get_datetime executed');
        return { success: true, content: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'get_datetime failed');
        return { success: false, content: `Failed to get datetime: ${message}` };
      }
    },
  };
}
