import { describe, expect, it } from 'bun:test';
import { CURIOSITY_PRESETS } from '../../../src/bot/curiosity/config';
import { DIAL_MEANINGS, FLOOR_RULES, buildDnaSection } from '../../../src/bot/curiosity/dna';

describe('buildDnaSection', () => {
  it('names all six genes', () => {
    const text = buildDnaSection(CURIOSITY_PRESETS.explorer);
    for (const gene of ['CURIOUS', 'COMPOUNDING', 'SELF-DIRECTED', 'CAPTIVATING', 'HONEST', 'BOLD']) {
      expect(text).toContain(gene);
    }
  });

  it('renders each dial with its level-specific meaning', () => {
    const text = buildDnaSection(CURIOSITY_PRESETS.explorer);
    expect(text).toContain(`topic: OPEN — ${DIAL_MEANINGS.topic.open}`);
    expect(text).toContain(`purpose: ASK — ${DIAL_MEANINGS.purpose.ask}`);
    expect(text).toContain(`identity: CLOSED — ${DIAL_MEANINGS.identity.closed}`);
  });

  it('always includes the floor, whatever the dials', () => {
    const text = buildDnaSection(CURIOSITY_PRESETS.wild);
    for (const rule of FLOOR_RULES) expect(text).toContain(rule);
  });

  it('every dial has a meaning for every level', () => {
    for (const levels of Object.values(DIAL_MEANINGS)) {
      expect(levels.closed && levels.ask && levels.open).toBeTruthy();
    }
  });

  it('adds the exploration mandate on explore cycles only', () => {
    expect(buildDnaSection(CURIOSITY_PRESETS.explorer)).not.toContain('EXPLORATION CYCLE');
    const text = buildDnaSection(CURIOSITY_PRESETS.explorer, {
      mode: 'explore',
      reason: 'concentration',
      frontierQuestion: 'How do rerankers change eval variance?',
      dominantTopic: 'harness-evaluation',
    });
    expect(text).toContain('EXPLORATION CYCLE');
    expect(text).toContain('How do rerankers change eval variance?');
    expect(text).toContain('harness-evaluation');
  });

  it('gives an open-ended mandate when exploring without a frontier item', () => {
    const text = buildDnaSection(CURIOSITY_PRESETS.focused, { mode: 'explore', reason: 'budget' });
    expect(text).toContain('EXPLORATION CYCLE');
    expect(text).toContain('Pick something you do not know yet');
  });
});
