/**
 * Avatar files in the soul dir (session S4 of docs/plans/jarvis-fleet-plan.md).
 * PNG or JPEG, 512 KB max, one file per bot; the type is read from the bytes,
 * never from what the client claims.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AVATAR_FILENAMES,
  AVATAR_MAX_BYTES,
  AvatarValidationError,
  avatarUrl,
  findAvatar,
  removeAvatar,
  sniffImageType,
  validateAvatar,
  writeAvatar,
} from '../../src/bot/agent-avatar';
import { createTempDir, removeTempDir } from '../helpers/temp-dir';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a......', 'latin1');

let dir: string;
beforeEach(() => {
  dir = createTempDir('agent-avatar');
});
afterEach(() => removeTempDir(dir));

describe('sniffImageType / validateAvatar', () => {
  it('recognises PNG and JPEG signatures and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
  it('rejects empty, oversized and non-image bytes with a code', () => {
    expect(() => validateAvatar(Buffer.alloc(0))).toThrow(AvatarValidationError);
    try {
      validateAvatar(Buffer.alloc(0));
    } catch (e) {
      expect((e as AvatarValidationError).code).toBe('empty');
    }
    try {
      validateAvatar(GIF);
    } catch (e) {
      expect((e as AvatarValidationError).code).toBe('bad-type');
    }
    const big = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    try {
      validateAvatar(big);
    } catch (e) {
      expect((e as AvatarValidationError).code).toBe('too-large');
    }
    expect(validateAvatar(PNG)).toBe('image/png');
    expect(
      validateAvatar(Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES - JPEG.length)]))
    ).toBe('image/jpeg');
  });
});

describe('writeAvatar / findAvatar / removeAvatar', () => {
  it('writes avatar.png, creating the soul dir, and finds it back', () => {
    const soul = join(dir, 'missing', 'soul');
    const file = writeAvatar(soul, PNG);
    expect(file.contentType).toBe('image/png');
    expect(file.path).toBe(join(soul, AVATAR_FILENAMES['image/png']));
    expect(file.size).toBe(PNG.length);
    expect(readFileSync(file.path)).toEqual(PNG);
    const found = findAvatar(soul);
    expect(found).toMatchObject({ contentType: 'image/png', size: PNG.length });
    expect(typeof found?.mtimeMs).toBe('number');
  });
  it('a JPEG upload replaces an existing PNG so only one face exists', () => {
    writeAvatar(dir, PNG);
    const jpg = writeAvatar(dir, JPEG);
    expect(jpg.contentType).toBe('image/jpeg');
    expect(existsSync(join(dir, 'avatar.png'))).toBe(false);
    expect(existsSync(join(dir, 'avatar.jpg'))).toBe(true);
    expect(findAvatar(dir)?.contentType).toBe('image/jpeg');
  });
  it('throws without touching disk on a bad upload', () => {
    expect(() => writeAvatar(dir, GIF)).toThrow(AvatarValidationError);
    expect(findAvatar(dir)).toBeNull();
  });
  it('findAvatar is null for a missing dir and ignores stray files', () => {
    expect(findAvatar(join(dir, 'nope'))).toBeNull();
    writeFileSync(join(dir, 'avatar.gif'), GIF);
    expect(findAvatar(dir)).toBeNull();
  });
  it('removeAvatar deletes whichever variant exists and reports it', () => {
    expect(removeAvatar(dir)).toBe(false);
    writeAvatar(dir, JPEG);
    expect(removeAvatar(dir)).toBe(true);
    expect(findAvatar(dir)).toBeNull();
    expect(removeAvatar(join(dir, 'nope'))).toBe(false);
  });
});

describe('avatarUrl', () => {
  it('is null without a file and a versioned API path with one', () => {
    expect(avatarUrl('b1', null)).toBeNull();
    const url = avatarUrl('a b/c', {
      path: 'x',
      contentType: 'image/png',
      size: 1,
      mtimeMs: 1700000000123.4,
    });
    expect(url).toBe('/api/agents/a%20b%2Fc/avatar?v=1700000000123');
  });
});
