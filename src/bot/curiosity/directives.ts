/**
 * Directive decay — the operator's instructions steer the bot until they are
 * served (N outputs answered them, or the half-life in days passed), then
 * they become context. A repeated instruction re-anchors. This is what stops
 * a two-week-old message from being the bot's only compass.
 *
 * What the operator says in a chat is recorded as `context`: the conversation
 * answers it, so the loop only reads it as background (see `Directive.status`).
 */
import { randomUUID } from 'node:crypto';
import { textSimilarity } from '../../hygiene/text-utils';
import type { Directive, DirectiveSource, NavigatorState, ResolvedCuriosity } from './types';

export const DIRECTIVES_CAP = 20;
const SAME_DIRECTIVE = 0.8;

export function addDirective(
  nav: NavigatorState,
  input: {
    text: string;
    source: DirectiveSource;
    receivedAt: string;
    status?: 'active' | 'context';
  }
): NavigatorState {
  const text = input.text.trim().slice(0, 1000);
  if (!text) return nav;
  const status = input.status ?? 'active';
  // Context only matches context: a chat line never re-anchors or demotes an instruction.
  const existing = nav.directives.find(
    (d) =>
      (d.status === 'context') === (status === 'context') &&
      textSimilarity(d.text, text) >= SAME_DIRECTIVE
  );
  let directives: Directive[];
  if (existing) {
    directives = nav.directives.map((d) =>
      d === existing
        ? {
            ...d,
            text,
            source: input.source,
            receivedAt: input.receivedAt,
            servedOutputs: 0,
            status,
            servedAt: undefined,
          }
        : d
    );
  } else {
    directives = [
      ...nav.directives,
      {
        id: randomUUID().slice(0, 8),
        text,
        source: input.source,
        receivedAt: input.receivedAt,
        servedOutputs: 0,
        status,
      },
    ];
  }
  // Over the cap: oldest chat context first, then served instructions, then the oldest.
  while (directives.length > DIRECTIVES_CAP) {
    const evict = [oldestIndex(directives, 'context'), oldestIndex(directives, 'served'), 0].find(
      (i) => i !== -1
    ) as number;
    directives.splice(evict, 1);
  }
  return { ...nav, directives };
}

function oldestIndex(directives: Directive[], status: Directive['status']): number {
  let idx = -1;
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    if (d.status !== status) continue;
    if (idx === -1 || d.receivedAt < directives[idx].receivedAt) idx = i;
  }
  return idx;
}

/** One more output answered each of these directives. Unknown ids are ignored. */
export function serveDirectives(
  nav: NavigatorState,
  ids: string[],
  _now: string = new Date().toISOString()
): NavigatorState {
  if (ids.length === 0) return nav;
  const set = new Set(ids);
  return {
    ...nav,
    directives: nav.directives.map((d) =>
      set.has(d.id) ? { ...d, servedOutputs: d.servedOutputs + 1 } : d
    ),
  };
}

export function decayDirectives(
  nav: NavigatorState,
  cfg: Pick<ResolvedCuriosity, 'directiveHalfLifeOutputs' | 'directiveHalfLifeDays'>,
  now: string = new Date().toISOString()
): NavigatorState {
  const nowMs = Date.parse(now);
  const maxAgeMs = cfg.directiveHalfLifeDays * 86_400_000;
  return {
    ...nav,
    directives: nav.directives.map((d) => {
      if (d.status !== 'active') return d;
      const aged = nowMs - Date.parse(d.receivedAt) >= maxAgeMs;
      const served = d.servedOutputs >= cfg.directiveHalfLifeOutputs;
      return aged || served ? { ...d, status: 'served' as const, servedAt: now } : d;
    }),
  };
}

export function activeDirectives(nav: NavigatorState): Directive[] {
  return nav.directives.filter((d) => d.status === 'active');
}

/** Each directive is clipped in prompts; the whole block stays under the budget. */
const DIRECTIVE_PROMPT_CHARS = 300;
const CHAT_CONTEXT_SHOWN = 5;

const clip = (t: string) =>
  t.length > DIRECTIVE_PROMPT_CHARS ? `${t.slice(0, DIRECTIVE_PROMPT_CHARS)}…` : t;

export function renderDirectivesForPrompt(nav: NavigatorState, maxChars = 2500): string {
  if (nav.directives.length === 0) return '';
  const active = activeDirectives(nav);
  const served = nav.directives.filter((d) => d.status === 'served').slice(-5);
  const chat = nav.directives
    .filter((d) => d.status === 'context')
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .slice(-CHAT_CONTEXT_SHOWN);
  const parts: string[] = ['## Operator Instructions'];
  if (active.length > 0) {
    parts.push(
      `Steer by these (each is answered by outputs; list the ids you served in "servedDirectiveIds"):\n${active
        .map(
          (d) =>
            `- [${d.id}] ${clip(d.text)} (received ${d.receivedAt.slice(0, 10)}, ${d.servedOutputs} outputs so far)`
        )
        .join('\n')}`
    );
  }
  if (served.length > 0) {
    parts.push(
      `Already served — context only, NOT your route anymore:\n${served
        .map((d) => `- ${clip(d.text)} (served ${d.servedAt?.slice(0, 10) ?? 'earlier'})`)
        .join('\n')}`
    );
  }
  if (chat.length > 0) {
    parts.push(
      `What the operator said in chat — already answered there by the conversation. Background on what they care about; never reply to it, never summarize it back, never message them about it:\n${chat
        .map((d) => `- ${clip(d.text)} (${d.receivedAt.slice(0, 10)})`)
        .join('\n')}`
    );
  }
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
