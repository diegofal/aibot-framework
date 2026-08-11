/**
 * Classification of Telegram Bot API failures, shared by the poller, the bot
 * manager and boot-time auto-start so the same condition is always reported
 * with the same words.
 *
 * The case that earns its own module is 409 Conflict. Telegram allows exactly
 * one active `getUpdates` consumer per bot token; the second one gets 409 and
 * both flap, so the symptom presents as "the bot is flaky" rather than as a
 * misconfiguration. It is also the single most likely failure of an automatic
 * boot-time start during a botched cutover, when the previous instance is
 * still alive. A generic "polling failed" line sends the operator to debug the
 * wrong thing.
 */

/** Detection is structural, not `instanceof GrammyError`: the error may arrive
 * wrapped by a retry layer, re-thrown across a promise chain, or reconstructed
 * from a log payload, and the code is the fact worth matching. */
function errorCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { error_code?: unknown }).error_code;
  return typeof code === 'number' ? code : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function isTelegramConflictError(err: unknown): boolean {
  if (errorCodeOf(err) === 409) return true;
  const message = messageOf(err);
  return (
    /terminated by other getupdates/i.test(message) ||
    /\b409\b.*conflict|conflict.*\b409\b/i.test(message)
  );
}

export function isTelegramUnauthorizedError(err: unknown): boolean {
  if (errorCodeOf(err) === 401) return true;
  return /\b401\b/.test(messageOf(err)) && /unauthorized/i.test(messageOf(err));
}

/**
 * The one sentence an operator needs when two consumers share a token. Kept as
 * a constant so the poller, the restart path and auto-start cannot drift into
 * three differently-worded versions of the same diagnosis.
 */
export const TELEGRAM_CONFLICT_EXPLANATION =
  'ANOTHER PROCESS IS ALREADY POLLING THIS BOT TOKEN (Telegram 409 Conflict). ' +
  'Telegram allows exactly one active getUpdates consumer per token, so this instance cannot win: ' +
  'find and stop the other one — most often the previous deployment still running, a second container, ' +
  'or a stray `bun run src/index.ts`. Verify with: ' +
  'curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=0&offset=-1" (409 means someone else holds it).';

/** Human-readable cause for a failure raised while bringing a bot up. */
export function describeTelegramStartFailure(err: unknown): string {
  if (isTelegramConflictError(err)) return TELEGRAM_CONFLICT_EXPLANATION;
  if (isTelegramUnauthorizedError(err)) {
    return 'Telegram rejected the bot token (401 Unauthorized) — it is wrong, revoked, or belongs to a deleted bot.';
  }
  return `Telegram API call failed: ${messageOf(err)}`;
}
