/**
 * An agent's face: one uploaded PNG or JPEG kept in the bot's soul directory
 * (session S4 of docs/plans/jarvis-fleet-plan.md).
 *
 * Lives next to IDENTITY.md on purpose: the soul dir is what
 * `BotExportService` archives, so a face travels with the agent for free.
 * The type is read from the bytes, never from what the client declares, and
 * a new upload of the other format replaces the old file so a bot never has
 * two faces. Nothing here touches the config.
 */
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AVATAR_MAX_BYTES = 512 * 1024;

export type AvatarType = 'image/png' | 'image/jpeg';

export const AVATAR_FILENAMES: Record<AvatarType, string> = {
  'image/png': 'avatar.png',
  'image/jpeg': 'avatar.jpg',
};

export interface AvatarFile {
  path: string;
  contentType: AvatarType;
  size: number;
  mtimeMs: number;
}

export type AvatarValidationCode = 'empty' | 'bad-type' | 'too-large';

export class AvatarValidationError extends Error {
  constructor(
    public readonly code: AvatarValidationCode,
    message: string
  ) {
    super(message);
    this.name = 'AvatarValidationError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(buf: Uint8Array, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

/** PNG or JPEG from the magic bytes; null for anything else (including empty). */
export function sniffImageType(buf: Uint8Array): AvatarType | null {
  if (startsWith(buf, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(buf, JPEG_SIGNATURE)) return 'image/jpeg';
  return null;
}

/** Throws `AvatarValidationError` with a code; returns the detected type. */
export function validateAvatar(buf: Uint8Array): AvatarType {
  if (buf.length === 0) throw new AvatarValidationError('empty', 'Empty upload');
  if (buf.length > AVATAR_MAX_BYTES) {
    throw new AvatarValidationError(
      'too-large',
      `Avatar is ${buf.length} bytes; the limit is ${AVATAR_MAX_BYTES / 1024} KB`
    );
  }
  const type = sniffImageType(buf);
  if (!type) throw new AvatarValidationError('bad-type', 'Avatar must be a PNG or JPEG image');
  return type;
}

function statFile(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The bot's face on disk, PNG preferred when (impossibly) both exist. */
export function findAvatar(soulDir: string): AvatarFile | null {
  for (const [contentType, filename] of Object.entries(AVATAR_FILENAMES) as Array<
    [AvatarType, string]
  >) {
    const path = join(soulDir, filename);
    const st = statFile(path);
    if (st) return { path, contentType, size: st.size, mtimeMs: st.mtimeMs };
  }
  return null;
}

/** Validate, create the soul dir if needed, write, and drop the other variant. */
export function writeAvatar(soulDir: string, buf: Buffer): AvatarFile {
  const contentType = validateAvatar(buf);
  mkdirSync(soulDir, { recursive: true });
  for (const [type, filename] of Object.entries(AVATAR_FILENAMES) as Array<[AvatarType, string]>) {
    if (type === contentType) continue;
    const other = join(soulDir, filename);
    if (existsSync(other)) unlinkSync(other);
  }
  const path = join(soulDir, AVATAR_FILENAMES[contentType]);
  writeFileSync(path, buf);
  const st = statFile(path) ?? { size: buf.length, mtimeMs: Date.now() };
  return { path, contentType, size: st.size, mtimeMs: st.mtimeMs };
}

/** Delete whichever variant exists. True when something was removed. */
export function removeAvatar(soulDir: string): boolean {
  let removed = false;
  for (const filename of Object.values(AVATAR_FILENAMES)) {
    const path = join(soulDir, filename);
    if (existsSync(path)) {
      unlinkSync(path);
      removed = true;
    }
  }
  return removed;
}

/**
 * Dashboard URL for a face, versioned by mtime so a fresh upload busts every
 * cached `<img>`; null when the bot has no face.
 */
export function avatarUrl(botId: string, avatar: AvatarFile | null): string | null {
  if (!avatar) return null;
  return `/api/agents/${encodeURIComponent(botId)}/avatar?v=${Math.floor(avatar.mtimeMs)}`;
}
