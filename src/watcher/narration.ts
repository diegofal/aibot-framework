/**
 * The text of every watcher log row: plain first-person English written by
 * code, never by an LLM (the same way `describeNow` speaks for a bot). Pure.
 */
import type { BirthStage, NeuronKind, SensedEvent } from './types';
import { isHumanInbound } from './types';

const num = (n: number): string => n.toLocaleString('en-US');

function plural(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

const BACKEND_NAMES: Record<string, string> = { 'claude-cli': 'Claude CLI', ollama: 'Ollama' };

function andList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

export function formatAgo(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

export function narrateWake(input: { bots: number; tenants: number; backends: string[] }): string {
  const backends =
    input.backends.length > 0
      ? `${andList(input.backends.map((b) => BACKEND_NAMES[b] ?? b))} available`
      : 'no LLM backend configured';
  return `Waking up for the first time. Looking around: ${plural(input.bots, 'bot', 'bots')}, ${plural(input.tenants, 'tenant', 'tenants')}, ${backends}.`;
}

export function narrateRewake(input: {
  neurons: number;
  lastAwakeMs?: number;
  nowMs: number;
}): string {
  const base = `Waking up. ${plural(input.neurons, 'neuron', 'neurons')}`;
  if (input.lastAwakeMs === undefined) return `${base}.`;
  return `${base}, last awake ${formatAgo(Math.max(0, input.nowMs - input.lastAwakeMs))} ago.`;
}

export function narrateResumeBirth(stage: BirthStage): string {
  return `Waking up in the middle of being born. Picking up at birth:${stage}.`;
}

export function narrateMetBot(input: {
  name: string;
  purpose?: string;
  channel: string;
  activeGoals: number;
}): string {
  const purpose = input.purpose ? `: "${input.purpose}"` : '';
  return `Met ${input.name}${purpose} (${input.channel}, ${plural(input.activeGoals, 'active goal', 'active goals')}).`;
}

export function narrateMetPerson(input: {
  name: string;
  operator: boolean;
  channels: string[];
  bots: number;
}): string {
  const parts = [
    ...(input.operator ? ['operator'] : []),
    ...(input.channels.length ? [input.channels.join(' + ')] : []),
  ];
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `Met ${input.name}${detail}, known to ${plural(input.bots, 'bot', 'bots')}.`;
}

export function narrateGoals(input: { bot: string; goals: number; openTasks: number }): string {
  return `Learned what ${input.bot} is working on: ${plural(input.goals, 'goal', 'goals')}, ${plural(input.openTasks, 'open task', 'open tasks')}.`;
}

export function narrateLearned(input: {
  bot: string;
  text: string;
  kind: NeuronKind;
  confidence?: string;
}): string {
  const detail = input.confidence ? `${input.kind}, confidence ${input.confidence}` : input.kind;
  return `Learned from ${input.bot}'s knowledge map: "${input.text}" (${detail}).`;
}

export function narrateRemembered(input: { bot: string; text: string }): string {
  return `Remembered from ${input.bot}: "${input.text}".`;
}

export function narrateHistory(input: {
  days: number;
  cycles: number;
  goalsWorked: number;
  goalsNever: number;
}): string {
  return `Reviewed ${plural(input.days, 'day', 'days')} of history: ${plural(input.cycles, 'cycle', 'cycles')}. ${plural(input.goalsWorked, 'goal was', 'goals were')} worked on, ${num(input.goalsNever)} never.`;
}

export function narrateLinking(input: { neurons: number; edges: number }): string {
  return `Linking what I know: ${plural(input.neurons, 'neuron', 'neurons')}, ${plural(input.edges, 'edge', 'edges')} so far.`;
}

export function narrateNoEmbeddings(reason: string): string {
  return `Could not embed what I know (${reason}). Placing neurons by kind, without related edges.`;
}

const KIND_LABELS: Record<NeuronKind, [string, string]> = {
  entity: ['bot', 'bots'],
  person: ['person', 'people'],
  goal: ['goal', 'goals'],
  topic: ['topic', 'topics'],
  fact: ['fact', 'facts'],
  surprise: ['surprise', 'surprises'],
  question: ['question', 'questions'],
  pattern: ['pattern', 'patterns'],
  insight: ['insight', 'insights'],
  contradiction: ['contradiction', 'contradictions'],
  prediction: ['prediction', 'predictions'],
};

export function narrateBorn(input: {
  counts: Partial<Record<NeuronKind, number>>;
  durationMs: number;
  unreadable: string[];
}): string {
  const entries = (Object.keys(KIND_LABELS) as NeuronKind[])
    .map((k) => [k, input.counts[k] ?? 0] as const)
    .filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const breakdown = entries
    .map(([k, n]) => plural(n, KIND_LABELS[k][0], KIND_LABELS[k][1]))
    .join(', ');
  const head = `Born. ${plural(total, 'neuron', 'neurons')}${breakdown ? `: ${breakdown}` : ''} in ${formatDuration(input.durationMs)}.`;
  return input.unreadable.length ? `${head} Could not read: ${input.unreadable.join(', ')}.` : head;
}

export function narrateStageFailed(stage: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Could not finish birth:${stage} (${msg}). Moving on.`;
}

export function narrateUnreadable(what: string, reason: string): string {
  return `Could not read ${what} (${reason}).`;
}

export function narrateResync(input: { bots: number; goals: number; people: number }): string {
  return `Caught up on what changed while I slept: ${plural(input.bots, 'new bot', 'new bots')}, ${plural(input.goals, 'new goal', 'new goals')}, ${num(input.people)} new ${input.people === 1 ? 'person' : 'people'}.`;
}

export function narrateSleep(input: { neurons: number }): string {
  return `Going to sleep. ${plural(input.neurons, 'neuron', 'neurons')}.`;
}

const round1 = (n: number): string => (Math.round(n * 10) / 10).toString();

export function narrateNoticed(input: {
  what: string;
  salience: number;
  reasons: string[];
  touched: number;
}): string {
  const why = [
    ...input.reasons,
    ...(input.touched > 0 ? [`touches ${plural(input.touched, 'neuron', 'neurons')}`] : []),
  ];
  return `Noticed: ${input.what}. Salience ${round1(input.salience)}${why.length ? ` (${why.join(', ')})` : ''}.`;
}

export function narrateSenseSummary(input: {
  events: number;
  windowMs: number;
  top?: string;
  topSalience?: number;
}): string {
  const head = `Sensed ${plural(input.events, 'event', 'events')} in the last ${formatDuration(input.windowMs)}`;
  if (!input.top) return `${head}.`;
  return `${head}, top: ${input.top} (salience ${round1(input.topSalience ?? 0)}).`;
}

/**
 * Model output inside a code-written row: one line, at most 200 chars,
 * double quotes inside turned to single, always wrapped in quotes.
 */
export function quoteModelText(text: string, max = 200): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, "'");
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return `"${clipped}"`;
}

export function narrateNoticeLearned(input: {
  text: string;
  kind: NeuronKind;
  confidence?: string;
  bots: string[];
}): string {
  const detail = input.confidence ? `${input.kind}, confidence ${input.confidence}` : input.kind;
  const from = input.bots.length ? `; from ${andList(input.bots)}` : '';
  return `Learned: ${quoteModelText(input.text)} (${detail}${from}).`;
}

export function narrateNoticeRecognised(input: { text: string; activations: number }): string {
  return `Recognised again: ${quoteModelText(input.text)} (${plural(input.activations, 'activation', 'activations')}).`;
}

export function narrateNoticePass(input: {
  events: number;
  kept: number;
  recognised: number;
  dropped: number;
}): string {
  const head = `Noticed ${plural(input.events, 'event', 'events')}`;
  if (input.kept === 0 && input.recognised === 0) return `${head}; nothing worth keeping.`;
  return `${head}: kept ${num(input.kept)}, recognised ${num(input.recognised)}, let ${num(input.dropped)} go.`;
}

export function narrateNoticeFailed(input: { events: number; error: string }): string {
  return `Could not notice: the model call failed (${quoteModelText(input.error, 160)}). I kept the ${plural(input.events, 'event', 'events')} for the next pass.`;
}

export function narrateNoticeUnparsable(input: { events: number }): string {
  return `Could not read the model's answer as JSON. I kept the ${plural(input.events, 'event', 'events')} for the next pass.`;
}

export function narrateNoticeCapped(input: { maxPerDay: number }): string {
  return `Reached today's noticing budget (${plural(input.maxPerDay, 'call', 'calls')}). I keep sensing and will notice again tomorrow.`;
}

export function narrateNoticePaused(input: { backend: string }): string {
  const name = BACKEND_NAMES[input.backend] ?? input.backend;
  return `${name} is rate-limited across the fleet (circuit open). Noticing is paused until it recovers.`;
}

/** What an event was, in a few words, for "Noticed: …" rows. Human text is never quoted, only its topic words. */
export function describeEvent(
  event: SensedEvent,
  names: { botName: (botId: string) => string; sender?: string }
): string {
  const bot = names.botName(event.botId);
  if (isHumanInbound(event)) {
    const who = names.sender ?? 'someone';
    return event.text ? `${who} wrote to ${bot} about ${event.text}` : `${who} wrote to ${bot}`;
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string =>
    typeof v === 'string' ? v : v === undefined ? '' : String(v);
  switch (event.type) {
    case 'tool:error':
      return `${str(data.toolName) || 'a tool'} failed in ${bot}`;
    case 'llm:error':
      return `an LLM call failed in ${bot}`;
    case 'tool:end':
      if (data.toolName === 'send_message' || data.toolName === 'send_proactive_message')
        return `${bot} sent a message`;
      return `${str(data.toolName) || 'a tool'} ran in ${bot}`;
    case 'task:changed':
      return data.from && data.to
        ? `${bot} moved task ${str(data.taskId)} from ${str(data.from)} to ${str(data.to)}`
        : `${bot} changed task ${str(data.taskId)}`;
    case 'worker:waiting':
      return `a worker of ${bot} is waiting for an answer`;
    case 'worker:ended':
      return `a worker of ${bot} ended ${str(data.status) || 'its run'}`;
    case 'karma:change':
      return `${bot}'s karma moved ${str(data.delta)}`;
    case 'memory:flush':
      return `${bot} saved to memory`;
    case 'agent:result':
      return `${bot} finished a cycle`;
    default:
      return `${event.type} in ${bot}`;
  }
}
