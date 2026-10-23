import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliDataDir,
  cliOperatorChatId,
  readOperatorReplies,
  run,
} from '../../../scripts/watcher/baseline';
import type { BotConfig } from '../../../src/config';
import { buildEffectiveConfig } from '../../../src/system/effective-config';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 3_600_000;

let root: string;
let dataDir: string;
let lines: string[];

function bot(id: string): BotConfig {
  return { id, name: id, soulDir: join(root, 'souls', id) } as unknown as BotConfig;
}

function writeCycles(botId: string, rows: Array<Record<string, unknown>>) {
  const dir = join(dataDir, 'agent-cycles', botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '2026-10-23.jsonl'),
    `${rows.map((r) => JSON.stringify({ botId, ...r })).join('\n')}\n`
  );
}

function writeMap(botId: string, names: string[]) {
  const dir = join(root, 'souls', botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'KNOWLEDGE.json'),
    JSON.stringify({ version: 1, topics: names.map((name) => ({ id: name, name })) })
  );
}

function deps(bots: BotConfig[], extra: Record<string, unknown> = {}) {
  return {
    config: buildEffectiveConfig({}, bots, root),
    dataDir,
    sessionsDir: join(root, 'sessions'),
    now: () => NOW,
    write: (l: string) => lines.push(l),
    ...extra,
  };
}

beforeEach(() => {
  root = createTempDir('watcher-baseline');
  dataDir = join(root, 'data');
  lines = [];
});

afterEach(() => removeTempDir(root));

describe('scripts/watcher/baseline run', () => {
  test('empty fleet data gives zeros and still writes the report', async () => {
    const report = await run([], deps([bot('a')]));
    expect(report.fleet.cycles).toBe(0);
    expect(report.fleet.idleShare).toBe(0);
    expect(report.fleet.medianIntervalMs).toBe(0);
    expect(report.fleet.overlappingTopics).toEqual([]);
    expect(report.bots[0]).toMatchObject({ botId: 'a', cycles: 0, topics: 0 });
    expect(report.path).toBe(join(dataDir, 'watcher', 'baseline-2026-10-23.json'));
    expect(existsSync(report.path)).toBe(true);
  });

  test('reads cycles, maps and operator replies per bot', async () => {
    writeCycles('a', [
      { cycleId: 'a1', startedAt: new Date(NOW - 3 * HOUR).toISOString(), status: 'idle' },
      {
        cycleId: 'a2',
        startedAt: new Date(NOW - 2 * HOUR).toISOString(),
        status: 'completed',
        planSummary: 'Finish the newsletter draft and send it',
      },
    ]);
    writeCycles('b', [
      { cycleId: 'b1', startedAt: new Date(NOW - 5 * HOUR).toISOString(), status: 'completed' },
      { cycleId: 'b2', startedAt: new Date(NOW - 1 * HOUR).toISOString(), status: 'completed' },
      // older than the window: ignored
      { cycleId: 'b0', startedAt: '2026-01-01T00:00:00Z', status: 'idle' },
    ]);
    writeMap('a', ['Remote job market', 'Gardening']);
    writeMap('b', ['remote job market']);
    const transcripts = join(root, 'sessions', 'transcripts', 'a');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, 'bot-a-private-42.jsonl'),
      [
        { role: 'user', content: 'pause the newsletter' },
        { role: 'assistant', content: 'Done, the newsletter draft is paused.' },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n')
    );

    const report = await run([], deps([bot('a'), bot('b')], { operatorChatId: 42 }));

    const a = report.bots.find((x) => x.botId === 'a');
    const b = report.bots.find((x) => x.botId === 'b');
    expect(a).toMatchObject({ cycles: 2, idleShare: 0.5, medianIntervalMs: HOUR, topics: 2 });
    expect(b).toMatchObject({ cycles: 2, idleShare: 0, medianIntervalMs: 4 * HOUR, topics: 1 });
    expect(report.fleet.cycles).toBe(4);
    expect(report.fleet.idleShare).toBe(0.25);
    // gaps 1h (a) and 4h (b) → 2.5h
    expect(report.fleet.medianIntervalMs).toBe(2.5 * HOUR);
    expect(report.fleet.overlappingTopics).toHaveLength(1);
    expect(report.fleet.contradictions).toHaveLength(1);
    expect(report.fleet.contradictions[0]).toMatchObject({ botId: 'a', cycleId: 'a2' });
    expect(a?.contradictionCandidates).toBe(1);

    const saved = JSON.parse(readFileSync(report.path, 'utf-8'));
    expect(saved.fleet.cycles).toBe(4);
    expect(lines.join('\n')).toContain('a');
  });

  test('without an operator chat id no transcript is read', async () => {
    writeCycles('a', [
      {
        cycleId: 'a1',
        startedAt: new Date(NOW - HOUR).toISOString(),
        status: 'completed',
        planSummary: 'Finish the newsletter draft',
      },
    ]);
    const transcripts = join(root, 'sessions', 'transcripts', 'a');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, 'bot-a-private-42.jsonl'),
      `${JSON.stringify({ role: 'assistant', content: 'newsletter draft paused' })}\n`
    );
    const report = await run([], deps([bot('a')]));
    expect(report.fleet.contradictions).toEqual([]);
  });

  test('--days narrows the window', async () => {
    writeCycles('a', [
      { cycleId: 'a1', startedAt: new Date(NOW - 3 * 86_400_000).toISOString(), status: 'idle' },
      { cycleId: 'a2', startedAt: new Date(NOW - HOUR).toISOString(), status: 'completed' },
    ]);
    const report = await run(['--days', '1'], deps([bot('a')]));
    expect(report.windowDays).toBe(1);
    expect(report.fleet.cycles).toBe(1);
  });

  test('--json prints the report as JSON', async () => {
    await run(['--json'], deps([bot('a')]));
    expect(JSON.parse(lines.join('\n')).fleet.cycles).toBe(0);
  });

  test('a malformed transcript or knowledge file never throws', async () => {
    mkdirSync(join(root, 'souls', 'a'), { recursive: true });
    writeFileSync(join(root, 'souls', 'a', 'KNOWLEDGE.json'), '{not json');
    const transcripts = join(root, 'sessions', 'transcripts', 'a');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'bot-a-private-42.jsonl'), 'garbage\n{"role":"assistant"}\n');
    const report = await run([], deps([bot('a')], { operatorChatId: 42 }));
    expect(report.bots[0].topics).toBe(0);
  });
});

describe('readOperatorReplies', () => {
  test('missing transcript is empty', () => {
    expect(readOperatorReplies(join(root, 'nope'), 'a', 1)).toEqual([]);
  });

  test('assistant turns only, newest last, capped at count', () => {
    const dir = join(root, 'sessions', 'transcripts', 'a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bot-a-private-7.jsonl'),
      ['one', 'two', 'three']
        .flatMap((t) => [
          { role: 'user', content: `q ${t}` },
          { role: 'assistant', content: t },
        ])
        .map((m) => JSON.stringify(m))
        .join('\n')
    );
    expect(readOperatorReplies(join(root, 'sessions'), 'a', 7, 2)).toEqual(['two', 'three']);
  });

  test('falls back to the legacy flat transcript path', () => {
    const dir = join(root, 'sessions', 'transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bot-a-private-7.jsonl'),
      `${JSON.stringify({ role: 'assistant', content: 'flat' })}\n`
    );
    expect(readOperatorReplies(join(root, 'sessions'), 'a', 7)).toEqual(['flat']);
  });
});

describe('cli helpers', () => {
  test('cliDataDir: --data wins, else paths.data, else ./data, absolute against root', () => {
    expect(cliDataDir('/x/data', {}, '/root')).toBe('/x/data');
    expect(cliDataDir(undefined, { paths: { data: 'store' } }, root)).toBe(join(root, 'store'));
    expect(cliDataDir(undefined, {}, root)).toBe(join(root, 'data'));
  });

  test('cliOperatorChatId: number or numeric string, else undefined', () => {
    expect(cliOperatorChatId({ operator: { telegramChatId: 42 } })).toBe(42);
    expect(cliOperatorChatId({ operator: { telegramChatId: '42' } })).toBe(42);
    expect(cliOperatorChatId({ operator: { telegramChatId: '${CHAT}' } })).toBeUndefined();
    expect(cliOperatorChatId({})).toBeUndefined();
  });
});
