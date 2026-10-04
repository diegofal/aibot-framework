import { describe, expect, it } from 'bun:test';
import { activityTabHash } from '../../web/pages/activity-helpers.js';
import { historyHasMore, nextHistoryLimit } from '../../web/pages/hygiene-helpers.js';

describe('activityTabHash', () => {
  it('puts the tab in the canonical activity hash', () => {
    expect(activityTabHash('#/insights/activity', 'logs')).toBe('#/insights/activity?tab=logs');
    expect(activityTabHash('#/activity?tab=logs', 'llm')).toBe('#/insights/activity?tab=llm');
  });
  it('drops the param for the default events tab and keeps other params', () => {
    expect(activityTabHash('#/insights/activity?tab=logs&x=1', 'events')).toBe(
      '#/insights/activity?x=1'
    );
    expect(activityTabHash('#/insights/activity?tab=llm', 'events')).toBe('#/insights/activity');
  });
});

describe('hygiene history paging', () => {
  it('has more only when the page came back full and under the store cap', () => {
    expect(historyHasMore(50, 50)).toBe(true);
    expect(historyHasMore(12, 50)).toBe(false);
    expect(historyHasMore(500, 500)).toBe(false);
  });
  it('next limit grows by a page and caps at 500', () => {
    expect(nextHistoryLimit(50)).toBe(100);
    expect(nextHistoryLimit(480)).toBe(500);
  });
});
