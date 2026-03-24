/**
 * Trait Registers — Mechanical personality parameters.
 *
 * Numeric traits (0.0-1.0) persisted as TRAITS.json in the soul directory.
 * These traits mechanically alter agent loop parameters (temperature, tool
 * selection, frequency) — they are NOT prompt text. The LLM can propose
 * trait adjustments via the strategist or reflection skill.
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

export type TraitSource = 'strategist' | 'reflection' | 'adaptive';

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

  constructor(
    private soulBaseDir: string,
    private logger: Logger
  ) {}

  /**
   * Load traits for a bot. Creates defaults if no file exists.
   */
  load(botId: string): TraitSet {
    const cached = this.cache.get(botId);
    if (cached) return { ...cached };

    const filePath = this.getFilePath(botId);
    if (existsSync(filePath)) {
      try {
        const raw: TraitFile = JSON.parse(readFileSync(filePath, 'utf-8'));
        const traits = this.validateTraits(raw.current);
        this.cache.set(botId, traits);
        return { ...traits };
      } catch (err) {
        this.logger.warn({ err, botId }, 'TraitRegisters: failed to load, using defaults');
      }
    }

    const defaults = createDefaultTraits();
    this.cache.set(botId, defaults);
    this.save(botId, defaults, 'adaptive'); // persist defaults
    return { ...defaults };
  }

  /**
   * Apply bounded trait adjustments from a given source.
   * Returns the new trait set.
   */
  adjust(botId: string, adjustments: Partial<TraitSet>, source: TraitSource): TraitSet {
    const current = this.load(botId);
    const maxDelta = MAX_DELTA[source];

    for (const key of TRAIT_NAMES) {
      const delta = adjustments[key];
      if (delta === undefined) continue;

      // Clamp delta to max for this source
      const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta));
      current[key] = clamp(current[key] + clampedDelta, CLAMP_MIN, CLAMP_MAX);
    }

    this.save(botId, current, source);
    this.cache.set(botId, current);

    this.logger.info(
      { botId, source, adjustments, result: summarizeTraits(current) },
      'TraitRegisters: traits adjusted'
    );

    return { ...current };
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

  // ── Internal ──

  private getFilePath(botId: string): string {
    const dir = join(this.soulBaseDir, botId);
    return join(dir, 'TRAITS.json');
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

function renderBar(value: number): string {
  const filled = Math.round(value * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function summarizeTraits(traits: TraitSet): string {
  return TRAIT_NAMES.map((k) => `${k}=${traits[k].toFixed(2)}`).join(', ');
}
