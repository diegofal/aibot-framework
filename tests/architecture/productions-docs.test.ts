/**
 * Documentation-alignment test for the productions refactor.
 *
 * Per docs/architecture-docs/productions-refactor.md §3.4 (Cycle 9):
 *   The Cycle 9 alignment test asserts every file path named in the docs
 *   exists on disk. This is the honest replacement for the deleted
 *   plan-contract test (§6.6) — it has real signal.
 *
 * Pinning the contract:
 *   - Every module under `src/productions/` listed in the docs exists.
 *   - The barrel `src/productions/index.ts` re-exports ProductionsService only.
 *   - The deleted `productions-refactor.html` is gone.
 *   - The CHANGELOG.md entry exists.
 *   - The docs pages (productions.html, architecture.md, productions-refactor.md) exist.
 *   - Each test file in `tests/productions/` exists.
 *
 * Per CLAUDE.md §"Flujo TDD obligatorio": one test per public function.
 * Here: one assertion per documented file path.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('productions module layout (§1)', () => {
  const modules = [
    'service.ts',
    'index.ts',
    'paths.ts',
    'frontmatter.ts',
    'summary.ts',
    'html.ts',
    'files.ts',
    'changelog.ts',
    'tree.ts',
    'cleanup.ts',
    'types.ts',
  ];

  for (const name of modules) {
    test(`${name} exists at src/productions/${name}`, () => {
      expect(existsSync(join(ROOT, 'src/productions', name))).toBe(true);
    });
  }
});

describe('productions test surface (§5)', () => {
  const tests = [
    'assert-within-dir.test.ts',
    'paths.test.ts',
    'frontmatter.test.ts',
    'summary.test.ts',
    'html.test.ts',
    'files.test.ts',
    'changelog.test.ts',
    'tree.test.ts',
    'cleanup.test.ts',
    'contracts.test.ts',
  ];

  for (const name of tests) {
    test(`${name} exists at tests/productions/${name}`, () => {
      expect(existsSync(join(ROOT, 'tests/productions', name))).toBe(true);
    });
  }
});

describe('docs alignment', () => {
  test('productions.html exists (as-built architecture page)', () => {
    expect(existsSync(join(ROOT, 'docs/architecture-docs/productions.html'))).toBe(true);
  });

  test('productions-refactor.md exists (consolidated plan)', () => {
    expect(existsSync(join(ROOT, 'docs/architecture-docs/productions-refactor.md'))).toBe(true);
  });

  test('productions-refactor.html does NOT exist (Cycle 9 §3.5 item 4)', () => {
    expect(existsSync(join(ROOT, 'docs/architecture-docs/productions-refactor.html'))).toBe(false);
  });

  test('CHANGELOG.md exists', () => {
    expect(existsSync(join(ROOT, 'CHANGELOG.md'))).toBe(true);
  });

  test('CHANGELOG.md Unreleased section mentions the seven modules', () => {
    const content = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('paths.ts');
    expect(content).toContain('frontmatter.ts');
    expect(content).toContain('summary.ts');
    expect(content).toContain('html.ts');
    expect(content).toContain('files.ts');
    expect(content).toContain('changelog.ts');
    expect(content).toContain('tree.ts');
  });

  test('docs/architecture.md mentions the productions/ directory entry', () => {
    const content = readFileSync(join(ROOT, 'docs/architecture.md'), 'utf-8');
    expect(content).toContain('├── productions/');
    expect(content).toContain('cleanup.ts');
  });
});

describe('barrel constraint (§6.5)', () => {
  test('index.ts re-exports ProductionsService only', () => {
    const content = readFileSync(join(ROOT, 'src/productions/index.ts'), 'utf-8');
    expect(content).toContain('ProductionsService');
    // Should NOT re-export the submodules.
    expect(content).not.toMatch(/export\s*\{[^}]*\bpaths\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bfrontmatter\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bchangelog\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\btree\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bcleanup\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bhtml\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bfiles\b/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bsummary\b/);
  });
});

describe('BOM is gone (§3.5 E1)', () => {
  test('service.ts does not start with a UTF-8 BOM', () => {
    const buf = readFileSync(join(ROOT, 'src/productions/service.ts'));
    expect(buf[0]).not.toBe(0xef);
    expect(buf[1]).not.toBe(0xbb);
    expect(buf[2]).not.toBe(0xbf);
  });
});
