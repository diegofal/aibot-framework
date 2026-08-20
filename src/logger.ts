import pino from 'pino';
import type { LoggerOptions } from 'pino';
import { redactPii } from './redact-pii';

export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
  /** Max size of each log file before rotation. Accepts plain bytes (number)
   * or a string with a unit suffix (k, m, g). Default: "10m". */
  fileMaxSize?: string | number;
  /** Number of rotated log files to keep. Default: 5. */
  fileLimit?: number;
}

export type Logger = pino.Logger;

/**
 * Backstop against a credential reaching the log file or the dashboard's log
 * stream. Call sites are expected not to log secrets in the first place (see
 * `src/core/ollama-http.ts`); this catches the case where someone logs a
 * request init, a headers object or a config slice wholesale. The default log
 * level is `debug`, so there is very little margin for a mistake here.
 */
const REDACTED_PATHS = [
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  'headers.Authorization',
  '*.headers.authorization',
  '*.headers.Authorization',
];

export function createLogger(config: LogConfig): Logger {
  const fileMaxSize = config.fileMaxSize ?? '10m';
  const fileLimit = config.fileLimit ?? 5;
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // Scrub PII patterns (emails, phone numbers, tokens, long hex keys) from
    // the formatted message and any string-valued metadata before the record
    // reaches the transports. Complements the field-level `redact` above,
    // which only covers known object paths.
    formatters: {
      log(record: Record<string, unknown>) {
        if (typeof record.msg === 'string') {
          record.msg = redactPii(record.msg) as string;
        }
        for (const key in record) {
          if (key !== 'msg' && typeof record[key] === 'string') {
            record[key] = redactPii(record[key]);
          }
        }
        return record;
      },
    },
    transport: config.file
      ? {
          targets: [
            {
              target: 'pino-pretty',
              level: config.level,
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
              },
            },
            {
              target: 'pino-roll',
              level: config.level,
              options: {
                file: config.file,
                size: fileMaxSize,
                limit: { count: fileLimit },
                mkdir: true,
                frequency: 'daily',
              },
            },
          ],
        }
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
  };

  return pino(options);
}
