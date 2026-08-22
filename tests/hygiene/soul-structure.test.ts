import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { soulStructure } from '../../src/hygiene/routines/soul-structure';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { dateDaysAgo, makeCtx, makeDeps, writeFile } from './helpers';

let root: string;
let soulDir: string;

beforeEach(() => {
  root = createTempDir('hygiene-soul');
  soulDir = join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul');
});

afterEach(() => {
  removeTempDir(root);
});

function healthySoul(): void {
  writeFile(join(soulDir, 'IDENTITY.md'), '# Identity\nI am bot one.');
  writeFile(join(soulDir, 'SOUL.md'), '# Soul\nWarm, direct, curious.');
  writeFile(
    join(soulDir, 'MOTIVATIONS.md'),
    `## Core Drives\n- help people\n\n## Current Focus\n- ship the thing\n\n## Last Reflection\n- date: ${dateDaysAgo(2)}\n`
  );
  writeFile(join(soulDir, 'MEMORY.md'), '# Memory\n');
  writeFile(join(soulDir, 'TRAITS.json'), '{}');
  writeFile(join(soulDir, 'memory', '.keep'), '');
}

describe('soul-structure metadata', () => {
  test('is bot-scoped and applicable (MEMORY.md creation only)', () => {
    expect(soulStructure.id).toBe('soul-structure');
    expect(soulStructure.scope).toBe('bot');
    expect(soulStructure.canApply).toBe(true);
  });

  test('a healthy soul yields no findings', () => {
    healthySoul();
    expect(soulStructure.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('soul-lint passthrough', () => {
  test('maps lintSoulDirectory issues to findings', () => {
    writeFile(join(soulDir, 'SOUL.md'), '## Your Inner Motivations\nleaked');
    writeFile(join(soulDir, 'MEMORY.md'), '');
    writeFile(join(soulDir, 'TRAITS.json'), '{}');
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    const lint = findings.filter((f) => f.kind === 'soul-lint');
    expect(lint.some((f) => f.severity === 'critical' && f.message.includes('IDENTITY.md'))).toBe(
      true
    );
    expect(lint.some((f) => f.severity === 'warn' && f.file === 'SOUL.md')).toBe(true);
    expect(lint.every((f) => !f.fixable)).toBe(true);
  });
});

describe('soul-equals-motivations', () => {
  test('reports when SOUL.md and MOTIVATIONS.md are near-identical', () => {
    healthySoul();
    const text = 'Be a genuine friend. Prioritise connection. Stay curious and kind.';
    writeFile(join(soulDir, 'SOUL.md'), `# Soul\n${text}`);
    writeFile(join(soulDir, 'MOTIVATIONS.md'), `## Core Drives\n${text}\n`);
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    const f = findings.find((x) => x.kind === 'soul-equals-motivations');
    expect(f).toBeDefined();
    expect(f!.fixable).toBe(false);
    expect(f!.severity).toBe('warn');
  });
});

describe('missing-memory-md', () => {
  test('is fixable and apply creates MEMORY.md with a header', () => {
    healthySoul();
    const { rmSync } = require('node:fs');
    rmSync(join(soulDir, 'MEMORY.md'));
    const ctx = makeCtx(root, { soulDir });
    const findings = soulStructure.preview(ctx);
    expect(findings.map((f) => f.kind)).toEqual(['missing-memory-md']);
    expect(findings[0].fixable).toBe(true);

    const result = soulStructure.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(result.backups).toEqual([]);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toMatch(/^# /);
  });

  test('apply never overwrites an existing MEMORY.md', () => {
    healthySoul();
    const ctx = makeCtx(root, { soulDir });
    const fake = [
      {
        id: 'x',
        kind: 'missing-memory-md',
        severity: 'warn' as const,
        file: 'MEMORY.md',
        line: null,
        message: '',
        fixable: true,
      },
    ];
    const result = soulStructure.apply(ctx, fake);
    expect(result.skipped).toHaveLength(1);
    expect(readFileSync(join(soulDir, 'MEMORY.md'), 'utf-8')).toBe('# Memory\n');
  });
});

describe('missing-traits', () => {
  test('reports when TRAITS.json is absent', () => {
    healthySoul();
    require('node:fs').rmSync(join(soulDir, 'TRAITS.json'));
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['missing-traits']);
    expect(findings[0].severity).toBe('info');
  });

  test('accepts TRAITS.json next to the soul dir (where TraitRegisters writes it)', () => {
    healthySoul();
    const fs = require('node:fs');
    fs.renameSync(join(soulDir, 'TRAITS.json'), join(soulDir, '..', 'TRAITS.json'));
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).not.toContain('missing-traits');
  });
});

describe('stale-current-focus', () => {
  test('reports a Last Reflection date older than 14 days', () => {
    healthySoul();
    writeFile(
      join(soulDir, 'MOTIVATIONS.md'),
      `## Core Drives\n- help\n\n## Current Focus\n- old stuff\n\n## Last Reflection\n- date: ${dateDaysAgo(30)}\n`
    );
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['stale-current-focus']);
    expect(findings[0].file).toBe('MOTIVATIONS.md');
    expect(findings[0].line).toBeGreaterThan(0);
  });

  test('uses a date on the Current Focus heading line itself', () => {
    healthySoul();
    writeFile(
      join(soulDir, 'MOTIVATIONS.md'),
      `## Core Drives\n- help\n\n## Current Focus (${dateDaysAgo(40)})\n- old stuff\n`
    );
    const findings = soulStructure.preview(makeCtx(root, { soulDir }));
    expect(findings.map((f) => f.kind)).toEqual(['stale-current-focus']);
  });

  test('does not report placeholders without dates', () => {
    healthySoul();
    writeFile(
      join(soulDir, 'MOTIVATIONS.md'),
      '## Core Drives\n- help\n\n## Current Focus\n- things\n\n## Last Reflection\n- date: 2026\n'
    );
    expect(soulStructure.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('last-review-failed', () => {
  test('reports when the last health check failed', () => {
    healthySoul();
    const ctx = makeCtx(root, {
      soulDir,
      deps: makeDeps({
        lastHealthCheckOf: () => ({ at: '2026-08-20T00:00:00Z', ok: false, error: 'boom' }),
      }),
    });
    const findings = soulStructure.preview(ctx);
    expect(findings.map((f) => f.kind)).toEqual(['last-review-failed']);
    expect(findings[0].message).toContain('boom');
  });

  test('stays silent when it succeeded or never ran', () => {
    healthySoul();
    expect(
      soulStructure.preview(
        makeCtx(root, {
          soulDir,
          deps: makeDeps({ lastHealthCheckOf: () => ({ at: 'x', ok: true }) }),
        })
      )
    ).toEqual([]);
    expect(soulStructure.preview(makeCtx(root, { soulDir }))).toEqual([]);
  });
});

describe('missing soul dir', () => {
  test('reports a single critical finding and apply does not create files', () => {
    const ctx = makeCtx(root, { soulDir: join(root, 'nope') });
    const findings = soulStructure.preview(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing-soul-dir');
    expect(findings[0].severity).toBe('critical');
    soulStructure.apply(ctx, findings);
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });
});
