import { type Bot, GrammyError } from 'grammy';
import type { Logger } from '../logger';

/** Brief pause between polls to prevent Telegram server-side session overlap → 409 */
const POLL_INTERVAL_MS = 500;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * Custom Telegram polling loop that replaces grammy's bot.start().
 * Calls getUpdates directly and feeds updates to bot.handleUpdate().
 * grammy's handlePollingError is never invoked — we handle 409 with backoff.
 */
export class TelegramPoller {
  private sleep: SleepFn;

  constructor(
    private logger: Logger,
    opts?: { sleep?: SleepFn }
  ) {
    this.sleep = opts?.sleep ?? abortableSleep;
  }

  async start(bot: Bot, botId: string, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let consecutive409 = 0;
    let first409At = 0;
    const MAX_409_CONSECUTIVE = 20;
    const MAX_409_DURATION_MS = 5 * 60_000;

    // Match grammy's internal behavior: clear any webhook before polling
    await bot.api.deleteWebhook();

    while (!signal.aborted) {
      try {
        const updates = await bot.api.getUpdates({ offset, limit: 100, timeout: 30 }, signal);

        // Success — reset 409 tracking
        consecutive409 = 0;
        first409At = 0;

        if (updates.length === 0) {
          // Inter-poll pause before next getUpdates (prevents session overlap → 409)
          if (!signal.aborted) await this.sleep(POLL_INTERVAL_MS, signal);
          continue;
        }

        // Advance offset BEFORE handling (prevents infinite crash loop on poisoned update)
        offset = updates[updates.length - 1].update_id + 1;

        for (const update of updates) {
          try {
            await bot.handleUpdate(update);
          } catch (err) {
            this.logger.error(
              { err, updateId: update.update_id, botId },
              'Error handling update (non-fatal)'
            );
          }
        }
      } catch (err) {
        if (signal.aborted) break;

        // Classify the error
        const is409 = err instanceof GrammyError && err.error_code === 409;
        const is401 = err instanceof GrammyError && err.error_code === 401;
        const is429 = err instanceof GrammyError && err.error_code === 429;

        if (is401) {
          throw err; // Bad token — unrecoverable
        }

        if (is409) {
          consecutive409++;
          if (first409At === 0) first409At = Date.now();

          const elapsed = Date.now() - first409At;
          if (consecutive409 >= MAX_409_CONSECUTIVE || elapsed >= MAX_409_DURATION_MS) {
            this.logger.error(
              { botId, consecutive409, elapsedMs: elapsed },
              'Sustained 409 conflict — giving up'
            );
            throw err;
          }

          const delay = Math.min(3_000 * consecutive409, 30_000);
          if (consecutive409 <= 2) {
            this.logger.debug(
              { botId, attempt: consecutive409, delay },
              'getUpdates 409 — backing off'
            );
          } else {
            this.logger.warn(
              { botId, attempt: consecutive409, delay },
              'getUpdates 409 — backing off'
            );
          }
          await this.sleep(delay, signal);
          continue;
        }

        if (is429) {
          const retryAfter =
            (err as GrammyError & { parameters?: { retry_after?: number } }).parameters
              ?.retry_after ?? 10;
          this.logger.warn({ botId, retryAfter }, 'Rate limited — respecting retry_after');
          await this.sleep(retryAfter * 1000, signal);
          continue;
        }

        // Other transient errors — brief backoff
        this.logger.warn({ err, botId }, 'getUpdates error — retrying in 3s');
        await this.sleep(3_000, signal);
      }

      // Brief pause between polls to prevent Telegram session overlap → 409
      if (!signal.aborted) await this.sleep(POLL_INTERVAL_MS, signal);
    }
  }
}
