import { describe, expect, it } from 'bun:test';
import { permissionToWhy } from '../../../src/why/builders/permission';
import { WhySchema } from '../../../src/why/types';

describe('permissionToWhy', () => {
  it('names the action, its stated reason, and that the cycle is not recorded yet', () => {
    const why = permissionToWhy({
      botId: 'b1',
      action: 'exec',
      resource: 'rm -rf build/',
      description: 'Clean the stale build before publishing',
    });
    expect(why).toEqual({
      what: 'It asked permission to exec on rm -rf build/',
      by: 'agent',
      reason: { text: 'Clean the stale build before publishing', source: 'its stated reason' },
      outcome: 'Waiting for your decision.',
      missing: 'Permission requests do not record the cycle or goal that asked yet.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('drops empty parts', () => {
    const why = permissionToWhy({ botId: 'b1', action: '', resource: '', description: ' ' });
    expect(why.what).toBe('It asked permission to act');
    expect(why.reason).toBeUndefined();
    expect(WhySchema.safeParse(why).success).toBe(true);
  });
});
