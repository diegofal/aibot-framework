import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

/**
 * Tests for the auto-restart timer tracking in BotManager.
 *
 * Since BotManager requires complex infrastructure (grammy, LLM clients, etc.),
 * these tests exercise the timer tracking logic in isolation by extracting the
 * relevant behavior into a minimal test harness.
 */

describe('BotManager auto-restart timer tracking', () => {
  // Simulate the timer tracking maps from BotManager
  let restartTimers: Map<string, ReturnType<typeof setTimeout>>;
  let restartAttempts: Map<string, number[]>;
  let restartedBots: string[];

  beforeEach(() => {
    restartTimers = new Map();
    restartAttempts = new Map();
    restartedBots = [];
  });

  afterEach(() => {
    // Clean up any timers
    for (const [, timer] of restartTimers) { clearTimeout(timer); }
    restartTimers.clear();
  });

  function scheduleRestart(botId: string, delayMs: number): void {
    const now = Date.now();
    const recent = (restartAttempts.get(botId) ?? [])
      .filter(t => now - t < 5 * 60_000);

    if (recent.length >= 3) {
      restartAttempts.delete(botId);
      return;
    }
    restartAttempts.set(botId, [...recent, now]);

    const timer = setTimeout(() => {
      restartTimers.delete(botId);
      restartedBots.push(botId);
    }, delayMs);
    restartTimers.set(botId, timer);
  }

  function cancelRestart(botId: string): void {
    const timer = restartTimers.get(botId);
    if (timer) { clearTimeout(timer); restartTimers.delete(botId); }
    restartAttempts.delete(botId);
  }

  it('timer fires and restarts after delay', async () => {
    scheduleRestart('bot1', 50);
    expect(restartTimers.has('bot1')).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(restartedBots).toContain('bot1');
    expect(restartTimers.has('bot1')).toBe(false); // cleaned up
  });

  it('stopBot during delay window cancels restart', async () => {
    scheduleRestart('bot1', 200);
    expect(restartTimers.has('bot1')).toBe(true);

    // Simulate stopBot: cancel the timer before it fires
    cancelRestart('bot1');
    expect(restartTimers.has('bot1')).toBe(false);

    await new Promise((r) => setTimeout(r, 300));
    expect(restartedBots).not.toContain('bot1');
  });

  it('multiple restart attempts respect the sliding window limit', () => {
    // Simulate 3 rapid restart attempts
    for (let i = 0; i < 3; i++) {
      scheduleRestart('bot1', 10_000);
      // Clear timer for next attempt
      const timer = restartTimers.get('bot1');
      if (timer) clearTimeout(timer);
      restartTimers.delete('bot1');
    }

    // 4th attempt should be blocked
    scheduleRestart('bot1', 10_000);
    expect(restartTimers.has('bot1')).toBe(false); // blocked by limit
    expect(restartAttempts.has('bot1')).toBe(false); // cleaned up after max reached
  });

  it('timer cleans itself from map after firing', async () => {
    scheduleRestart('bot1', 20);
    expect(restartTimers.size).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(restartTimers.size).toBe(0);
  });

  it('multiple bots can have independent restart timers', async () => {
    scheduleRestart('bot1', 30);
    scheduleRestart('bot2', 60);
    expect(restartTimers.size).toBe(2);

    // Cancel bot1 but let bot2 fire
    cancelRestart('bot1');

    await new Promise((r) => setTimeout(r, 100));
    expect(restartedBots).not.toContain('bot1');
    expect(restartedBots).toContain('bot2');
  });
});
