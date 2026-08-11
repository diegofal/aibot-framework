/**
 * `ollama.apiKey` must behave like the framework's other secrets: optional,
 * absent by default, and resolvable from `${VAR}` so config files stay
 * credential-free. `config.example.json` also relies on `${OLLAMA_BASE_URL}`
 * resolving at load time, which is what makes the container path work without
 * hand-editing the seeded file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const TEST_DIR = join(tmpdir(), `ollama-apikey-test-${Date.now()}`);

function writeConfig(ollama: Record<string, unknown>): string {
  const configPath = join(TEST_DIR, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ollama,
      skills: { enabled: [], config: {} },
      logging: { level: 'info' },
      paths: { data: './data', logs: './data/logs', skills: './src/skills' },
    })
  );
  return configPath;
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env = { ...SAVED_ENV };
});

describe('ollama.apiKey', () => {
  test('is optional — existing configs load unchanged', async () => {
    const config = await loadConfig(
      writeConfig({ baseUrl: 'http://127.0.0.1:11434', models: { primary: 'llama3' } })
    );
    expect(config.ollama.apiKey).toBeUndefined();
  });

  test('accepts a literal value', async () => {
    const config = await loadConfig(
      writeConfig({
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: 'literal-key',
        models: { primary: 'llama3' },
      })
    );
    expect(config.ollama.apiKey).toBe('literal-key');
  });

  test('resolves ${OLLAMA_API_KEY} from the environment', async () => {
    process.env.OLLAMA_API_KEY = 'env-provided-key';
    const config = await loadConfig(
      writeConfig({
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '${OLLAMA_API_KEY}',
        models: { primary: 'llama3' },
      })
    );
    expect(config.ollama.apiKey).toBe('env-provided-key');
  });

  test('an unset ${OLLAMA_API_KEY} becomes an empty string, which means "no key"', async () => {
    // `delete` is required: assigning undefined stores the string "undefined".
    // biome-ignore lint/performance/noDelete: only way to truly unset an env var
    delete process.env.OLLAMA_API_KEY;
    const config = await loadConfig(
      writeConfig({
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '${OLLAMA_API_KEY}',
        models: { primary: 'llama3' },
      })
    );
    expect(config.ollama.apiKey).toBe('');
  });
});

describe('ollama.baseUrl env substitution', () => {
  test('${OLLAMA_BASE_URL} resolves before url validation', async () => {
    process.env.OLLAMA_BASE_URL = 'https://ollama.com';
    const config = await loadConfig(
      writeConfig({ baseUrl: '${OLLAMA_BASE_URL}', models: { primary: 'kimi-k2.6:cloud' } })
    );
    expect(config.ollama.baseUrl).toBe('https://ollama.com');
  });

  test('resolves the compose sidecar hostname', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    const config = await loadConfig(
      writeConfig({ baseUrl: '${OLLAMA_BASE_URL}', models: { primary: 'llama3' } })
    );
    expect(config.ollama.baseUrl).toBe('http://ollama:11434');
  });

  test('an unset OLLAMA_BASE_URL fails validation loudly rather than silently defaulting', async () => {
    // biome-ignore lint/performance/noDelete: only way to truly unset an env var
    delete process.env.OLLAMA_BASE_URL;
    await expect(
      loadConfig(writeConfig({ baseUrl: '${OLLAMA_BASE_URL}', models: { primary: 'llama3' } }))
    ).rejects.toThrow();
  });
});
