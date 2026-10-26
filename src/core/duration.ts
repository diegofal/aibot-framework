/**
 * Duration strings the config uses (`agentLoop.every: '6h'`). Kept apart from
 * `src/bot/agent-loop.ts` so a reader (the watcher's autonomy allowlist) can
 * parse one without importing the bot runtime.
 */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit];
}
