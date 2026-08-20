import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-test scratch directories that survive Windows file locking.
 *
 * Why this exists: on Windows, Bun does not release SQLite file handles when a
 * `Database` is closed — the OS frees them only at process exit. Measured with
 * bun 1.3.9:
 *
 *   const db = initializeMemoryDb(`${dir}/memory.db`, logger);
 *   db.close();                       // reports success
 *   unlinkSync(`${dir}/memory.db`);   // EBUSY
 *   renameSync(dir, `${dir}.trash`);  // EPERM
 *
 * `close(true)` is worse — it throws `database is locked` and then the handle is
 * definitely still open. Retrying does not help: the handle is held for the life
 * of the process, so no amount of backoff releases it. WAL mode leaves
 * `-shm`/`-wal` siblings locked the same way.
 *
 * The consequence for tests is that any suite touching a memory DB cannot delete
 * its own directory afterwards. When every test shares one fixed directory, the
 * first DB-touching test wedges it and every later test fails in `beforeEach` or
 * `afterEach` — cascading failures that have nothing to do with the assertions.
 *
 * So: give each test its own directory and treat cleanup as best-effort. A
 * wedged directory is then inert rather than contagious, and it lands under the
 * OS temp dir where it does not pollute the repo and gets reaped externally.
 */

/** Create a unique scratch directory under the OS temp dir. */
export function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a scratch directory, tolerating the Windows lock described above.
 *
 * Swallows only the two error codes that mean "an open handle owns this"; any
 * other failure is re-thrown, so a genuine cleanup bug still surfaces.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
  }
}
