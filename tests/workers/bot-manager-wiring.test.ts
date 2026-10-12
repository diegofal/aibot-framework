/**
 * BotManager creates the worker pool only when `config.workers.enabled`,
 * shares it as `ctx.workerPool`, and `stopAll` interrupts every run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotManager } from '../../src/bot/bot-manager';
import { loadConfig } from '../../src/config';
import { SkillRegistry } from '../../src/core/skill-registry';
import { CronService } from '../../src/cron/service';
import { SessionManager } from '../../src/session';

const silent: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};
silent.child = () => silent;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workers-wiring-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function manager(workers: Record<string, unknown>) {
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ollama: { baseUrl: 'http://127.0.0.1:9', models: { primary: 'm' } },
      skills: { enabled: [], config: {} },
      logging: { level: 'error' },
      paths: { data, logs: join(dir, 'logs'), skills: join(dir, 'skills') },
      session: { dataDir: join(data, 'sessions') },
      soul: { dir: join(dir, 'legacy-soul'), healthCheck: { enabled: false } },
      cron: { enabled: false, storePath: join(data, 'cron') },
      agentLoop: { enabled: false },
      security: { auditOnStartup: false },
      conversations: { baseDir: join(data, 'conversations') },
      karma: { baseDir: join(data, 'karma') },
      productions: { baseDir: join(dir, 'productions') },
      multiTenant: { dataDir: join(data, 'tenants') },
      dynamicTools: { storePath: join(data, 'tools') },
      agentProposals: { storePath: join(data, 'agent-proposals') },
      workers,
    })
  );
  writeFileSync(
    join(dir, 'bots.json'),
    JSON.stringify([
      { id: 'b1', name: 'B1', token: '', skills: [], soulDir: join(data, 'soul', 'b1') },
    ])
  );
  const config = await loadConfig(configPath);
  const skills = new SkillRegistry(config, silent);
  const sessions = new SessionManager(config.session, silent);
  await sessions.initialize();
  const cron = new CronService({
    logger: silent,
    storePath: config.cron.storePath,
    cronEnabled: false,
    sendMessage: async () => {},
    sendInstruction: async () => '',
    resolveSkillHandler: () => undefined,
  } as any);
  return new BotManager(
    skills,
    silent,
    skills.getOllamaClient(),
    config,
    sessions,
    cron,
    undefined,
    configPath
  );
}

describe('BotManager worker wiring', () => {
  test('no pool when workers are off (the default)', async () => {
    const m = await manager({});
    expect(m.getWorkerPool()).toBeUndefined();
    expect((m as any).botContext.workerPool).toBeUndefined();
    await m.stopAll();
  });

  test('workers on: one pool, shared through the context; stopAll interrupts', async () => {
    const m = await manager({ enabled: true, bots: ['b1'] });
    const pool = m.getWorkerPool();
    expect(pool).toBeDefined();
    expect((m as any).botContext.workerPool).toBe(pool);
    expect(pool?.isEnabledFor('b1')).toBe(true);
    expect(pool?.isEnabledFor('b2')).toBe(false);
    let aborted = false;
    const orig = pool?.abortAll.bind(pool);
    if (pool && orig)
      pool.abortAll = async (r) => {
        aborted = true;
        return orig(r);
      };
    await m.stopAll();
    expect(aborted).toBe(true);
  });
});
