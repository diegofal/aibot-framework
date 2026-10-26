/**
 * Contract test (autonomy rung 0, invariants C1 and C6 of
 * `docs/plans/watcher-autonomy-plan.md`): every model call the watcher makes
 * goes through `instrumented()` in `src/watcher/llm.ts`, the single choke
 * point that reads the hard kill (`kill.ts`) and asks the budget, monthly
 * ceiling included (`budget.ts`). A watcher module that imported a model
 * client itself, or spawned a process (the Claude CLI is a process), could
 * make a call that skips the kill switch and the ceiling. This scans every
 * module under `src/watcher/` and fails on such an import or spawn anywhere
 * but `llm.ts`. Type-only imports are fine: they are erased and call nothing
 * (the scan reads runtime imports through Bun's transpiler, which drops them).
 *
 * If this fails: route the call through `Watcher.tierClient(...)` (or
 * `instrumented()` with the watcher's budget), never around it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..', '..');
const WATCHER_SRC = join(REPO, 'src', 'watcher');
/** The one module allowed to hold model clients. */
const CHOKE_POINT = 'src/watcher/llm.ts';

/** Repo modules (path without extension) that are, or construct, model clients or spawn the CLI. */
const FORBIDDEN_MODULES = [
  'src/core/llm-client', // ClaudeCliLLMClient, OllamaLLMClient, createLLMClient
  'src/claude-cli', // spawns the Claude CLI
  'src/ollama', // OllamaClient (HTTP to the model server)
  'src/core/ollama-http',
  'src/claude-accounts', // spawns `claude auth`
];

/** Packages that call a model or spawn a process. */
const FORBIDDEN_PACKAGES = [
  /^(node:)?child_process$/,
  /^(node:)?worker_threads$/,
  /^(node:)?cluster$/,
  /^bun$/, // `$` shell
  /^@anthropic-ai\//,
  /^openai$/,
  /^ollama$/,
];

/** Process spawns that need no import (read from the transpiled code: comments and types gone). */
const FORBIDDEN_CALLS = [/\bBun\s*\.\s*(spawn|spawnSync|\$)\b/, /\bnew\s+Worker\s*\(/];

const transpiler = new Bun.Transpiler({ loader: 'ts' });

const posix = (p: string) => p.replace(/\\/g, '/');

function watcherModules(): string[] {
  return (readdirSync(WATCHER_SRC, { recursive: true }) as string[])
    .map((f) => posix(f))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/watcher/${f}`);
}

/** The reasons a module (repo-relative path, its source) breaks the contract. */
function chokePointViolations(file: string, source: string): string[] {
  const out: string[] = [];
  const abs = join(REPO, file);
  for (const imp of transpiler.scanImports(source)) {
    const spec = imp.path;
    if (spec.startsWith('.')) {
      const target = posix(relative(REPO, resolve(dirname(abs), spec))).replace(/\.(ts|js)$/, '');
      const hit = FORBIDDEN_MODULES.find(
        (m) => target === m || target === `${m}/index` || target.startsWith(`${m}/`)
      );
      if (hit) out.push(`imports ${spec} (${hit})`);
    } else if (FORBIDDEN_PACKAGES.some((re) => re.test(spec))) {
      out.push(`imports ${spec}`);
    }
  }
  const code = transpiler.transformSync(source);
  for (const re of FORBIDDEN_CALLS) if (re.test(code)) out.push(`calls ${re.source}`);
  return out;
}

describe('watcher LLM choke point (C1, C6)', () => {
  test('no watcher module but llm.ts imports a model client or spawns a process', () => {
    const modules = watcherModules();
    // the scan really sees the watcher (a broken path would pass vacuously)
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKE_POINT);
    const offenders = modules
      .filter((f) => f !== CHOKE_POINT)
      .flatMap((f) =>
        chokePointViolations(f, readFileSync(join(REPO, f), 'utf-8')).map((v) => `${f}: ${v}`)
      );
    expect(offenders).toEqual([]);
  });

  test('the scan catches the choke point itself (it holds the clients)', () => {
    const v = chokePointViolations(CHOKE_POINT, readFileSync(join(REPO, CHOKE_POINT), 'utf-8'));
    expect(v.some((x) => x.includes('src/core/llm-client'))).toBe(true);
  });

  test('the detector: value imports, re-exports, dynamic imports, requires and spawns', () => {
    const file = 'src/watcher/autonomy/offender.ts';
    const bad = [
      "import { ClaudeCliLLMClient } from '../../core/llm-client';",
      "import { OllamaClient } from '../../ollama';",
      "export { generateClaude } from '../../claude-cli';",
      "const m = await import('../../core/ollama-http');",
      "const cp = require('node:child_process');",
      "import { spawn } from 'child_process';",
      "import { $ } from 'bun';",
      "import Anthropic from '@anthropic-ai/sdk';",
      "import { ClaudeAccountService } from '../../claude-accounts/service';",
      'Bun.spawn(["claude"]);',
      'Bun.spawnSync(["claude"]);',
      'new Worker("x.js");',
    ];
    for (const line of bad) {
      expect({
        line,
        v: chokePointViolations(file, `${line}\nexport const x = 1;`).length,
      }).toEqual({ line, v: 1 });
    }
  });

  test('the detector: type-only imports, comments and allowed modules pass', () => {
    const file = 'src/watcher/notice.ts';
    const fine = [
      "import type { LLMClient } from '../core/llm-client';",
      "import { type ChatMessage } from '../ollama';",
      "export type { TokenUsage } from '../core/llm-client';",
      "import { getClaudeCliStats } from '../core/cli-semaphore';",
      "import { isAbort } from '../core/abort';",
      "import { instrumented } from './llm';",
      "import { readFileSync } from 'node:fs';",
      '// Bun.spawn is never called here',
      '/* new Worker( */',
    ];
    for (const line of fine) {
      expect({ line, v: chokePointViolations(file, `${line}\nexport const x = 1;`) }).toEqual({
        line,
        v: [],
      });
    }
  });
});
