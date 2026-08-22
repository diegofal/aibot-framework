import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { dataCleanup } from '../../src/hygiene/routines/data-cleanup';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';
import { daysAgo, makeBot, makeConfig, makeCtx, writeFile } from './helpers';

let root: string;

beforeEach(() => {
  root = createTempDir('hygiene-data');
});

afterEach(() => {
  removeTempDir(root);
});

function fleetCtx(bots = [makeBot({ id: 'bot1' }), makeBot({ id: 'bot2' })], options = {}) {
  return makeCtx(root, {
    botId: null,
    soulDir: null,
    workDir: null,
    config: makeConfig(root, bots),
    options,
  });
}

function kinds(ctx = fleetCtx()) {
  return dataCleanup.preview(ctx).map((f) => f.kind);
}

describe('data-cleanup metadata', () => {
  test('is fleet-scoped and applicable; empty data dir yields nothing', () => {
    expect(dataCleanup.id).toBe('data-cleanup');
    expect(dataCleanup.scope).toBe('fleet');
    expect(dataCleanup.canApply).toBe(true);
    expect(kinds()).toEqual([]);
  });
});

describe('orphan-karma-dir', () => {
  test('flags karma dirs for unknown bots and trashes them on apply', () => {
    writeFile(join(root, 'data', 'karma', 'bot1', 'events.jsonl'), '');
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const ctx = fleetCtx();
    const findings = dataCleanup.preview(ctx);
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ['orphan-karma-dir', join('karma', 'ghost')],
    ]);
    expect(findings[0].fixable).toBe(true);

    const result = dataCleanup.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(existsSync(join(root, 'data', 'karma', 'ghost'))).toBe(false);
    expect(existsSync(join(root, 'data', 'karma', 'bot1'))).toBe(true);
    const trashed = result.applied[0].result;
    expect(trashed).toContain('_trash');
    expect(existsSync(join(trashed, 'events.jsonl'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(trashed, '..', '..', 'manifest.json'), 'utf-8'));
    expect(manifest.entries[0].reason).toBe('orphan-karma-dir');
  });
});

describe('orphan-soul-dir', () => {
  test('flags tenants/*/bots/<id> dirs for unknown bots', () => {
    writeFile(join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'SOUL.md'), 'x');
    writeFile(join(root, 'data', 'tenants', 't1', 'bots', 'zombie', 'soul', 'SOUL.md'), 'x');
    const findings = dataCleanup.preview(fleetCtx());
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ['orphan-soul-dir', join('tenants', 't1', 'bots', 'zombie')],
    ]);
    expect(findings[0].severity).toBe('warn');
  });

  test('apply moves the orphan bot dir preserving its tenant path', () => {
    writeFile(join(root, 'data', 'tenants', 't1', 'bots', 'zombie', 'soul', 'SOUL.md'), 'x');
    const ctx = fleetCtx();
    const result = dataCleanup.apply(ctx, dataCleanup.preview(ctx));
    expect(result.applied).toHaveLength(1);
    expect(existsSync(join(result.applied[0].result, 'soul', 'SOUL.md'))).toBe(true);
    expect(result.applied[0].result).toContain(join('tenants', 't1', 'bots', 'zombie'));
  });
});

describe('legacy-config-soul', () => {
  test('flags config/soul/<id> when the bot already has a data soul', () => {
    writeFile(join(root, 'config', 'soul', 'bot1', 'SOUL.md'), 'legacy');
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'SOUL.md'),
      'current'
    );
    const findings = dataCleanup.preview(fleetCtx());
    expect(findings.map((f) => f.kind)).toEqual(['legacy-config-soul']);
    expect(findings[0].fixable).toBe(true);
  });

  test('leaves config/soul alone when it is the only soul or explicitly configured', () => {
    writeFile(join(root, 'config', 'soul', 'bot1', 'SOUL.md'), 'only copy');
    expect(kinds()).toEqual([]);

    writeFile(join(root, 'config', 'soul', 'bot2', 'SOUL.md'), 'explicit');
    writeFile(join(root, 'data', 'tenants', '__admin__', 'bots', 'bot2', 'soul', 'SOUL.md'), 'x');
    const bots = [
      makeBot({ id: 'bot1' }),
      makeBot({ id: 'bot2', soulDir: join(root, 'config', 'soul', 'bot2') }),
    ];
    expect(kinds(fleetCtx(bots))).toEqual([]);
  });

  test('apply moves the legacy dir into _trash under config-soul/', () => {
    writeFile(join(root, 'config', 'soul', 'bot1', 'SOUL.md'), 'legacy');
    writeFile(
      join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul', 'SOUL.md'),
      'current'
    );
    const ctx = fleetCtx();
    const result = dataCleanup.apply(ctx, dataCleanup.preview(ctx));
    expect(result.applied).toHaveLength(1);
    expect(existsSync(join(root, 'config', 'soul', 'bot1'))).toBe(false);
    expect(readFileSync(join(result.applied[0].result, 'SOUL.md'), 'utf-8')).toBe('legacy');
  });
});

describe('claude-tmp-transcripts', () => {
  test('flags -tmp transcripts older than 7 days only', () => {
    const old = join(root, 'data', 'claude', 'projects', '-tmp', 'old.jsonl');
    const fresh = join(root, 'data', 'claude', 'projects', '-tmp', 'fresh.jsonl');
    writeFile(old, '{}');
    writeFile(fresh, '{}');
    utimesSync(old, daysAgo(10), daysAgo(10));
    utimesSync(fresh, daysAgo(1), daysAgo(1));
    const ctx = fleetCtx();
    const findings = dataCleanup.preview(ctx);
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ['claude-tmp-transcripts', join('claude', 'projects', '-tmp', 'old.jsonl')],
    ]);

    const result = dataCleanup.apply(ctx, findings);
    expect(result.applied).toHaveLength(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('duplicate-skills', () => {
  test('reports repeated skill ids with the deduped array, apply skips', () => {
    const bots = [
      makeBot({ id: 'bot1', skills: ['a', 'b', 'a', 'c', 'b'] }),
      makeBot({ id: 'bot2' }),
    ];
    const ctx = fleetCtx(bots);
    const findings = dataCleanup.preview(ctx);
    expect(findings.map((f) => f.kind)).toEqual(['duplicate-skills']);
    expect(findings[0].fixable).toBe(false);
    expect(findings[0].data?.dedupedSkills).toEqual(['a', 'b', 'c']);
    expect(findings[0].data?.botId).toBe('bot1');

    const result = dataCleanup.apply(ctx, findings);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(join(root, 'data', '_trash'))).toBe(false);
  });
});

describe('skills-are-tools', () => {
  test('does not flag a name that is both a real skill and a tool (improve)', () => {
    // `improve` ships as src/skills/improve AND as a tool. Six bots legitimately
    // enable the skill; flagging them every run is noise, not a finding.
    const bots = [makeBot({ id: 'bot1', skills: ['improve', 'reflection'] })];
    expect(dataCleanup.preview(fleetCtx(bots, { knownSkillIds: ['improve', 'reflection'] }))).toEqual(
      []
    );
  });

  test('still flags a tool name that is not a registered skill', () => {
    const bots = [makeBot({ id: 'bot1', skills: ['web_search', 'improve'] })];
    const findings = dataCleanup
      .preview(fleetCtx(bots, { knownSkillIds: ['improve'] }))
      .filter((f) => f.kind === 'skills-are-tools');
    expect(findings[0].data?.tools).toEqual(['web_search']);
  });

  test('reports skill ids that are really tool names', () => {
    const bots = [makeBot({ id: 'bot1', skills: ['web_search', 'reflection', 'file_read'] })];
    const findings = dataCleanup.preview(fleetCtx(bots));
    expect(findings.map((f) => f.kind)).toEqual(['skills-are-tools']);
    expect(findings[0].data?.tools).toEqual(['web_search', 'file_read']);
    expect(findings[0].fixable).toBe(false);
  });
});

describe('apply safety', () => {
  test('skips findings whose path vanished between preview and apply', () => {
    writeFile(join(root, 'data', 'karma', 'ghost', 'events.jsonl'), '{}');
    const ctx = fleetCtx();
    const findings = dataCleanup.preview(ctx);
    require('node:fs').rmSync(join(root, 'data', 'karma', 'ghost'), { recursive: true });
    const result = dataCleanup.apply(ctx, findings);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/missing/);
  });
});
