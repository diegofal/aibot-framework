import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationsService } from '../src/conversations/service';

const TEST_DIR = join(import.meta.dir, '.tmp-conversations-test');

function makeService(): ConversationsService {
  return new ConversationsService(TEST_DIR);
}

describe('ConversationsService', () => {
  let svc: ConversationsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    svc = makeService();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('createConversation', () => {
    test('creates a general conversation with default title', () => {
      const convo = svc.createConversation('bot1');
      expect(convo.id).toBeTruthy();
      expect(convo.botId).toBe('bot1');
      expect(convo.type).toBe('general');
      expect(convo.title).toBe('New Conversation');
      expect(convo.messageCount).toBe(0);
      expect(convo.createdAt).toBeTruthy();
      expect(convo.updatedAt).toBeTruthy();
    });

    test('creates a productions conversation with custom title', () => {
      const convo = svc.createConversation('bot1', 'productions', 'My Chat');
      expect(convo.type).toBe('productions');
      expect(convo.title).toBe('My Chat');
    });

    test('defaults title for productions type', () => {
      const convo = svc.createConversation('bot1', 'productions');
      expect(convo.title).toBe('Productions Chat');
    });
  });

  describe('listConversations', () => {
    test('returns empty for unknown bot', () => {
      expect(svc.listConversations('unknown')).toEqual([]);
    });

    test('lists conversations sorted by updatedAt desc', async () => {
      const c1 = svc.createConversation('bot1', 'general', 'First');
      // Small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
      const c2 = svc.createConversation('bot1', 'general', 'Second');
      await new Promise((r) => setTimeout(r, 5));
      svc.addMessage('bot1', c2.id, 'human', 'bump');
      const list = svc.listConversations('bot1');
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(c2.id);
      expect(list[1].id).toBe(c1.id);
    });

    test('filters by type', () => {
      svc.createConversation('bot1', 'general', 'Gen');
      svc.createConversation('bot1', 'productions', 'Prod');
      const general = svc.listConversations('bot1', { type: 'general' });
      expect(general.length).toBe(1);
      expect(general[0].title).toBe('Gen');

      const prods = svc.listConversations('bot1', { type: 'productions' });
      expect(prods.length).toBe(1);
      expect(prods[0].title).toBe('Prod');
    });

    test('supports limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        svc.createConversation('bot1', 'general', `Conv ${i}`);
      }
      const page = svc.listConversations('bot1', { limit: 2, offset: 1 });
      expect(page.length).toBe(2);
    });
  });

  describe('getConversation', () => {
    test('returns null for non-existent', () => {
      expect(svc.getConversation('bot1', 'nope')).toBeNull();
    });

    test('returns the conversation by id', () => {
      const created = svc.createConversation('bot1');
      const found = svc.getConversation('bot1', created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });
  });

  describe('updateTitle', () => {
    test('updates title and updatedAt', () => {
      const created = svc.createConversation('bot1');
      const updated = svc.updateTitle('bot1', created.id, 'Renamed');
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Renamed');
    });

    test('returns null for non-existent conversation', () => {
      expect(svc.updateTitle('bot1', 'nope', 'X')).toBeNull();
    });
  });

  describe('deleteConversation', () => {
    test('deletes conversation and messages', () => {
      const convo = svc.createConversation('bot1');
      svc.addMessage('bot1', convo.id, 'human', 'Hello');
      expect(svc.deleteConversation('bot1', convo.id)).toBe(true);
      expect(svc.getConversation('bot1', convo.id)).toBeNull();
      expect(svc.getMessages('bot1', convo.id)).toEqual([]);
    });

    test('returns false for non-existent', () => {
      expect(svc.deleteConversation('bot1', 'nope')).toBe(false);
    });
  });

  describe('addMessage + getMessages', () => {
    test('adds messages and increments count', () => {
      const convo = svc.createConversation('bot1');
      const msg = svc.addMessage('bot1', convo.id, 'human', 'Hello');
      expect(msg).not.toBeNull();
      expect(msg!.role).toBe('human');
      expect(msg!.content).toBe('Hello');

      const messages = svc.getMessages('bot1', convo.id);
      expect(messages.length).toBe(1);

      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.messageCount).toBe(1);
    });

    test('returns null when conversation does not exist', () => {
      expect(svc.addMessage('bot1', 'nope', 'human', 'hi')).toBeNull();
    });

    test('supports limit on getMessages', () => {
      const convo = svc.createConversation('bot1');
      for (let i = 0; i < 10; i++) {
        svc.addMessage('bot1', convo.id, 'human', `msg ${i}`);
      }
      const last5 = svc.getMessages('bot1', convo.id, { limit: 5 });
      expect(last5.length).toBe(5);
      expect(last5[0].content).toBe('msg 5');
    });

    test('returns empty for missing messages file', () => {
      expect(svc.getMessages('bot1', 'nope')).toEqual([]);
    });
  });

  describe('auto-title on first message', () => {
    test('sets title from first human message', () => {
      const convo = svc.createConversation('bot1');
      svc.addMessage('bot1', convo.id, 'human', 'What are your current goals and motivations?');
      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.title).toBe('What are your current goals and motivations?');
    });

    test('truncates long messages at word boundary', () => {
      const convo = svc.createConversation('bot1');
      const longMsg = 'This is a very long message that should be truncated at a word boundary because it exceeds sixty characters';
      svc.addMessage('bot1', convo.id, 'human', longMsg);
      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.title.length).toBeLessThanOrEqual(63); // 60 + '...'
      expect(updated!.title.endsWith('...')).toBe(true);
    });

    test('does not overwrite custom title', () => {
      const convo = svc.createConversation('bot1', 'general', 'Custom Title');
      svc.addMessage('bot1', convo.id, 'human', 'Hello there');
      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.title).toBe('Custom Title');
    });

    test('does not update title on bot messages', () => {
      const convo = svc.createConversation('bot1');
      svc.addMessage('bot1', convo.id, 'bot', 'Hello from bot');
      // messageCount is 1 but role is bot, so title should not change
      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.title).toBe('New Conversation');
    });
  });

  describe('inbox type', () => {
    test('creates inbox conversation with default title', () => {
      const convo = svc.createConversation('bot1', 'inbox');
      expect(convo.type).toBe('inbox');
      expect(convo.title).toBe('Inbox Question');
    });

    test('creates inbox conversation with metadata', () => {
      const convo = svc.createConversation('bot1', 'inbox', 'What should I do?', {
        askHumanQuestionId: 'q-123',
        inboxStatus: 'pending',
      });
      expect(convo.type).toBe('inbox');
      expect(convo.title).toBe('What should I do?');
      expect(convo.askHumanQuestionId).toBe('q-123');
      expect(convo.inboxStatus).toBe('pending');
    });

    test('filters inbox type in listConversations', () => {
      svc.createConversation('bot1', 'general', 'Gen');
      svc.createConversation('bot1', 'inbox', 'Q1', { inboxStatus: 'pending' });
      svc.createConversation('bot1', 'inbox', 'Q2', { inboxStatus: 'answered' });

      const inbox = svc.listConversations('bot1', { type: 'inbox' });
      expect(inbox.length).toBe(2);
      expect(inbox.every((c) => c.type === 'inbox')).toBe(true);
    });

    test('auto-titles inbox from first human message', () => {
      const convo = svc.createConversation('bot1', 'inbox');
      svc.addMessage('bot1', convo.id, 'human', 'My custom response');
      const updated = svc.getConversation('bot1', convo.id);
      expect(updated!.title).toBe('My custom response');
    });
  });

  describe('markInboxStatus', () => {
    test('updates inbox status', () => {
      const convo = svc.createConversation('bot1', 'inbox', 'Q', { inboxStatus: 'pending' });
      const updated = svc.markInboxStatus('bot1', convo.id, 'answered');
      expect(updated).not.toBeNull();
      expect(updated!.inboxStatus).toBe('answered');

      // Verify persistence
      const reloaded = svc.getConversation('bot1', convo.id);
      expect(reloaded!.inboxStatus).toBe('answered');
    });

    test('returns null for non-existent conversation', () => {
      expect(svc.markInboxStatus('bot1', 'nope', 'answered')).toBeNull();
    });
  });

  describe('countByInboxStatus', () => {
    test('counts inbox conversations by status', () => {
      svc.createConversation('bot1', 'inbox', 'Q1', { inboxStatus: 'pending' });
      svc.createConversation('bot1', 'inbox', 'Q2', { inboxStatus: 'pending' });
      svc.createConversation('bot1', 'inbox', 'Q3', { inboxStatus: 'answered' });
      svc.createConversation('bot1', 'general', 'Gen'); // not inbox

      expect(svc.countByInboxStatus('bot1', 'pending')).toBe(2);
      expect(svc.countByInboxStatus('bot1', 'answered')).toBe(1);
      expect(svc.countByInboxStatus('bot1', 'dismissed')).toBe(0);
    });

    test('returns 0 for unknown bot', () => {
      expect(svc.countByInboxStatus('unknown', 'pending')).toBe(0);
    });
  });

  describe('findByQuestionId', () => {
    test('finds conversation by askHumanQuestionId', () => {
      svc.createConversation('bot1', 'inbox', 'Q1', { askHumanQuestionId: 'q-abc' });
      svc.createConversation('bot1', 'inbox', 'Q2', { askHumanQuestionId: 'q-def' });

      const found = svc.findByQuestionId('bot1', 'q-abc');
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Q1');
      expect(found!.askHumanQuestionId).toBe('q-abc');
    });

    test('returns null when not found', () => {
      expect(svc.findByQuestionId('bot1', 'nope')).toBeNull();
    });
  });

  describe('getBotIds', () => {
    test('returns empty when base dir does not exist', () => {
      const fresh = new ConversationsService('/tmp/nonexistent-convos-test');
      expect(fresh.getBotIds()).toEqual([]);
    });

    test('returns bot directories', () => {
      svc.createConversation('bot1');
      svc.createConversation('bot2');
      const ids = svc.getBotIds();
      expect(ids).toContain('bot1');
      expect(ids).toContain('bot2');
    });
  });
});
