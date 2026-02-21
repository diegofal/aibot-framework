import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFeedbackStore } from '../../src/bot/agent-feedback-store';
import type { Logger } from '../../src/logger';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('AgentFeedbackStore', () => {
  let store: AgentFeedbackStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `feedback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new AgentFeedbackStore(noopLogger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('submit', () => {
    test('creates a pending feedback entry', () => {
      store.loadFromDisk('bot1', tmpDir);
      const entry = store.submit('bot1', 'Focus more on creative writing');

      expect(entry.id).toBeTruthy();
      expect(entry.botId).toBe('bot1');
      expect(entry.content).toBe('Focus more on creative writing');
      expect(entry.status).toBe('pending');
      expect(entry.createdAt).toBeTruthy();
    });

    test('persists to JSONL file', () => {
      store.loadFromDisk('bot1', tmpDir);
      store.submit('bot1', 'Be more concise');

      const filePath = join(tmpDir, 'feedback.jsonl');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.content).toBe('Be more concise');
      expect(parsed.status).toBe('pending');
    });

    test('appends multiple entries', () => {
      store.loadFromDisk('bot1', tmpDir);
      store.submit('bot1', 'First feedback');
      store.submit('bot1', 'Second feedback');

      const filePath = join(tmpDir, 'feedback.jsonl');
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });
  });

  describe('getPending', () => {
    test('returns only pending entries', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Pending one');
      store.submit('bot1', 'Pending two');
      store.markApplied('bot1', f1.id, 'Applied it');

      const pending = store.getPending('bot1');
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe('Pending two');
    });

    test('returns empty for unknown bot', () => {
      expect(store.getPending('unknown')).toEqual([]);
    });
  });

  describe('getAll', () => {
    test('returns all entries sorted newest first', () => {
      store.loadFromDisk('bot1', tmpDir);
      store.submit('bot1', 'First');
      store.submit('bot1', 'Second');
      store.submit('bot1', 'Third');

      const all = store.getAll('bot1');
      expect(all).toHaveLength(3);
      // Newest first
      expect(all[0].content).toBe('Third');
    });

    test('filters by status', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Will apply');
      store.submit('bot1', 'Still pending');
      store.markApplied('bot1', f1.id, 'Done');

      const applied = store.getAll('bot1', { status: 'applied' });
      expect(applied).toHaveLength(1);
      expect(applied[0].content).toBe('Will apply');
    });

    test('respects limit and offset', () => {
      store.loadFromDisk('bot1', tmpDir);
      for (let i = 0; i < 5; i++) {
        store.submit('bot1', `Feedback ${i}`);
      }

      const page = store.getAll('bot1', { limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
    });
  });

  describe('markApplied', () => {
    test('sets status to applied with response', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Change tone');

      const updated = store.markApplied('bot1', f1.id, 'Updated soul to be more formal');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('applied');
      expect(updated!.response).toBe('Updated soul to be more formal');
      expect(updated!.appliedAt).toBeTruthy();
    });

    test('persists change to JSONL', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Test');
      store.markApplied('bot1', f1.id, 'Done');

      const filePath = join(tmpDir, 'feedback.jsonl');
      const line = readFileSync(filePath, 'utf-8').trim();
      const parsed = JSON.parse(line);
      expect(parsed.status).toBe('applied');
      expect(parsed.response).toBe('Done');
    });

    test('returns null for unknown id', () => {
      store.loadFromDisk('bot1', tmpDir);
      expect(store.markApplied('bot1', 'nonexistent', 'resp')).toBeNull();
    });

    test('returns null for unknown bot', () => {
      expect(store.markApplied('unknown', 'id', 'resp')).toBeNull();
    });
  });

  describe('dismiss', () => {
    test('sets status to dismissed', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Dismiss me');

      const result = store.dismiss('bot1', f1.id);
      expect(result).toBe(true);

      const all = store.getAll('bot1', { status: 'dismissed' });
      expect(all).toHaveLength(1);
    });

    test('returns false for already applied entry', () => {
      store.loadFromDisk('bot1', tmpDir);
      const f1 = store.submit('bot1', 'Applied');
      store.markApplied('bot1', f1.id, 'resp');

      expect(store.dismiss('bot1', f1.id)).toBe(false);
    });

    test('returns false for unknown id', () => {
      store.loadFromDisk('bot1', tmpDir);
      expect(store.dismiss('bot1', 'nonexistent')).toBe(false);
    });
  });

  describe('getPendingCount', () => {
    test('counts pending across all bots', () => {
      const tmpDir2 = join(tmpdir(), `feedback-test-2-${Date.now()}`);
      mkdirSync(tmpDir2, { recursive: true });

      store.loadFromDisk('bot1', tmpDir);
      store.loadFromDisk('bot2', tmpDir2);

      store.submit('bot1', 'One');
      store.submit('bot1', 'Two');
      store.submit('bot2', 'Three');

      expect(store.getPendingCount()).toBe(3);

      store.dismiss('bot1', store.getPending('bot1')[0].id);
      expect(store.getPendingCount()).toBe(2);

      rmSync(tmpDir2, { recursive: true, force: true });
    });
  });

  describe('loadFromDisk', () => {
    test('loads existing JSONL file', () => {
      store.loadFromDisk('bot1', tmpDir);
      store.submit('bot1', 'Persistent feedback');
      const f2 = store.submit('bot1', 'Another one');
      store.markApplied('bot1', f2.id, 'Done');

      // Create a new store and load
      const store2 = new AgentFeedbackStore(noopLogger);
      store2.loadFromDisk('bot1', tmpDir);

      const all = store2.getAll('bot1');
      expect(all).toHaveLength(2);

      const pending = store2.getPending('bot1');
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe('Persistent feedback');
    });

    test('handles missing file gracefully', () => {
      const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      store.loadFromDisk('bot1', emptyDir);
      expect(store.getAll('bot1')).toEqual([]);

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('getBotIds', () => {
    test('returns loaded bot IDs', () => {
      store.loadFromDisk('bot1', tmpDir);
      const tmpDir2 = join(tmpdir(), `feedback-test-3-${Date.now()}`);
      mkdirSync(tmpDir2, { recursive: true });
      store.loadFromDisk('bot2', tmpDir2);

      const ids = store.getBotIds();
      expect(ids).toContain('bot1');
      expect(ids).toContain('bot2');
      expect(ids).toHaveLength(2);

      rmSync(tmpDir2, { recursive: true, force: true });
    });
  });
});
