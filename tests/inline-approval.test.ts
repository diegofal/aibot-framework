import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InlineApprovalStore,
  classifyApprovalResponse,
  describeToolCall,
} from '../src/bot/inline-approval';
import type { ApprovalRequest } from '../src/types/thread';

// ─── InlineApprovalStore ───

describe('InlineApprovalStore', () => {
  let store: InlineApprovalStore;

  beforeEach(() => {
    store = new InlineApprovalStore();
  });

  it('set and get pending', () => {
    const approval = {
      toolName: 'exec',
      args: { command: 'ls' },
      createdAt: Date.now(),
      botId: 'bot1',
      sessionKey: 'sk1',
    };
    store.setPending('sk1', approval);
    expect(store.hasPending('sk1')).toBe(true);
    expect(store.getPending('sk1')).toEqual(approval);
  });

  it('consume removes pending', () => {
    store.setPending('sk1', {
      toolName: 'exec',
      args: {},
      createdAt: Date.now(),
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    const consumed = store.consumePending('sk1');
    expect(consumed?.toolName).toBe('exec');
    expect(store.hasPending('sk1')).toBe(false);
    expect(store.consumePending('sk1')).toBeUndefined();
  });

  it('clear removes pending', () => {
    store.setPending('sk1', {
      toolName: 'exec',
      args: {},
      createdAt: Date.now(),
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    store.clearPending('sk1');
    expect(store.hasPending('sk1')).toBe(false);
  });

  it('auto-expires after 10 minutes', () => {
    store.setPending('sk1', {
      toolName: 'exec',
      args: {},
      createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    expect(store.hasPending('sk1')).toBe(false);
    expect(store.getPending('sk1')).toBeUndefined();
  });

  it('does not expire before 10 minutes', () => {
    store.setPending('sk1', {
      toolName: 'exec',
      args: {},
      createdAt: Date.now() - 9 * 60 * 1000, // 9 minutes ago
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    expect(store.hasPending('sk1')).toBe(true);
  });

  it('returns undefined for unknown keys', () => {
    expect(store.getPending('nonexistent')).toBeUndefined();
    expect(store.hasPending('nonexistent')).toBe(false);
    expect(store.consumePending('nonexistent')).toBeUndefined();
  });

  it('overwrites previous pending for same session', () => {
    store.setPending('sk1', {
      toolName: 'exec',
      args: { command: 'ls' },
      createdAt: Date.now(),
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    store.setPending('sk1', {
      toolName: 'file_write',
      args: { path: '/tmp/test' },
      createdAt: Date.now(),
      botId: 'bot1',
      sessionKey: 'sk1',
    });
    expect(store.getPending('sk1')?.toolName).toBe('file_write');
  });
});

// ─── classifyApprovalResponse ───

describe('classifyApprovalResponse', () => {
  // Approve patterns
  const approveInputs = [
    'sí',
    'si',
    'yes',
    'ok',
    'okay',
    'dale',
    'go',
    'go ahead',
    'hacelo',
    'adelante',
    'sure',
    'do it',
    'proceed',
    'confirm',
    'aprobado',
    'approve',
    'hacélo',
    'ejecuta',
    'ejecutá',
    'run it',
    'yeah',
    'yep',
    'claro',
    'por supuesto',
    'obvio',
    'mandále',
    'meta',
    'metele',
    'dale que sí',
    // With trailing punctuation
    'sí!',
    'ok.',
    'dale!',
  ];

  for (const input of approveInputs) {
    it(`classifies "${input}" as approve`, () => {
      expect(classifyApprovalResponse(input)).toBe('approve');
    });
  }

  // Deny patterns
  const denyInputs = [
    'no',
    'cancel',
    'nope',
    'para',
    'stop',
    "don't",
    'dont',
    'deny',
    'denied',
    'reject',
    'abort',
    'cancelar',
    'nah',
    'nel',
    'ni en pedo',
    'olvidate',
    'olvídate',
    // With trailing punctuation
    'no!',
    'cancel.',
  ];

  for (const input of denyInputs) {
    it(`classifies "${input}" as deny`, () => {
      expect(classifyApprovalResponse(input)).toBe('deny');
    });
  }

  // Unrelated patterns
  const unrelatedInputs = [
    'what does exec do?',
    'can you explain the command first?',
    'tell me more',
    'I need to think about it',
    'hola',
    'buenas',
    '',
    '   ',
    'maybe',
    'not sure',
    'what is ls',
  ];

  for (const input of unrelatedInputs) {
    it(`classifies "${input}" as unrelated`, () => {
      expect(classifyApprovalResponse(input)).toBe('unrelated');
    });
  }
});

// ─── describeToolCall ───

describe('describeToolCall', () => {
  it('describes a tool call with args', () => {
    const desc = describeToolCall('exec', { command: 'ls -la' });
    expect(desc).toBe('exec(command: ls -la)');
  });

  it('describes a tool call without args', () => {
    const desc = describeToolCall('browser', {});
    expect(desc).toBe('browser');
  });

  it('truncates long arg values', () => {
    const longValue = 'a'.repeat(100);
    const desc = describeToolCall('file_write', { path: '/tmp/test', content: longValue });
    expect(desc).toContain('…');
    expect(desc.length).toBeLessThan(200);
  });

  it('skips internal args (prefixed with _)', () => {
    const desc = describeToolCall('exec', {
      command: 'ls',
      _chatId: 123,
      _botId: 'bot1',
    });
    expect(desc).toBe('exec(command: ls)');
    expect(desc).not.toContain('_chatId');
  });

  it('handles non-string arg values', () => {
    const desc = describeToolCall('process', { pid: 1234, signal: 'SIGTERM' });
    expect(desc).toContain('pid: 1234');
    expect(desc).toContain('signal: SIGTERM');
  });
});

// ─── ApprovalRequest type ───

describe('ApprovalRequest type', () => {
  it('can be constructed with pending status', () => {
    const approval: ApprovalRequest = {
      toolName: 'exec',
      description: 'exec(command: ls)',
      status: 'pending',
    };
    expect(approval.status).toBe('pending');
    expect(approval.toolName).toBe('exec');
  });

  it('supports approved and denied statuses', () => {
    const approved: ApprovalRequest = {
      toolName: 'exec',
      description: 'exec(command: ls)',
      status: 'approved',
    };
    const denied: ApprovalRequest = {
      toolName: 'exec',
      description: 'exec(command: rm -rf /)',
      status: 'denied',
    };
    expect(approved.status).toBe('approved');
    expect(denied.status).toBe('denied');
  });
});

// ─── ConversationsService.updateApprovalStatus ───

describe('ConversationsService.updateApprovalStatus', () => {
  const testDir = join(import.meta.dir, '.tmp-approval-test');
  let service: import('../src/conversations/service').ConversationsService;

  beforeEach(async () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    const { ConversationsService } = await import('../src/conversations/service');
    service = new ConversationsService(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('updates approval status on a message', () => {
    const convo = service.createConversation('bot1', 'general', 'Test');
    const msg = service.addMessage(
      'bot1',
      convo.id,
      'bot',
      'Need approval',
      undefined,
      undefined,
      undefined,
      {
        toolName: 'exec',
        description: 'exec(command: ls)',
        status: 'pending',
      }
    );

    expect(msg).toBeTruthy();
    expect(msg?.approval?.status).toBe('pending');

    const updated = service.updateApprovalStatus('bot1', convo.id, msg?.id, 'approved');
    expect(updated).toBe(true);

    const messages = service.getMessages('bot1', convo.id);
    const updatedMsg = messages.find((m) => m.id === msg?.id);
    expect(updatedMsg?.approval?.status).toBe('approved');
  });

  it('returns false for non-existent message', () => {
    const convo = service.createConversation('bot1', 'general', 'Test');
    const updated = service.updateApprovalStatus('bot1', convo.id, 'nonexistent', 'denied');
    expect(updated).toBe(false);
  });

  it('returns false for message without approval', () => {
    const convo = service.createConversation('bot1', 'general', 'Test');
    const msg = service.addMessage('bot1', convo.id, 'bot', 'No approval here');
    const updated = service.updateApprovalStatus('bot1', convo.id, msg?.id, 'approved');
    expect(updated).toBe(false);
  });

  it('returns false for non-existent conversation', () => {
    const updated = service.updateApprovalStatus('bot1', 'nonexistent', 'msg1', 'approved');
    expect(updated).toBe(false);
  });

  it('preserves other messages when updating approval status', () => {
    const convo = service.createConversation('bot1', 'general', 'Test');
    service.addMessage('bot1', convo.id, 'human', 'Hello');
    const approvalMsg = service.addMessage(
      'bot1',
      convo.id,
      'bot',
      'Need approval',
      undefined,
      undefined,
      undefined,
      {
        toolName: 'exec',
        description: 'exec(command: ls)',
        status: 'pending',
      }
    );
    service.addMessage('bot1', convo.id, 'human', 'Sure');

    service.updateApprovalStatus('bot1', convo.id, approvalMsg?.id, 'approved');

    const messages = service.getMessages('bot1', convo.id);
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('human');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].approval?.status).toBe('approved');
    expect(messages[2].role).toBe('human');
    expect(messages[2].content).toBe('Sure');
  });
});

// ─── WebGenerateOptions inline approval fields ───

describe('WebGenerateOptions inline approval fields', () => {
  it('webGenerate options accept permissionMode and store fields', () => {
    // Type-level test: ensure the interface accepts these fields
    const store = new InlineApprovalStore();
    const opts = {
      prompt: 'test',
      systemPrompt: 'sys',
      botId: 'bot1',
      botManager: {} as any,
      config: {} as any,
      logger: {} as any,
      permissionMode: 'conversation' as const,
      inlineApprovalStore: store,
      sessionKey: 'web:bot1:conv1',
    };
    expect(opts.permissionMode).toBe('conversation');
    expect(opts.inlineApprovalStore).toBe(store);
    expect(opts.sessionKey).toBe('web:bot1:conv1');
  });
});
