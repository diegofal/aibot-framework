import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CollaborationSessionManager } from '../src/collaboration-session';

describe('CollaborationSessionManager', () => {
  let manager: CollaborationSessionManager;

  beforeEach(() => {
    manager = new CollaborationSessionManager(200); // 200ms TTL for fast tests
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('create', () => {
    test('creates a session with unique id', () => {
      const session = manager.create('botA', 'botB');
      expect(session.id).toBeDefined();
      expect(session.id.length).toBe(8);
      expect(session.sourceBotId).toBe('botA');
      expect(session.targetBotId).toBe('botB');
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActivityAt).toBe(session.createdAt);
    });

    test('creates unique ids for different sessions', () => {
      const s1 = manager.create('botA', 'botB');
      const s2 = manager.create('botA', 'botC');
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('get', () => {
    test('retrieves existing session by id', () => {
      const created = manager.create('botA', 'botB');
      const retrieved = manager.get(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    test('returns undefined for non-existent session', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });
  });

  describe('appendMessages', () => {
    test('appends messages to existing session', () => {
      const session = manager.create('botA', 'botB');
      manager.appendMessages(session.id, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);

      const updated = manager.get(session.id)!;
      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[0].content).toBe('hello');
      expect(updated.messages[1].content).toBe('hi');
    });

    test('updates lastActivityAt on append', async () => {
      const session = manager.create('botA', 'botB');
      const originalActivity = session.lastActivityAt;

      await Bun.sleep(10);
      manager.appendMessages(session.id, [{ role: 'user', content: 'msg' }]);

      const updated = manager.get(session.id)!;
      expect(updated.lastActivityAt).toBeGreaterThan(originalActivity);
    });

    test('does nothing for non-existent session', () => {
      // Should not throw
      manager.appendMessages('nonexistent', [{ role: 'user', content: 'msg' }]);
    });
  });

  describe('end', () => {
    test('removes session by id', () => {
      const session = manager.create('botA', 'botB');
      expect(manager.get(session.id)).toBeDefined();

      manager.end(session.id);
      expect(manager.get(session.id)).toBeUndefined();
    });

    test('does nothing for non-existent session', () => {
      // Should not throw
      manager.end('nonexistent');
    });
  });

  describe('sweep', () => {
    test('removes expired sessions', async () => {
      const s1 = manager.create('botA', 'botB');

      await Bun.sleep(250); // exceed 200ms TTL

      const s2 = manager.create('botA', 'botC'); // fresh

      manager.sweep();

      expect(manager.get(s1.id)).toBeUndefined();
      expect(manager.get(s2.id)).toBeDefined();
    });

    test('keeps active sessions', () => {
      const session = manager.create('botA', 'botB');
      manager.sweep(); // immediate sweep — session is fresh
      expect(manager.get(session.id)).toBeDefined();
    });
  });

  describe('dispose', () => {
    test('clears all sessions and stops timer', () => {
      const session = manager.create('botA', 'botB');
      manager.dispose();
      expect(manager.get(session.id)).toBeUndefined();
    });

    test('can be called multiple times safely', () => {
      manager.dispose();
      manager.dispose(); // should not throw
    });
  });
});
