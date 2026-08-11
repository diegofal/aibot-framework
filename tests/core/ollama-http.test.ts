import { describe, expect, test } from 'bun:test';
import {
  buildOllamaHeaders,
  buildOllamaJsonHeaders,
  describeEmbedFailure,
  describeEmbeddingBackendGap,
  hasOllamaApiKey,
  isOllamaCloudUrl,
} from '../../src/core/ollama-http';

describe('hasOllamaApiKey', () => {
  test('treats undefined, empty and whitespace as absent', () => {
    expect(hasOllamaApiKey(undefined)).toBe(false);
    expect(hasOllamaApiKey('')).toBe(false);
    expect(hasOllamaApiKey('   ')).toBe(false);
  });

  test('treats a real key as present', () => {
    expect(hasOllamaApiKey('sk-test')).toBe(true);
  });
});

describe('buildOllamaHeaders', () => {
  test('omits Authorization entirely when no key is configured', () => {
    const headers = buildOllamaHeaders(undefined);
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).toHaveLength(0);
  });

  test('omits Authorization when the key interpolated to an empty string', () => {
    // An unset ${OLLAMA_API_KEY} becomes '' in substituteEnvVars — that must
    // not produce a bare "Bearer ".
    expect(buildOllamaHeaders('').Authorization).toBeUndefined();
    expect(buildOllamaHeaders('  ').Authorization).toBeUndefined();
  });

  test('adds a bearer token when a key is configured', () => {
    expect(buildOllamaHeaders('sk-abc').Authorization).toBe('Bearer sk-abc');
  });

  test('trims surrounding whitespace from the key', () => {
    expect(buildOllamaHeaders(' sk-abc \n').Authorization).toBe('Bearer sk-abc');
  });

  test('preserves base headers with and without a key', () => {
    expect(buildOllamaHeaders(undefined, { 'X-A': '1' })).toEqual({ 'X-A': '1' });
    expect(buildOllamaHeaders('sk-abc', { 'X-A': '1' })).toEqual({
      'X-A': '1',
      Authorization: 'Bearer sk-abc',
    });
  });

  test('does not mutate the base object', () => {
    const base = { 'Content-Type': 'application/json' };
    buildOllamaHeaders('sk-abc', base);
    expect(base).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('buildOllamaJsonHeaders', () => {
  test('local daemon path is exactly Content-Type', () => {
    expect(buildOllamaJsonHeaders(undefined)).toEqual({ 'Content-Type': 'application/json' });
  });

  test('cloud path adds the bearer token', () => {
    expect(buildOllamaJsonHeaders('sk-abc')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-abc',
    });
  });
});

describe('isOllamaCloudUrl', () => {
  test('recognises the hosted API', () => {
    expect(isOllamaCloudUrl('https://ollama.com')).toBe(true);
    expect(isOllamaCloudUrl('https://ollama.com/')).toBe(true);
    expect(isOllamaCloudUrl('https://www.ollama.com')).toBe(true);
    expect(isOllamaCloudUrl('https://api.ollama.com')).toBe(true);
  });

  test('does not match a local daemon', () => {
    expect(isOllamaCloudUrl('http://127.0.0.1:11434')).toBe(false);
    expect(isOllamaCloudUrl('http://ollama:11434')).toBe(false);
    expect(isOllamaCloudUrl('http://localhost:11434')).toBe(false);
  });

  test('does not match a lookalike host', () => {
    expect(isOllamaCloudUrl('http://ollama.com.evil.test')).toBe(false);
    expect(isOllamaCloudUrl('http://notollama.com')).toBe(false);
  });

  test('handles blank and malformed input', () => {
    expect(isOllamaCloudUrl(undefined)).toBe(false);
    expect(isOllamaCloudUrl('')).toBe(false);
    expect(isOllamaCloudUrl('not a url')).toBe(false);
  });
});

describe('describeEmbeddingBackendGap', () => {
  test('flags soul.search enabled against Ollama Cloud', () => {
    const message = describeEmbeddingBackendGap({
      baseUrl: 'https://ollama.com',
      searchEnabled: true,
      embeddingModel: 'nomic-embed-text:latest',
    });
    expect(message).toContain('no embedding models');
    expect(message).toContain('soul.search.enabled=false');
    expect(message).toContain('nomic-embed-text:latest');
  });

  test('stays silent when search is disabled', () => {
    expect(
      describeEmbeddingBackendGap({
        baseUrl: 'https://ollama.com',
        searchEnabled: false,
        embeddingModel: 'nomic-embed-text:latest',
      })
    ).toBeNull();
  });

  test('stays silent for a local daemon', () => {
    expect(
      describeEmbeddingBackendGap({
        baseUrl: 'http://ollama:11434',
        searchEnabled: true,
        embeddingModel: 'nomic-embed-text:latest',
      })
    ).toBeNull();
  });

  // The live symptom is {"error": "unauthorized"} from a key that chats fine.
  // If the boot message does not pre-empt that, the operator spends the next
  // hour rotating a working API key.
  test('warns that the observed "unauthorized" is not an API key problem', () => {
    const message = describeEmbeddingBackendGap({
      baseUrl: 'https://ollama.com',
      searchEnabled: true,
      embeddingModel: 'nomic-embed-text',
    });
    expect(message).toContain('unauthorized');
    expect(message).toContain('not an API key problem');
    expect(message).toContain('local-ollama');
  });
});

describe('describeEmbedFailure', () => {
  const cloud = (status: number, statusText = 'Unauthorized') =>
    describeEmbedFailure({
      baseUrl: 'https://ollama.com',
      status,
      statusText,
      model: 'nomic-embed-text',
    });

  test('a cloud 401 is reported as a missing capability, not as auth', () => {
    const message = cloud(401);
    expect(message).toContain('NOT an authentication problem');
    expect(message).toContain('no embedding models');
    expect(message).toContain('regardless of the API key');
    // Names the actual remedies.
    expect(message).toContain('local-ollama');
    expect(message).toContain('soul.search.enabled=false');
  });

  test('the cloud message never tells the reader their credentials failed', () => {
    for (const status of [401, 403, 404, 500]) {
      const message = cloud(status, 'whatever');
      expect(message).toContain('NOT an authentication problem');
      expect(message).not.toContain('check ollama.apiKey');
    }
  });

  test('names the model that cannot be served', () => {
    expect(cloud(401)).toContain('nomic-embed-text');
  });

  test('a local daemon 401 IS an auth problem and says so', () => {
    const message = describeEmbedFailure({
      baseUrl: 'http://ollama:11434',
      status: 401,
      statusText: 'Unauthorized',
      model: 'nomic-embed-text',
    });
    expect(message).toContain('rejected the credentials');
    expect(message).toContain('ollama.apiKey');
    expect(message).not.toContain('no embedding models');
  });

  test('a local daemon 404 points at the missing pull', () => {
    const message = describeEmbedFailure({
      baseUrl: 'http://ollama:11434',
      status: 404,
      statusText: 'Not Found',
      model: 'nomic-embed-text',
    });
    expect(message).toContain('ollama pull nomic-embed-text');
  });

  test('an unclassified local failure stays plain', () => {
    expect(
      describeEmbedFailure({
        baseUrl: 'http://ollama:11434',
        status: 500,
        statusText: 'Internal Server Error',
        model: 'nomic-embed-text',
      })
    ).toBe('Ollama embed API error: 500 Internal Server Error');
  });
});
