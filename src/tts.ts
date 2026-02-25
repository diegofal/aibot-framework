import type { TtsConfig } from './config';
import type { Logger } from './logger';

export interface TtsResult {
  audioBuffer: Buffer;
  latencyMs: number;
}

/**
 * Strip markdown formatting from text before sending to TTS.
 * Removes headers, bold/italic markers, code blocks, and link syntax.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')        // headers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, '')  // inline code & code blocks
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → keep alt (before links)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → keep label
    .trim();
}

/**
 * Truncate text to maxLength chars, appending "..." if truncated.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Generate speech audio from text using ElevenLabs TTS API.
 * Follows the OpenClaw pattern from tts-core.ts.
 */
export async function generateSpeech(
  text: string,
  config: TtsConfig,
  logger: Logger,
): Promise<TtsResult> {
  const start = Date.now();

  // Prepare text: strip markdown, then truncate
  let processedText = stripMarkdown(text);
  processedText = truncateText(processedText, config.maxTextLength);

  if (!processedText) {
    throw new Error('TTS: text is empty after processing');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}?output_format=${config.outputFormat}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const body: Record<string, unknown> = {
      text: processedText,
      model_id: config.modelId,
      voice_settings: {
        stability: config.voiceSettings.stability,
        similarity_boost: config.voiceSettings.similarityBoost,
        style: config.voiceSettings.style,
        use_speaker_boost: config.voiceSettings.useSpeakerBoost,
        speed: config.voiceSettings.speed,
      },
    };

    if (config.languageCode) {
      body.language_code = config.languageCode;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const latencyMs = Date.now() - start;

    logger.info(
      { latencyMs, textLength: processedText.length, audioBytes: audioBuffer.length },
      'TTS audio generated',
    );

    return { audioBuffer, latencyMs };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`TTS timeout after ${config.timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
