/**
 * Why for a frontier item: who put the question there (a navigator run or the
 * extractor of a work cycle), why it looked interesting at the time, the
 * limit-dial rule it falls under, and what happened to it (explored, dropped
 * and by whom).
 */
import type { FrontierVerdict } from '../../bot/curiosity/config';
import type { DirectionRecord, FrontierItem } from '../../bot/curiosity/types';
import type { Why } from '../types';

export interface FrontierWhyInput {
  botId: string;
  item: FrontierItem;
  /** `evaluateFrontierItem` against the bot's dials. */
  verdict?: FrontierVerdict;
  /** The navigator run that added it, from the direction history (null: fell out of it). */
  run?: Pick<DirectionRecord, 'runId' | 'at' | 'summary'> | null;
}

const day = (iso: string) => iso.slice(0, 10);

function distanceText(n: number): string {
  if (n <= 0) return 'one of its core topics';
  if (n === 1) return 'an adjacent topic';
  return `far from its topics (distance ${n})`;
}

const list = (dials: string[]) => dials.join(' and ');

function dialRule(item: FrontierItem, v: FrontierVerdict): string {
  const crossings: string[] = [];
  if (v.crosses.includes('topic')) {
    const far = distanceText(item.distance);
    crossings.push(`${far[0].toUpperCase()}${far.slice(1)} crosses the topic dial`);
  }
  if (v.crosses.includes('purpose')) {
    crossings.push(
      `${crossings.length ? 'no' : 'No'} bridge to its purpose crosses the purpose dial`
    );
  }
  const head =
    crossings.length > 0
      ? `${crossings.join('; ')}.`
      : `Inside its limits: ${distanceText(item.distance)}, tied to its purpose${
          item.bridge ? ` (“${item.bridge}”)` : ''
        }.`;
  const verdict: string[] = [];
  if (v.blockedBy.length) verdict.push(`Blocked by the ${list(v.blockedBy)} dial`);
  if (v.needsApproval.length) {
    verdict.push(
      `${verdict.length ? 'needs' : 'Needs'} your approval on the ${list(v.needsApproval)} dial`
    );
  }
  if (item.operatorSignal === 'down')
    verdict.push(verdict.length ? 'you dropped it' : 'You dropped it');
  const tail = verdict.length
    ? `${verdict.join('; ')}.`
    : item.operatorSignal === 'up' && crossings.length
      ? 'You approved it.'
      : 'Free to explore.';
  return `${head} ${tail}`;
}

function outcome(item: FrontierItem): string {
  if (item.status === 'exploring') return 'Being explored now.';
  if (item.status === 'explored') {
    return item.exploredAt ? `Explored on ${day(item.exploredAt)}.` : 'Explored.';
  }
  if (item.status === 'dropped') {
    const r = item.droppedReason;
    if (r?.by === 'navigator') return 'Dropped by the navigator as stale or already answered.';
    if (r?.by === 'operator') {
      return r.via === 'dispatch'
        ? 'Dropped: you turned down the dispatch that proposed it.'
        : 'Dropped: you turned it down.';
    }
    return 'Dropped (no record of why).';
  }
  return 'Open: waiting for an exploration cycle.';
}

export function frontierItemToWhy({ botId, item, verdict, run }: FrontierWhyInput): Why {
  const origin = item.createdBy;
  const byNavigator = origin?.by === 'navigator';
  const why: Why = {
    what: byNavigator
      ? 'A question the navigator put on its frontier'
      : origin?.by === 'extractor'
        ? 'A question that came out of one of its work cycles'
        : 'A question on its frontier',
    by: byNavigator ? 'navigator' : 'curiosity',
  };
  if (origin?.by === 'extractor' && origin.cycleId) {
    why.cycle = { id: origin.cycleId, botId };
  }
  const pitch = (item.whyInteresting ?? '').trim();
  if (pitch) {
    why.reason = {
      text: pitch,
      source: origin?.by === 'extractor' ? 'Cycle extractor' : 'Navigator',
    };
  }
  if (verdict) why.rule = dialRule(item, verdict);
  if (byNavigator && run?.summary) {
    why.related = {
      label: 'Added in the navigator run',
      items: [{ text: run.summary, at: run.at }],
    };
  }
  why.outcome = outcome(item);
  if (byNavigator && !run?.summary && origin?.at) {
    why.notes = [{ label: 'Run', text: `Added by the navigator run of ${day(origin.at)}.` }];
  }
  if (!origin) {
    why.missing = 'No record of what added it (written before frontier provenance was kept).';
  }
  return why;
}
