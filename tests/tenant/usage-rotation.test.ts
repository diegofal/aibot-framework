import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TenantManager } from '../../src/tenant/manager';

const TEST_DIR = join(import.meta.dir, '.tmp-usage-rotation-test');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

describe('TenantManager.rotateUsage', () => {
  let manager: TenantManager;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    manager = new TenantManager({ dataDir: TEST_DIR }, makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('returns 0 archived when no usage file', () => {
    const result = manager.rotateUsage();
    expect(result).toEqual({ archived: 0, kept: 0 });
  });

  test('keeps current month records in main file', () => {
    const now = new Date();
    const currentRecord = {
      tenantId: 't1',
      botId: 'b1',
      timestamp: now.toISOString(),
      messageCount: 5,
      apiCallCount: 2,
      storageBytesUsed: 0,
    };
    writeFileSync(join(TEST_DIR, 'usage.jsonl'), `${JSON.stringify(currentRecord)}\n`);

    const result = manager.rotateUsage();
    expect(result.archived).toBe(0);
    expect(result.kept).toBe(1);
  });

  test('archives old records and keeps current', () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);

    const oldRecord = {
      tenantId: 't1',
      botId: 'b1',
      timestamp: lastMonth.toISOString(),
      messageCount: 10,
      apiCallCount: 5,
      storageBytesUsed: 100,
    };
    const currentRecord = {
      tenantId: 't1',
      botId: 'b1',
      timestamp: now.toISOString(),
      messageCount: 3,
      apiCallCount: 1,
      storageBytesUsed: 0,
    };

    writeFileSync(
      join(TEST_DIR, 'usage.jsonl'),
      `${JSON.stringify(oldRecord)}\n${JSON.stringify(currentRecord)}\n`
    );

    const result = manager.rotateUsage();
    expect(result.archived).toBe(1);
    expect(result.kept).toBe(1);

    // Verify main file only has current record
    const main = readFileSync(join(TEST_DIR, 'usage.jsonl'), 'utf-8').trim();
    const mainRecords = main.split('\n').map((l) => JSON.parse(l));
    expect(mainRecords).toHaveLength(1);
    expect(mainRecords[0].messageCount).toBe(3);

    // Verify archive file exists with old record
    const archiveFiles = require('node:fs')
      .readdirSync(TEST_DIR)
      .filter((f: string) => f.startsWith('usage-archive-'));
    expect(archiveFiles.length).toBe(1);
  });

  test('handles corrupt lines gracefully', () => {
    const now = new Date();
    const currentRecord = {
      tenantId: 't1',
      botId: 'b1',
      timestamp: now.toISOString(),
      messageCount: 1,
      apiCallCount: 0,
      storageBytesUsed: 0,
    };

    writeFileSync(
      join(TEST_DIR, 'usage.jsonl'),
      `CORRUPT LINE\n${JSON.stringify(currentRecord)}\n{bad json\n`
    );

    const result = manager.rotateUsage();
    // Corrupt lines are dropped, only valid current record kept
    expect(result.kept).toBe(1);
    expect(result.archived).toBe(0);
  });
});
