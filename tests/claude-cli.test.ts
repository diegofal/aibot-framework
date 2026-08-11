import { describe, expect, test } from 'bun:test';
import { type WhichFn, resolveClaudeBin } from '../src/claude-cli';

const realPlatform = process.platform;

/** Run `fn` with `process.platform` forced, always restoring the real value. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

/**
 * Fake PATH lookup: resolves only the commands listed in `installed`.
 * Keeps the tests independent of whatever Claude install exists on the host.
 */
function fakeWhich(installed: string[]): WhichFn & { calls: string[] } {
  const calls: string[] = [];
  const which = (command: string): string | null => {
    calls.push(command);
    return installed.includes(command) ? `C:\\fake\\${command}` : null;
  };
  return Object.assign(which, { calls });
}

describe('resolveClaudeBin', () => {
  test('returns path unchanged on linux without probing the filesystem', () => {
    const which = fakeWhich(['claude.cmd']);
    withPlatform('linux', () => {
      expect(resolveClaudeBin('claude', which)).toBe('claude');
    });
    expect(which.calls).toEqual([]);
  });

  test('returns path unchanged on darwin without probing the filesystem', () => {
    const which = fakeWhich(['/usr/local/bin/claude.cmd']);
    withPlatform('darwin', () => {
      expect(resolveClaudeBin('/usr/local/bin/claude', which)).toBe('/usr/local/bin/claude');
    });
    expect(which.calls).toEqual([]);
  });

  test('appends .cmd on win32 when the npm shim wrapper exists', () => {
    const which = fakeWhich(['claude.cmd']);
    withPlatform('win32', () => {
      expect(resolveClaudeBin('claude', which)).toBe('claude.cmd');
    });
    expect(which.calls).toEqual(['claude.cmd']);
  });

  test('appends .cmd on win32 for a full path when the wrapper exists', () => {
    const which = fakeWhich(['C:\\Program Files\\nodejs\\claude.cmd']);
    withPlatform('win32', () => {
      expect(resolveClaudeBin('C:\\Program Files\\nodejs\\claude', which)).toBe(
        'C:\\Program Files\\nodejs\\claude.cmd'
      );
    });
  });

  test('leaves the path alone on win32 when no .cmd wrapper exists (native exe install)', () => {
    const which = fakeWhich(['claude.exe']);
    withPlatform('win32', () => {
      expect(resolveClaudeBin('claude', which)).toBe('claude');
    });
    expect(which.calls).toEqual(['claude.cmd']);
  });

  test('leaves a non-claude stub command alone on win32 so tests can spawn real binaries', () => {
    const which = fakeWhich([]);
    withPlatform('win32', () => {
      expect(resolveClaudeBin('echo', which)).toBe('echo');
      expect(resolveClaudeBin('false', which)).toBe('false');
    });
  });

  test.each([
    ['claude.cmd'],
    ['claude.exe'],
    ['claude.bat'],
    ['claude.CMD'],
    ['claude.EXE'],
    ['claude.Bat'],
  ])('leaves an already-suffixed path %s untouched on win32', (path) => {
    const which = fakeWhich(['claude.cmd.cmd', 'claude.exe.cmd', 'claude.bat.cmd']);
    withPlatform('win32', () => {
      expect(resolveClaudeBin(path, which)).toBe(path);
    });
    expect(which.calls).toEqual([]);
  });

  test('keeps working as a single-argument call, defaulting to a real PATH lookup', () => {
    // Host-dependent by nature: only assert the contract the call sites rely on —
    // one argument is enough, and the result is either the input or its .cmd wrapper.
    expect(['claude', 'claude.cmd']).toContain(resolveClaudeBin('claude'));
  });
});
