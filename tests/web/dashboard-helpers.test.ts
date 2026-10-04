import { describe, expect, it } from 'bun:test';
import {
  activityCell,
  loopStateError,
  selectionSummary,
} from '../../web/pages/dashboard-helpers.js';

describe('agent loop page helpers', () => {
  it('activityCell says Executing with a pulse, or Idle', () => {
    const on = activityCell(true);
    expect(on).toContain('Executing');
    expect(on).toContain('processing-pulse');
    expect(activityCell(false)).toContain('Idle');
    expect(activityCell(false)).not.toContain('Executing');
  });
  it('selectionSummary explains the empty selection and counts the rest', () => {
    expect(selectionSummary(0, 5)).toBe('None selected — Run Now runs every running bot');
    expect(selectionSummary(2, 5)).toBe('2 of 5 selected');
    expect(selectionSummary(5, 5)).toBe('All 5 selected');
  });
  it('loopStateError flags error payloads and non-objects only', () => {
    expect(loopStateError({ error: 'boom' })).toBe('boom');
    expect(loopStateError(null)).toBe('No response from /api/agent-loop');
    expect(loopStateError({ enabled: true, botSchedules: [] })).toBeNull();
  });
});
