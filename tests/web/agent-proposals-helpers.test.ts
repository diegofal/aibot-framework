import { describe, expect, it } from 'bun:test';
import { proposerLabel, rosterFieldsHtml } from '../../web/pages/agent-proposals-helpers.js';

describe('proposerLabel', () => {
  it('names the mind for a watcher proposal and the bot otherwise', () => {
    expect(proposerLabel({ proposedBy: '__watcher__' })).toBe('The mind (watcher)');
    expect(proposerLabel({ proposedBy: 'scout' })).toBe('scout');
    expect(proposerLabel({})).toBe('');
  });
});

describe('rosterFieldsHtml', () => {
  it('renders nothing for a proposal without the new fields', () => {
    expect(rosterFieldsHtml({ agentId: 'x', skills: [] })).toBe('');
    expect(rosterFieldsHtml(null)).toBe('');
  });

  it('shows serves, deliverable, delivery, kill criterion, goals and preset', () => {
    const html = rosterFieldsHtml({
      serves: [{ id: 'w-aaaaaa', what: 'Weekly job digest' }],
      deliverable: 'A Monday list of 5 offers',
      delivery: 'Telegram',
      killCriterion: 'No approval in 3 weeks',
      goals: ['Find offers', 'Rank them'],
      preset: 'job-seeker',
    });
    for (const s of [
      'Serves',
      'Weekly job digest',
      'Deliverable',
      'A Monday list of 5 offers',
      'Delivery',
      'Telegram',
      'Kill criterion',
      'No approval in 3 weeks',
      'Goals',
      'Find offers',
      'Rank them',
      'Preset',
      'job-seeker',
    ]) {
      expect(html).toContain(s);
    }
  });

  it('escapes every field', () => {
    const evil = '<script>x</script>';
    const html = rosterFieldsHtml({
      serves: [{ id: evil, what: evil }],
      deliverable: evil,
      delivery: evil,
      killCriterion: evil,
      goals: [evil],
      preset: evil,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
