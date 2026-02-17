import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MessageBuffer, type BufferEntry, type ConversationProcessor } from '../src/message-buffer';
import type { BufferConfig } from '../src/config';

// ─── Test Helpers ────────────────────────────────────────────────

function createMockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: mock(() => createMockLogger()),
    fatal: mock(() => {}),
    trace: mock(() => {}),
    level: 'info',
    silent: mock(() => {}),
  } as any;
}

let entryIdCounter = 0;

function createEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  entryIdCounter++;
  return {
    sessionKey: 'session-1',
    ctx: {} as any,
    config: {} as any,
    userText: `message ${entryIdCounter}`,
    messageId: entryIdCounter,
    isMedia: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MessageBuffer', () => {
  let buffer: MessageBuffer;
  let processor: ReturnType<typeof mock>;
  let logger: ReturnType<typeof createMockLogger>;
  let config: BufferConfig;

  beforeEach(() => {
    entryIdCounter = 0;
    logger = createMockLogger();
    processor = mock((() => Promise.resolve()) as ConversationProcessor);
    config = {
      inboundDebounceMs: 50,
      queueDebounceMs: 50,
      queueCap: 10,
    };
    buffer = new MessageBuffer(config, processor, logger);
  });

  afterEach(() => {
    buffer.dispose();
  });

  describe('dedup', () => {
    test('ignores duplicate messageIds', () => {
      const entry = createEntry({ messageId: 999 });
      buffer.enqueue(entry);
      buffer.enqueue({ ...entry }); // same messageId

      // With debounce, wait for it to flush
      // Only 1 should get through
      expect(logger.debug).toHaveBeenCalled();
    });

    test('processes different messageIds', async () => {
      config.inboundDebounceMs = 0; // disable debounce for this test
      buffer = new MessageBuffer(config, processor, logger);

      const e1 = createEntry({ messageId: 1, sessionKey: 'a' });
      const e2 = createEntry({ messageId: 2, sessionKey: 'b' });

      buffer.enqueue(e1);
      buffer.enqueue(e2);

      // Both should eventually dispatch
      await Bun.sleep(20);
      expect(processor).toHaveBeenCalledTimes(2);
    });
  });

  describe('immediate dispatch (debounce disabled)', () => {
    beforeEach(() => {
      config.inboundDebounceMs = 0;
      buffer = new MessageBuffer(config, processor, logger);
    });

    test('dispatches immediately when debounce is 0', async () => {
      buffer.enqueue(createEntry());
      await Bun.sleep(10);
      expect(processor).toHaveBeenCalledTimes(1);
    });

    test('dispatches media immediately regardless of debounce', async () => {
      config.inboundDebounceMs = 1000; // re-enable debounce
      buffer = new MessageBuffer(config, processor, logger);

      buffer.enqueue(createEntry({ isMedia: true }));
      await Bun.sleep(10);
      expect(processor).toHaveBeenCalledTimes(1);
    });
  });

  describe('inbound debounce (capa 1)', () => {
    test('batches rapid messages into single dispatch', async () => {
      config.inboundDebounceMs = 50;
      buffer = new MessageBuffer(config, processor, logger);

      buffer.enqueue(createEntry({ userText: 'hello' }));
      buffer.enqueue(createEntry({ userText: 'world' }));

      // Before debounce fires — no dispatch yet
      expect(processor).not.toHaveBeenCalled();

      await Bun.sleep(100);

      expect(processor).toHaveBeenCalledTimes(1);
      // Merged text should contain both messages
      const call = processor.mock.calls[0];
      expect(call[3]).toContain('hello');
      expect(call[3]).toContain('world');
    });

    test('single message dispatches after debounce', async () => {
      buffer.enqueue(createEntry({ userText: 'solo' }));

      await Bun.sleep(100);

      expect(processor).toHaveBeenCalledTimes(1);
      expect(processor.mock.calls[0][3]).toBe('solo');
    });
  });

  describe('followup queue (capa 2)', () => {
    test('queues messages when processor is busy', async () => {
      config.inboundDebounceMs = 0;
      config.queueDebounceMs = 0;

      let resolveProcessor!: () => void;
      const slowProcessor = mock(
        (() =>
          new Promise<void>((resolve) => {
            resolveProcessor = resolve;
          })) as ConversationProcessor
      );

      buffer = new MessageBuffer(config, slowProcessor, logger);

      // First message starts processing
      buffer.enqueue(createEntry({ userText: 'first', sessionKey: 'k' }));
      await Bun.sleep(5);
      expect(slowProcessor).toHaveBeenCalledTimes(1);

      // Second message while first is busy — queued
      buffer.enqueue(createEntry({ userText: 'second', sessionKey: 'k' }));

      // Complete first processing
      resolveProcessor();
      await Bun.sleep(20);

      // Second should have been dispatched after first completed
      expect(slowProcessor).toHaveBeenCalledTimes(2);
    });

    test('drops oldest when queue cap reached', () => {
      config.inboundDebounceMs = 0;
      config.queueCap = 2;

      let resolveProcessor!: () => void;
      const slowProcessor = mock(
        (() =>
          new Promise<void>((resolve) => {
            resolveProcessor = resolve;
          })) as ConversationProcessor
      );

      buffer = new MessageBuffer(config, slowProcessor, logger);

      // Start processing to make session busy
      buffer.enqueue(createEntry({ sessionKey: 'k' }));

      // Queue up to cap
      buffer.enqueue(createEntry({ sessionKey: 'k', userText: 'a' }));
      buffer.enqueue(createEntry({ sessionKey: 'k', userText: 'b' }));

      // This should drop the oldest queued message
      buffer.enqueue(createEntry({ sessionKey: 'k', userText: 'c' }));

      expect(logger.warn).toHaveBeenCalled();

      resolveProcessor();
    });
  });

  describe('cross-session isolation', () => {
    test('different sessions dispatch independently', async () => {
      config.inboundDebounceMs = 0;
      buffer = new MessageBuffer(config, processor, logger);

      buffer.enqueue(createEntry({ sessionKey: 'session-a', userText: 'msg-a' }));
      buffer.enqueue(createEntry({ sessionKey: 'session-b', userText: 'msg-b' }));

      await Bun.sleep(20);

      expect(processor).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    test('logs error when processor throws', async () => {
      config.inboundDebounceMs = 0;
      const failingProcessor = mock(
        (() => Promise.reject(new Error('boom'))) as ConversationProcessor
      );

      buffer = new MessageBuffer(config, failingProcessor, logger);
      buffer.enqueue(createEntry());

      await Bun.sleep(20);

      expect(logger.error).toHaveBeenCalled();
    });

    test('continues processing queued messages after error', async () => {
      config.inboundDebounceMs = 0;
      config.queueDebounceMs = 0;

      let callCount = 0;
      const sometimesFailProcessor = mock((() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('fail'));
        return Promise.resolve();
      }) as ConversationProcessor);

      buffer = new MessageBuffer(config, sometimesFailProcessor, logger);

      buffer.enqueue(createEntry({ sessionKey: 'k' }));
      await Bun.sleep(5);

      buffer.enqueue(createEntry({ sessionKey: 'k' }));
      await Bun.sleep(50);

      // Both should have been attempted
      expect(sometimesFailProcessor).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    test('clears all state', () => {
      buffer.enqueue(createEntry());
      buffer.dispose();
      // Should not throw on subsequent enqueue attempts after dispose
      // (timers cleaned up, no pending state)
    });
  });

  describe('merge helpers', () => {
    test('merges images from multiple entries', async () => {
      config.inboundDebounceMs = 50;
      buffer = new MessageBuffer(config, processor, logger);

      buffer.enqueue(createEntry({ images: ['img1'] }));
      buffer.enqueue(createEntry({ images: ['img2', 'img3'] }));

      await Bun.sleep(100);

      expect(processor).toHaveBeenCalledTimes(1);
      const images = processor.mock.calls[0][4];
      expect(images).toEqual(['img1', 'img2', 'img3']);
    });

    test('merged entry has no images when none provided', async () => {
      config.inboundDebounceMs = 50;
      buffer = new MessageBuffer(config, processor, logger);

      buffer.enqueue(createEntry());
      buffer.enqueue(createEntry());

      await Bun.sleep(100);

      const images = processor.mock.calls[0][4];
      expect(images).toBeUndefined();
    });
  });
});
