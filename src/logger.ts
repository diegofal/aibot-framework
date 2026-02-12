import pino from 'pino';
import type { LoggerOptions } from 'pino';

export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
}

export type Logger = pino.Logger;

export function createLogger(config: LogConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    transport: config.file
      ? {
          targets: [
            {
              target: 'pino-pretty',
              level: config.level,
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
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
