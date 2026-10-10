/**
 * Cycle 1 — paths.ts Red tests.
 *
 * Pinning the contract of src/productions/paths.ts. Per the plan
 * (docs/architecture-docs/productions-refactor.md §4 C1), this
 * module is the single source of truth for directory resolution and
 * traversal guards. Cycle 1.1 writes these tests first (Red).
 * Cycle 1.3 creates the module (Green).
 *
 * The functions are pure: they take a config and/or a dir, and return
 * strings / booleans / nulls. They do NOT touch the filesystem. Tests
 * that exercise fs state go in tests/productions/assert-within-dir.test.ts
 * (which observes the public API of ProductionsService).
 *
 * Per-function coverage: each function above gets its own describe
 * block, with at least one test per divergent branch (per the TDD rule
 * in CLAUDE.md §"Flujo TDD obligatorio").
 */

import { describe, expect, test } from 'bun:test';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Config } from '../../src/config';
import {
  assertWithinDir,
  INDEX_EXCLUDES,
  isEnabled,
  isScratchProductionPath,
  isTrackOnly,
  isUntrackedProductionPath,
  normalizeEntryPath,
  resolveDir,
  resolveFilePath,
  TREE_EXCLUDES,
} from '../../src/productions/paths';

const TEST_DIR = join(process.cwd(), '.test-productions-paths');

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    bots: [
      {
        id: 'bot1',
        name: 'Bot One',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: false },
      },
      {
        id: 'bot2',
        name: 'Bot Two',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: true },
      },
      {
        id: 'bot3',
        name: 'Bot Three',
        token: '',
        enabled: true,
        skills: [],
        // No productions config = defaults
      },
    ],
    productions: {
      enabled: true,
      baseDir: TEST_DIR,
    },
    ...overrides,
  } as Config;
}

// ---------------------------------------------------------------------------
// resolveDir
// ---------------------------------------------------------------------------

describe('resolveDir', () => {
  test('returns absolute path containing botId under baseDir', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).toContain('bot1');
  });

  test('uses botConfig.productions.dir when present', () => {
    const customDir = join(TEST_DIR, 'custom-dir');
    const config = makeConfig();
    (config.bots[0] as any).productions = { enabled: true, trackOnly: false, dir: customDir };
    const dir = resolveDir(config, 'bot1');
    expect(dir).toBe(resolve(customDir));
  });

  test('uses botConfig.workDir when productions.dir is absent', () => {
    const workDir = join(TEST_DIR, 'work-dir');
    const config = makeConfig();
    (config.bots[0] as any).workDir = workDir;
    delete (config.bots[0] as any).productions.dir;
    const dir = resolveDir(config, 'bot1');
    expect(dir).toBe(resolve(workDir));
  });

  test('falls back to {baseDir}/{botId} when neither productions.dir nor workDir is set', () => {
    const config = makeConfig();
    delete (config.bots[0] as any).productions.dir;
    delete (config.bots[0] as any).workDir;
    const dir = resolveDir(config, 'bot1');
    expect(dir).toBe(resolve(join(TEST_DIR, 'bot1')));
  });

  test('creates the directory if it does not exist', () => {
    const config = makeConfig();
    const dir = resolveDir(config, 'bot1');
    // fs check
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTrackOnly
// ---------------------------------------------------------------------------

describe('isTrackOnly', () => {
  test('returns false for a bot with trackOnly: false', () => {
    expect(isTrackOnly(makeConfig(), 'bot1')).toBe(false);
  });

  test('returns true for a bot with trackOnly: true', () => {
    expect(isTrackOnly(makeConfig(), 'bot2')).toBe(true);
  });

  test('returns false for a bot with no productions config (default)', () => {
    expect(isTrackOnly(makeConfig(), 'bot3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe('isEnabled', () => {
  test('returns true for enabled bot with productions.enabled: true', () => {
    expect(isEnabled(makeConfig(), 'bot1')).toBe(true);
  });

  test('returns false when global productions.enabled is false', () => {
    const config = makeConfig();
    config.productions.enabled = false;
    expect(isEnabled(config, 'bot1')).toBe(false);
  });

  test('returns false when bot productions.enabled is false', () => {
    const config = makeConfig();
    (config.bots[0] as any).productions = { enabled: false, trackOnly: false };
    expect(isEnabled(config, 'bot1')).toBe(false);
  });

  test('returns true when bot productions.enabled is true (no global override)', () => {
    // Default global is enabled; bot productions enabled by default.
    expect(isEnabled(makeConfig(), 'bot2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveFilePath
// ---------------------------------------------------------------------------

describe('resolveFilePath', () => {
  test('joins relative path with dir and returns absolute', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    const result = resolveFilePath(dir, { path: 'file.md', trackOnly: false });
    expect(result).toBe(resolve(join(dir, 'file.md')));
  });

  test('returns null for path with .. (traversal)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(resolveFilePath(dir, { path: '../outside.md', trackOnly: false })).toBeNull();
  });

  test('returns null for absolute path', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(resolveFilePath(dir, { path: '/etc/passwd', trackOnly: false })).toBeNull();
  });

  test('returns null for path with leading .. segments', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(resolveFilePath(dir, { path: '../../etc/passwd', trackOnly: false })).toBeNull();
  });

  test('returns null for absolute path on a different drive', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(resolveFilePath(dir, { path: 'D:/x', trackOnly: false })).toBeNull();
  });

  test('permits path with .. inside a filename (..file.md)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    const result = resolveFilePath(dir, { path: '..file.md', trackOnly: false });
    expect(result).toBe(resolve(join(dir, '..file.md')));
  });

  test('permits my..file.md (filename contains .. substring)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    const result = resolveFilePath(dir, { path: 'my..file.md', trackOnly: false });
    expect(result).toBe(resolve(join(dir, 'my..file.md')));
  });

  test('resolves symlink-like a/../b.md to b.md (in-dir)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    const result = resolveFilePath(dir, { path: 'a/../b.md', trackOnly: false });
    expect(result).toBe(resolve(join(dir, 'b.md')));
  });

  test('returns trackOnly path as-is (no validation, no joining)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    // trackOnly is "trust the external path" — outside the dir by design.
    const result = resolveFilePath(dir, { path: '/external/path.md', trackOnly: true });
    expect(result).toBe(resolve('/external/path.md'));
  });

  test('returns null for parent-of-bot prefix-sibling (../bot10/safe.md)', () => {
    const dir = resolveDir(makeConfig(), 'bot1');
    expect(resolveFilePath(dir, { path: '../bot10/safe.md', trackOnly: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertWithinDir (exported from paths.ts during Cycle 1)
// ---------------------------------------------------------------------------

describe('assertWithinDir', () => {
  const dir = resolveDir(makeConfig(), 'bot1');

  test('returns true for a clean relative path', () => {
    expect(assertWithinDir(dir, 'safe.md')).toBe(true);
  });

  test('returns true for nested relative path', () => {
    expect(assertWithinDir(dir, 'subdir/file.md')).toBe(true);
  });

  test('returns true for the empty path (dir itself)', () => {
    expect(assertWithinDir(dir, '')).toBe(true);
  });

  test('returns true for a filename that begins with .. (...file.md)', () => {
    expect(assertWithinDir(dir, '..file.md')).toBe(true);
  });

  test('returns true for a filename with .. substring (my..file.md)', () => {
    expect(assertWithinDir(dir, 'my..file.md')).toBe(true);
  });

  test('returns true for a/../b.md (resolves in-dir)', () => {
    expect(assertWithinDir(dir, 'a/../b.md')).toBe(true);
  });

  test('returns false for .. (parent segment)', () => {
    expect(assertWithinDir(dir, '..')).toBe(false);
  });

  test('returns false for ../outside.md', () => {
    expect(assertWithinDir(dir, '../outside.md')).toBe(false);
  });

  test('returns false for ../../etc/passwd', () => {
    expect(assertWithinDir(dir, '../../etc/passwd')).toBe(false);
  });

  test('returns false for /etc/passwd (POSIX absolute)', () => {
    expect(assertWithinDir(dir, '/etc/passwd')).toBe(false);
  });

  test('returns false for D:/x (Windows absolute)', () => {
    expect(assertWithinDir(dir, 'D:/x')).toBe(false);
  });

  test('returns false for ../bot10/safe.md (prefix-sibling)', () => {
    expect(assertWithinDir(dir, '../bot10/safe.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INDEX_EXCLUDES / TREE_EXCLUDES
// ---------------------------------------------------------------------------

describe('INDEX_EXCLUDES', () => {
  test('is a Set of strings', () => {
    expect(INDEX_EXCLUDES).toBeInstanceOf(Set);
    for (const v of INDEX_EXCLUDES) {
      expect(typeof v).toBe('string');
    }
  });

  test('excludes the changelog, summary, index, and standard noise files', () => {
    expect(INDEX_EXCLUDES.has('changelog.jsonl')).toBe(true);
    expect(INDEX_EXCLUDES.has('summary.json')).toBe(true);
    expect(INDEX_EXCLUDES.has('INDEX.md')).toBe(true);
    expect(INDEX_EXCLUDES.has('index.html')).toBe(true);
    expect(INDEX_EXCLUDES.has('.gitignore')).toBe(true);
  });

  test('excludes build/tool directories', () => {
    expect(INDEX_EXCLUDES.has('node_modules')).toBe(true);
    expect(INDEX_EXCLUDES.has('venv')).toBe(true);
    expect(INDEX_EXCLUDES.has('.vercel')).toBe(true);
    expect(INDEX_EXCLUDES.has('.git')).toBe(true);
  });

  test('does not exclude plain user files', () => {
    expect(INDEX_EXCLUDES.has('report.md')).toBe(false);
    expect(INDEX_EXCLUDES.has('notes.txt')).toBe(false);
  });
});

describe('TREE_EXCLUDES', () => {
  test('is a Set of strings', () => {
    expect(TREE_EXCLUDES).toBeInstanceOf(Set);
    for (const v of TREE_EXCLUDES) {
      expect(typeof v).toBe('string');
    }
  });

  test('excludes the changelog and summary', () => {
    expect(TREE_EXCLUDES.has('changelog.jsonl')).toBe(true);
    expect(TREE_EXCLUDES.has('summary.json')).toBe(true);
  });

  test('excludes build/tool directories', () => {
    expect(TREE_EXCLUDES.has('node_modules')).toBe(true);
    expect(TREE_EXCLUDES.has('venv')).toBe(true);
    expect(TREE_EXCLUDES.has('.vercel')).toBe(true);
    expect(TREE_EXCLUDES.has('.git')).toBe(true);
  });

  test('does not exclude plain files or index.html (the tree shows archived files too)', () => {
    expect(TREE_EXCLUDES.has('report.md')).toBe(false);
    expect(TREE_EXCLUDES.has('index.html')).toBe(false);
  });
});

describe('normalizeEntryPath', () => {
  const dir = resolve('/data/prod/b1');
  test('an absolute path inside the dir becomes dir-relative with forward slashes', () => {
    expect(normalizeEntryPath(dir, join(dir, 'notes', 'a.md'))).toBe('notes/a.md');
  });
  test('a relative path is returned as is', () => {
    expect(normalizeEntryPath(dir, 'a.md')).toBe('a.md');
  });
  test('an absolute path outside the dir is returned as is', () => {
    const outside = resolve('/elsewhere/a.md');
    expect(normalizeEntryPath(dir, outside)).toBe(outside);
  });
  test('the dir itself is returned as is (not an entry inside it)', () => {
    expect(normalizeEntryPath(dir, dir)).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// isUntrackedProductionPath — bookkeeping and archived paths are never outputs
// ---------------------------------------------------------------------------

describe('isUntrackedProductionPath', () => {
  test('reserved bookkeeping files are untracked, at the root or nested', () => {
    for (const p of ['changelog.jsonl', 'summary.json', 'INDEX.md', 'index.html', 'sub/INDEX.md']) {
      expect(isUntrackedProductionPath(p)).toBe(true);
    }
  });

  test('anything under archived/ is untracked', () => {
    expect(isUntrackedProductionPath('archived/22_paraphrase_proxy.ts')).toBe(true);
    expect(isUntrackedProductionPath('archived')).toBe(true);
  });

  test('absolute paths are judged by their basename only', () => {
    expect(isUntrackedProductionPath('/app/productions/bot/changelog.jsonl')).toBe(true);
    expect(isUntrackedProductionPath('/home/x/archived/notes.md')).toBe(false);
  });

  test('ordinary outputs are tracked', () => {
    for (const p of ['01_ideas.md', 'reports/02_brief.md', 'my-archived-notes.md', 'notes/archived.md']) {
      expect(isUntrackedProductionPath(p)).toBe(false);
    }
  });

  test('Windows separators are understood', () => {
    expect(isUntrackedProductionPath('archived\\x.md')).toBe(true);
    expect(isUntrackedProductionPath('sub\\changelog.jsonl')).toBe(true);
  });
});

describe('isScratchProductionPath', () => {
  test('a leading _ or . on the file name marks scratch, at any depth', () => {
    for (const p of ['_sim.ts', '.probe.json', 'notes/_draft.md', './_x.ts', 'a\\_b.ts']) {
      expect(isScratchProductionPath(p)).toBe(true);
    }
  });

  test('numbered outputs, plain names and shell scripts are not scratch', () => {
    for (const p of ['07_bias_power_sim.ts', 'brief.md', '00_preflight.sh', 'x_y.md', '']) {
      expect(isScratchProductionPath(p)).toBe(false);
    }
  });
});
