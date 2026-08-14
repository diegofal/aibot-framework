#!/usr/bin/env bun
/**
 * Non-destructive Telegram token probe. Run it before enabling any bot.
 *
 *   docker compose exec -T aibot bun /app/scripts/docker/telegram-probe.ts
 *
 * Telegram allows exactly one getUpdates consumer per token. If a bot is
 * already live somewhere else — another machine, an old container, a stray
 * `bun run src/index.ts` — starting a second one makes both flap with HTTP 409
 * and silently drops messages. This tells you which tokens are real and
 * whether anything is currently draining them.
 *
 * Only getMe and getWebhookInfo are called. Both are pure reads: no updates
 * consumed, no offsets confirmed, no long poll terminated. getUpdates is
 * deliberately avoided — it is not a trustworthy conflict detector, because
 * Telegram may terminate the *existing* consumer instead of rejecting the
 * probe, so it can knock a live bot offline and still report "clear".
 *
 * THE SAFE CUTOVER TEST
 *   1. Run this and note pending for the bot you want to enable.
 *   2. Send it a Telegram message from your phone.
 *   3. Run this again.
 *      pending went up  -> nothing is consuming; safe to enable here.
 *      pending stayed 0 -> something else owns the token. Find and stop it
 *                          first, or you will 409-fight your own bot.
 */
import { readFileSync } from 'node:fs';

interface Bot {
  id: string;
  token: string;
  enabled?: boolean;
}

const CONFIG = process.env.AIBOT_CONFIG_DIR ?? '/app/config';
const bots = JSON.parse(readFileSync(`${CONFIG}/bots.json`, 'utf-8')) as Bot[];

const resolveToken = (t: string): string =>
  (t ?? '').replace(/\$\{([^}]+)\}/g, (_, v) => process.env[v] ?? '');

/** Telegram echoes the token back in some error strings. Never let it print. */
const scrub = (s: unknown): string =>
  String(s ?? '').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<token>');

async function call(token: string, method: string): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    signal: AbortSignal.timeout(20_000),
  });
  return res.json();
}

const rows: string[] = [];
let liveCapable = 0;

for (const bot of bots) {
  const token = resolveToken(bot.token);
  const id = bot.id.padEnd(16);
  const en = (bot.enabled ? 'yes' : 'no').padEnd(7);

  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    const why = bot.token?.startsWith('${')
      ? `env var ${bot.token} is unset`
      : 'placeholder, not a Telegram token';
    rows.push(`${id} ${en} NO TELEGRAM   ${why}`);
    continue;
  }

  try {
    const me = await call(token, 'getMe');
    if (!me.ok) {
      rows.push(`${id} ${en} REJECTED      HTTP ${me.error_code}: ${scrub(me.description)}`);
      continue;
    }
    const hook = await call(token, 'getWebhookInfo');
    const mode = hook.result?.url ? 'webhook set' : 'polling';
    const pending = hook.result?.pending_update_count ?? 0;
    const err = hook.result?.last_error_message
      ? `  last_error="${scrub(hook.result.last_error_message)}"`
      : '';
    liveCapable++;
    rows.push(
      `${id} ${en} OK            @${String(me.result.username).padEnd(22)} ${mode.padEnd(12)} pending=${pending}${err}`
    );
  } catch (e) {
    rows.push(`${id} ${en} ERROR         ${scrub((e as Error).message)}`);
  }
}

console.log('bot              enabled status        detail');
console.log('---------------- ------- ------------- ------------------------------------------');
for (const r of rows) console.log(r);
console.log(`\n${liveCapable} of ${bots.length} bots have a working Telegram token.`);
console.log('Bots without one still run agent loops; they just have no chat channel.');
console.log('\nBefore enabling: message the bot, re-run this, and confirm pending increased.');
