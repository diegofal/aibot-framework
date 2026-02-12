import type { MediaConfig } from './config';
import type { Logger } from './logger';

const DEFAULT_SUPPORTED_DOC_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
];

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
]);

const MAX_DOC_CHARS = 50_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Map common file extensions to MIME types for when Telegram doesn't provide one */
const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
};

export interface MediaResult {
  /** Text content to send to Ollama as the user message */
  text: string;
  /** Base64 images for Ollama vision models */
  images?: string[];
  /** Transcript-safe text for JSONL session storage (never contains binary data) */
  sessionText: string;
}

/**
 * User-friendly error class. The message is safe to show to Telegram users.
 */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

export class MediaHandler {
  private maxFileSizeBytes: number;
  private supportedDocTypes: Set<string>;

  constructor(
    private config: MediaConfig,
    private logger: Logger,
  ) {
    this.maxFileSizeBytes = config.maxFileSizeMb * 1024 * 1024;
    this.supportedDocTypes = new Set(
      config.supportedDocTypes ?? DEFAULT_SUPPORTED_DOC_TYPES,
    );
  }

  /**
   * Download a file from a URL with size guard and timeout.
   */
  async downloadFile(fileUrl: string, fileSize?: number): Promise<Buffer> {
    // Pre-check size if known
    if (fileSize && fileSize > this.maxFileSizeBytes) {
      throw new MediaError(
        `File is too large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is ${this.config.maxFileSizeMb} MB.`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(fileUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new MediaError(`Failed to download file (HTTP ${response.status}).`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Post-check actual size
      if (buffer.length > this.maxFileSizeBytes) {
        throw new MediaError(
          `File is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is ${this.config.maxFileSizeMb} MB.`,
        );
      }

      return buffer;
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new MediaError('File download timed out.');
      }
      throw new MediaError(`Failed to download file: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Process a photo message. Returns base64 image for vision models.
   */
  async processPhoto(
    fileUrl: string,
    caption?: string,
    fileSize?: number,
  ): Promise<MediaResult> {
    this.logger.debug({ fileUrl, caption }, 'Processing photo');

    const buffer = await this.downloadFile(fileUrl, fileSize);
    const base64 = buffer.toString('base64');

    const text = caption || 'User sent an image.';
    const sessionText = caption ? `[Image] ${caption}` : '[Image] (no caption)';

    return { text, images: [base64], sessionText };
  }

  /**
   * Process a document message. Extracts text from PDFs and text-based files.
   */
  async processDocument(
    fileUrl: string,
    mimeType: string | undefined,
    fileName: string | undefined,
    caption?: string,
    fileSize?: number,
  ): Promise<MediaResult> {
    this.logger.debug({ fileUrl, mimeType, fileName, caption }, 'Processing document');

    // Infer MIME from file extension when Telegram doesn't provide a useful one
    let effectiveMime = mimeType || 'application/octet-stream';
    if (effectiveMime === 'application/octet-stream' && fileName) {
      const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
      effectiveMime = EXT_TO_MIME[ext] ?? effectiveMime;
    }

    if (!this.supportedDocTypes.has(effectiveMime)) {
      const supported = [...this.supportedDocTypes].join(', ');
      throw new MediaError(
        `Unsupported document type: ${effectiveMime}. Supported types: ${supported}`,
      );
    }

    const buffer = await this.downloadFile(fileUrl, fileSize);
    let extractedText: string;

    if (effectiveMime === 'application/pdf') {
      extractedText = await this.extractPdfText(buffer);
    } else if (TEXT_MIME_TYPES.has(effectiveMime)) {
      extractedText = buffer.toString('utf-8');
    } else {
      throw new MediaError(`Cannot extract text from: ${effectiveMime}`);
    }

    // Truncate long documents
    if (extractedText.length > MAX_DOC_CHARS) {
      extractedText = extractedText.substring(0, MAX_DOC_CHARS) + '\n\n[Document truncated]';
    }

    const label = fileName || 'document';
    const prefix = caption ? `${caption}\n\n` : '';
    const text = `${prefix}Content of "${label}":\n\n${extractedText}`;
    const sessionText = caption
      ? `[Document: ${label}] ${caption}`
      : `[Document: ${label}]`;

    return { text, sessionText };
  }

  /**
   * Process a voice message by sending it to a Whisper-compatible endpoint.
   */
  async processVoice(
    fileUrl: string,
    duration?: number,
    fileSize?: number,
  ): Promise<MediaResult> {
    if (!this.config.whisper) {
      throw new MediaError(
        'Voice transcription is not configured. Please ask the bot administrator to set up a Whisper endpoint.',
      );
    }

    this.logger.debug({ fileUrl, duration }, 'Processing voice message');

    const buffer = await this.downloadFile(fileUrl, fileSize);
    const whisperConfig = this.config.whisper;

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/ogg' }), 'voice.ogg');
    formData.append('model', whisperConfig.model);
    if (whisperConfig.language) {
      formData.append('language', whisperConfig.language);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), whisperConfig.timeout);

    try {
      const response = await fetch(whisperConfig.endpoint, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MediaError(`Voice transcription failed (HTTP ${response.status}).`);
      }

      const data = await response.json() as { text?: string };
      const transcription = (data.text ?? '').trim();

      if (!transcription) {
        throw new MediaError('Voice transcription returned empty result.');
      }

      const durationLabel = duration ? `${duration}s` : 'unknown';
      const sessionText = `[Voice: ${durationLabel}] ${transcription}`;

      return { text: transcription, sessionText };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new MediaError('Voice transcription timed out.');
      }
      throw new MediaError(`Voice transcription failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract text from a PDF buffer using pdf-parse.
   */
  private async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      // @ts-ignore -- pdf-parse has no type declarations
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer) as { text: string };
      return data.text;
    } catch (error) {
      this.logger.warn({ error }, 'PDF text extraction failed');
      throw new MediaError('Failed to extract text from PDF.');
    }
  }
}
