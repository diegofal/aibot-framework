import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationsService } from '../src/conversations/service';

const TEST_DIR = join(import.meta.dir, '.tmp-doc-attachments-test');

describe('Document attachments in ConversationsService', () => {
  let svc: ConversationsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    svc = new ConversationsService(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('addMessage stores documents metadata', () => {
    const convo = svc.createConversation('bot1');
    const msg = svc.addMessage('bot1', convo.id, 'human', 'Check this file', undefined, undefined, [
      { name: 'report.pdf', mimeType: 'application/pdf', size: 12345 },
    ]);

    expect(msg).not.toBeNull();
    expect(msg?.documents).toHaveLength(1);
    expect(msg?.documents?.[0].name).toBe('report.pdf');
    expect(msg?.documents?.[0].mimeType).toBe('application/pdf');
    expect(msg?.documents?.[0].size).toBe(12345);
  });

  test('documents persist through getMessages', () => {
    const convo = svc.createConversation('bot1');
    svc.addMessage('bot1', convo.id, 'human', 'Here is a doc', undefined, undefined, [
      { name: 'notes.txt', mimeType: 'text/plain', size: 500 },
      { name: 'data.csv', mimeType: 'text/csv', size: 1024 },
    ]);

    const messages = svc.getMessages('bot1', convo.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].documents).toHaveLength(2);
    expect(messages[0].documents?.[0].name).toBe('notes.txt');
    expect(messages[0].documents?.[1].name).toBe('data.csv');
  });

  test('message without documents does not include documents field', () => {
    const convo = svc.createConversation('bot1');
    const msg = svc.addMessage('bot1', convo.id, 'human', 'Plain message');

    expect(msg?.documents).toBeUndefined();

    const messages = svc.getMessages('bot1', convo.id);
    expect(messages[0].documents).toBeUndefined();
  });

  test('empty documents array is not stored', () => {
    const convo = svc.createConversation('bot1');
    const msg = svc.addMessage('bot1', convo.id, 'human', 'No docs', undefined, undefined, []);

    expect(msg?.documents).toBeUndefined();
  });

  test('images and documents can coexist', () => {
    const convo = svc.createConversation('bot1');
    const msg = svc.addMessage(
      'bot1',
      convo.id,
      'human',
      'With both',
      undefined,
      ['base64imagedata'],
      [{ name: 'readme.md', mimeType: 'text/markdown', size: 200 }]
    );

    expect(msg?.images).toHaveLength(1);
    expect(msg?.documents).toHaveLength(1);

    const messages = svc.getMessages('bot1', convo.id);
    expect(messages[0].images).toHaveLength(1);
    expect(messages[0].documents).toHaveLength(1);
  });
});
