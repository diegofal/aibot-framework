/**
 * One way to explain everything: every surface builds the same `Why` and
 * renders it with the same panel. Adding a builder means adding a fixture
 * here; rendering a Why fold anywhere but `web/pages/why-helpers.js` fails.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dispatch } from '../../src/bot/curiosity/types';
import { WHY_BUILDERS, type WhyBuilderName } from '../../src/why/builders';
import { WhySchema } from '../../src/why/types';
import { whyPanel } from '../../web/pages/why-helpers.js';

const ROOT = join(import.meta.dir, '..', '..');

const dispatch: Dispatch = {
  id: 'd1',
  botId: 'b1',
  createdAt: '2026-10-11T12:00:00Z',
  kind: 'insight',
  topic: 't',
  hook: 'h',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.5,
  status: 'held',
  heldReason: 'editor',
  heldBar: 0.7,
  origin: { trigger: 'insight', cycleId: 'c1', goalTitle: 'G', plan: 'P' },
};

/** One fixture per builder: its input. */
const FIXTURES: { [K in WhyBuilderName]: Parameters<(typeof WHY_BUILDERS)[K]>[0] } = {
  dispatch,
};

describe('Why contract', () => {
  for (const name of Object.keys(WHY_BUILDERS) as WhyBuilderName[]) {
    it(`${name}: a valid Why, rendered by the shared panel`, () => {
      const why = WHY_BUILDERS[name](FIXTURES[name] as never);
      const parsed = WhySchema.safeParse(why);
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
      expect(whyPanel(why)).toStartWith('<details class="why">');
    });
  }

  it('every builder file is registered', () => {
    const files = readdirSync(join(ROOT, 'src', 'why', 'builders'))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''));
    const index = readFileSync(join(ROOT, 'src', 'why', 'builders', 'index.ts'), 'utf-8');
    for (const f of files) expect(index).toContain(`from './${f}'`);
  });

  it('no page renders its own Why fold', () => {
    const pages = join(ROOT, 'web', 'pages');
    const offenders = readdirSync(pages)
      .filter((f) => f.endsWith('.js') && f !== 'why-helpers.js')
      .filter((f) => /class="why[" -]|curio-origin/.test(readFileSync(join(pages, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
