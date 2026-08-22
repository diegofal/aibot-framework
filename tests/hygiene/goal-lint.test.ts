import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { goalLint } from '../../src/hygiene/routines/goal-lint';
import { parseGoals } from '../../src/tools/goals';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { TODAY, dateDaysAgo, makeCtx, makeDeps, writeFile } from './helpers';

let root: string;
let soulDir: string;

beforeEach(() => {
  root = createTempDir('hygiene-goals');
  soulDir = join(root, 'soul');
});

afterEach(() => {
  removeTempDir(root);
});

function goals(content: string): string {
  const path = join(soulDir, 'GOALS.md');
  writeFile(path, content);
  return path;
}

describe('goal-lint metadata', () => {
  test('is bot-scoped and applicable', () => {
    expect(goalLint.id).toBe('goal-lint');
    expect(goalLint.scope).toBe('bot');
    expect(goalLint.canApply).toBe(true);
  });

  test('returns no findings when GOALS.md is missing', () => {
    expect(goalLint.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('archived-in-active', () => {
  test('flags an archived goal under Active Goals and moves it on apply', () => {
    goals(`## Active Goals
- [ ] Write the weekly newsletter
  - status: archived
  - priority: low
- [ ] Keep learning
  - status: in_progress
  - priority: medium

## Completed
(none yet)
`);
    const ctx = makeCtx(root, { soulDir });
    const findings = goalLint.preview(ctx);
    const f = findings.find((x) => x.kind === 'archived-in-active');
    expect(f).toBeDefined();
    expect(f!.fixable).toBe(true);
    expect(f!.line).toBe(2);
    expect(f!.file).toBe('GOALS.md');

    const result = goalLint.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(result.backups).toHaveLength(1);
    expect(existsSync(result.backups[0])).toBe(true);

    const parsed = parseGoals(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8'));
    expect(parsed.active.map((g) => g.text)).toEqual(['Keep learning']);
    expect(parsed.completed[0]).toMatchObject({
      text: 'Write the weekly newsletter',
      completed: TODAY,
      outcome: 'moved by goal-lint (was status=archived)',
    });
  });

  test('treats status completed under Active the same way', () => {
    goals(`## Active Goals
- [ ] Done thing
  - status: completed
  - priority: low
`);
    const findings = goalLint.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['archived-in-active']);
  });
});

describe('duplicate-title', () => {
  test('reports near-identical active goals as manual, apply skips them', () => {
    goals(`## Active Goals
- [ ] Publicar el artículo sobre hábitos de sueño
  - status: pending
  - priority: medium
- [ ] Publicar artículo: hábitos de sueño
  - status: pending
  - priority: low
- [ ] Comprar leche
  - status: pending
  - priority: low
`);
    const ctx = makeCtx(root, { soulDir });
    const findings = goalLint.preview(ctx);
    const dups = findings.filter((f) => f.kind === 'duplicate-title');
    expect(dups).toHaveLength(1);
    expect(dups[0].fixable).toBe(false);
    expect(dups[0].message).toContain('Publicar');
    expect(dups[0].message).not.toContain('Comprar leche');

    const result = goalLint.apply(ctx, findings);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/manual/i);
    // No rewrite → no backup
    expect(result.backups).toHaveLength(0);
  });
});

describe('oversized-notes', () => {
  test("trims notes to 600 chars and appends the original to today's memory log", () => {
    const longNotes = 'x'.repeat(1200);
    goals(`## Active Goals
- [ ] Big goal
  - status: pending
  - priority: high
  - notes: ${longNotes}
`);
    const ctx = makeCtx(root, { soulDir });
    const findings = goalLint.preview(ctx);
    expect(findings.map((f) => f.kind)).toEqual(['oversized-notes']);
    expect(findings[0].fixable).toBe(true);

    const result = goalLint.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);

    const parsed = parseGoals(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8'));
    expect(parsed.active[0].notes).toBe(
      `${'x'.repeat(600)} … [trimmed by goal-lint; full text in memory/${TODAY}.md]`
    );

    const memoryLog = readFileSync(join(soulDir, 'memory', `${TODAY}.md`), 'utf-8');
    expect(memoryLog).toMatch(/\[\d{2}:\d{2}\] \[goal-lint\] Trimmed notes of goal: Big goal/);
    expect(memoryLog).toContain(longNotes);
    // Backups: GOALS.md only (memory log is new)
    expect(result.backups).toHaveLength(1);
  });

  test('does not flag notes at or under 1000 chars', () => {
    goals(`## Active Goals
- [ ] Fine goal
  - status: pending
  - priority: high
  - notes: ${'y'.repeat(1000)}
`);
    expect(goalLint.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('stale-block', () => {
  test('reports a blocked goal whose notes cite a date older than 14 days', () => {
    goals(`## Active Goals
- [ ] Launch site
  - status: blocked
  - priority: high
  - notes: waiting for DNS since ${dateDaysAgo(20)}
`);
    const findings = goalLint.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['stale-block']);
    expect(findings[0].fixable).toBe(false);
    expect(findings[0].severity).toBe('warn');
  });

  test('ignores blocked goals with recent dates or no dates', () => {
    goals(`## Active Goals
- [ ] Recent block
  - status: blocked
  - priority: high
  - notes: waiting since ${dateDaysAgo(3)}
- [ ] Dateless block
  - status: stalled
  - priority: high
  - notes: waiting for someone
`);
    expect(goalLint.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('dead-trigger', () => {
  test('reports goals referencing the channel when the channel is not ok', () => {
    goals(`## Active Goals
- [ ] Send career tips via Telegram every morning
  - status: pending
  - priority: high
`);
    const ctx = makeCtx(root, {
      soulDir,
      deps: makeDeps({ channelStateOf: () => 'error' }),
    });
    const findings = goalLint.preview(ctx);
    expect(findings.map((f) => f.kind)).toEqual(['dead-trigger']);
    expect(findings[0].fixable).toBe(false);
    expect(findings[0].message).toContain('error');
  });

  test('stays silent when the channel is ok or its state is unknown', () => {
    goals(`## Active Goals
- [ ] Send career tips via Telegram every morning
  - status: pending
  - priority: high
`);
    expect(
      goalLint.preview(makeCtx(root, { soulDir, deps: makeDeps({ channelStateOf: () => 'ok' }) }))
    ).toEqual([]);
    expect(goalLint.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('apply safety', () => {
  test('skips a finding whose goal changed since preview', () => {
    goals(`## Active Goals
- [ ] Old title
  - status: archived
  - priority: low
`);
    const ctx = makeCtx(root, { soulDir });
    const findings = goalLint.preview(ctx);
    goals(`## Active Goals
- [ ] New title
  - status: archived
  - priority: low
`);
    const result = goalLint.apply(ctx, findings);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/changed/);
    expect(readdirSync(soulDir)).not.toContain('.versions');
  });
});
