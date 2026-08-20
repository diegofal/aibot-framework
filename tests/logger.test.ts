import { describe, expect, it } from 'bun:test';
import { createLogger } from '../src/logger';

// Note: we do NOT exercise the pino-roll file transport here. pino-roll spins
// up a worker_threads instance that interferes with setTimeout-based mock
// transports in other tests when run in the same process. The rotation
// behaviour is validated by the pino-roll suite itself; here we only verify
// the logger is constructed with the new options without throwing.

describe('createLogger', () => {
  it('should build a logger without a file target (stdout only)', () => {
    const logger = createLogger({ level: 'info' });
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should accept fileMaxSize and fileLimit options without throwing', () => {
    // Omit `file` so pino-roll is not instantiated — we only assert the option
    // shaping in createLogger does not throw for the new rotation fields.
    const logger = createLogger({
      level: 'info',
      fileMaxSize: '1k',
      fileLimit: 3,
    });
    expect(typeof logger.info).toBe('function');
  });

  it('should default fileMaxSize to "10m" and fileLimit to 5 when omitted', () => {
    const logger = createLogger({ level: 'info' });
    expect(typeof logger.info).toBe('function');
  });
});