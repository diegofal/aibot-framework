import pino from 'pino';
import type { LoggerOptions } from 'pino';

export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
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
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
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
              target: 'pino/file',
              level: config.level,
              options: {
                destination: config.file,
                mkdir: true,
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
