import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemPromptBuilder } from '../../src/bot/system-prompt-builder';
import type { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import { SoulLoader } from '../../src/soul';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

const LEGACY = `## Active Goals
- [ ] Research dark factories
  - status: pending
  - priority: high
  - task: [~] Find 3 companies {id: t-bbbbbb, by: agent}
  - id: g-aaaaaaaa

## Completed
(none yet)
`;

let dir: string;
let loader: SoulLoader;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'soul-tasks-'));
  writeFileSync(join(dir, 'GOALS.md'), LEGACY, 'utf-8');
  loader = new SoulLoader(
    { enabled: true, dir, versioning: { enabled: false, maxVersionsPerFile: 10 } } as any,
    logger
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SoulLoader tasks', () => {
  test('readTasks migrates and returns the store tasks', () => {
    expect(loader.readTasks().map((t) => t.id)).toEqual(['t-bbbbbb']);
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).not.toContain('- task:');
  });

  test('getTaskStore is bound to the soul dir', () => {
    const r = loader
      .getTaskStore()
      .apply([{ op: 'add', goalId: 'g-aaaaaaaa', text: 'Write it up' }], { actor: 'agent' });
    expect(r.ok).toBe(true);
    expect(loader.readTasks()).toHaveLength(2);
  });

  test('readGoalsView renders goals with their open tasks', () => {
    const view = loader.readGoalsView();
    expect(view).toContain('[g-aaaaaaaa] Research dark factories');
    expect(view).toContain('[~] t-bbbbbb Find 3 companies');
  });

  test('composeSystemPrompt carries the goals view, unless told not to', () => {
    const prompt = loader.composeSystemPrompt() ?? '';
    expect(prompt).toContain('## Goals');
    expect(prompt).toContain('[~] t-bbbbbb Find 3 companies');
    expect(loader.composeSystemPrompt(undefined, { goals: false }) ?? '').not.toContain('## Goals');
  });

  test('the autonomous (executor) system prompt leaves goals to the executor prompt', () => {
    const ctx = {
      config: {
        bots: [],
        humanizer: { enabled: false },
        soul: { enabled: true, dir },
        ollama: { models: { primary: 'm' } },
        conversation: { systemPrompt: 'Base.', temperature: 0.7, maxHistory: 20 },
        karma: { enabled: false },
      },
      logger,
      getSoulLoader: () => loader,
      runningBots: new Set(),
      agentRegistry: { listOtherAgents: () => [] },
    } as unknown as BotContext;
    const builder = new SystemPromptBuilder(ctx, {
      getDefinitionsForBot: () => [],
    } as unknown as ToolRegistry);
    const base = { botId: 'b', botConfig: { id: 'b', name: 'B' } as any, isGroup: false };
    expect(builder.build({ ...base, mode: 'autonomous' })).not.toContain('## Goals');
    expect(builder.build({ ...base, mode: 'conversation' })).toContain('## Goals');
  });
});
