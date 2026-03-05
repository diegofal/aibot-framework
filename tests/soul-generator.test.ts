import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSoul } from '../src/soul-generator';
import type { SoulGenerationInput } from '../src/soul-generator';

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as any;
}

const validSoulJson = JSON.stringify({
  identity: 'name: TestBot\nemoji: 🤖\nvibe: A helpful test bot',
  soul: '## Personality Foundation\n- Helpful\n- Friendly\n\n## Communication Style\nCasual and warm\n\n## Boundaries\nNo harmful content\n\n### Permission Protocol\nAlways ask before sensitive actions',
  motivations:
    '## Core Drives\n- Help users\n\n## Current Focus\n- Testing\n\n## Open Questions\n- What makes a good test?\n\n## Self-Observations\n- I am thorough\n\n## Last Reflection\ndate: (none yet), trigger: (none), changes: (none)',
});

const defaultInput: SoulGenerationInput = {
  name: 'TestBot',
  role: 'assistant',
  personalityDescription: 'A helpful test bot',
};

describe('generateSoul', () => {
  let soulDir: string;
  let logger: ReturnType<typeof mockLogger>;

  beforeEach(() => {
    soulDir = mkdtempSync(join(tmpdir(), 'soul-gen-test-'));
    logger = mockLogger();
  });

  test('uses custom generate function when provided', async () => {
    const generate = mock(() => Promise.resolve(validSoulJson));

    const result = await generateSoul(defaultInput, {
      soulDir,
      logger,
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.identity).toContain('TestBot');
    expect(result.soul).toContain('Personality Foundation');
    expect(result.motivations).toContain('Core Drives');
  });

  test('passes the built prompt to the custom generate function', async () => {
    let receivedPrompt = '';
    const generate = mock((prompt: string) => {
      receivedPrompt = prompt;
      return Promise.resolve(validSoulJson);
    });

    await generateSoul(defaultInput, { soulDir, logger, generate });

    expect(receivedPrompt).toContain('TestBot');
    expect(receivedPrompt).toContain('assistant');
    expect(receivedPrompt).toContain('A helpful test bot');
    expect(receivedPrompt).toContain('bot personality designer');
  });

  test('strips markdown fences from output', async () => {
    const wrapped = `\`\`\`json\n${validSoulJson}\n\`\`\``;
    const generate = mock(() => Promise.resolve(wrapped));

    const result = await generateSoul(defaultInput, { soulDir, logger, generate });

    expect(result.identity).toContain('TestBot');
  });

  test('throws on invalid JSON', async () => {
    const generate = mock(() => Promise.resolve('not valid json'));

    await expect(generateSoul(defaultInput, { soulDir, logger, generate })).rejects.toThrow(
      'Failed to parse generated soul JSON'
    );
  });

  test('throws when required fields are missing', async () => {
    const incomplete = JSON.stringify({ identity: 'some identity', soul: '', motivations: '' });
    const generate = mock(() => Promise.resolve(incomplete));

    await expect(generateSoul(defaultInput, { soulDir, logger, generate })).rejects.toThrow(
      'Generated soul is missing required fields'
    );
  });

  test('includes few-shot examples from soulDir subdirectories', async () => {
    const exampleDir = join(soulDir, 'example-bot');
    mkdirSync(exampleDir, { recursive: true });
    writeFileSync(join(exampleDir, 'IDENTITY.md'), 'name: ExampleBot\nemoji: 🎭\nvibe: fun');
    writeFileSync(join(exampleDir, 'SOUL.md'), '## Personality Foundation\n- Fun');

    let receivedPrompt = '';
    const generate = mock((prompt: string) => {
      receivedPrompt = prompt;
      return Promise.resolve(validSoulJson);
    });

    await generateSoul(defaultInput, { soulDir, logger, generate });

    expect(receivedPrompt).toContain('ExampleBot');
    expect(receivedPrompt).toContain('Examples from existing bots');
  });

  test('respects language and emoji input', async () => {
    let receivedPrompt = '';
    const generate = mock((prompt: string) => {
      receivedPrompt = prompt;
      return Promise.resolve(validSoulJson);
    });

    await generateSoul(
      { ...defaultInput, language: 'English', emoji: '🧪' },
      { soulDir, logger, generate }
    );

    expect(receivedPrompt).toContain('English');
    expect(receivedPrompt).toContain('🧪');
  });

  test('logs backend type as custom when generate function is provided', async () => {
    const generate = mock(() => Promise.resolve(validSoulJson));

    await generateSoul(defaultInput, { soulDir, logger, generate });

    const infoCalls = logger.info.mock.calls;
    const genCall = infoCalls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('generating')
    );
    expect(genCall).toBeDefined();
    expect(genCall?.[0].backend).toBe('custom');
  });

  test('logs backend type as claude-cli when no generate function', async () => {
    // We can't actually call Claude CLI in tests, so we verify the logger call
    // by catching the expected error from the missing CLI
    try {
      await generateSoul(defaultInput, { soulDir, logger });
    } catch {
      // Expected: Claude CLI not available in test env
    }

    const infoCalls = logger.info.mock.calls;
    const genCall = infoCalls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('generating')
    );
    expect(genCall).toBeDefined();
    expect(genCall?.[0].backend).toBe('claude-cli');
  });
});
