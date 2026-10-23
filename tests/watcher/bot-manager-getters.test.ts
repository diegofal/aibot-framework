/**
 * BotManager exposes the hook emitter and the contact directory the watcher
 * senses and reads (src/watcher/watcher.ts).
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
  dir = mkdtempSync(join(tmpdir(), 'watcher-bm-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

import { HUMAN_INBOUND_HOOK } from '../../src/bot/agent-loop-utils';
import { HookEmitter } from '../../src/bot/hooks';
import { UserDirectory } from '../../src/bot/user-directory';
async function manager() {
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
describe('BotManager watcher getters', () => {
  test('getHooks returns the shared HookEmitter the pipeline emits human_inbound on', async () => {
    const m = await manager();
    const hooks = m.getHooks();
    expect(hooks).toBeInstanceOf(HookEmitter);
    expect(hooks).toBe((m as any).botContext.hooks);
    const seen: unknown[] = [];
    hooks.on(HUMAN_INBOUND_HOOK, (e: unknown) => seen.push(e));
    (m as any).botContext.hooks.emit(HUMAN_INBOUND_HOOK, { botId: 'b1' });
    expect(seen).toHaveLength(1);
    await m.stopAll();
  });

  test('getUserDirectory returns the one contact directory', async () => {
    const m = await manager();
    expect(m.getUserDirectory()).toBeInstanceOf(UserDirectory);
    expect(m.getUserDirectory()).toBe(m.getUserDirectory());
    expect(m.getUserDirectory().list('b1')).toEqual([]);
    await m.stopAll();
  });
});
