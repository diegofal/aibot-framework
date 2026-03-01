import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { resolveTtsConfig } from '../src/config';
import type { BotConfig, TtsConfig } from '../src/config';
import type { Logger } from '../src/logger';
import { generateSpeech, stripMarkdown, truncateText } from '../src/tts';

describe('TTS Module', () => {
  const createMockLogger = (): Logger =>
    ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      child: jest.fn().mockReturnThis(),
      bindings: () => ({}),
      flush: jest.fn(),
      level: 'info',
    }) as unknown as Logger;

  const createDefaultConfig = (overrides?: Partial<TtsConfig>): TtsConfig => ({
    provider: 'elevenlabs',
    apiKey: 'test-api-key',
    voiceId: 'test-voice-id',
    modelId: 'eleven_multilingual_v2',
    outputFormat: 'opus_48000_64',
    timeout: 30_000,
    maxTextLength: 1500,
    voiceSettings: {
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: true,
      speed: 1,
    },
    ...overrides,
  });

  describe('stripMarkdown', () => {
    it('should remove headers', () => {
      expect(stripMarkdown('# Hello\n## World')).toBe('Hello\nWorld');
    });

    it('should remove bold and italic markers', () => {
      expect(stripMarkdown('This is **bold** and *italic* text')).toBe(
        'This is bold and italic text'
      );
    });

    it('should remove inline code', () => {
      expect(stripMarkdown('Use `console.log()` here')).toBe('Use  here');
    });

    it('should remove code blocks', () => {
      expect(stripMarkdown('Before ```code block``` after')).toBe('Before  after');
    });

    it('should keep link labels and remove URLs', () => {
      expect(stripMarkdown('Check [this link](https://example.com) out')).toBe(
        'Check this link out'
      );
    });

    it('should keep image alt text', () => {
      expect(stripMarkdown('See ![alt text](image.png) here')).toBe('See alt text here');
    });

    it('should handle plain text unchanged', () => {
      expect(stripMarkdown('Just plain text')).toBe('Just plain text');
    });
  });

  describe('truncateText', () => {
    it('should not truncate text within limit', () => {
      expect(truncateText('Hello', 100)).toBe('Hello');
    });

    it('should truncate long text and add ellipsis', () => {
      const long = 'A'.repeat(200);
      const result = truncateText(long, 100);
      expect(result.length).toBe(100);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle text exactly at limit', () => {
      const text = 'A'.repeat(100);
      expect(truncateText(text, 100)).toBe(text);
    });
  });

  describe('generateSpeech', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should return audio buffer and latency on success', async () => {
      const fakeAudio = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OGG header bytes
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
      }) as any;

      const config = createDefaultConfig();
      const logger = createMockLogger();

      const result = await generateSpeech('Hello world', config, logger);

      expect(result.audioBuffer).toBeInstanceOf(Buffer);
      expect(result.audioBuffer.length).toBe(4);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should send correct headers', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({ apiKey: 'my-secret-key' });
      const logger = createMockLogger();

      await generateSpeech('Test', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const options = fetchCall[1];
      expect(options.headers['xi-api-key']).toBe('my-secret-key');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('should send voice settings in body', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({
        voiceSettings: {
          stability: 0.8,
          similarityBoost: 0.9,
          style: 0.3,
          useSpeakerBoost: false,
          speed: 1.2,
        },
      });
      const logger = createMockLogger();

      await generateSpeech('Test', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.voice_settings).toEqual({
        stability: 0.8,
        similarity_boost: 0.9,
        style: 0.3,
        use_speaker_boost: false,
        speed: 1.2,
      });
    });

    it('should send language code when configured', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({ languageCode: 'es' });
      const logger = createMockLogger();

      await generateSpeech('Hola mundo', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.language_code).toBe('es');
    });

    it('should not send language code when not configured', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig();
      const logger = createMockLogger();

      await generateSpeech('Hello', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.language_code).toBeUndefined();
    });

    it('should strip markdown from text before sending', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig();
      const logger = createMockLogger();

      await generateSpeech('# Hello **world**', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.text).toBe('Hello world');
    });

    it('should truncate long text', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({ maxTextLength: 50 });
      const logger = createMockLogger();

      const longText = 'A'.repeat(200);
      await generateSpeech(longText, config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.text.length).toBe(50);
      expect(body.text.endsWith('...')).toBe(true);
    });

    it('should throw on HTTP error', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }) as any;

      const config = createDefaultConfig();
      const logger = createMockLogger();

      await expect(generateSpeech('Test', config, logger)).rejects.toThrow(
        'ElevenLabs API error (401)'
      );
    });

    it('should throw on timeout', async () => {
      globalThis.fetch = jest.fn().mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      ) as any;

      const config = createDefaultConfig({ timeout: 50 }); // 50ms timeout
      const logger = createMockLogger();

      await expect(generateSpeech('Test', config, logger)).rejects.toThrow(
        'TTS timeout after 50ms'
      );
    });

    it('should use correct URL with voiceId and outputFormat', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({
        voiceId: 'my-voice',
        outputFormat: 'mp3_44100_128',
      });
      const logger = createMockLogger();

      await generateSpeech('Test', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).toBe(
        'https://api.elevenlabs.io/v1/text-to-speech/my-voice?output_format=mp3_44100_128'
      );
    });

    it('should send correct model_id in body', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }) as any;

      const config = createDefaultConfig({ modelId: 'eleven_turbo_v2_5' });
      const logger = createMockLogger();

      await generateSpeech('Test', config, logger);

      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model_id).toBe('eleven_turbo_v2_5');
    });

    it('should throw when text is empty after processing', async () => {
      const config = createDefaultConfig();
      const logger = createMockLogger();

      // Only markdown, stripped to empty
      await expect(generateSpeech('```code```', config, logger)).rejects.toThrow(
        'TTS: text is empty after processing'
      );
    });
  });

  describe('resolveTtsConfig', () => {
    const globalTts: TtsConfig = {
      provider: 'elevenlabs',
      apiKey: 'global-api-key',
      voiceId: 'global-voice',
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'opus_48000_64',
      timeout: 30_000,
      maxTextLength: 1500,
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
    };

    const makeBotConfig = (tts?: BotConfig['tts']): BotConfig =>
      ({
        id: 'test-bot',
        name: 'TestBot',
        skills: [],
        tts,
      }) as unknown as BotConfig;

    it('should return global config unchanged when no bot override', () => {
      const result = resolveTtsConfig(globalTts, makeBotConfig());
      expect(result).toEqual(globalTts);
    });

    it('should override voiceId only, rest from global', () => {
      const result = resolveTtsConfig(globalTts, makeBotConfig({ voiceId: 'bot-voice' }));
      expect(result.voiceId).toBe('bot-voice');
      expect(result.modelId).toBe('eleven_multilingual_v2');
      expect(result.apiKey).toBe('global-api-key');
      expect(result.provider).toBe('elevenlabs');
      expect(result.voiceSettings.stability).toBe(0.5);
    });

    it('should merge voiceSettings partially with global defaults', () => {
      const result = resolveTtsConfig(
        globalTts,
        makeBotConfig({
          voiceSettings: { stability: 0.9, speed: 1.5 },
        })
      );
      expect(result.voiceSettings.stability).toBe(0.9);
      expect(result.voiceSettings.speed).toBe(1.5);
      expect(result.voiceSettings.similarityBoost).toBe(0.75);
      expect(result.voiceSettings.style).toBe(0);
      expect(result.voiceSettings.useSpeakerBoost).toBe(true);
    });

    it('should use all bot overrides when fully specified', () => {
      const result = resolveTtsConfig(
        globalTts,
        makeBotConfig({
          voiceId: 'bot-voice',
          modelId: 'eleven_turbo_v2_5',
          outputFormat: 'mp3_44100_128',
          languageCode: 'es',
          maxTextLength: 500,
          voiceSettings: {
            stability: 0.3,
            similarityBoost: 0.6,
            style: 0.2,
            useSpeakerBoost: false,
            speed: 1.8,
          },
        })
      );
      expect(result.voiceId).toBe('bot-voice');
      expect(result.modelId).toBe('eleven_turbo_v2_5');
      expect(result.outputFormat).toBe('mp3_44100_128');
      expect(result.languageCode).toBe('es');
      expect(result.maxTextLength).toBe(500);
      expect(result.voiceSettings).toEqual({
        stability: 0.3,
        similarityBoost: 0.6,
        style: 0.2,
        useSpeakerBoost: false,
        speed: 1.8,
      });
      // Global-only fields preserved
      expect(result.apiKey).toBe('global-api-key');
      expect(result.provider).toBe('elevenlabs');
      expect(result.timeout).toBe(30_000);
    });
  });
});
