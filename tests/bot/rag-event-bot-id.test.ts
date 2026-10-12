import { describe, expect, mock, test } from 'bun:test';
import { ConversationPipeline } from '../../src/bot/conversation-pipeline';

const logger: any = { info() {}, warn() {}, debug() {}, error() {}, child: () => logger };

describe('RAG prefetch activity event', () => {
  test('carries the bot id, so the tenant-filtered socket can deliver it', async () => {
    const publish = mock(() => {});
    const ctx: any = {
      config: {
        soul: {
          search: { autoRag: { enabled: true, maxResults: 3, minScore: 0, maxContentChars: 2000 } },
        },
      },
      searchEnabled: true,
      memoryManager: {
        search: async () => [
          {
            filePath: 'memory/2020-01-01.md',
            content: 'Old fact about the operator',
            score: 0.9,
            sourceType: 'memory',
          },
        ],
      },
      activityStream: { publish },
      logger,
    };
    const pipeline = new ConversationPipeline(ctx, {} as any, {} as any, {} as any, {} as any);
    await pipeline.prefetchMemoryContext('what did we decide last time?', false, logger, 'bot-7');
    expect(publish).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0] as any[])[0]).toMatchObject({
      type: 'memory:rag',
      botId: 'bot-7',
    });
  });
});
