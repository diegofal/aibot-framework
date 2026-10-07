/**
 * Who is looking at a bot's memory.
 *
 * A bot talks to several people, and what one of them tells it in private is
 * that person's. The viewer is the person on the other side of the
 * conversation (their channel user id), independent of `userIsolation`, which
 * also splits daily logs and goals per user:
 *
 * - a person id: that person's facts, files and private transcript, plus everything shared;
 * - `null`: shared only (agent loop, bot-to-bot collaboration);
 * - `undefined`: no viewer given — the legacy behaviour (scope by the
 *   isolation `userId` if any, otherwise everything).
 */
export type MemoryViewer = string | null | undefined;

/** Tool argument the executor injects for memory tools. */
export const MEMORY_VIEWER_ARG = '_memoryViewer';

export function memoryViewerFromArgs(args: Record<string, unknown>): MemoryViewer {
  if (!(MEMORY_VIEWER_ARG in args)) return undefined;
  const v = args[MEMORY_VIEWER_ARG];
  return typeof v === 'string' && v ? v : null;
}

/** The user scope to read or write core memory with: the viewer if given, else the legacy userId. */
export function memoryScope(
  viewer: MemoryViewer,
  userId: string | undefined
): string | null | undefined {
  return viewer !== undefined ? viewer : userId;
}

/**
 * Whether an indexed path (memory search) may be shown to the viewer. Other
 * people's per-user memory folders and private transcripts are hidden; the
 * shared viewer sees none of them.
 */
export function isPathVisibleTo(path: string, botId: string, viewer: string | null): boolean {
  const userDir = `${botId}/memory/users/`;
  if (path.startsWith(userDir)) {
    const owner = path.slice(userDir.length).split('/')[0];
    return viewer !== null && owner === viewer;
  }
  const privateSession = `sessions/bot-${botId}-private-`;
  if (path.startsWith(privateSession)) {
    const owner = path.slice(privateSession.length).split(/[^0-9A-Za-z_-]/)[0];
    return viewer !== null && owner === viewer;
  }
  return true;
}
