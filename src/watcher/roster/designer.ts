/**
 * The roster designer (`docs/plans/mind-roster-plan.md`): one model call that
 * reads the operator's brief, the fleet, what the bots the mind proposed did,
 * and the mind's own state, and answers with at most a few bots to propose.
 * Everything around the call is code: the prompt is built from records, the
 * answer is parsed and vetted (every bot must serve a want of the brief), and
 * what survives becomes an agent proposal the operator approves or rejects.
 */
import { parseLLMJson } from '../../bot/llm-json-parser';
import { parseDurationMs } from '../../core/duration';
import type { ChatMessage } from '../../ollama';
import type { AgentProposal } from '../../tools/agent-proposal-store';
import { renderBriefForPrompt } from './brief';
import {
  type DesignedBot,
  type OperatorBrief,
  type RetireSuggestion,
  type RosterBotOutcome,
  type RosterDropped,
  WATCHER_PROPOSER,
} from './types';

const AGENT_ID = /^[a-z][a-z0-9_-]{2,39}$/;
const CADENCE_MIN_MS = 30 * 60_000;
const CADENCE_MAX_MS = 7 * 86_400_000;
const TEXT_MAX = 400;
const MAX_GOALS = 3;
const MAX_QUESTIONS = 3;

export interface RosterBotLine {
  id: string;
  name: string;
  enabled: boolean;
  /** Approved from a proposal of the mind. */
  mindProposed: boolean;
}

export interface PreviousProposal {
  agentId: string;
  name: string;
  status: 'pending' | 'approved' | 'rejected';
  /** The operator's rejection note. */
  note?: string;
}

export interface MindSnapshot {
  /** Live neurons by kind. */
  counts: Record<string, number>;
  broadcasts7d?: { delivered: number; served: number };
}

export interface DesignerInput {
  brief: OperatorBrief;
  bots: RosterBotLine[];
  outcomes: RosterBotOutcome[];
  previous: PreviousProposal[];
  presets: Array<{ id: string; description: string }>;
  mind: MindSnapshot;
  /** How many bots this run may propose. */
  slots: number;
}

export interface RosterAnswer {
  proposals: DesignedBot[];
  retire: RetireSuggestion[];
  questions: string[];
  note?: string;
}

const SYSTEM = `You are the fleet's mind: you watch every agent and you design the roster of agents the operator runs.

Your job now: from the operator's brief, propose the agents worth running. The operator approves or rejects each one.

Rules:
- Every agent you propose must serve at least one want of the brief: list the want ids in "serves". An agent that serves no want is discarded.
- Prefer fewer agents. One agent can serve several wants. Never propose one that duplicates an agent that is on or a proposal still waiting.
- Each agent delivers something concrete the operator will actually consume, on the cadence and through the channel he asked for.
- "killCriterion": one observable condition, checkable within two or three weeks, that means the agent is not worth running (for example "two weekly lists in a row with no role I open").
- "mindObjective" is optional: how the agent also makes you a better mind (better information, predictions you can check). It is never the reason for the agent.
- "retire": agents you proposed earlier whose kill criterion is met by the numbers shown. Only those.
- If the brief is too vague to design anything, propose nothing and ask at most 3 short questions in "questions".
- "agentId": lowercase slug, 3–40 characters. "cadence": how often its loop runs, like "6h", "1d" or "7d" (between 30m and 7d). "goals": 1–3 concrete goals, the first one its main deliverable. Write in the operator's language.

Answer with JSON only:
{"proposals":[{"agentId":"","name":"","emoji":"","role":"","personality":"","serves":["w-…"],"mindObjective":"","deliverable":"","cadence":"","delivery":"","killCriterion":"","preset":"","goals":[""],"language":""}],"retire":[{"botId":"","reason":""}],"questions":[""],"note":""}`;

function rosterLines(bots: RosterBotLine[]): string {
  if (bots.length === 0) return '(no agents)';
  return bots
    .map(
      (b) =>
        `- ${b.id} (${b.name}): ${b.enabled ? 'on' : 'off'}${b.mindProposed ? ', proposed by me' : ''}`
    )
    .join('\n');
}

function outcomeLines(outcomes: RosterBotOutcome[]): string {
  if (outcomes.length === 0) return '(none yet)';
  return outcomes
    .map((o) =>
      [
        `- ${o.botId} (${o.name}), approved ${o.approvedAt.slice(0, 10)}, ${o.enabled ? 'on' : 'off'}`,
        `  serves ${o.serves.join(', ') || '(no want recorded)'}`,
        `  ${o.cyclesCompleted} cycles completed${o.lastCycleAt ? `, last ${o.lastCycleAt.slice(0, 16).replace('T', ' ')}` : ''}`,
        `  ${o.productions} productions since approval; ${o.approved} approved, ${o.rejected} rejected by the operator`,
        o.killCriterion ? `  kill if: ${o.killCriterion}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n');
}

function previousLines(previous: PreviousProposal[]): string {
  if (previous.length === 0) return '(none)';
  return previous
    .map((p) => `- ${p.agentId} (${p.name}): ${p.status}${p.note ? ` — ${p.note}` : ''}`)
    .join('\n');
}

function mindLines(mind: MindSnapshot): string {
  const counts = Object.entries(mind.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const lines = [`Live neurons: ${counts || 'none'}`];
  if (mind.broadcasts7d)
    lines.push(
      `Broadcasts to agents in the last 7 days: ${mind.broadcasts7d.delivered} delivered, ${mind.broadcasts7d.served} acted on`
    );
  return lines.join('\n');
}

/** The designer's messages. Pure. */
export function buildRosterPrompt(input: DesignerInput): ChatMessage[] {
  const user = [
    `## The operator's brief\n${renderBriefForPrompt(input.brief)}`,
    `## Agents in the fleet\n${rosterLines(input.bots)}`,
    `## Agents I proposed and what they did\n${outcomeLines(input.outcomes)}`,
    `## My earlier proposals\n${previousLines(input.previous)}`,
    `## Presets an agent can start from\n${
      input.presets.map((p) => `- ${p.id}: ${p.description}`).join('\n') || '(none)'
    }`,
    `## My own state\n${mindLines(input.mind)}`,
    `## Limit\nPropose at most ${input.slots} agent${input.slots === 1 ? '' : 's'} now.`,
  ].join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

const str = (v: unknown, max = TEXT_MAX): string =>
  typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x))
        .filter(Boolean)
        .slice(0, max)
    : [];

function designedBot(raw: unknown): DesignedBot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const agentId = str(r.agentId, 60);
  const name = str(r.name, 60);
  if (!agentId || !name) return null;
  const optional = (key: 'emoji' | 'mindObjective' | 'preset' | 'language', max = TEXT_MAX) => {
    const v = str(r[key], max);
    return v ? { [key]: v } : {};
  };
  return {
    agentId,
    name,
    role: str(r.role),
    personality: str(r.personality),
    serves: strings(r.serves, 5),
    deliverable: str(r.deliverable),
    cadence: str(r.cadence, 10),
    delivery: str(r.delivery, 80),
    killCriterion: str(r.killCriterion),
    goals: strings(r.goals, MAX_GOALS),
    ...optional('emoji', 8),
    ...optional('mindObjective'),
    ...optional('preset', 40),
    ...optional('language', 20),
  };
}

const quiet = { warn: () => {} };

/** The model's JSON, or null when unreadable. Malformed entries are dropped. */
export function parseRosterAnswer(text: string): RosterAnswer | null {
  return parseLLMJson<RosterAnswer>(text, quiet, {
    label: 'roster',
    extractPattern: /\{[\s\S]*\}/,
    validate: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const proposals = (Array.isArray(raw.proposals) ? raw.proposals : [])
        .map(designedBot)
        .filter((b: DesignedBot | null): b is DesignedBot => b !== null);
      const retire = (Array.isArray(raw.retire) ? raw.retire : []).flatMap((x: unknown) => {
        const r = x as Record<string, unknown> | null;
        const botId = str(r?.botId, 60);
        const reason = str(r?.reason);
        return botId && reason ? [{ botId, reason }] : [];
      });
      const note = str(raw.note);
      return {
        proposals,
        retire,
        questions: strings(raw.questions, MAX_QUESTIONS),
        ...(note ? { note } : {}),
      };
    },
  });
}

export interface VetContext {
  brief: OperatorBrief;
  /** Ids of every bot in the config and every pending proposal. */
  takenIds: Set<string>;
  presetIds: Set<string>;
  slots: number;
}

function cadenceOk(cadence: string): boolean {
  try {
    const ms = parseDurationMs(cadence);
    return ms >= CADENCE_MIN_MS && ms <= CADENCE_MAX_MS;
  } catch {
    return false;
  }
}

/** Keep the bots that pass every check, in order, up to `slots`. Pure. */
export function vetRoster(
  bots: DesignedBot[],
  ctx: VetContext
): { accepted: DesignedBot[]; dropped: RosterDropped[] } {
  const wants = new Set(ctx.brief.wants.map((w) => w.id));
  const taken = new Set(ctx.takenIds);
  const accepted: DesignedBot[] = [];
  const dropped: RosterDropped[] = [];
  for (const bot of bots) {
    const drop = (reason: string) => dropped.push({ name: bot.name, reason });
    const serves = bot.serves.filter((id) => wants.has(id));
    if (!AGENT_ID.test(bot.agentId)) drop(`id "${bot.agentId}" is not a lowercase slug`);
    else if (taken.has(bot.agentId)) drop(`id "${bot.agentId}" is taken`);
    else if (serves.length === 0) drop('serves no want in the brief');
    else if (!cadenceOk(bot.cadence)) drop(`cadence "${bot.cadence}" is outside 30m–7d`);
    else if (bot.preset && !ctx.presetIds.has(bot.preset)) drop(`unknown preset "${bot.preset}"`);
    else if (!bot.killCriterion) drop('no kill criterion');
    else if (!bot.deliverable) drop('no deliverable');
    else if (accepted.length >= ctx.slots)
      drop(`over the limit of ${ctx.slots} proposal${ctx.slots === 1 ? '' : 's'}`);
    else {
      taken.add(bot.agentId);
      accepted.push({ ...bot, serves });
    }
  }
  return { accepted, dropped };
}

export type RosterProposalData = Omit<AgentProposal, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

/** A vetted bot as an agent proposal by the watcher. */
export function toProposalData(
  bot: DesignedBot,
  ctx: { brief: OperatorBrief; presetSkills: (id: string) => string[] }
): RosterProposalData {
  const serves = bot.serves.flatMap((id) => {
    const w = ctx.brief.wants.find((x) => x.id === id);
    return w ? [{ id, what: w.what }] : [];
  });
  const justification = [
    `Serves: ${serves.map((s) => s.what).join('; ')}.`,
    `Delivers ${bot.deliverable} (${bot.cadence}${bot.delivery ? `, via ${bot.delivery}` : ''}).`,
    `Kill if: ${bot.killCriterion}`,
    bot.mindObjective ? `For the mind: ${bot.mindObjective}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    agentId: bot.agentId,
    agentName: bot.name,
    role: bot.role || bot.deliverable,
    personalityDescription: bot.personality,
    skills: bot.preset ? ctx.presetSkills(bot.preset) : [],
    justification,
    ...(bot.emoji ? { emoji: bot.emoji } : {}),
    ...(bot.language ? { language: bot.language } : {}),
    agentLoop: { mode: 'periodic', every: bot.cadence },
    proposedBy: WATCHER_PROPOSER,
    serves,
    goals: bot.goals.length ? bot.goals : [bot.deliverable],
    deliverable: bot.deliverable,
    ...(bot.delivery ? { delivery: bot.delivery } : {}),
    killCriterion: bot.killCriterion,
    ...(bot.preset ? { preset: bot.preset } : {}),
    ...(bot.mindObjective ? { mindObjective: bot.mindObjective } : {}),
  };
}
