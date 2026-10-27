import { describe, expect, test } from 'bun:test';
import { FAILURE_CLASSES, classifyFailure } from '../../src/bot/self-improve/classes';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';

type E = Pick<ToolAuditEntry, 'toolName' | 'result' | 'success' | 'failureKind'>;

function failed(toolName: string, result: string, over: Partial<E> = {}): E {
  return { toolName, result, success: false, ...over };
}

describe('classifyFailure', () => {
  test('a missing file is file-not-found', () => {
    expect(
      classifyFailure(failed('file_read', 'File not found: /app/productions/default/x.md'))
    ).toEqual({
      key: 'file_read:file-not-found',
      tool: 'file_read',
      errorClass: 'file-not-found',
    });
  });

  test('reading a directory is read-a-directory', () => {
    const cls = classifyFailure(
      failed('file_read', 'Failed to read file: Directories cannot be read like files')
    );
    expect(cls?.errorClass).toBe('read-a-directory');
  });

  test('a 404 page is guessed-url', () => {
    const cls = classifyFailure(
      failed(
        'web_fetch',
        'Page does not exist (404 Not Found). Only fetch URLs that appeared in search results.'
      )
    );
    expect(cls?.key).toBe('web_fetch:guessed-url');
  });

  test('failureKind not-found is guessed-url whatever the text', () => {
    const cls = classifyFailure(failed('web_fetch', 'Gone.', { failureKind: 'not-found' }));
    expect(cls?.errorClass).toBe('guessed-url');
  });

  test('a 500 is server-error', () => {
    expect(
      classifyFailure(failed('web_fetch', 'Fetch failed: 500 Internal Server Error'))?.errorClass
    ).toBe('server-error');
  });

  test('a 5xx status with Server Error but no "Fetch failed" prefix is server-error', () => {
    expect(classifyFailure(failed('web_fetch', 'Upstream said 502 Server Error'))?.errorClass).toBe(
      'server-error'
    );
  });

  test('a long task note is note-too-long', () => {
    expect(
      classifyFailure(failed('manage_goals', 'A note is longer than 200 characters.'))?.errorClass
    ).toBe('note-too-long');
  });

  test('a claimed task is task-claimed', () => {
    expect(
      classifyFailure(
        failed('manage_goals', 'Task t-1a2b3c is being worked on by run wr-9f8e7d6c.')
      )?.errorClass
    ).toBe('task-claimed');
  });

  test('an oversized value is value-too-long', () => {
    expect(
      classifyFailure(
        failed('save_memory', 'Failed to save memory: value is 812 characters, the limit is 500.')
      )?.errorClass
    ).toBe('value-too-long');
  });

  test('anything else is other:<slug> without digits', () => {
    expect(
      classifyFailure(failed('exec', 'Command timed out after 30000 ms: npm run build --watch'))
        ?.key
    ).toBe('exec:other:command-timed-out-after-ms-npm-run-bui');
  });

  test('numbers of different length do not split a class (digits go before the cut)', () => {
    const a = classifyFailure(failed('exec', 'Command timed out after 30000 ms: npm run build'));
    const b = classifyFailure(failed('exec', 'Command timed out after 3000000 ms: npm run build'));
    expect(a?.key).toBe(b?.key as string);
  });

  test('two errors that differ only in numbers share a class', () => {
    const a = classifyFailure(failed('exec', 'Rate limited, retry in 12 s'));
    const b = classifyFailure(failed('exec', 'Rate limited, retry in 7 s'));
    expect(a?.key).toBe(b?.key as string);
  });

  test('an empty result is other:empty', () => {
    expect(classifyFailure(failed('exec', ''))?.errorClass).toBe('other:empty');
  });

  test('a result with nothing alphanumeric left is other:empty', () => {
    expect(classifyFailure(failed('exec', '404 -- 500'))?.errorClass).toBe('other:empty');
  });

  test('a blocked call is not a failure', () => {
    expect(
      classifyFailure(
        failed('web_fetch', 'wiley.com blocks bots (Cloudflare bot challenge).', {
          failureKind: 'blocked',
        })
      )
    ).toBeNull();
  });

  test('a successful call is not a failure', () => {
    expect(
      classifyFailure({ toolName: 'file_read', result: 'File not found: x', success: true })
    ).toBeNull();
  });

  test('a scope refusal is not a failure', () => {
    expect(
      classifyFailure(
        failed('file_write', 'Write outside the task directory refused.', { failureKind: 'scope' })
      )
    ).toBeNull();
  });

  test('FAILURE_CLASSES lists every named class', () => {
    expect([...FAILURE_CLASSES]).toEqual([
      'file-not-found',
      'read-a-directory',
      'guessed-url',
      'server-error',
      'note-too-long',
      'task-claimed',
      'value-too-long',
    ]);
  });
});
