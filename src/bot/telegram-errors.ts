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

// ---------------------------------------------------------------------------
// Channel state
//
// The August 2026 audit found seven of eight bots logging the same "Telegram
// start failed — falling back to headless mode" line, and nothing downstream
// could tell a token BotFather had revoked (401) from the literal string
// "nothing" an operator typed as a placeholder. The states below make that
// distinction explicit, and the one rule that matters operationally is that a
// token which cannot possibly be valid never reaches Telegram at all.
// ---------------------------------------------------------------------------

export type ChannelState = 'ok' | 'revoked' | 'placeholder' | 'missing' | 'error';

export interface ChannelStatus {
  kind: 'telegram' | 'headless';
  state: ChannelState;
  /** Operator-facing cause for `revoked` / `error`; null otherwise. */
  lastError: string | null;
  /** ISO timestamp of the last start attempt; null when the status is derived from config alone. */
  checkedAt: string | null;
}

/** Bot tokens are `<numeric bot id>:<secret>`; the secret is 35 chars today, 30 leaves slack. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export type TelegramTokenClass = 'missing' | 'placeholder' | 'shaped';

/**
 * `missing` is empty/null/undefined, `placeholder` is any other string that
 * cannot be a token ("empty", "nothing", the bot id), `shaped` is something
 * only Telegram can judge.
 */
export function classifyTelegramToken(token: string | null | undefined): TelegramTokenClass {
  const trimmed = token?.trim() ?? '';
  if (trimmed === '') return 'missing';
  return TELEGRAM_TOKEN_PATTERN.test(trimmed) ? 'shaped' : 'placeholder';
}

/** A start failure on a real-shaped token: 401 means revoked, everything else is `error`. */
export function channelStateFromStartFailure(err: unknown): 'revoked' | 'error' {
  return isTelegramUnauthorizedError(err) ? 'revoked' : 'error';
}

/**
 * Status a bot would have without ever being started. Deterministic for
 * missing/placeholder tokens; undefined for a shaped token, because whether
 * it is `ok` or `revoked` is Telegram's call.
 */
export function channelStatusForUnstartedToken(
  token: string | null | undefined
): ChannelStatus | undefined {
  const cls = classifyTelegramToken(token);
  if (cls === 'shaped') return undefined;
  return { kind: 'headless', state: cls, lastError: null, checkedAt: null };
}

export interface ResolveChannelStartOpts {
  botId: string;
  token: string | null | undefined;
  /** Brings the Telegram side up (getMe, handlers, poller). Only called for a shaped token. */
  startTelegram: (token: string) => Promise<void>;
  logger: Pick<import('../logger').Logger, 'info' | 'warn'>;
  now?: () => Date;
}

/**
 * Decide and perform the channel start for one bot. Never throws: a Telegram
 * failure becomes a headless start with the reason recorded, which is what
 * the dashboard and the auto-start summary need to show.
 */
export async function resolveChannelStart(opts: ResolveChannelStartOpts): Promise<ChannelStatus> {
  const checkedAt = (opts.now ?? (() => new Date()))().toISOString();
  const cls = classifyTelegramToken(opts.token);

  if (cls !== 'shaped') {
    opts.logger.info(
      { botId: opts.botId, channelState: cls },
      `Bot ${opts.botId} starting headless (no Telegram token)`
    );
    return { kind: 'headless', state: cls, lastError: null, checkedAt };
  }

  try {
    await opts.startTelegram((opts.token as string).trim());
    return { kind: 'telegram', state: 'ok', lastError: null, checkedAt };
  } catch (err) {
    // Every non-401 failure used to be reported as "token invalid", which
    // sends the operator to rotate a perfectly good token. That matters more
    // now that this path runs unattended at boot, when the most likely causes
    // are a still-running previous instance (409) and an API that is not
    // reachable yet.
    const state = channelStateFromStartFailure(err);
    const lastError = describeTelegramStartFailure(err);
    opts.logger.warn(
      { err, botId: opts.botId, channelState: state },
      `Telegram start failed — falling back to headless mode. ${lastError}`
    );
    return { kind: 'headless', state, lastError, checkedAt };
  }
}
