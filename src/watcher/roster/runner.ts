/**
 * When the roster designer runs and what it leaves behind
 * (`docs/plans/mind-roster-plan.md`). Due 30 min after the operator saves a
 * changed brief, then every `everyHours`; never with an empty brief or with
 * `maxPending` mind proposals already waiting. A run that never reached the
 * model (refused: kill, cap, breaker; or an error) waits `ROSTER_RETRY_MS`.
 * State in `<watcherDir>/self/roster.json`. Never throws.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../config';
import { writeJsonFileAtomic } from '../../config';
import type { Logger } from '../../logger';
import type { AgentProposal, AgentProposalStore } from '../../tools/agent-proposal-store';
import type { InstrumentedClient } from '../llm';
import { readBrief } from './brief';
import {
  type MindSnapshot,
  buildRosterPrompt,
  parseRosterAnswer,
  toProposalData,
  vetRoster,
} from './designer';
import {
  type OperatorBrief,
  ROSTER_DEFAULTS,
  type RosterBotOutcome,
  type RosterOutcome,
  type RosterProposalView,
  type RosterSettings,
  type RosterState,
  type RosterStatus,
  type RosterTrigger,
  WATCHER_PROPOSER,
} from './types';

const HOUR_MS = 3_600_000;
/** A saved brief waits this long, so a few edits in a row cost one run. */
export const BRIEF_SETTLE_MS = 30 * 60_000;
/** After an attempt that never reached the model. */
export const ROSTER_RETRY_MS = 6 * HOUR_MS;
/** How often the watcher's timer asks `tick`. */
export const ROSTER_CHECK_MS = 10 * 60_000;
const PREVIOUS_SHOWN = 10;
const PROPOSALS_LISTED = 20;

export type BotOutcomeCounts = Pick<
  RosterBotOutcome,
  'cyclesCompleted' | 'lastCycleAt' | 'productions' | 'approved' | 'rejected'
>;

export interface RosterRunnerDeps {
  watcherDir: string;
  settings: () => RosterSettings;
  config: () => Pick<Config, 'bots'>;
  /** The agent proposal queue; undefined when `agentProposals.enabled` is off. */
  store: () => AgentProposalStore | undefined;
  client: () => InstrumentedClient | undefined;
  mind: () => MindSnapshot;
  botOutcome: (botId: string, sinceMs: number) => BotOutcomeCounts;
  presets: () => Array<{ id: string; description: string; skills: string[] }>;
  log: (op: string, text: string) => void;
  running: () => boolean;
  killed: () => boolean;
  /**
   * The watcher's stop signal, read once when a run starts: a stop during the
   * call cancels that run (it writes nothing) even if the watcher starts again.
   */
  signal: () => AbortSignal | undefined;
  now?: () => number;
  logger?: Pick<Logger, 'warn'>;
}

export type RosterRunResult =
  | { status: 'ran'; outcome: RosterOutcome }
  | { status: 'unavailable'; reason: string }
  | { status: 'cancelled' };

function statePath(watcherDir: string): string {
  return join(watcherDir, 'self', 'roster.json');
}

/** `roster.json`; missing or unreadable = `{}`. Never throws. */
export function readRosterState(watcherDir: string): RosterState {
  try {
    const raw = JSON.parse(readFileSync(statePath(watcherDir), 'utf-8')) as RosterState;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeRosterState(watcherDir: string, state: RosterState): void {
  mkdirSync(join(watcherDir, 'self'), { recursive: true });
  writeJsonFileAtomic(statePath(watcherDir), state);
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const iso = (t: number) => new Date(t).toISOString();

export class RosterRunner {
  private inFlight: Promise<RosterRunResult> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RosterRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private settings(): RosterSettings {
    try {
      return { ...ROSTER_DEFAULTS, ...this.deps.settings() };
    } catch {
      return { ...ROSTER_DEFAULTS };
    }
  }

  private unavailable(): string | undefined {
    if (!this.deps.running()) return 'The watcher is asleep';
    if (this.deps.killed()) return 'The hard kill is on';
    if (!this.settings().enabled) return 'The roster is off (watcher.roster.enabled)';
    if (!this.deps.store()) return 'Agent proposals are off (agentProposals.enabled)';
    if (this.inFlight) return 'A roster run is already running';
    return undefined;
  }

  private mindProposals(): AgentProposal[] {
    try {
      return (this.deps.store()?.list() ?? []).filter((p) => p.proposedBy === WATCHER_PROPOSER);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher: roster could not read the agent proposals');
      return [];
    }
  }

  private pendingCount(): number {
    return this.mindProposals().filter((p) => p.status === 'pending').length;
  }

  /** When the next run is due and why; null when nothing makes it due. */
  private nextDue(
    state: RosterState,
    brief: OperatorBrief
  ): { at: number; trigger: RosterTrigger } | null {
    if (brief.wants.length === 0) return null;
    if (this.pendingCount() >= this.settings().maxPending) return null;
    const ran = ms(state.lastRunAt);
    const changed = ms(brief.updatedAt);
    let due: { at: number; trigger: RosterTrigger };
    if (Number.isFinite(changed) && (!state.briefSeen || changed > ms(state.briefSeen)))
      due = { at: changed + BRIEF_SETTLE_MS, trigger: 'brief-changed' };
    else if (Number.isFinite(ran))
      due = { at: ran + this.settings().everyHours * HOUR_MS, trigger: 'scheduled' };
    else return null;
    const attempt = ms(state.lastAttemptAt);
    if (Number.isFinite(attempt) && !(attempt <= ran))
      due = { ...due, at: Math.max(due.at, attempt + ROSTER_RETRY_MS) };
    return due;
  }

  status(): RosterStatus {
    const state = readRosterState(this.deps.watcherDir);
    const settings = this.settings();
    const proposals = this.mindProposals();
    const due =
      settings.enabled && this.deps.running()
        ? this.nextDue(state, readBrief(this.deps.watcherDir))
        : null;
    return {
      enabled: settings.enabled,
      proposalsOn: !!this.deps.store(),
      running: this.inFlight !== null,
      lastRunAt: state.lastRunAt ?? null,
      nextRunAt: due ? iso(due.at) : null,
      lastOutcome: state.lastOutcome ?? null,
      proposals: [...proposals]
        .reverse()
        .slice(0, PROPOSALS_LISTED)
        .map(
          (p): RosterProposalView => ({
            id: p.id,
            agentId: p.agentId,
            name: p.agentName,
            status: p.status,
            createdAt: p.createdAt,
            serves: (p.serves ?? []).map((s) => s.id),
            ...(p.deliverable ? { deliverable: p.deliverable } : {}),
            ...(p.agentLoop?.every ? { cadence: p.agentLoop.every } : {}),
            ...(p.killCriterion ? { killCriterion: p.killCriterion } : {}),
          })
        ),
      bots: this.botOutcomes(proposals),
    };
  }

  /** The bots that came from an approved mind proposal and are still in the config. */
  private botOutcomes(proposals: AgentProposal[]): RosterBotOutcome[] {
    const bots = this.deps.config().bots ?? [];
    return proposals.flatMap((p) => {
      if (p.status !== 'approved') return [];
      const bot = bots.find((b) => b.id === p.agentId);
      if (!bot) return [];
      let counts: BotOutcomeCounts = {
        cyclesCompleted: 0,
        productions: 0,
        approved: 0,
        rejected: 0,
      };
      try {
        counts = this.deps.botOutcome(bot.id, ms(p.updatedAt));
      } catch (err) {
        this.deps.logger?.warn({ err, botId: bot.id }, 'Watcher: roster could not read outcomes');
      }
      return [
        {
          botId: bot.id,
          name: bot.name ?? bot.id,
          enabled: bot.enabled !== false,
          approvedAt: p.updatedAt,
          serves: (p.serves ?? []).map((s) => s.id),
          ...(p.killCriterion ? { killCriterion: p.killCriterion } : {}),
          ...counts,
        },
      ];
    });
  }

  current(): Promise<RosterRunResult> | null {
    return this.inFlight;
  }

  /** The timer's check: starts a run when one is due. True when it started one. */
  tick(nowMs: number = this.now()): boolean {
    if (this.unavailable()) return false;
    const due = this.nextDue(
      readRosterState(this.deps.watcherDir),
      readBrief(this.deps.watcherDir)
    );
    if (!due || nowMs < due.at) return false;
    void this.run(due.trigger);
    return true;
  }

  /** Run now. Never throws. */
  run(trigger: RosterTrigger): Promise<RosterRunResult> {
    const why = this.unavailable();
    if (why) return Promise.resolve({ status: 'unavailable', reason: why });
    const run = Promise.resolve()
      .then(() => this.execute(trigger))
      .catch((err): RosterRunResult => {
        this.deps.logger?.warn({ err }, 'Watcher: roster run failed');
        return { status: 'unavailable', reason: 'The roster run failed unexpectedly' };
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private save(patch: Partial<RosterState>): void {
    try {
      writeRosterState(this.deps.watcherDir, {
        ...readRosterState(this.deps.watcherDir),
        ...patch,
      });
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher: could not write roster.json');
    }
  }

  private async execute(trigger: RosterTrigger): Promise<RosterRunResult> {
    const signal = this.deps.signal();
    const isCancelled = () => !!signal?.aborted;
    const at = iso(this.now());
    const base: RosterOutcome = {
      at,
      trigger,
      status: 'nothing',
      proposed: [],
      dropped: [],
      retire: [],
      questions: [],
    };
    const brief = readBrief(this.deps.watcherDir);
    const finish = (outcome: RosterOutcome, patch: Partial<RosterState> = {}): RosterRunResult => {
      this.save({ ...patch, lastOutcome: outcome });
      return { status: 'ran', outcome };
    };
    if (brief.wants.length === 0) return finish({ ...base, reason: 'The brief has no wants yet' });

    const settings = this.settings();
    const proposals = this.mindProposals();
    const pending = proposals.filter((p) => p.status === 'pending').length;
    const slots = Math.min(settings.maxProposals, settings.maxPending - pending);
    if (slots <= 0)
      return finish({
        ...base,
        reason: `${pending} proposal${pending === 1 ? ' is' : 's are'} waiting for you`,
      });

    const client = this.deps.client();
    if (!client)
      return finish(
        { ...base, status: 'refused', reason: 'No model for the mind (both tiers are off)' },
        { lastAttemptAt: at }
      );

    const config = this.deps.config();
    const outcomes = this.botOutcomes(proposals);
    const mindBots = new Set(outcomes.map((o) => o.botId));
    const presets = this.deps.presets();
    const messages = buildRosterPrompt({
      brief,
      bots: (config.bots ?? []).map((b) => ({
        id: b.id,
        name: b.name ?? b.id,
        enabled: b.enabled !== false,
        mindProposed: mindBots.has(b.id),
      })),
      outcomes,
      previous: proposals.slice(-PREVIOUS_SHOWN).map((p) => ({
        agentId: p.agentId,
        name: p.agentName,
        status: p.status,
        ...(p.rejectionNote ? { note: p.rejectionNote } : {}),
      })),
      presets: presets.map((p) => ({ id: p.id, description: p.description })),
      mind: this.deps.mind(),
      slots,
    });

    if (isCancelled()) return { status: 'cancelled' };
    const res = await client.chat(messages, { temperature: 0.3 });
    if (isCancelled()) return { status: 'cancelled' };

    if (!res.ok) {
      const failed = res.reason === 'error';
      const reason = failed
        ? `The model failed: ${'error' in res ? res.error : ''}`
        : `Refused: ${res.reason}`;
      this.deps.log('roster:failed', `I could not design a roster. ${reason}.`);
      return finish(
        { ...base, status: failed ? 'failed' : 'refused', reason },
        { lastAttemptAt: at }
      );
    }
    const paid = {
      model: res.model,
      tokens: res.tokens,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    };
    const ran = {
      lastRunAt: at,
      lastAttemptAt: at,
      ...(brief.updatedAt ? { briefSeen: brief.updatedAt } : {}),
    };

    const answer = parseRosterAnswer(res.text);
    if (!answer) {
      this.deps.log(
        'roster:unparsable',
        'My roster answer was not readable JSON; nothing proposed.'
      );
      return finish(
        { ...base, ...paid, status: 'unparsable', reason: 'The answer was not readable' },
        ran
      );
    }

    const store = this.deps.store();
    const taken = new Set<string>([
      ...(config.bots ?? []).map((b) => b.id),
      ...(store?.list() ?? []).filter((p) => p.status === 'pending').map((p) => p.agentId),
    ]);
    const { accepted, dropped } = vetRoster(answer.proposals, {
      brief,
      takenIds: taken,
      presetIds: new Set(presets.map((p) => p.id)),
      slots,
    });
    const skillsOf = (id: string) => presets.find((p) => p.id === id)?.skills ?? [];
    const proposed: RosterOutcome['proposed'] = [];
    for (const bot of accepted) {
      try {
        const created = store?.create(toProposalData(bot, { brief, presetSkills: skillsOf }));
        if (created)
          proposed.push({
            proposalId: created.id,
            agentId: bot.agentId,
            name: bot.name,
            serves: bot.serves,
          });
      } catch (err) {
        this.deps.logger?.warn({ err, agentId: bot.agentId }, 'Watcher: roster proposal not saved');
        dropped.push({ name: bot.name, reason: 'could not be saved' });
      }
    }
    const retire = answer.retire.filter((r) => mindBots.has(r.botId));

    for (const d of dropped) this.deps.log('roster:dropped', `I dropped ${d.name}: ${d.reason}.`);
    this.deps.log(
      'roster:run',
      proposed.length
        ? `I proposed ${proposed.map((p) => p.name).join(' and ')} for the operator's brief.`
        : answer.questions.length
          ? `I need answers before proposing: ${answer.questions.join(' ')}`
          : 'I proposed no new bot this time.'
    );
    return finish(
      {
        ...base,
        ...paid,
        status: proposed.length ? 'proposed' : 'nothing',
        ...(proposed.length
          ? {}
          : {
              reason: answer.questions.length
                ? 'The mind asks first'
                : dropped.length
                  ? 'No bot passed the checks'
                  : 'No new bot needed',
            }),
        proposed,
        dropped,
        retire,
        questions: answer.questions,
        ...(answer.note ? { note: answer.note } : {}),
      },
      ran
    );
  }
}
