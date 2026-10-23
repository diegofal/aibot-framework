/**
 * patchConfigFile / writeJsonFileAtomic — the one way the process rewrites
 * config.json (and bots.json): raw read, mutate, atomic write, no `.bak`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchConfigFile, persistBots, writeJsonFileAtomic } from '../src/config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-patch-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('patchConfigFile', () => {
  test('reads the file raw, applies the mutation, keeps ${VAR} references and the rest', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ apiKey: '${SECRET}', evolution: { a: 1 }, keep: true }));
    const out = patchConfigFile(path, (raw) => {
      raw.evolution = { a: 2 };
      return 'done';
    });
    expect(out).toBe('done');
    const text = readFileSync(path, 'utf-8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ apiKey: '${SECRET}', evolution: { a: 2 }, keep: true });
  });

  test('leaves no .bak (secrets are not copied around) and no .tmp', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ token: 'inline-secret' }));
    patchConfigFile(path, (raw) => {
      raw.x = 1;
    });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  test('a mutation that throws writes nothing', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{"a":1}');
    expect(() =>
      patchConfigFile(path, () => {
        throw new Error('rejected');
      })
    ).toThrow('rejected');
    expect(readFileSync(path, 'utf-8')).toBe('{"a":1}');
  });

  test('a file that is not a JSON object throws and stays as is', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '[1,2]');
    expect(() => patchConfigFile(path, () => {})).toThrow(/not a JSON object/);
    expect(readFileSync(path, 'utf-8')).toBe('[1,2]');
    expect(() => patchConfigFile(join(dir, 'missing.json'), () => {})).toThrow();
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
  });
});

describe('writeJsonFileAtomic', () => {
  test('pretty JSON with a trailing newline, no .tmp left', () => {
    const path = join(dir, 'bots.json');
    writeJsonFileAtomic(path, [{ id: 'b1' }]);
    expect(readFileSync(path, 'utf-8')).toBe('[\n  {\n    "id": "b1"\n  }\n]\n');
    expect(readdirSync(dir)).toEqual(['bots.json']);
  });

  test('persistBots goes through it', () => {
    persistBots(join(dir, 'config.json'), [{ id: 'b1' }] as never);
    expect(JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'))).toEqual([{ id: 'b1' }]);
    expect(readdirSync(dir)).toEqual(['bots.json']);
  });
});
