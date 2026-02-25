import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MediaHandler, MediaError } from '../src/media';
import type { MediaConfig } from '../src/config';

const originalFetch = globalThis.fetch;

function mockLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => mockLogger(),
    level: 'debug',
    fatal: mock(() => {}),
  } as any;
}

function makeConfig(overrides: Partial<MediaConfig> = {}): MediaConfig {
  return {
    enabled: true,
    maxFileSizeMb: 10,
    whisper: {
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      timeout: 60_000,
    },
    ...overrides,
  };
}

/** Tiny OGG-like buffer for download mock */
const FAKE_AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);

describe('MediaHandler.processVoice', () => {
  let handler: MediaHandler;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve(new Response('should not reach')));
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Helper: sets up fetch mock that handles both the download call (first)
   * and the whisper call (second) based on URL matching.
   */
  function setupFetchMock(opts: {
    whisperResponse?: object;
    whisperStatus?: number;
    downloadBuffer?: Uint8Array;
    downloadStatus?: number;
    whisperAbort?: boolean;
  } = {}) {
    const {
      whisperResponse = { text: 'hello world' },
      whisperStatus = 200,
      downloadBuffer = FAKE_AUDIO,
      downloadStatus = 200,
      whisperAbort = false,
    } = opts;

    fetchMock.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // Whisper endpoint
      if (urlStr.includes('audio/transcriptions') || urlStr.includes('whisper')) {
        if (whisperAbort) {
          return new Promise((_, reject) => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
        return Promise.resolve(new Response(JSON.stringify(whisperResponse), {
          status: whisperStatus,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Download (file URL)
      if (downloadStatus !== 200) {
        return Promise.resolve(new Response('error', { status: downloadStatus }));
      }
      return Promise.resolve(new Response(downloadBuffer, { status: 200 }));
    });
  }

  test('successful transcription returns text and sessionText', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'hola mundo' } });

    const result = await handler.processVoice('https://tg.file/voice.ogg', 5);

    expect(result.text).toBe('hola mundo');
    expect(result.sessionText).toBe('[Voice: 5s] hola mundo');
    // Two fetches: download + whisper
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('sessionText includes duration when provided', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'test' } });

    const result = await handler.processVoice('https://tg.file/voice.ogg', 12);

    expect(result.sessionText).toBe('[Voice: 12s] test');
  });

  test('sessionText shows "unknown" when duration is undefined', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'test' } });

    const result = await handler.processVoice('https://tg.file/voice.ogg');

    expect(result.sessionText).toBe('[Voice: unknown] test');
  });

  test('sends language hint in formData when configured', async () => {
    const config = makeConfig({
      whisper: {
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        language: 'es',
        timeout: 60_000,
      },
    });
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'hola' } });

    await handler.processVoice('https://tg.file/voice.ogg', 3);

    // The second call is to whisper — inspect its body (FormData)
    const whisperCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes('audio/transcriptions'),
    );
    expect(whisperCall).toBeDefined();
    const body = whisperCall![1]?.body as FormData;
    expect(body.get('language')).toBe('es');
  });

  test('does not send language when not configured', async () => {
    const config = makeConfig(); // no language in default whisper config
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'hello' } });

    await handler.processVoice('https://tg.file/voice.ogg', 3);

    const whisperCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes('audio/transcriptions'),
    );
    const body = whisperCall![1]?.body as FormData;
    expect(body.get('language')).toBeNull();
  });

  test('sends Authorization Bearer header when apiKey is configured', async () => {
    const config = makeConfig({
      whisper: {
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        timeout: 60_000,
        apiKey: 'sk-test-key-123',
      },
    });
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'hello' } });

    await handler.processVoice('https://tg.file/voice.ogg', 5);

    const whisperCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes('audio/transcriptions'),
    );
    expect(whisperCall).toBeDefined();
    const headers = whisperCall![1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key-123');
  });

  test('does not send Authorization header when apiKey is not configured', async () => {
    const config = makeConfig(); // no apiKey in default config
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: 'hello' } });

    await handler.processVoice('https://tg.file/voice.ogg', 5);

    const whisperCall = fetchMock.mock.calls.find(
      (c: any[]) => String(c[0]).includes('audio/transcriptions'),
    );
    expect(whisperCall).toBeDefined();
    const headers = whisperCall![1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  test('throws MediaError when whisper is not configured', async () => {
    const config = makeConfig({ whisper: undefined });
    handler = new MediaHandler(config, mockLogger());

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow(MediaError);

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow('not configured');
  });

  test('throws MediaError on HTTP error from whisper', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperStatus: 429 });

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow('HTTP 429');
  });

  test('throws MediaError on empty transcription', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperResponse: { text: '   ' } });

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow('empty result');
  });

  test('throws MediaError on whisper timeout', async () => {
    const config = makeConfig({
      whisper: {
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        timeout: 1, // 1ms — will abort immediately
      },
    });
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ whisperAbort: true });

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow('timed out');
  });

  test('throws MediaError when download fails with HTTP error', async () => {
    const config = makeConfig();
    handler = new MediaHandler(config, mockLogger());
    setupFetchMock({ downloadStatus: 404 });

    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5),
    ).rejects.toThrow('HTTP 404');
  });

  test('throws MediaError when file is too large (pre-check)', async () => {
    const config = makeConfig({ maxFileSizeMb: 1 }); // 1 MB limit
    handler = new MediaHandler(config, mockLogger());

    const twoMb = 2 * 1024 * 1024;
    await expect(
      handler.processVoice('https://tg.file/voice.ogg', 5, twoMb),
    ).rejects.toThrow('too large');
  });
});
