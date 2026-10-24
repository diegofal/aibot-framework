import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import {
  assessTenantPaths,
  formatAssessment,
  takesTenantBranch,
} from '../../../scripts/watcher/tenant-paths';
import type { Config } from '../../../src/config';

const root = resolve('/tmp/aibot-o8');
function config(enabled = true): Config {
  return {
    bots: [
      { id: 'adm', name: 'Admin bot', tenantId: '__admin__' },
      { id: 'cust', name: 'Customer bot', tenantId: 't1' },
      { id: 'plain', name: 'Plain bot' },
    ],
    soul: { dir: join(root, 'config', 'soul') },
    productions: { baseDir: join(root, 'productions') },
    multiTenant: { enabled, dataDir: join(root, 'data', 'tenants') },
    paths: { data: join(root, 'data') },
    ollama: { models: { primary: 'm' } },
    conversation: { systemPrompt: '', temperature: 0.7, maxHistory: 20 },
    claudeCli: {},
  } as unknown as Config;
}

const rowsOf = (rows: ReturnType<typeof assessTenantPaths>, botId: string) =>
  rows.filter((r) => r.botId === botId);

describe('tenant-paths assessment (O8)', () => {
  test('the branch: today any tenantId; isTenantBot not __admin__', () => {
    const c = config();
    const [adm, cust, plain] = c.bots;
    expect(takesTenantBranch(adm, c, 'today')).toBe(true);
    expect(takesTenantBranch(adm, c, 'isTenantBot')).toBe(false);
    expect(takesTenantBranch(cust, c, 'isTenantBot')).toBe(true);
    expect(takesTenantBranch(plain, c, 'today')).toBe(false);
  });

  test('an __admin__ bot: same soul dir, a different work dir, and the chat-history gate', () => {
    const rows = assessTenantPaths(config());
    const adm = rowsOf(rows, 'adm');
    expect(adm.filter((r) => r.field === 'soulDir').every((r) => !r.differs)).toBe(true);
    const work = adm.filter((r) => r.field === 'workDir');
    expect(work).toHaveLength(3);
    expect(work.every((r) => r.differs)).toBe(true);
    expect(work[0].today).toBe(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'adm', 'productions')
    );
    expect(work[0].withIsTenantBot).toBe(join(root, 'productions', 'adm'));
    const gate = adm.find((r) => r.field === 'tenantGate');
    expect(gate?.differs).toBe(true);
  });

  test('a customer-tenant bot and a bot without tenant never differ', () => {
    const rows = assessTenantPaths(config());
    expect(rowsOf(rows, 'cust').some((r) => r.differs)).toBe(false);
    expect(rowsOf(rows, 'plain').some((r) => r.differs)).toBe(false);
  });

  test('multi-tenant off: nothing differs', () => {
    expect(assessTenantPaths(config(false)).some((r) => r.differs)).toBe(false);
  });

  test('the report names the differing sites and gives a verdict', () => {
    const text = formatAssessment(assessTenantPaths(config()), true);
    expect(text).toContain('adm  (tenantId: __admin__)  4 site(s) differ');
    expect(text).toContain('Verdict: 1 bot(s) resolve a different path at 3 site/field(s)');
    expect(text).toContain('one-time move');
    expect(text).toContain('chat-history');
  });
});
