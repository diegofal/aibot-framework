import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Bun binds an import of a name the module does not export to `undefined`
 * instead of failing, so a test can keep importing a deleted helper and stay
 * green. A browser (and any spec ESM loader) refuses the whole module. This
 * checks every named import from `web/` in these tests against real exports.
 */
const HERE = import.meta.dir;
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](\.\.\/\.\.\/web\/[^'"]+\.js)['"]/g;

describe('tests import only what web/ modules export', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.ts'));
  for (const file of files) {
    const src = readFileSync(join(HERE, file), 'utf8');
    const imports = [...src.matchAll(IMPORT)];
    if (!imports.length) continue;
    it(file, async () => {
      const missing: string[] = [];
      for (const [, names, spec] of imports) {
        const mod = await import(resolve(dirname(join(HERE, file)), spec));
        for (const raw of names.split(',')) {
          const name = raw
            .replace(/^\s*type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim();
          if (name && !(name in mod)) missing.push(`${name} from ${spec}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
