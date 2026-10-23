/**
 * Why for a watcher neuron: what it holds, who brought it (the watcher or the
 * bot it was read from), the cycle it came from when one was recorded, what it
 * is connected to, how often it fired, and where it was created (a birth
 * stage or a tick). Built from the graph and the cycle log only.
 */
import type { Edge, Neuron, NeuronKind } from '../../watcher/types';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export interface NeuronWhyInput {
  neuron: Neuron;
  edges: Edge[];
  neighbours: Array<{ neuron: Neuron; edge: Edge }>;
  /** The cycle-log row of `support.cycles[0]`, when it was found. */
  cycle?: CycleRow;
}

const KIND_TEXT: Record<NeuronKind, string> = {
  entity: 'Agent',
  person: 'Person',
  goal: 'Goal',
  topic: 'Topic',
  fact: 'Fact',
  surprise: 'Surprise',
  question: 'Question',
  pattern: 'Pattern',
  insight: 'Insight',
  contradiction: 'Contradiction',
  prediction: 'Prediction',
};

const STAGE_TEXT: Record<string, string> = {
  'birth:fleet': 'At birth, meeting the fleet',
  'birth:people': 'At birth, reading the contact directories',
  'birth:goals': 'At birth, reading the goals',
  'birth:knowledge': 'At birth, reading the knowledge map',
  'birth:memory': 'At birth, reading shared memory',
  'resync:fleet': 'On waking up, meeting a new agent',
  'resync:people': 'On waking up, meeting a new contact',
  'resync:goals': 'On waking up, reading a new goal',
};

const RELATED_MAX = 12;
const day = (iso: string) => iso.slice(0, 10);

export function neuronToWhy(input: NeuronWhyInput): Why {
  const { neuron } = input;
  const fromBot = neuron.createdBy.startsWith('bot:') ? neuron.createdBy.slice(4) : undefined;
  const why: Why = {
    what: `${KIND_TEXT[neuron.kind] ?? neuron.kind}: "${neuron.text}"`,
    by: fromBot ? 'agent' : 'watcher',
  };

  const cycleId = neuron.support.cycles?.[0];
  const botId = fromBot ?? neuron.support.bots[0];
  if (cycleId && botId) {
    const attribution = cycleAttribution(botId, { cycleId }, input.cycle);
    if (attribution.cycle) why.cycle = attribution.cycle;
    if (attribution.goal) why.goal = attribution.goal;
  }

  if (input.neighbours.length > 0) {
    why.related = {
      label: 'Connected to',
      items: input.neighbours.slice(0, RELATED_MAX).map(({ neuron: other, edge }) => ({
        text: `${edge.rel} → ${other.kind}: ${other.text}`,
      })),
      ...(input.neighbours.length > RELATED_MAX
        ? { note: `${input.neighbours.length - RELATED_MAX} more not shown` }
        : {}),
    };
  }

  const fired =
    neuron.activations > 0
      ? `Activated ${neuron.activations} time${neuron.activations === 1 ? '' : 's'}, last on ${day(neuron.lastActivatedAt)}.`
      : 'Never activated since it was created.';
  why.outcome = neuron.archivedAt ? `${fired} Archived on ${day(neuron.archivedAt)}.` : fired;

  const notes: Array<{ label: string; text: string }> = [];
  if (fromBot) notes.push({ label: 'Brought by', text: fromBot });
  const stage = neuron.meta?.stage;
  notes.push({
    label: 'Created',
    text: stage ? (STAGE_TEXT[stage] ?? stage) : `On ${day(neuron.createdAt)}, while sensing`,
  });
  if (neuron.confidence) notes.push({ label: 'Confidence', text: neuron.confidence });
  if (neuron.meta?.source) notes.push({ label: 'Source', text: neuron.meta.source });
  why.notes = notes;
  return why;
}
