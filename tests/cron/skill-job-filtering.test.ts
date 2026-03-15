import { describe, expect, it } from 'bun:test';

/**
 * Tests the skill job filtering logic from src/index.ts:
 * Jobs should only be registered for bots that have the skill in their skills array.
 * Orphaned jobs (bot removed skill, bot deleted) should be cleaned up.
 */

interface FakeBot {
  id: string;
  skills?: string[];
}
interface FakeSkill {
  id: string;
  name: string;
  jobs?: { id: string; schedule: string }[];
}
interface FakeJob {
  skillId: string;
  jobId: string;
  botId: string;
}

/** Mirrors the registration logic in src/index.ts */
function computeRegistrations(skills: FakeSkill[], bots: FakeBot[]): FakeJob[] {
  const result: FakeJob[] = [];
  for (const skill of skills) {
    if (!skill.jobs) continue;
    for (const job of skill.jobs) {
      for (const bot of bots) {
        if (bot.skills && !bot.skills.includes(skill.id)) continue;
        result.push({ skillId: skill.id, jobId: job.id, botId: bot.id });
      }
    }
  }
  return result;
}

/** Mirrors the orphan cleanup logic in src/index.ts */
function findOrphans(existing: FakeJob[], valid: FakeJob[]): FakeJob[] {
  const validSet = new Set(valid.map((j) => `${j.skillId}:${j.jobId}:${j.botId}`));
  return existing.filter((j) => !validSet.has(`${j.skillId}:${j.jobId}:${j.botId}`));
}

describe('skill job filtering', () => {
  const skills: FakeSkill[] = [
    {
      id: 'reflection',
      name: 'Reflection',
      jobs: [{ id: 'nightly-reflection', schedule: '30 3 * * *' }],
    },
    {
      id: 'intel-gatherer',
      name: 'Intel Gatherer',
      jobs: [{ id: 'daily-intel-collection', schedule: '0 8 * * *' }],
    },
    { id: 'no-jobs-skill', name: 'No Jobs' },
  ];

  const bots: FakeBot[] = [
    { id: 'default', skills: ['reflection', 'intel-gatherer', 'daily-briefing'] },
    { id: 'cryptik', skills: ['reflection'] },
    { id: 'job-seeker', skills: ['reflection'] },
    { id: 'openclone', skills: [] },
    { id: 'moltbook', skills: [] },
    { id: 'monetize', skills: [] },
  ];

  it('only registers jobs for bots that have the skill', () => {
    const jobs = computeRegistrations(skills, bots);

    // reflection: default, cryptik, job-seeker (3 bots)
    const reflectionJobs = jobs.filter((j) => j.skillId === 'reflection');
    expect(reflectionJobs.map((j) => j.botId).sort()).toEqual(['cryptik', 'default', 'job-seeker']);

    // intel-gatherer: only default
    const intelJobs = jobs.filter((j) => j.skillId === 'intel-gatherer');
    expect(intelJobs.map((j) => j.botId)).toEqual(['default']);

    // Total: 3 + 1 = 4 (not 6*2=12)
    expect(jobs.length).toBe(4);
  });

  it('does not register jobs for bots with empty skills array', () => {
    const jobs = computeRegistrations(skills, bots);
    const emptySkillBots = ['openclone', 'moltbook', 'monetize'];
    for (const botId of emptySkillBots) {
      expect(jobs.filter((j) => j.botId === botId)).toEqual([]);
    }
  });

  it('registers for all bots when bot has no skills field (undefined)', () => {
    const botsNoField: FakeBot[] = [
      { id: 'legacy-bot' }, // no skills field — should get all jobs
    ];
    const jobs = computeRegistrations(skills, botsNoField);
    expect(jobs.length).toBe(2); // reflection + intel-gatherer
  });

  it('skips skills with no jobs', () => {
    const jobs = computeRegistrations(skills, bots);
    expect(jobs.filter((j) => j.skillId === 'no-jobs-skill')).toEqual([]);
  });

  it('identifies orphaned jobs for cleanup', () => {
    const validJobs = computeRegistrations(skills, bots);

    // Simulate existing jobs that include orphans (e.g. openclone had reflection before)
    const existingJobs: FakeJob[] = [
      ...validJobs,
      { skillId: 'reflection', jobId: 'nightly-reflection', botId: 'openclone' },
      { skillId: 'intel-gatherer', jobId: 'daily-intel-collection', botId: 'monetize' },
      { skillId: 'reflection', jobId: 'nightly-reflection', botId: 'deleted-bot' },
    ];

    const orphans = findOrphans(existingJobs, validJobs);
    expect(orphans.length).toBe(3);
    expect(orphans.map((o) => o.botId).sort()).toEqual(['deleted-bot', 'monetize', 'openclone']);
  });

  it('no orphans when existing matches valid exactly', () => {
    const validJobs = computeRegistrations(skills, bots);
    const orphans = findOrphans(validJobs, validJobs);
    expect(orphans.length).toBe(0);
  });
});
