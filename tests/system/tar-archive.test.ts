import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectDirEntries,
  subtree,
  subtreeChildren,
  writeArchiveToDisk,
} from '../../src/system/archive-fs';
import {
  isSafeArchivePath,
  normalizeArchivePath,
  packTar,
  packTarGz,
  unpackTarGz,
} from '../../src/system/tar-archive';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tar-archive');

describe('normalizeArchivePath', () => {
  it('converts Windows separators to POSIX', () => {
    expect(normalizeArchivePath('soul\\memory\\2026-01-01.md')).toBe('soul/memory/2026-01-01.md');
  });

  it('strips drive letters so a Windows export lands correctly on Linux', () => {
    expect(normalizeArchivePath('D:\\aibot\\soul\\IDENTITY.md')).toBe('aibot/soul/IDENTITY.md');
    expect(normalizeArchivePath('C:/data/x.md')).toBe('data/x.md');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(normalizeArchivePath('./soul//memory/./a.md')).toBe('soul/memory/a.md');
    expect(normalizeArchivePath('/leading/slash')).toBe('leading/slash');
  });

  it('preserves directory names containing spaces', () => {
    expect(normalizeArchivePath('config\\soul\\Improve my life\\SOUL.md')).toBe(
      'config/soul/Improve my life/SOUL.md'
    );
  });
});

describe('isSafeArchivePath', () => {
  it('rejects traversal, absolute and drive-qualified paths', () => {
    expect(isSafeArchivePath('../etc/passwd')).toBe(false);
    expect(isSafeArchivePath('soul/../../escape')).toBe(false);
    expect(isSafeArchivePath('/etc/passwd')).toBe(false);
    expect(isSafeArchivePath('C:\\Windows\\system32')).toBe(false);
    expect(isSafeArchivePath('')).toBe(false);
  });

  it('accepts ordinary relative paths', () => {
    expect(isSafeArchivePath('soul/IDENTITY.md')).toBe(true);
    expect(isSafeArchivePath('agents/my bot/soul/a.md')).toBe(true);
  });
});

describe('packTarGz / unpackTarGz', () => {
  it('round-trips file contents byte for byte', () => {
    const buffer = packTarGz([
      { path: 'a.txt', data: Buffer.from('hello', 'utf-8') },
      { path: 'nested/deep/b.json', data: Buffer.from('{"x":1}', 'utf-8') },
    ]);

    const { files } = unpackTarGz(buffer);
    expect(files.get('a.txt')?.toString('utf-8')).toBe('hello');
    expect(files.get('nested/deep/b.json')?.toString('utf-8')).toBe('{"x":1}');
  });

  it('round-trips binary content unchanged', () => {
    const binary = Buffer.from([0, 1, 2, 255, 128, 0, 77]);
    const { files } = unpackTarGz(packTarGz([{ path: 'blob.bin', data: binary }]));
    expect(files.get('blob.bin')?.equals(binary)).toBe(true);
  });

  it('round-trips paths with spaces and unicode', () => {
    const path = 'config/soul/Improve my life/MEMORÍA.md';
    const { files } = unpackTarGz(packTarGz([{ path, data: Buffer.from('x') }]));
    expect(files.has(path)).toBe(true);
  });

  it('round-trips paths longer than the 100-byte ustar name field', () => {
    const long = `agents/${'a'.repeat(90)}/soul/${'b'.repeat(90)}/IDENTITY.md`;
    const { files } = unpackTarGz(packTarGz([{ path: long, data: Buffer.from('deep') }]));
    expect(files.get(long)?.toString('utf-8')).toBe('deep');
  });

  it('round-trips a single path segment longer than 100 bytes (PAX header)', () => {
    const long = `${'x'.repeat(180)}.md`;
    const { files } = unpackTarGz(packTarGz([{ path: long, data: Buffer.from('pax') }]));
    expect(files.get(long)?.toString('utf-8')).toBe('pax');
  });

  it('preserves empty directories', () => {
    const { dirs, files } = unpackTarGz(packTarGz([{ path: 'soul/empty' }]));
    expect(dirs.has('soul/empty')).toBe(true);
    expect(files.size).toBe(0);
  });

  it('normalizes Windows paths at pack time', () => {
    const { files } = unpackTarGz(
      packTarGz([{ path: 'soul\\memory\\a.md', data: Buffer.from('x') }])
    );
    expect(files.has('soul/memory/a.md')).toBe(true);
  });

  it('refuses to pack a traversal path', () => {
    expect(() => packTarGz([{ path: '../escape.txt', data: Buffer.from('x') }])).toThrow(
      'unsafe path'
    );
  });

  it('rejects input that is not gzip', () => {
    expect(() => unpackTarGz(Buffer.from('definitely not gzip'))).toThrow('valid .tar.gz');
  });

  it('detects a corrupted header', () => {
    const raw = packTar([{ path: 'a.txt', data: Buffer.from('hello') }]);
    raw[10] = 0x41; // corrupt the mode field, invalidating the checksum
    expect(() => unpackTarGz(Bun.gzipSync(raw) as unknown as Buffer)).toThrow('checksum mismatch');
  });

  it('handles an archive with many entries', () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      path: `dir${i % 7}/file-${i}.txt`,
      data: Buffer.from(`content ${i}`),
    }));
    const { files } = unpackTarGz(packTarGz(entries));
    expect(files.size).toBe(250);
    expect(files.get('dir3/file-101.txt')?.toString('utf-8')).toBe('content 101');
  });
});

describe('archive-fs', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('collects a directory tree with a POSIX prefix regardless of host separators', () => {
    mkdirSync(join(TEST_DIR, 'src', 'Improve my life'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'top.md'), 'top');
    writeFileSync(join(TEST_DIR, 'src', 'Improve my life', 'SOUL.md'), 'soul');

    const entries = collectDirEntries(join(TEST_DIR, 'src'), 'agents/bot');
    const paths = entries.map((entry) => entry.path).sort();

    expect(paths).toEqual(['agents/bot/Improve my life/SOUL.md', 'agents/bot/top.md']);
    expect(paths.every((path) => !path.includes('\\'))).toBe(true);
  });

  it('honours the filter callback', () => {
    mkdirSync(join(TEST_DIR, 'src', '.versions'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'keep.md'), 'keep');
    writeFileSync(join(TEST_DIR, 'src', '.versions', 'old.md'), 'old');

    const entries = collectDirEntries(join(TEST_DIR, 'src'), 'soul', {
      filter: (path) => !path.split('/').includes('.versions'),
    });
    expect(entries.map((entry) => entry.path)).toEqual(['soul/keep.md']);
  });

  it('skips files over maxFileBytes and reports them', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'big.bin'), Buffer.alloc(2048));
    writeFileSync(join(TEST_DIR, 'src', 'small.txt'), 'ok');

    const skipped: string[] = [];
    const entries = collectDirEntries(join(TEST_DIR, 'src'), 'data', {
      maxFileBytes: 1024,
      onSkipped: (path) => skipped.push(path),
    });

    expect(entries.map((entry) => entry.path)).toEqual(['data/small.txt']);
    expect(skipped).toEqual(['big.bin']);
  });

  it('writes an extracted subtree back to disk, creating parents', () => {
    const archive = unpackTarGz(
      packTarGz([
        { path: 'agents/bot/soul/IDENTITY.md', data: Buffer.from('id') },
        { path: 'agents/bot/soul/memory/a.md', data: Buffer.from('mem') },
        { path: 'agents/other/soul/x.md', data: Buffer.from('other') },
      ])
    );

    const written = writeArchiveToDisk(subtree(archive, 'agents/bot/soul'), join(TEST_DIR, 'out'));

    expect(written).toBe(2);
    expect(readFileSync(join(TEST_DIR, 'out', 'IDENTITY.md'), 'utf-8')).toBe('id');
    expect(readFileSync(join(TEST_DIR, 'out', 'memory', 'a.md'), 'utf-8')).toBe('mem');
    expect(existsSync(join(TEST_DIR, 'out', 'x.md'))).toBe(false);
  });

  it('lists immediate children of a prefix', () => {
    const archive = unpackTarGz(
      packTarGz([
        { path: 'agents/alpha/manifest.json', data: Buffer.from('{}') },
        { path: 'agents/beta/manifest.json', data: Buffer.from('{}') },
        { path: 'agents/beta/soul/a.md', data: Buffer.from('x') },
        { path: 'config/config.json', data: Buffer.from('{}') },
      ])
    );
    expect(subtreeChildren(archive, 'agents')).toEqual(['alpha', 'beta']);
  });
});

describe('interoperability with system tar', () => {
  // Windows ships bsdtar, but it fails on drive-qualified `-C` paths, so the
  // interop check only runs where a POSIX tar is available. That divergence is
  // the whole reason the exporter no longer shells out to it.
  const tarAvailable = (() => {
    if (process.platform === 'win32') return false;
    try {
      return Bun.spawnSync(['tar', '--version']).exitCode === 0;
    } catch {
      return false;
    }
  })();

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Skipped where `tar` is absent (plain Windows shells, slim containers) —
  // which is exactly why the exporter no longer depends on it.
  it.skipIf(!tarAvailable)('produces archives GNU/bsdtar can extract', async () => {
    const buffer = packTarGz([
      { path: 'manifest.json', data: Buffer.from('{"version":1}') },
      { path: 'soul/Improve my life/SOUL.md', data: Buffer.from('spaces work') },
      { path: `deep/${'n'.repeat(120)}/file.md`, data: Buffer.from('long path') },
    ]);

    const archivePath = join(TEST_DIR, 'out.tar.gz');
    const extractDir = join(TEST_DIR, 'extract');
    writeFileSync(archivePath, buffer);
    mkdirSync(extractDir, { recursive: true });

    const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', extractDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    expect(readFileSync(join(extractDir, 'manifest.json'), 'utf-8')).toBe('{"version":1}');
    expect(readFileSync(join(extractDir, 'soul', 'Improve my life', 'SOUL.md'), 'utf-8')).toBe(
      'spaces work'
    );
  });

  it.skipIf(!tarAvailable)('reads archives produced by system tar', async () => {
    const sourceDir = join(TEST_DIR, 'source');
    mkdirSync(join(sourceDir, 'soul'), { recursive: true });
    writeFileSync(join(sourceDir, 'manifest.json'), '{"version":1}');
    writeFileSync(join(sourceDir, 'soul', 'IDENTITY.md'), 'from gnu tar');

    const archivePath = join(TEST_DIR, 'gnu.tar.gz');
    const proc = Bun.spawn(['tar', '-czf', archivePath, '-C', sourceDir, '.'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const { files } = unpackTarGz(readFileSync(archivePath));
    expect(files.get('manifest.json')?.toString('utf-8')).toBe('{"version":1}');
    expect(files.get('soul/IDENTITY.md')?.toString('utf-8')).toBe('from gnu tar');
  });
});
