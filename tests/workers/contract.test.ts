import { describe, expect, test } from 'bun:test';
import { WorkersConfigSchema } from '../../src/config';
import { taskWorkDir, workersDir } from '../../src/workers/paths';
import { WORKERS_DEFAULTS, type WorkerRun, isActiveRun, toRunView } from '../../src/workers/types';

describe('workers contract', () => {
  test('config schema defaults match WORKERS_DEFAULTS', () => {
    expect(WorkersConfigSchema.parse(undefined)).toEqual(WORKERS_DEFAULTS);
  });

  test('active statuses keep the task; ended ones do not', () => {
    for (const s of ['queued', 'running', 'waiting', 'interrupted'] as const)
      expect(isActiveRun(s)).toBe(true);
    for (const s of ['done', 'blocked', 'failed', 'stopped'] as const)
      expect(isActiveRun(s)).toBe(false);
  });

  test('the browser view never carries the claim token', () => {
    const run = { runId: 'r-1', claimToken: 'secret' } as unknown as WorkerRun;
    expect(toRunView(run)).not.toHaveProperty('claimToken');
  });

  test('each task gets its own working directory', () => {
    expect(taskWorkDir('/p/bot', 't-1')).not.toBe(taskWorkDir('/p/bot', 't-2'));
    expect(workersDir('/d', 'b').split(/[\\/]/).join('/')).toBe('/d/workers/b');
  });
});
