import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotConfig, Config } from '../../src/config';
import type { HygieneContext, HygieneDeps } from '../../src/hygiene/types';

export const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

export const NOW = new Date('2026-08-21T12:00:00');
export const TODAY = '2026-08-21';

export function daysAgo(n: number, from: Date = NOW): Date {
  return new Date(from.getTime() - n * 86_400_000);
}

export function isoDaysAgo(n: number): string {
  return daysAgo(n).toISOString();
}

export function dateDaysAgo(n: number): string {
  return daysAgo(n).toLocaleDateString('sv-SE');
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot1',
    name: 'Bot One',
    token: 'tok',
    enabled: true,
    skills: [],
    ...overrides,
  } as BotConfig;
}

/** Build a Config whose every directory lives under `root`. */
export function makeConfig(root: string, bots: BotConfig[] = [makeBot()]): Config {
  return {
    bots,
    soul: { dir: join(root, 'config', 'soul') },
    productions: { baseDir: join(root, 'productions'), enabled: true },
    karma: { baseDir: join(root, 'data', 'karma'), enabled: true },
    multiTenant: { enabled: false, dataDir: join(root, 'data', 'tenants') },
    paths: { data: join(root, 'data'), logs: join(root, 'logs'), skills: join(root, 'skills') },
    ollama: { models: { primary: 'test-model' } },
    conversation: {},
    agentLoop: {},
  } as unknown as Config;
}

export function makeDeps(overrides: Partial<HygieneDeps> = {}): HygieneDeps {
  return {
    toolSucceededRecently: () => false,
    channelStateOf: () => undefined,
    lastHealthCheckOf: () => undefined,
    ...overrides,
  };
}

export function makeCtx(root: string, overrides: Partial<HygieneContext> = {}): HygieneContext {
  const config = overrides.config ?? makeConfig(root);
  const soulDir =
    overrides.soulDir ?? join(root, 'data', 'tenants', '__admin__', 'bots', 'bot1', 'soul');
  const workDir = overrides.workDir ?? join(root, 'productions', 'bot1');
  const dataDir = join(root, 'data');
  return {
    botId: 'bot1',
    soulDir,
    workDir,
    dataDir,
    allowedRoots: [
      dataDir,
      join(root, 'config', 'soul'),
      join(root, 'productions'),
      soulDir,
      workDir,
    ],
    config,
    logger: noopLogger,
    now: NOW,
    options: {},
    deps: makeDeps(),
    ...overrides,
  };
}
