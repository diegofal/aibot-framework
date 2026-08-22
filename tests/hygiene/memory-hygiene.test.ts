import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { detectPii, memoryHygiene } from '../../src/hygiene/routines/memory-hygiene';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { TODAY, dateDaysAgo, daysAgo, makeCtx, makeDeps, writeFile } from './helpers';

let root: string;
let soulDir: string;

beforeEach(() => {
  root = createTempDir('hygiene-memory');
  soulDir = join(root, 'soul');
});

afterEach(() => {
  removeTempDir(root);
});

describe('detectPii', () => {
  test('detects emails, phones, chat ids and money', () => {
    const hits = detectPii(
      [
        'contact: ana@example.com',
        'tel +54 9 11 1234-5678',
        'chat 123456789 said hi',
        'owes $1.200 and 300 USD',
      ].join('\n')
    );
    expect(hits.map((h) => [h.line, h.kind])).toEqual([
      [1, 'email'],
      [2, 'phone'],
      [3, 'chat-id'],
      [4, 'money'],
      [4, 'money'],
    ]);
    expect(hits[0].excerpt).toContain('ana@example.com');
  });

  test('does not treat ISO dates or short numbers as chat ids', () => {
    expect(detectPii('on 2026-08-21 we met 42 people, ticket 123456')).toEqual([]);
  });

  test('flags custody/children lines with the default keyword list', () => {
    const hits = detectPii('- [10:00] habló de la custodia de sus hijos (5) y (7)');
    expect(hits.map((h) => h.kind)).toEqual(['custody']);
  });

  test('does not mistake dates, file numbers or parenthesised digits for custody talk', () => {
    expect(
      detectPii(
        '- [10:00] Founder Community Gap Analysis (2026-08-19): searched r/startups (7) and 07_everyday_analogies.md'
      )
    ).toEqual([]);
  });

  test('family keywords are word-bounded (no hit inside "Archivo" or "Self-custody")', () => {
    expect(detectPii('Archivo 07_everyday reescrito')).toEqual([]);
    expect(detectPii('Self-custody relocates risk, it does not eliminate it')).toEqual([]);
    expect(detectPii('habló de sus hijos').map((h) => h.kind)).toEqual(['custody']);
  });

  test('accepts a custom keyword list', () => {
    expect(
      detectPii('talked about the divorce', { keywords: ['divorce'] }).map((h) => h.kind)
    ).toEqual(['custody']);
    expect(detectPii('habló de la custodia', { keywords: ['divorce'] })).toEqual([]);
  });

  test('skips already redacted spans', () => {
    expect(detectPii('mail [redacted:email] done')).toEqual([]);
  });
});

describe('memory-hygiene metadata', () => {
  test('is bot-scoped and applicable', () => {
    expect(memoryHygiene.id).toBe('memory-hygiene');
    expect(memoryHygiene.scope).toBe('bot');
    expect(memoryHygiene.canApply).toBe(true);
  });

  test('empty soul dir yields no findings', () => {
    expect(memoryHygiene.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('pii kinds: severity and redactKinds', () => {
  test('money is report-only (info, not fixable) by default', () => {
    writeFile(join(soulDir, 'MEMORY.md'), '- budget USD 8,800 and mail bob@example.com\n');
    const findings = memoryHygiene.preview(makeCtx(root, { soulDir }));
    const money = findings.find((f) => f.data?.piiKind === 'money')!;
    const email = findings.find((f) => f.data?.piiKind === 'email')!;
    expect(money.severity).toBe('info');
    expect(money.fixable).toBe(false);
    expect(money.fix).toBeUndefined();
    expect(email.severity).toBe('critical');
    expect(email.fixable).toBe(true);
  });

  test('options.redactKinds narrows what apply may touch', () => {
    writeFile(join(soulDir, 'MEMORY.md'), '- hijos: Ana (5)\n- mail bob@example.com\n');
    const ctx = makeCtx(root, { soulDir, options: { redactKinds: ['email'] } });
    const findings = memoryHygiene.preview(ctx);
    const custody = findings.find((f) => f.data?.piiKind === 'custody')!;
    expect(custody.fixable).toBe(false);
    const result = memoryHygiene.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- hijos: Ana (5)\n- mail [redacted:email]\n'
    );
  });

  test('options.redactKinds can opt money in', () => {
    writeFile(join(soulDir, 'MEMORY.md'), '- paid $40\n');
    const ctx = makeCtx(root, { soulDir, options: { redactKinds: ['money'] } });
    const findings = memoryHygiene.preview(ctx);
    expect(findings[0].fixable).toBe(true);
    memoryHygiene.apply(ctx, findings);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe('- paid [redacted:money]\n');
  });
});

describe('pii findings + apply', () => {
  test('scans MEMORY.md and memory/*.md but not memory/archive', () => {
    writeFile(join(soulDir, 'MEMORY.md'), '# Memory\n- user mail: bob@example.com\n');
    writeFile(join(soulDir, 'memory', `${TODAY}.md`), '- [09:00] call +34 600 123 456\n');
    writeFile(join(soulDir, 'memory', 'archive', 'old.md'), '- old mail: zed@example.com\n');
    const ctx = makeCtx(root, { soulDir });
    const findings = memoryHygiene.preview(ctx);
    const pii = findings.filter((f) => f.kind === 'pii');
    expect(pii.map((f) => f.file).sort()).toEqual(['MEMORY.md', `memory/${TODAY}.md`]);
    expect(pii.every((f) => f.fixable && f.severity === 'critical')).toBe(true);
    expect(pii.find((f) => f.file === 'MEMORY.md')!.line).toBe(2);

    const result = memoryHygiene.apply(ctx, findings);
    expect(result.applied).toHaveLength(2);
    expect(result.backups).toHaveLength(2);
    expect(result.backups.every((b) => existsSync(b))).toBe(true);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe(
      '# Memory\n- user mail: [redacted:email]\n'
    );
    expect(readFileSync(join(soulDir, 'memory', `${TODAY}.md`), 'utf-8')).toBe(
      '- [09:00] call [redacted:phone]\n'
    );
    expect(readFileSync(join(soulDir, 'memory', 'archive', 'old.md'), 'utf-8')).toContain(
      'zed@example.com'
    );
  });

  test('redacts several matches on one line right-to-left without corrupting offsets', () => {
    writeFile(join(soulDir, 'MEMORY.md'), 'a@x.io and b@y.io owe $50\n');
    const ctx = makeCtx(root, { soulDir, options: { redactKinds: ['email', 'money'] } });
    const findings = memoryHygiene.preview(ctx);
    expect(findings.filter((f) => f.kind === 'pii')).toHaveLength(3);
    memoryHygiene.apply(ctx, findings);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe(
      '[redacted:email] and [redacted:email] owe [redacted:money]\n'
    );
  });

  test('custody lines are redacted wholesale but keep the bullet/timestamp prefix', () => {
    writeFile(
      join(soulDir, 'MEMORY.md'),
      '- [10:00] habló de la custodia de los hijos\n- ok line\n'
    );
    const ctx = makeCtx(root, { soulDir });
    const findings = memoryHygiene.preview(ctx);
    memoryHygiene.apply(ctx, findings);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- [10:00] [redacted:custody]\n- ok line\n'
    );
  });

  test('skips a finding when the line changed since preview', () => {
    writeFile(join(soulDir, 'MEMORY.md'), 'mail a@x.io\n');
    const ctx = makeCtx(root, { soulDir });
    const findings = memoryHygiene.preview(ctx);
    writeFile(join(soulDir, 'MEMORY.md'), 'something else entirely\n');
    const result = memoryHygiene.apply(ctx, findings);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/changed/);
    expect(result.backups).toHaveLength(0);
  });
});

describe('stale-constraint', () => {
  test('reports as info when the tool is not known to work, warn+fixable when it succeeded recently', () => {
    writeFile(join(soulDir, 'MEMORY.md'), '- web_search no disponible, usar otra cosa\n');
    const quiet = memoryHygiene.preview(makeCtx(root, { soulDir }));
    expect(quiet.map((f) => [f.kind, f.severity, f.fixable])).toEqual([
      ['stale-constraint', 'info', false],
    ]);

    const ctx = makeCtx(root, {
      soulDir,
      deps: makeDeps({ toolSucceededRecently: (_b, tool) => tool === 'web_search' }),
    });
    const findings = memoryHygiene.preview(ctx);
    expect(findings.map((f) => [f.kind, f.severity, f.fixable])).toEqual([
      ['stale-constraint', 'warn', true],
    ]);

    const result = memoryHygiene.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe(
      `- web_search no disponible, usar otra cosa [stale as of ${TODAY}: tool succeeded recently — memory-hygiene]\n`
    );
  });

  test('does not re-flag lines already marked stale, and ignores lines without a tool name', () => {
    writeFile(
      join(soulDir, 'MEMORY.md'),
      '- web_fetch unavailable [stale as of 2026-08-01: tool succeeded recently — memory-hygiene]\n- the service is not available today\n'
    );
    expect(memoryHygiene.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('daily-logs-pending', () => {
  test('counts logs older than 7 days that are not archived', () => {
    writeFile(join(soulDir, 'memory', `${dateDaysAgo(10)}.md`), '- old\n');
    writeFile(join(soulDir, 'memory', `${dateDaysAgo(8)}.md`), '- old\n');
    writeFile(join(soulDir, 'memory', `${dateDaysAgo(2)}.md`), '- fresh\n');
    writeFile(join(soulDir, 'memory', 'archive', `${dateDaysAgo(30)}.md`), '- archived\n');
    const findings = memoryHygiene.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['daily-logs-pending']);
    expect(findings[0].fixable).toBe(false);
    expect(findings[0].message).toContain('2');
    expect(findings[0].data?.files).toEqual([`${dateDaysAgo(10)}.md`, `${dateDaysAgo(8)}.md`]);
  });

  test('falls back to mtime for logs without a date in the name', () => {
    const path = join(soulDir, 'memory', 'legacy.md');
    writeFile(path, '- legacy\n');
    const old = daysAgo(20);
    utimesSync(path, old, old);
    const findings = memoryHygiene.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['daily-logs-pending']);
  });
});
