/**
 * Server half of the create-an-agent wizard (session S6 of
 * docs/plans/jarvis-fleet-plan.md; the page is web/pages/agent-wizard.js).
 *
 * Pure pieces the `POST /api/agents` route composes:
 *   - four personality sliders -> the eight trait registers (mirrored in
 *     web/pages/agent-wizard-helpers.js; both test files share vectors),
 *   - sliders + quirks -> prose for the soul generator,
 *   - the purpose -> an initial GOALS.md the goals tool can parse,
 *   - writing a freshly generated soul (refusing to clobber one that exists),
 *   - seeding TRAITS.json where BotManager's TraitRegisters will read it,
 *   - channel token validation: shape only, plus an injected live `getMe`
 *     for Telegram so the route never talks to Telegram in tests.
 *
 * Slider -> trait mapping (0..1 sliders, 0.1..0.9 registers):
 *   warmth      -> sociability up,    independence down
 *   boldness    -> risk_tolerance up, caution down
 *   rigor       -> depth up,          persistence up
 *   playfulness -> creativity up,     curiosity up
 * `up` = 0.1 + 0.8·x, `down` = 0.9 − 0.8·x. 0.5 everywhere is the default set.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { GeneratedSoul } from '../soul-generator';
import { type GoalEntry, serializeGoals } from '../tools/goals';
import { writeGoalsFile } from './goal-events';
import { classifyTelegramToken } from './telegram-errors';
import {
  type TraitName,
  type TraitPolicy,
  TraitRegisters,
  type TraitSet,
  createDefaultTraits,
} from './trait-registers';

// ── Personality ──

export interface Personality {
  warmth: number;
  boldness: number;
  rigor: number;
  playfulness: number;
}

export type PersonalityAxis = keyof Personality;

interface AxisSpec {
  id: PersonalityAxis;
  low: string;
  high: string;
  drives: ReadonlyArray<readonly [TraitName, 1 | -1]>;
}

export const PERSONALITY_AXES: ReadonlyArray<AxisSpec> = [
  {
    id: 'warmth',
    low: 'reserved',
    high: 'warm',
    drives: [
      ['sociability', 1],
      ['independence', -1],
    ],
  },
  {
    id: 'boldness',
    low: 'careful',
    high: 'bold',
    drives: [
      ['risk_tolerance', 1],
      ['caution', -1],
    ],
  },
  {
    id: 'rigor',
    low: 'light-touch',
    high: 'thorough',
    drives: [
      ['depth', 1],
      ['persistence', 1],
    ],
  },
  {
    id: 'playfulness',
    low: 'serious',
    high: 'playful',
    drives: [
      ['creativity', 1],
      ['curiosity', 1],
    ],
  },
];

const TRAIT_MIN = 0.1;
const TRAIT_MAX = 0.9;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Every present axis must be a finite number; missing axes default to 0.5 later. */
export function isPersonality(value: unknown): value is Partial<Personality> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  for (const axis of PERSONALITY_AXES) {
    const n = v[axis.id];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n))) return false;
  }
  return true;
}

export function normalizePersonality(value: Partial<Personality> | null | undefined): Personality {
  const out = {} as Personality;
  for (const axis of PERSONALITY_AXES) {
    const n = value?.[axis.id];
    out[axis.id] = typeof n === 'number' && Number.isFinite(n) ? clamp01(n) : 0.5;
  }
  return out;
}

export function personalityToTraits(value: Partial<Personality>): TraitSet {
  const p = normalizePersonality(value);
  const out = createDefaultTraits();
  for (const axis of PERSONALITY_AXES) {
    const x = p[axis.id];
    for (const [trait, dir] of axis.drives) {
      const raw = dir > 0 ? TRAIT_MIN + 0.8 * x : TRAIT_MAX - 0.8 * x;
      out[trait] = round2(Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, raw)));
    }
  }
  return out;
}

/** Prose for the soul generator's `personalityDescription`. */
export function describePersonality(value: Partial<Personality>, quirks?: string): string {
  const p = normalizePersonality(value);
  const strong: string[] = [];
  const mild: string[] = [];
  for (const axis of PERSONALITY_AXES) {
    const x = p[axis.id];
    if (x <= 0.2) strong.push(`very ${axis.low}`);
    else if (x < 0.4) mild.push(axis.low);
    else if (x >= 0.8) strong.push(`very ${axis.high}`);
    else if (x > 0.6) mild.push(axis.high);
  }
  const words = [...strong, ...mild];
  const lines: string[] = [];
  if (words.length === 0) {
    lines.push(
      'A balanced character: neither reserved nor gushing, careful but not timid, thorough without being pedantic, and lightly playful.'
    );
  } else {
    lines.push(
      `Personality dials: ${words.join(', ')}${words.length < 4 ? '; balanced on the other axes' : ''}.`
    );
  }
  lines.push(
    `Numeric registers (0-1): warmth ${p.warmth.toFixed(2)}, boldness ${p.boldness.toFixed(2)}, rigor ${p.rigor.toFixed(2)}, playfulness ${p.playfulness.toFixed(2)}.`
  );
  const q = (quirks ?? '').trim();
  if (q) lines.push(`Quirks and habits the operator wants kept: ${q}`);
  return lines.join(' ');
}

// ── Soul files ──

export const WIZARD_SOUL_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md', 'GOALS.md'] as const;

/** The one goal every wizard-born agent starts with, derived from its purpose sentence. */
export function purposeGoalEntry(purpose: string): GoalEntry {
  const text = purpose.trim().replace(/\s+/g, ' ');
  return {
    text: `Live up to my purpose: ${text}`,
    status: 'active',
    priority: 'high',
    notes:
      'Set by the creation wizard. Refine into concrete goals as you learn what the operator needs.',
    source: 'wizard',
  };
}

/** GOALS.md with one active goal derived from the purpose sentence. */
export function initialGoalsMarkdown(purpose: string): string {
  return `${serializeGoals([purposeGoalEntry(purpose)], [])}\n`;
}

/**
 * Write a generated soul into `soulDir` (IDENTITY / SOUL / MOTIVATIONS, their
 * `.baseline` copies for reset, GOALS.md, an empty memory dir). Refuses when
 * any soul file already exists: the wizard creates, it never overwrites.
 * Returns the list of files written.
 */
export function writeWizardSoul(
  soulDir: string,
  soul: GeneratedSoul,
  goalsMarkdown: string
): string[] {
  for (const f of WIZARD_SOUL_FILES) {
    if (existsSync(join(soulDir, f))) {
      throw new Error(`Soul already exists at ${soulDir} (${f}); refusing to overwrite`);
    }
  }
  mkdirSync(join(soulDir, 'memory'), { recursive: true });
  mkdirSync(join(soulDir, '.baseline'), { recursive: true });
  const core: Array<[string, string]> = [
    ['IDENTITY.md', soul.identity],
    ['SOUL.md', soul.soul],
    ['MOTIVATIONS.md', soul.motivations],
  ];
  for (const [name, content] of core) {
    writeFileSync(join(soulDir, name), content, 'utf-8');
    writeFileSync(join(soulDir, '.baseline', name), content, 'utf-8');
  }
  writeGoalsFile(join(soulDir, 'GOALS.md'), goalsMarkdown, { actor: 'wizard' });
  return [...WIZARD_SOUL_FILES];
}

/**
 * Where BotManager builds its TraitRegisters: `<paths.data>/tenants/__admin__/bots`
 * (TRAITS.json lands at `<base>/<botId>/TRAITS.json`, a sibling of `soul/`).
 */
export function traitsBaseDirFor(config: Pick<Config, 'paths'>): string {
  const data = (config.paths as { data?: string } | undefined)?.data ?? './data';
  return join(data, 'tenants', '__admin__', 'bots');
}

export function seedTraits(
  baseDir: string,
  botId: string,
  traits: Partial<TraitSet>,
  logger: Logger,
  policy?: TraitPolicy
): TraitSet {
  const registers = new TraitRegisters(baseDir, logger, () => policy);
  return registers.seed(botId, traits);
}

// ── Channel tokens ──

export type ChannelKind = 'telegram' | 'whatsapp' | 'discord';
export const CHANNEL_KINDS: ReadonlyArray<ChannelKind> = ['telegram', 'whatsapp', 'discord'];

export type TokenState = 'ok' | 'shaped' | 'placeholder' | 'missing' | 'revoked' | 'error';

export interface TokenValidation {
  kind: ChannelKind;
  state: TokenState;
  /** Whether a live API call backed the verdict (Telegram `getMe` only). */
  live: boolean;
  detail: string;
  username?: string | null;
}

export type TelegramCheckResult =
  | { ok: true; username: string }
  | { ok: false; unauthorized: boolean; message: string };

export type TelegramTokenCheck = (token: string) => Promise<TelegramCheckResult>;

/** Discord bot tokens are three dot-separated url-safe parts. */
export const DISCORD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/;

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === 'string' && (CHANNEL_KINDS as string[]).includes(value);
}

const TELEGRAM_GETME_TIMEOUT_MS = 6_000;

/**
 * Live Telegram check: `getMe` with the token. Only the outcome leaves this
 * function — the token never appears in a message or a log line.
 */
export function createTelegramTokenCheck(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TELEGRAM_GETME_TIMEOUT_MS
): TelegramTokenCheck {
  return async (token) => {
    const scrub = (s: string) => s.split(token).join('<token>');
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { username?: string };
        description?: string;
        error_code?: number;
      };
      if (res.status === 200 && body.ok && body.result) {
        return { ok: true, username: body.result.username ?? '' };
      }
      const unauthorized = res.status === 401 || body.error_code === 401;
      return {
        ok: false,
        unauthorized,
        message: scrub(body.description ?? `Telegram answered HTTP ${res.status}`),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, unauthorized: false, message: scrub(message) };
    }
  };
}

/**
 * Validate a channel credential. Missing/placeholder verdicts come from the
 * shape alone and never touch the network; a shaped Telegram token is
 * checked live through `check` when one is provided (otherwise `shaped`).
 */
export async function validateChannelToken(
  kind: ChannelKind,
  token: string | null | undefined,
  check?: TelegramTokenCheck
): Promise<TokenValidation> {
  const trimmed = (token ?? '').trim();
  if (kind === 'telegram') {
    const cls = classifyTelegramToken(trimmed);
    if (cls === 'missing')
      return { kind, state: 'missing', live: false, detail: 'No token given.' };
    if (cls === 'placeholder') {
      return {
        kind,
        state: 'placeholder',
        live: false,
        detail: 'Not a Telegram bot token (expected <digits>:<secret>).',
      };
    }
    if (!check)
      return {
        kind,
        state: 'shaped',
        live: false,
        detail: 'Looks like a token; not checked live.',
      };
    try {
      const r = await check(trimmed);
      if (r.ok) {
        return {
          kind,
          state: 'ok',
          live: true,
          detail: 'Telegram accepted the token.',
          username: r.username,
        };
      }
      return {
        kind,
        state: r.unauthorized ? 'revoked' : 'error',
        live: true,
        detail: r.message,
        username: null,
      };
    } catch (err) {
      return {
        kind,
        state: 'error',
        live: true,
        detail: err instanceof Error ? err.message : String(err),
        username: null,
      };
    }
  }
  if (trimmed === '') return { kind, state: 'missing', live: false, detail: 'No token given.' };
  if (kind === 'discord') {
    return DISCORD_TOKEN_PATTERN.test(trimmed)
      ? {
          kind,
          state: 'shaped',
          live: false,
          detail: 'Looks like a Discord bot token; not checked live.',
        }
      : {
          kind,
          state: 'placeholder',
          live: false,
          detail: 'Not a Discord bot token (three dot-separated parts).',
        };
  }
  return { kind, state: 'shaped', live: false, detail: 'Access token present; not checked live.' };
}
