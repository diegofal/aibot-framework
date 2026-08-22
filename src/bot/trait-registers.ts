/**
 * Trait Registers — Mechanical personality parameters.
 *
 * Numeric traits (0.0-1.0) persisted as TRAITS.json in the soul directory.
 * These traits mechanically alter agent loop parameters (temperature, tool
 * selection, frequency) — they are NOT prompt text. The LLM can propose
 * trait adjustments via the strategist or reflection skill.
 *
 * Operators can declare a per-bot `TraitPolicy` (bot config `traits`):
 * `pinned` values win on load and after every adjustment, `locked` traits
 * silently drop strategist/adaptive deltas. This keeps a reactive identity
 * from drifting toward "more sociable" just because nobody is talking to it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';

// ── Types ──

export interface TraitSet {
  /** Web search / research tool selection weight */
  curiosity: number;
  /** Inversely affects executor temperature (high caution = lower temp) */
  caution: number;
  /** Affects ask_human frequency and proactive outreach */
  sociability: number;
  /** Idle cycles before goal abandonment */
  persistence: number;
  /** Affects planner temperature */
  creativity: number;
  /** Cycles before human check-in */
  independence: number;
  /** Max tool rounds per execution */
  depth: number;
  /** Willingness to try new tool patterns (novelty karma weight) */
  risk_tolerance: number;
}

export type TraitName = keyof TraitSet;

export interface DerivedParameters {
  executorTemperature: number;
  plannerTemperature: number;
  askHumanCheckInCycles: number;
  maxToolRoundsBonus: number;
  webToolAlwaysIncluded: boolean;
  idleCyclesBeforeAbandon: number;
}

/** `pinned` is written by the framework when an operator pin overrides a stored value */
export type TraitSource = 'strategist' | 'reflection' | 'adaptive' | 'pinned';

/** Operator guard rails for one bot (bot config `traits`) */
export interface TraitPolicy {
  pinned?: Partial<Record<TraitName, number>>;
  locked?: TraitName[];
}

export type TraitPolicyResolver = (botId: string) => TraitPolicy | undefined;

/** How far the current traits have moved from their first persisted snapshot */
export interface TraitDrift {
  baseline: TraitSet;
  current: TraitSet;
  delta: Record<TraitName, number>;
}

interface TraitSnapshot {
  timestamp: number;
  source: TraitSource;
  traits: TraitSet;
}

interface TraitFile {
  current: TraitSet;
  history: TraitSnapshot[];
}

// ── Constants ──

const TRAIT_NAMES: TraitName[] = [
  'curiosity',
  'caution',
  'sociability',
  'persistence',
  'creativity',
  'independence',
  'depth',
  'risk_tolerance',
];

const CLAMP_MIN = 0.1;
const CLAMP_MAX = 0.9;
const MAX_HISTORY = 10;

/** Maximum absolute delta per adjustment, by source */
const MAX_DELTA: Record<TraitSource, number> = {
  strategist: 0.05,
  reflection: 0.15,
  adaptive: 0.03,
  pinned: 1,
};

// ── Default traits ──

export function createDefaultTraits(): TraitSet {
  return {
    curiosity: 0.5,
    caution: 0.5,
    sociability: 0.5,
    persistence: 0.5,
    creativity: 0.5,
    independence: 0.5,
    depth: 0.5,
    risk_tolerance: 0.5,
  };
}

// ── Derived parameters ──

/**
 * Compute mechanical parameters from trait values.
 * These replace hardcoded values in the agent loop.
 */
export function deriveParameters(traits: TraitSet): DerivedParameters {
  return {
    // Higher creativity → higher temperature (0.4–1.0)
    executorTemperature: 0.4 + traits.creativity * 0.6,
    // Higher creativity → higher planner temp (0.15–0.5)
    plannerTemperature: 0.15 + traits.creativity * 0.35,
    // Higher independence → more cycles before check-in (3–13)
    askHumanCheckInCycles: Math.round(3 + traits.independence * 10),
    // Higher depth → more tool rounds (0–15 bonus)
    maxToolRoundsBonus: Math.round(traits.depth * 15),
    // High curiosity → always include web tools
    webToolAlwaysIncluded: traits.curiosity > 0.7,
    // Higher persistence → more idle cycles before abandoning (3–15)
    idleCyclesBeforeAbandon: Math.round(3 + traits.persistence * 12),
  };
}

// ── TraitRegisters class ──

export class TraitRegisters {
  /** In-memory cache: botId → TraitSet */
  private cache = new Map<string, TraitSet>();
  /** Explicit per-bot policies (take precedence over the resolver) */
  private policies = new Map<string, TraitPolicy | undefined>();

  constructor(
    private soulBaseDir: string,
    private logger: Logger,
    private policyResolver?: TraitPolicyResolver
  ) {}

  /**
   * Set (or clear with `undefined`) the policy for a bot. Invalidates the
   * cache so the next `load` re-applies pins.
   */
  setPolicy(botId: string, policy: TraitPolicy | undefined): void {
    this.policies.set(botId, policy);
    this.cache.delete(botId);
  }

  /** Effective policy for a bot: explicit `setPolicy` first, then the resolver. */
  getPolicy(botId: string): TraitPolicy | undefined {
    if (this.policies.has(botId)) return this.policies.get(botId);
    try {
      return this.policyResolver?.(botId);
    } catch (err) {
      this.logger.warn({ err, botId }, 'TraitRegisters: policy resolver failed');
      return undefined;
    }
  }

  /**
   * Load traits for a bot. Creates defaults if no file exists.
   * Pinned values always win; when a pin changes a stored value the file is
   * rewritten (source `pinned`) so anything reading TRAITS.json agrees.
   */
  load(botId: string): TraitSet {
    const cached = this.cache.get(botId);
    if (cached) return { ...cached };

    const filePath = this.getFilePath(botId);
    if (existsSync(filePath)) {
      try {
        const raw: TraitFile = JSON.parse(readFileSync(filePath, 'utf-8'));
        const stored = this.validateTraits(raw.current);
        const traits = this.applyPins(botId, stored);
        if (!traitsEqual(stored, traits)) this.save(botId, traits, 'pinned');
        this.cache.set(botId, traits);
        return { ...traits };
      } catch (err) {
        this.logger.warn({ err, botId }, 'TraitRegisters: failed to load, using defaults');
      }
    }

    const defaults = createDefaultTraits();
    this.save(botId, defaults, 'adaptive'); // persist defaults (the drift baseline)
    const traits = this.applyPins(botId, defaults);
    if (!traitsEqual(defaults, traits)) this.save(botId, traits, 'pinned');
    this.cache.set(botId, traits);
    return { ...traits };
  }

  /**
   * Apply bounded trait adjustments from a given source.
   * Deltas for locked traits are dropped (logged once per call at debug);
   * pinned traits are restored afterwards. Returns the new trait set.
   */
  adjust(botId: string, adjustments: Partial<TraitSet>, source: TraitSource): TraitSet {
    const current = this.load(botId);
    const maxDelta = MAX_DELTA[source];
    const policy = this.getPolicy(botId);
    const locked = new Set<TraitName>(policy?.locked ?? []);
    const pinnedKeys = new Set<TraitName>(
      Object.keys(policy?.pinned ?? {}).filter((k) =>
        TRAIT_NAMES.includes(k as TraitName)
      ) as TraitName[]
    );

    const dropped: Partial<Record<TraitName, number>> = {};
    let applied = 0;
    for (const key of TRAIT_NAMES) {
      const delta = adjustments[key];
      if (delta === undefined) continue;
      if (locked.has(key) || pinnedKeys.has(key)) {
        dropped[key] = delta;
        continue;
      }

      // Clamp delta to max for this source
      const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta));
      current[key] = clamp(current[key] + clampedDelta, CLAMP_MIN, CLAMP_MAX);
      applied++;
    }

    if (Object.keys(dropped).length > 0) {
      this.logger.debug(
        { botId, source, dropped },
        'TraitRegisters: dropped deltas for locked/pinned traits'
      );
    }

    if (applied === 0) {
      // Nothing changed — do not write a history entry for a no-op
      return { ...current };
    }

    const result = this.applyPins(botId, current);
    this.save(botId, result, source);
    this.cache.set(botId, result);

    this.logger.info(
      { botId, source, adjustments, result: summarizeTraits(result) },
      'TraitRegisters: traits adjusted'
    );

    return { ...result };
  }

  /**
   * Get computed parameters for a bot.
   */
  getParameters(botId: string): DerivedParameters {
    const traits = this.load(botId);
    return deriveParameters(traits);
  }

  /**
   * Render traits for prompt injection (strategist/reflection can reason about them).
   */
  renderForPrompt(botId: string): string {
    const traits = this.load(botId);
    const params = deriveParameters(traits);
    const policy = this.getPolicy(botId);

    const lines: string[] = ['## Current Trait State'];
    lines.push('');
    lines.push('Traits (0.1-0.9 scale):');
    for (const key of TRAIT_NAMES) {
      const bar = renderBar(traits[key]);
      lines.push(`  ${key}: ${traits[key].toFixed(2)} ${bar}`);
    }
    lines.push('');
    lines.push('Derived parameters:');
    lines.push(`  executor_temperature: ${params.executorTemperature.toFixed(2)}`);
    lines.push(`  planner_temperature: ${params.plannerTemperature.toFixed(2)}`);
    lines.push(`  ask_human_check_in_cycles: ${params.askHumanCheckInCycles}`);
    lines.push(`  max_tool_rounds_bonus: +${params.maxToolRoundsBonus}`);
    lines.push(`  web_tools_always_included: ${params.webToolAlwaysIncluded}`);
    lines.push(`  idle_cycles_before_abandon: ${params.idleCyclesBeforeAbandon}`);

    const locked = policy?.locked ?? [];
    const pinned = Object.entries(policy?.pinned ?? {}).filter(([k]) =>
      TRAIT_NAMES.includes(k as TraitName)
    );
    if (locked.length > 0 || pinned.length > 0) {
      lines.push('');
      if (locked.length > 0) {
        lines.push(`Locked traits (proposals ignored): ${locked.join(', ')}`);
      }
      if (pinned.length > 0) {
        lines.push(
          `Pinned traits (fixed by the operator): ${pinned
            .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
            .join(', ')}`
        );
      }
    }

    lines.push('');
    lines.push(
      `You may propose trait_adjustments (max ±${MAX_DELTA.strategist} per trait per cycle).`
    );
    lines.push(
      'Higher values amplify the trait behavior. Changes are mechanical — they directly alter system parameters.'
    );

    return lines.join('\n');
  }

  /**
   * Get the trait history for a bot (last N snapshots).
   */
  getHistory(botId: string): TraitSnapshot[] {
    const filePath = this.getFilePath(botId);
    if (!existsSync(filePath)) return [];
    try {
      const raw: TraitFile = JSON.parse(readFileSync(filePath, 'utf-8'));
      return raw.history ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Drift since the first persisted snapshot. Baseline = first `adaptive`
   * history entry (the defaults written on first load); falls back to the
   * first history entry of any source, then to the defaults.
   */
  getDrift(botId: string): TraitDrift {
    const history = this.getHistory(botId);
    const baselineSnapshot = history.find((s) => s.source === 'adaptive') ?? history[0];
    const baseline = this.validateTraits(baselineSnapshot?.traits ?? createDefaultTraits());
    const current = this.load(botId);
    const delta = {} as Record<TraitName, number>;
    for (const key of TRAIT_NAMES) {
      delta[key] = round2(current[key] - baseline[key]);
    }
    return { baseline, current, delta };
  }

  // ── Internal ──

  private getFilePath(botId: string): string {
    const dir = join(this.soulBaseDir, botId);
    return join(dir, 'TRAITS.json');
  }

  /** Returns a copy of `traits` with the bot's pinned values forced in (clamped). */
  private applyPins(botId: string, traits: TraitSet): TraitSet {
    const pinned = this.getPolicy(botId)?.pinned;
    if (!pinned) return { ...traits };
    const result = { ...traits };
    for (const key of TRAIT_NAMES) {
      const val = pinned[key];
      if (typeof val === 'number' && !Number.isNaN(val)) {
        result[key] = clamp(val, CLAMP_MIN, CLAMP_MAX);
      }
    }
    return result;
  }

  private save(botId: string, traits: TraitSet, source: TraitSource): void {
    const filePath = this.getFilePath(botId);
    const dir = join(this.soulBaseDir, botId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let history: TraitSnapshot[] = [];
    if (existsSync(filePath)) {
      try {
        const raw: TraitFile = JSON.parse(readFileSync(filePath, 'utf-8'));
        history = raw.history ?? [];
      } catch {
        // start fresh
      }
    }

    // Add snapshot and prune to MAX_HISTORY
    history.push({ timestamp: Date.now(), source, traits: { ...traits } });
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    const file: TraitFile = { current: traits, history };
    writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  private validateTraits(raw: Partial<TraitSet>): TraitSet {
    const defaults = createDefaultTraits();
    const result = { ...defaults };
    for (const key of TRAIT_NAMES) {
      const val = raw[key];
      if (typeof val === 'number' && !Number.isNaN(val)) {
        result[key] = clamp(val, CLAMP_MIN, CLAMP_MAX);
      }
    }
    return result;
  }
}

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function traitsEqual(a: TraitSet, b: TraitSet): boolean {
  return TRAIT_NAMES.every((k) => a[k] === b[k]);
}

function renderBar(value: number): string {
  const filled = Math.round(value * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function summarizeTraits(traits: TraitSet): string {
  return TRAIT_NAMES.map((k) => `${k}=${traits[k].toFixed(2)}`).join(', ');
}
