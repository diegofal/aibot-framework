import type { CronService } from '../cron';
import type { Tool, ToolResult } from './types';

export function createCronTool(cronService: CronService): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'cron',
        description: `Manage scheduled jobs and reminders. Use this to create, list, remove, or run cron jobs.

ACTIONS:
- "add": Create a new scheduled job/reminder. Requires: name, schedule, text.
- "list": List all active jobs.
- "remove": Delete a job. Requires: jobId.
- "run": Trigger a job immediately. Requires: jobId.
- "status": Check cron scheduler status.

SCHEDULE TYPES (schedule object):
- One-shot: { "kind": "at", "at": "<ISO-8601 timestamp>" } — fires once at the specified time, then auto-deletes.
- Interval: { "kind": "every", "everyMs": <milliseconds> } — fires repeatedly at the given interval.
- Cron expression: { "kind": "cron", "expr": "<5-field cron>", "tz": "<timezone>" } — standard cron schedule.

IMPORTANT: Always use get_datetime first to know the current time before calculating schedule timestamps.`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['add', 'list', 'remove', 'run', 'status'],
              description: 'The action to perform',
            },
            name: {
              type: 'string',
              description: 'Job name (for "add" action, e.g. "Drink water reminder")',
            },
            schedule: {
              type: 'object',
              description:
                'Schedule config. One of: { kind: "at", at: "<ISO-8601>" }, { kind: "every", everyMs: <ms> }, { kind: "cron", expr: "<cron>", tz: "<tz>" }',
              properties: {
                kind: { type: 'string', enum: ['at', 'every', 'cron'] },
                at: { type: 'string', description: 'ISO-8601 timestamp (for kind "at")' },
                everyMs: { type: 'number', description: 'Interval in ms (for kind "every")' },
                expr: { type: 'string', description: 'Cron expression (for kind "cron")' },
                tz: { type: 'string', description: 'Timezone (for kind "cron")' },
              },
            },
            text: {
              type: 'string',
              description: 'The reminder/message text to deliver when the job fires (for "add")',
            },
            deleteAfterRun: {
              type: 'boolean',
              description: 'Delete job after first execution (default true for one-shot "at" jobs)',
            },
            jobId: {
              type: 'string',
              description: 'Job ID (for "remove" and "run" actions)',
            },
            includeDisabled: {
              type: 'boolean',
              description: 'Include disabled jobs in list (for "list" action)',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args, logger): Promise<ToolResult> {
      const action = args.action as string;
      const _chatId = args._chatId as number | undefined;
      const _botId = args._botId as string | undefined;

      try {
        switch (action) {
          case 'status': {
            const status = await cronService.status();
            return { success: true, content: JSON.stringify(status) };
          }

          case 'list': {
            const includeDisabled = args.includeDisabled === true;
            const jobs = await cronService.list({ includeDisabled });
            const summary = jobs.map((j) => ({
              id: j.id,
              name: j.name,
              enabled: j.enabled,
              schedule: j.schedule,
              nextRunAtMs: j.state.nextRunAtMs,
              nextRunAt: j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
              lastStatus: j.state.lastStatus,
              payload:
                j.payload.kind === 'message'
                  ? { kind: 'message', text: j.payload.text }
                  : { kind: 'skillJob', skillId: j.payload.skillId, jobId: j.payload.jobId },
            }));
            return { success: true, content: JSON.stringify(summary) };
          }

          case 'add': {
            if (!_chatId || !_botId) {
              return {
                success: false,
                content: 'Internal error: missing chat context for cron add',
              };
            }

            const schedule = args.schedule as
              | { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string }
              | undefined;
            if (!schedule || !schedule.kind) {
              // Flat-params recovery: LLMs sometimes flatten schedule fields to top level
              const kind = args.kind as string | undefined;
              const at = args.at as string | undefined;
              const everyMs = args.everyMs as number | undefined;
              const expr = args.expr as string | undefined;
              const tz = args.tz as string | undefined;

              if (kind) {
                const recovered = { kind, at, everyMs, expr, tz };
                return await doAdd(cronService, args, recovered, _chatId, _botId, logger);
              }
              return { success: false, content: 'schedule is required for add action' };
            }

            return await doAdd(cronService, args, schedule, _chatId, _botId, logger);
          }

          case 'remove': {
            const jobId = (args.jobId ?? args.id) as string | undefined;
            if (!jobId) {
              return { success: false, content: 'jobId is required for remove action' };
            }
            const result = await cronService.remove(jobId);
            return {
              success: result.ok,
              content: result.removed
                ? `Job ${jobId} removed successfully.`
                : `Job ${jobId} not found.`,
            };
          }

          case 'run': {
            const jobId = (args.jobId ?? args.id) as string | undefined;
            if (!jobId) {
              return { success: false, content: 'jobId is required for run action' };
            }
            const result = await cronService.run(jobId, 'force');
            if (result.ran) {
              return { success: true, content: `Job ${jobId} executed successfully.` };
            }
            return {
              success: true,
              content: `Job ${jobId} was not executed: ${result.reason ?? 'unknown reason'}`,
            };
          }

          default:
            return { success: false, content: `Unknown action: ${action}` };
        }
      } catch (err) {
        logger.error({ err, action }, 'cron tool error');
        return { success: false, content: `Error: ${String(err)}` };
      }
    },
  };
}

async function doAdd(
  cronService: CronService,
  args: Record<string, unknown>,
  schedule: { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string },
  chatId: number,
  botId: string,
  logger: { info: (obj: unknown, msg?: string) => void }
): Promise<ToolResult> {
  const name = (args.name as string) || 'Reminder';
  const text = args.text as string | undefined;
  if (!text) {
    return { success: false, content: 'text is required for add action (the reminder message)' };
  }

  let cronSchedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; everyMs: number }
    | { kind: 'cron'; expr: string; tz?: string };

  if (schedule.kind === 'at') {
    if (!schedule.at) {
      return {
        success: false,
        content: 'schedule.at (ISO-8601 timestamp) is required for "at" schedule',
      };
    }
    cronSchedule = { kind: 'at', at: schedule.at };
  } else if (schedule.kind === 'every') {
    if (!schedule.everyMs || schedule.everyMs <= 0) {
      return {
        success: false,
        content: 'schedule.everyMs (positive number) is required for "every" schedule',
      };
    }
    cronSchedule = { kind: 'every', everyMs: schedule.everyMs };
  } else if (schedule.kind === 'cron') {
    if (!schedule.expr) {
      return {
        success: false,
        content: 'schedule.expr (cron expression) is required for "cron" schedule',
      };
    }
    cronSchedule = { kind: 'cron', expr: schedule.expr, tz: schedule.tz };
  } else {
    return {
      success: false,
      content: `Unknown schedule kind: ${schedule.kind}. Use "at", "every", or "cron".`,
    };
  }

  const deleteAfterRun = typeof args.deleteAfterRun === 'boolean' ? args.deleteAfterRun : undefined;

  const job = await cronService.add({
    name,
    enabled: true,
    deleteAfterRun,
    schedule: cronSchedule,
    payload: {
      kind: 'message',
      text,
      chatId,
      botId,
    },
  });

  logger.info(
    { jobId: job.id, jobName: job.name, nextRunAtMs: job.state.nextRunAtMs },
    'cron: job created via tool'
  );

  return {
    success: true,
    content: JSON.stringify({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      nextRunAt: job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
      deleteAfterRun: job.deleteAfterRun,
    }),
  };
}
