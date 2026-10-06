/**
 * src/bot/agent-wizard.ts — the server half of the create-an-agent wizard
 * (session S6). The slider -> trait vectors mirror
 * tests/web/agent-wizard-helpers.test.ts so TRAITS.json always matches what
 * the wizard previewed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISCORD_TOKEN_PATTERN,
  PERSONALITY_AXES,
  WIZARD_SOUL_FILES,
  createTelegramTokenCheck,
  describePersonality,
  initialGoalsMarkdown,
  isPersonality,
  normalizePersonality,
  personalityToTraits,
  seedTraits,
  traitsBaseDirFor,
  validateChannelToken,
  writeWizardSoul,
} from '../../src/bot/agent-wizard';
import { readGoalEvents } from '../../src/bot/goal-events';
import { TraitRegisters, createDefaultTraits } from '../../src/bot/trait-registers';
import type { Config } from '../../src/config';
import { parseGoals } from '../../src/tools/goals';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
} as never;

const SHAPED = `123456789:${'a'.repeat(35)}`;

describe('personality -> traits', () => {
  it('neutral sliders give the default trait set', () => {
    expect(
      personalityToTraits({ warmth: 0.5, boldness: 0.5, rigor: 0.5, playfulness: 0.5 })
    ).toEqual(createDefaultTraits());
  });
  it('shared fixture vector (mirrored in the web helper test)', () => {
    expect(
      personalityToTraits({ warmth: 0.75, boldness: 0.25, rigor: 0.5, playfulness: 1 })
    ).toEqual({
      sociability: 0.7,
      independence: 0.3,
      risk_tolerance: 0.3,
      caution: 0.7,
      depth: 0.5,
      persistence: 0.5,
      creativity: 0.9,
      curiosity: 0.9,
    });
  });
  it('clamps to the 0.1..0.9 register bounds and mirrors around the midpoint', () => {
    const hi = personalityToTraits({ warmth: 9, boldness: 9, rigor: 9, playfulness: 9 });
    const lo = personalityToTraits({ warmth: -9, boldness: -9, rigor: -9, playfulness: -9 });
    for (const k of Object.keys(hi) as Array<keyof typeof hi>) {
      expect(hi[k]).toBeGreaterThanOrEqual(0.1);
      expect(hi[k]).toBeLessThanOrEqual(0.9);
      expect(+(hi[k] + lo[k]).toFixed(2)).toBe(1);
    }
    expect(PERSONALITY_AXES.flatMap((a) => a.drives.map((d) => d[0])).length).toBe(8);
  });
  it('isPersonality / normalizePersonality accept partial input and reject junk', () => {
    expect(isPersonality({ warmth: 1, boldness: 0, rigor: 0.5, playfulness: 0.2 })).toBe(true);
    expect(isPersonality({ warmth: 'x' })).toBe(false);
    expect(isPersonality(null)).toBe(false);
    expect(normalizePersonality({ warmth: 2, rigor: -1 })).toEqual({
      warmth: 1,
      boldness: 0.5,
      rigor: 0,
      playfulness: 0.5,
    });
  });
});

describe('describePersonality', () => {
  it('turns sliders and quirks into prose for the soul generator', () => {
    const s = describePersonality(
      { warmth: 0.9, boldness: 0.1, rigor: 0.5, playfulness: 0.8 },
      'Loves puns'
    );
    expect(s).toMatch(/warm/i);
    expect(s).toMatch(/careful/i);
    expect(s).toMatch(/playful/i);
    expect(s).toContain('Loves puns');
    expect(
      describePersonality({ warmth: 0.5, boldness: 0.5, rigor: 0.5, playfulness: 0.5 })
    ).toMatch(/balanced/i);
  });
});

describe('initialGoalsMarkdown', () => {
  it('writes one active goal from the purpose that the goals parser reads back', () => {
    const md = initialGoalsMarkdown('Keep my reading list alive.');
    const { active, completed } = parseGoals(md);
    expect(active.length).toBe(1);
    expect(active[0].text).toContain('Keep my reading list alive.');
    expect(active[0].status).toBe('active');
    expect(active[0].source).toBe('wizard');
    expect(completed).toEqual([]);
  });
});

describe('writeWizardSoul / seedTraits', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('agent-wizard');
  });
  afterEach(() => removeTempDir(dir));

  it('writes the four soul files, the baseline copies and a memory dir', () => {
    const soulDir = join(dir, 'bots', 'ada', 'soul');
    const files = writeWizardSoul(
      soulDir,
      { identity: 'name: Ada', soul: '## Personality', motivations: '## Core Drives' },
      'Keep going.'
    );
    expect(files).toEqual(WIZARD_SOUL_FILES);
    expect(readFileSync(join(soulDir, 'IDENTITY.md'), 'utf-8')).toBe('name: Ada');
    expect(readFileSync(join(soulDir, '.baseline', 'SOUL.md'), 'utf-8')).toBe('## Personality');
    expect(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8')).toContain('Keep going.');
    expect(existsSync(join(soulDir, 'memory'))).toBe(true);
  });

  it('refuses to overwrite an existing soul', () => {
    const soulDir = join(dir, 'soul');
    writeWizardSoul(soulDir, { identity: 'a', soul: 'b', motivations: 'c' }, 'x');
    expect(() =>
      writeWizardSoul(soulDir, { identity: 'z', soul: 'z', motivations: 'z' }, 'x')
    ).toThrow(/already/);
    expect(readFileSync(join(soulDir, 'IDENTITY.md'), 'utf-8')).toBe('a');
  });

  it('seedTraits writes TRAITS.json in the TraitRegisters format, as the drift baseline', () => {
    const traits = personalityToTraits({ warmth: 1, boldness: 0, rigor: 0.5, playfulness: 0.5 });
    const written = seedTraits(dir, 'ada', traits, nullLogger);
    expect(written.sociability).toBe(0.9);
    const file = JSON.parse(readFileSync(join(dir, 'ada', 'TRAITS.json'), 'utf-8'));
    expect(file.current).toEqual(traits);
    expect(file.history.length).toBe(1);
    expect(file.history[0].source).toBe('adaptive');
    // A fresh registers instance reads the seed back and reports zero drift.
    const reg = new TraitRegisters(dir, nullLogger);
    expect(reg.load('ada')).toEqual(traits);
    expect(Object.values(reg.getDrift('ada').delta).every((d) => d === 0)).toBe(true);
  });

  it('seedTraits respects operator pins', () => {
    const traits = personalityToTraits({ warmth: 1, boldness: 1, rigor: 1, playfulness: 1 });
    const written = seedTraits(dir, 'ada', traits, nullLogger, { pinned: { caution: 0.8 } });
    expect(written.caution).toBe(0.8);
    expect(written.depth).toBe(0.9);
  });

  it('traitsBaseDirFor follows BotManager: <paths.data>/tenants/__admin__/bots', () => {
    expect(traitsBaseDirFor({ paths: { data: '/srv/data' } } as unknown as Config)).toBe(
      join('/srv/data', 'tenants', '__admin__', 'bots')
    );
    expect(traitsBaseDirFor({} as Config)).toBe(join('./data', 'tenants', '__admin__', 'bots'));
  });
});

describe('validateChannelToken', () => {
  const never = async () => {
    throw new Error('checker must not be called');
  };

  it('never calls Telegram for a missing or placeholder token', async () => {
    expect(await validateChannelToken('telegram', '', never)).toMatchObject({
      kind: 'telegram',
      state: 'missing',
      live: false,
    });
    expect(await validateChannelToken('telegram', 'nothing', never)).toMatchObject({
      state: 'placeholder',
      live: false,
    });
  });

  it('a shaped Telegram token goes to the injected checker', async () => {
    const calls: string[] = [];
    const ok = await validateChannelToken('telegram', ` ${SHAPED} `, async (t) => {
      calls.push(t);
      return { ok: true, username: 'ada_bot' };
    });
    expect(calls).toEqual([SHAPED]);
    expect(ok).toMatchObject({ state: 'ok', username: 'ada_bot', live: true });

    const revoked = await validateChannelToken('telegram', SHAPED, async () => ({
      ok: false,
      unauthorized: true,
      message: '401 Unauthorized',
    }));
    expect(revoked).toMatchObject({ state: 'revoked', live: true });
    expect(revoked.detail).toContain('401');

    const down = await validateChannelToken('telegram', SHAPED, async () => ({
      ok: false,
      unauthorized: false,
      message: 'fetch failed',
    }));
    expect(down).toMatchObject({ state: 'error', live: true });

    const threw = await validateChannelToken('telegram', SHAPED, async () => {
      throw new Error('boom');
    });
    expect(threw).toMatchObject({ state: 'error' });
    expect(threw.detail).toContain('boom');
  });

  it('without a checker a shaped Telegram token is reported as shaped', async () => {
    expect(await validateChannelToken('telegram', SHAPED)).toMatchObject({
      state: 'shaped',
      live: false,
    });
  });

  it('Discord and WhatsApp are shape-only', async () => {
    const d = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
    expect(DISCORD_TOKEN_PATTERN.test(d)).toBe(true);
    expect(await validateChannelToken('discord', d, never)).toMatchObject({
      state: 'shaped',
      live: false,
    });
    expect(await validateChannelToken('discord', 'abc', never)).toMatchObject({
      state: 'placeholder',
    });
    expect(await validateChannelToken('whatsapp', 'EAAB', never)).toMatchObject({
      state: 'shaped',
    });
    expect(await validateChannelToken('whatsapp', '  ', never)).toMatchObject({ state: 'missing' });
  });
});

describe('createTelegramTokenCheck', () => {
  const res = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('calls getMe with the token and reads the username', async () => {
    const urls: string[] = [];
    const check = createTelegramTokenCheck(async (url) => {
      urls.push(String(url));
      return res(200, { ok: true, result: { username: 'ada_bot', id: 1 } });
    });
    expect(await check(SHAPED)).toEqual({ ok: true, username: 'ada_bot' });
    expect(urls[0]).toBe(`https://api.telegram.org/bot${SHAPED}/getMe`);
  });
  it('401 is unauthorized, anything else is a plain failure', async () => {
    const bad = createTelegramTokenCheck(async () =>
      res(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    );
    expect(await bad(SHAPED)).toEqual({ ok: false, unauthorized: true, message: 'Unauthorized' });
    const flaky = createTelegramTokenCheck(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await flaky(SHAPED)).toMatchObject({ ok: false, unauthorized: false });
    const weird = createTelegramTokenCheck(async () => res(500, { ok: false }));
    expect(await weird(SHAPED)).toMatchObject({ ok: false, unauthorized: false });
  });
  it('the token never appears in the failure message', async () => {
    const flaky = createTelegramTokenCheck(async () => {
      throw new Error(`fetch failed for ${SHAPED}`);
    });
    const r = await flaky(SHAPED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(SHAPED);
  });
});

describe('writeWizardSoul goal events', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('agent-wizard-events');
  });
  afterEach(() => removeTempDir(dir));

  it('logs the initial goals as added by the wizard, with ids', () => {
    const soulDir = join(dir, 'soul');
    writeWizardSoul(
      soulDir,
      { identity: 'a', soul: 'b', motivations: 'c' },
      initialGoalsMarkdown('Help Diego ship')
    );
    const evs = readGoalEvents(soulDir);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.op === 'add' && e.actor === 'wizard' && /^g-/.test(e.goalId))).toBe(
      true
    );
  });
});
