/**
 * Agent presets (session S7 of docs/plans/jarvis-fleet-plan.md): five starting
 * points for the create-an-agent wizard and for `POST /api/agents`.
 *
 * The data lives in `src/bot/presets/*.json` rather than under `config/`
 * because `config/` is a Docker volume the image never copies; `src/` is
 * baked in, so every deploy ships the same catalogue. Each file is validated
 * against `AgentPresetSchema` at module load — a malformed preset fails the
 * boot (and the test suite) instead of a wizard click.
 *
 * `applyPreset` is the only merge: it fills preset values *under* whatever the
 * caller already provided. A field the user set — even an empty string or an
 * empty array — is never overwritten; objects (personality, agentLoop) merge
 * per key. The wizard applies a preset client-side for the prefill and sends
 * `preset: '<id>'` too, so an API caller sending only `{ id, preset }` gets
 * exactly what the wizard would have built.
 */
import { z } from 'zod';
import type { BotConfig } from '../config';
import type { TemplateConfig } from '../tenant/template-service';
import { serializeGoals } from '../tools/goals';
import { type Personality, purposeGoalEntry } from './agent-wizard';
import assistant from './presets/assistant.json';
import coder from './presets/coder.json';
import jobSeeker from './presets/job-seeker.json';
import researcher from './presets/researcher.json';
import social from './presets/social.json';

export const PRESET_IDS = ['assistant', 'researcher', 'job-seeker', 'coder', 'social'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const slider = z.number().min(0).max(1);

export const PresetGoalSchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((s) => !s.includes('\n'), 'one line'),
  priority: z.enum(['high', 'medium', 'low']),
  notes: z
    .string()
    .min(1)
    .refine((s) => !s.includes('\n'), 'one line')
    .optional(),
});

export const AgentPresetSchema = z.object({
  id: z.enum(PRESET_IDS),
  /** Suggested agent name (the wizard fills it only when the name box is empty). */
  name: z.string().min(2),
  emoji: z.string().min(1).max(8),
  /** One line for the preset card. */
  description: z
    .string()
    .min(10)
    .refine((s) => !s.includes('\n'), 'one line'),
  purpose: z.string().min(8),
  personality: z.object({
    warmth: slider,
    boldness: slider,
    rigor: slider,
    playfulness: slider,
  }),
  quirks: z.string().min(1),
  skills: z.array(z.string().min(1)),
  disabledTools: z.array(z.string().min(1)),
  agentLoop: z.object({
    every: z.string().regex(/^\d+[mhd]$/),
    mode: z.enum(['periodic', 'continuous']),
  }),
  goals: z.array(PresetGoalSchema).min(1),
});

export type AgentPreset = z.infer<typeof AgentPresetSchema>;
export type PresetGoal = z.infer<typeof PresetGoalSchema>;

const CATALOGUE: ReadonlyArray<AgentPreset> = [assistant, researcher, jobSeeker, coder, social].map(
  (raw) => AgentPresetSchema.parse(raw)
);

const clone = <T>(v: T): T => structuredClone(v);

/** All presets, in catalogue order, as fresh copies. */
export function listPresets(): AgentPreset[] {
  return CATALOGUE.map(clone);
}

/** One preset by id, as a fresh copy; `undefined` for anything unknown. */
export function getPreset(id: unknown): AgentPreset | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  const found = CATALOGUE.find((p) => p.id === id);
  return found ? clone(found) : undefined;
}

/** The fields `applyPreset` can fill. */
export interface PresetFields {
  preset: PresetId;
  name: string;
  purpose: string;
  personality: Personality;
  quirks: string;
  emoji: string;
  skills: string[];
  disabledTools: string[];
  agentLoop: { every: string; mode: 'periodic' | 'continuous' } & Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge preset defaults under `input`. Pure: neither argument is touched, and
 * the result shares no references with the preset. Scalars and arrays the
 * input already carries (anything other than `undefined`) win outright;
 * `personality` and `agentLoop` merge per key so a partial override keeps
 * the rest of the preset.
 */
export function applyPreset<T extends object>(preset: AgentPreset, input: T): T & PresetFields {
  const inp = input as Record<string, unknown>;
  const pick = <K extends keyof AgentPreset>(key: K, from: K = key): AgentPreset[K] | unknown =>
    inp[key as string] !== undefined ? inp[key as string] : clone(preset[from]);
  const personality = isObject(inp.personality)
    ? { ...preset.personality, ...(inp.personality as Partial<Personality>) }
    : clone(preset.personality);
  const agentLoop = isObject(inp.agentLoop)
    ? { ...preset.agentLoop, ...inp.agentLoop }
    : clone(preset.agentLoop);
  return {
    ...input,
    preset: preset.id,
    name: pick('name'),
    purpose: pick('purpose'),
    personality,
    quirks: pick('quirks'),
    emoji: pick('emoji'),
    skills: pick('skills'),
    disabledTools: pick('disabledTools'),
    agentLoop,
  } as T & PresetFields;
}

/**
 * GOALS.md for an agent born from a preset: the purpose goal first (same
 * entry the plain wizard writes), then the preset's goals, all in the shape
 * `tools/goals.ts` parses back.
 */
export function presetGoalsMarkdown(preset: AgentPreset, purpose: string): string {
  const goals = preset.goals.map((g) => ({
    text: g.text,
    status: 'pending',
    priority: g.priority,
    notes: g.notes,
    source: `preset:${preset.id}`,
  }));
  return `${serializeGoals([purposeGoalEntry(purpose), ...goals], [])}\n`;
}

/** A complete, headless, disabled BotConfig from a preset — what the schema test parses. */
export function presetToBotConfig(preset: AgentPreset, id: string): BotConfig {
  return {
    id,
    name: preset.name,
    description: preset.description,
    token: '',
    enabled: false,
    skills: [...preset.skills],
    disabledSkills: [],
    disabledTools: [...preset.disabledTools],
    agentLoop: { ...preset.agentLoop },
    plan: 'free',
    // The schema fills the agentLoop defaults (continuousPauseMs, ...) on parse.
  } as unknown as BotConfig;
}

/** What `GET /api/agents/presets` returns per preset: the card plus the prefill. */
export function presetSummary(preset: AgentPreset) {
  const p = clone(preset);
  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    purpose: p.purpose,
    personality: p.personality,
    quirks: p.quirks,
    skills: p.skills,
    disabledTools: p.disabledTools,
    agentLoop: p.agentLoop,
    goals: p.goals,
  };
}

export type PresetSummary = ReturnType<typeof presetSummary>;

/** The reusable subset the multi-tenant TemplateService understands. */
export function presetToTemplateConfig(preset: AgentPreset): TemplateConfig {
  return {
    name: preset.name,
    description: `${preset.emoji} ${preset.description}`,
    skills: [...preset.skills],
    tools: { disabled: [...preset.disabledTools] },
    agentLoop: { ...preset.agentLoop },
  };
}

/** Stable template id for a preset exposed through the TemplateService. */
export const presetTemplateId = (id: PresetId): string => `preset:${id}`;
