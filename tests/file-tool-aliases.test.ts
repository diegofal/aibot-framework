import { describe, expect, test } from 'bun:test';
import { resolveNewTextParam, resolveOldTextParam, resolvePathParam } from '../src/tools/file';

describe('resolvePathParam', () => {
  test('returns path when present', () => {
    expect(resolvePathParam({ path: 'docs/readme.md' })).toBe('docs/readme.md');
  });

  test('returns file_path as fallback (common LLM alias)', () => {
    expect(resolvePathParam({ file_path: 'marketing/deploy.sh' })).toBe('marketing/deploy.sh');
  });

  test('returns filepath as fallback', () => {
    expect(resolvePathParam({ filepath: 'src/index.ts' })).toBe('src/index.ts');
  });

  test('returns file as fallback', () => {
    expect(resolvePathParam({ file: 'config.json' })).toBe('config.json');
  });

  test('path takes priority over aliases', () => {
    expect(resolvePathParam({ path: 'primary.md', file_path: 'alias.md' })).toBe('primary.md');
  });

  test('returns empty for no matching key', () => {
    expect(resolvePathParam({ content: 'some text' })).toBe('');
  });

  test('trims whitespace', () => {
    expect(resolvePathParam({ path: '  docs/readme.md  ' })).toBe('docs/readme.md');
    expect(resolvePathParam({ file_path: '  src/main.ts  ' })).toBe('src/main.ts');
  });

  test('skips empty string aliases', () => {
    expect(resolvePathParam({ path: '', file_path: '', filepath: 'found.txt' })).toBe('found.txt');
  });
});

describe('resolveOldTextParam', () => {
  test('returns old_text when present', () => {
    expect(resolveOldTextParam({ old_text: 'function foo()' })).toBe('function foo()');
  });

  test('returns old_string as fallback (Cursor-style name)', () => {
    expect(resolveOldTextParam({ old_string: 'const x = 1' })).toBe('const x = 1');
  });

  test('returns oldText as fallback (camelCase)', () => {
    expect(resolveOldTextParam({ oldText: 'let y = 2' })).toBe('let y = 2');
  });

  test('returns search as fallback', () => {
    expect(resolveOldTextParam({ search: 'pattern' })).toBe('pattern');
  });

  test('old_text takes priority', () => {
    expect(resolveOldTextParam({ old_text: 'primary', old_string: 'alias' })).toBe('primary');
  });

  test('returns empty for no matching key', () => {
    expect(resolveOldTextParam({ path: 'file.ts' })).toBe('');
  });
});

describe('resolveNewTextParam', () => {
  test('returns new_text when present', () => {
    expect(resolveNewTextParam({ new_text: 'function bar()' })).toBe('function bar()');
  });

  test('returns new_string as fallback (Cursor-style name)', () => {
    expect(resolveNewTextParam({ new_string: 'const x = 2' })).toBe('const x = 2');
  });

  test('returns newText as fallback (camelCase)', () => {
    expect(resolveNewTextParam({ newText: 'let y = 3' })).toBe('let y = 3');
  });

  test('returns replace as fallback', () => {
    expect(resolveNewTextParam({ replace: 'replacement' })).toBe('replacement');
  });

  test('new_text takes priority', () => {
    expect(resolveNewTextParam({ new_text: 'primary', new_string: 'alias' })).toBe('primary');
  });

  test('returns empty for no matching key', () => {
    expect(resolveNewTextParam({ path: 'file.ts' })).toBe('');
  });
});
