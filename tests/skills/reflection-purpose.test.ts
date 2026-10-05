import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import skill from '../../src/skills/reflection/index';
import { protectCoreDrives, readOperatorFeedback } from '../../src/skills/reflection/motivations';
import { buildAnalysisPrompt, buildImprovementPrompt } from '../../src/skills/reflection/prompts';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

// 2026-10-04: the nightly reflection rewrote every bot's whole MOTIVATIONS.md
// from a 1000-char view of it plus self-focused logs, and over weeks turned
// "help Diego" into "fix my own pipeline". Purpose (Core Drives) is now the
// operator's; reflection evolves the methods around it.

const CURRENT = `## Core Drives
- **Diego's growth is the product**: research, distil, teach.
- **Signal over hype**: primary sources, dated.

## Current Focus
- Ship the first brief.

## Open Questions
- What is Diego's level?

## Last Reflection
- date: 2026-10-01
`;

describe('protectCoreDrives', () => {
  test('restores the current Core Drives verbatim when the proposal rewrites them', () => {
    const proposed = CURRENT.replace(
      /## Core Drives[\s\S]*?(?=\n## Current Focus)/,
      '## Core Drives\n- **Perfect my own preflight checks**\n'
    ).replace('Ship the first brief.', 'Read two arXiv papers on evals.');
    const out = protectCoreDrives(CURRENT, proposed);
    expect(out).toContain("**Diego's growth is the product**");
    expect(out).not.toContain('Perfect my own preflight checks');
    expect(out).toContain('Read two arXiv papers on evals.');
  });

  test('puts the Core Drives back at the top when the proposal drops the section', () => {
    const proposed = '## Current Focus\n- Something new.\n';
    const out = protectCoreDrives(CURRENT, proposed);
    expect(out.startsWith('## Core Drives')).toBe(true);
    expect(out).toContain('- Something new.');
  });

  test('lets reflection fill placeholder drives on a new bot', () => {
    const placeholder = '## Core Drives\n- (pending first reflection)\n\n## Current Focus\n- x\n';
    const proposed = '## Core Drives\n- Real drive from identity\n\n## Current Focus\n- y\n';
    expect(protectCoreDrives(placeholder, proposed)).toBe(proposed);
  });

  test('without current Core Drives the proposal is kept as is', () => {
    const proposed = '## Core Drives\n- New\n';
    expect(protectCoreDrives('## Current Focus\n- x\n', proposed)).toBe(proposed);
  });

  test('handles CRLF in the current file', () => {
    const crlf = CURRENT.replace(/\n/g, '\r\n');
    const out = protectCoreDrives(crlf, '## Core Drives\n- Other\n\n## Current Focus\n- z\n');
    expect(out).toContain("Diego's growth is the product");
    expect(out).not.toContain('- Other');
  });
});

describe('readOperatorFeedback', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('reflection-feedback');
  });
  afterEach(() => removeTempDir(dir));

  const NOW = Date.parse('2026-10-10T12:00:00Z');

  test('lists recent production verdicts and dispatch signals, newest first', () => {
    const work = join(dir, 'work');
    const soul = join(dir, 'soul');
    mkdirSync(work, { recursive: true });
    mkdirSync(soul, { recursive: true });
    writeFileSync(
      join(work, 'changelog.jsonl'),
      [
        {
          path: 'old.md',
          timestamp: '2026-09-01T00:00:00Z',
          evaluation: { status: 'rejected', evaluatedAt: '2026-09-01T00:00:00Z' },
        },
        {
          path: 'brief.md',
          timestamp: '2026-10-06T00:00:00Z',
          evaluation: {
            status: 'approved',
            rating: 4,
            feedback: 'useful, keep the try-this',
            evaluatedAt: '2026-10-07T00:00:00Z',
          },
        },
        { path: 'meh.md', timestamp: '2026-10-08T00:00:00Z' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n')
    );
    writeFileSync(
      join(soul, 'DISPATCHES.jsonl'),
      `${JSON.stringify({ hook: 'FDE title not hiring in your region', status: 'sent', signal: 'up', signalAt: '2026-10-09T00:00:00Z' })}\n`
    );
    const out = readOperatorFeedback({ workDir: work, soulDir: soul, nowMs: NOW });
    expect(out).toContain('brief.md');
    expect(out).toContain('approved');
    expect(out).toContain('useful, keep the try-this');
    expect(out).toContain('FDE title not hiring in your region');
    expect(out).not.toContain('old.md'); // older than the window
    expect(out).not.toContain('meh.md'); // never evaluated
    expect(out.indexOf('FDE title')).toBeLessThan(out.indexOf('brief.md'));
  });

  test('says so plainly when there is no feedback at all', () => {
    expect(
      readOperatorFeedback({ workDir: join(dir, 'none'), soulDir: join(dir, 'none'), nowMs: NOW })
    ).toBe('No operator feedback in the last 14 days.');
  });

  test('skips malformed lines and caps the length', () => {
    const work = join(dir, 'w2');
    mkdirSync(work, { recursive: true });
    const rows = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        path: `f${i}.md`,
        evaluation: {
          status: 'approved',
          feedback: 'x'.repeat(80),
          evaluatedAt: '2026-10-09T00:00:00Z',
        },
      })
    );
    writeFileSync(join(work, 'changelog.jsonl'), `{broken\n${rows.join('\n')}`);
    const out = readOperatorFeedback({ workDir: work, nowMs: NOW, maxChars: 500 });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('f199.md');
  });
});

describe('prompts', () => {
  const analysis = {
    consistency: 'a',
    people: 'b',
    gaps: 'c',
    patterns: 'd',
    alignment: 'e',
    breadth: 'f',
  };

  test('the improvement prompt keeps Core Drives and asks to evolve the methods', () => {
    const { system, prompt } = buildImprovementPrompt({
      identity: 'i',
      soul: 's',
      motivations: CURRENT,
      analysis,
      trigger: 'cron',
      date: '2026-10-10',
      operatorFeedback: '- approved brief.md',
    });
    expect(system).toMatch(/Core Drives are set by the operator/);
    expect(system).toMatch(/one topic or on your own tooling/);
    expect(prompt).toContain('## What landed with the operator');
    expect(prompt).toContain('- approved brief.md');
  });

  test('the analysis prompt sees the operator feedback too', () => {
    const { prompt } = buildAnalysisPrompt({
      identity: 'i',
      soul: 's',
      motivations: CURRENT,
      recentLogs: 'log',
      operatorFeedback: '- 👍 FDE title',
    });
    expect(prompt).toContain('## What landed with the operator');
    expect(prompt).toContain('- 👍 FDE title');
  });
});

describe('reflection pipeline', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('reflection-pipeline');
  });
  afterEach(() => removeTempDir(dir));

  test('a run keeps Core Drives, updates the methods, and reads the full motivations file', async () => {
    const soul = join(dir, 'soul');
    mkdirSync(join(soul, 'memory'), { recursive: true });
    const longFocus = `- ${'reading list item '.repeat(80)}END-OF-FOCUS`;
    const current = CURRENT.replace(
      '- Ship the first brief.',
      `- Ship the first brief.\n${longFocus}`
    );
    writeFileSync(join(soul, 'MOTIVATIONS.md'), current);
    writeFileSync(join(soul, 'IDENTITY.md'), 'name: Mentor');
    writeFileSync(join(soul, 'SOUL.md'), 'Direct and technical.');
    writeFileSync(join(soul, 'memory', '2026-10-09.md'), '- read a paper on eval drift\n');

    const prompts: string[] = [];
    const replies = [
      JSON.stringify({
        consistency: 'ok',
        people: '-',
        gaps: 'g',
        patterns: 'p',
        alignment: 'a',
        breadth: 'b',
      }),
      JSON.stringify({
        motivations:
          '## Core Drives\n- **Optimize my own logs**\n\n## Current Focus\n- Read two eval papers this week.\n\n## Last Reflection\n- date: 2026-10-10\n',
        soul_patch: null,
        soul_changed: false,
        journal_entry: 'Moved focus outward.',
      }),
    ];
    const ctx = {
      config: {},
      soulDir: soul,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      llm: {
        generate: async (prompt: string) => {
          prompts.push(prompt);
          return { text: replies.shift() ?? '{}' };
        },
      },
    } as never;

    await skill.commands?.reflect.handler([], ctx);

    const written = readFileSync(join(soul, 'MOTIVATIONS.md'), 'utf-8');
    expect(written).toContain("**Diego's growth is the product**");
    expect(written).not.toContain('Optimize my own logs');
    expect(written).toContain('Read two eval papers this week.');
    // The old 1000-char cap cut the file before this marker.
    expect(prompts[0]).toContain('END-OF-FOCUS');
  });

  test('the scheduled job runs weekly (Sunday 03:30)', () => {
    expect(skill.jobs?.find((j) => j.id === 'nightly-reflection')?.schedule).toBe('30 3 * * 0');
  });
});

describe('reflection pipeline — productions dir', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('reflection-proddir');
  });
  afterEach(() => removeTempDir(dir));

  // Review round 1: a bot with productions.dir set writes evaluations there,
  // not in workDir; reflection must read the resolved productions dir.
  test('reads operator feedback from ctx.productionsDir when it differs from workDir', async () => {
    const soul = join(dir, 'soul');
    const work = join(dir, 'work');
    const prod = join(dir, 'prod');
    for (const d of [join(soul, 'memory'), work, prod]) mkdirSync(d, { recursive: true });
    writeFileSync(join(soul, 'MOTIVATIONS.md'), CURRENT);
    writeFileSync(
      join(soul, 'memory', `${new Date().toISOString().slice(0, 10)}.md`),
      '- did things\n'
    );
    writeFileSync(
      join(prod, 'changelog.jsonl'),
      `${JSON.stringify({ path: 'brief.md', evaluation: { status: 'approved', feedback: 'MARKER-FROM-PRODUCTIONS-DIR', evaluatedAt: new Date().toISOString() } })}\n`
    );
    const prompts: string[] = [];
    const ctx = {
      config: {},
      soulDir: soul,
      workDir: work,
      productionsDir: prod,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      llm: {
        generate: async (prompt: string) => {
          prompts.push(prompt);
          return { text: '{}' };
        },
      },
    } as never;
    await skill.commands?.reflect.handler([], ctx);
    expect(prompts[0]).toContain('MARKER-FROM-PRODUCTIONS-DIR');
  });
});
