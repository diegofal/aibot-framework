import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SoulLoader } from '../src/soul';
import { parseGoals, serializeGoals } from '../src/tools/goals';

const TEST_DIR = '/tmp/aibot-test-goals-per-user';

function createTestLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as any;
}

describe('Per-User Goals', () => {
  let soulLoader: SoulLoader;

  beforeEach(() => {
    // Clean up and recreate test directory
    try {
      rmSync(TEST_DIR, { recursive: true });
    } catch {}
    mkdirSync(join(TEST_DIR, 'memory', 'users', 'user-123'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'memory', 'users', 'user-456'), { recursive: true });

    soulLoader = new SoulLoader(
      {
        enabled: true,
        dir: TEST_DIR,
        versioning: { enabled: false, maxVersionsPerFile: 10 },
      } as any,
      createTestLogger()
    );
  });

  test('readUserGoals returns null when no file exists', () => {
    expect(soulLoader.readUserGoals('user-123')).toBeNull();
  });

  test('writeUserGoals creates file and readUserGoals reads it', () => {
    const content = serializeGoals(
      [{ text: 'Learn Python', status: 'pending', priority: 'high' }],
      []
    );
    soulLoader.writeUserGoals('user-123', content);

    const result = soulLoader.readUserGoals('user-123');
    expect(result).toContain('Learn Python');
  });

  test('per-user goals are isolated between users', () => {
    soulLoader.writeUserGoals(
      'user-123',
      serializeGoals([{ text: 'Learn Python', status: 'pending', priority: 'high' }], [])
    );
    soulLoader.writeUserGoals(
      'user-456',
      serializeGoals([{ text: 'Prepare IELTS', status: 'pending', priority: 'high' }], [])
    );

    const goals123 = soulLoader.readUserGoals('user-123');
    const goals456 = soulLoader.readUserGoals('user-456');

    expect(goals123).toContain('Learn Python');
    expect(goals123).not.toContain('Prepare IELTS');
    expect(goals456).toContain('Prepare IELTS');
    expect(goals456).not.toContain('Learn Python');
  });

  test('shared goals are separate from per-user goals', () => {
    // Write shared goals
    const sharedGoalsPath = join(TEST_DIR, 'GOALS.md');
    writeFileSync(
      sharedGoalsPath,
      serializeGoals([{ text: 'Help all students learn', status: 'pending', priority: 'high' }], [])
    );

    // Write per-user goal
    soulLoader.writeUserGoals(
      'user-123',
      serializeGoals([{ text: 'Learn Python', status: 'pending', priority: 'high' }], [])
    );

    const shared = soulLoader.readGoals();
    const user = soulLoader.readUserGoals('user-123');

    expect(shared).toContain('Help all students');
    expect(shared).not.toContain('Learn Python');
    expect(user).toContain('Learn Python');
    expect(user).not.toContain('Help all students');
  });

  test('composeSystemPrompt includes per-user goals when userId provided', () => {
    // Create identity file for composeSystemPrompt to work
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'name: TestBot\n');

    // Write shared goals
    writeFileSync(
      join(TEST_DIR, 'GOALS.md'),
      serializeGoals([{ text: 'Shared goal', status: 'pending', priority: 'medium' }], [])
    );

    // Write per-user goals
    soulLoader.writeUserGoals(
      'user-123',
      serializeGoals([{ text: 'User specific goal', status: 'pending', priority: 'high' }], [])
    );

    const prompt = soulLoader.composeSystemPrompt('user-123');
    expect(prompt).toContain('Shared goal');
    expect(prompt).toContain('User specific goal');
    expect(prompt).toContain('Your Goals (for this user)');
  });

  test('composeSystemPrompt without userId does not include per-user goals', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'name: TestBot\n');
    soulLoader.writeUserGoals(
      'user-123',
      serializeGoals([{ text: 'User specific goal', status: 'pending', priority: 'high' }], [])
    );

    const prompt = soulLoader.composeSystemPrompt();
    expect(prompt).not.toContain('User specific goal');
    expect(prompt).not.toContain('Your Goals (for this user)');
  });

  test('writeUserGoals creates directory if not exists', () => {
    const userId = 'new-user-789';
    soulLoader.writeUserGoals(
      userId,
      serializeGoals([{ text: 'New user goal', status: 'pending', priority: 'medium' }], [])
    );

    const goalsPath = join(TEST_DIR, 'memory', 'users', userId, 'GOALS.md');
    expect(existsSync(goalsPath)).toBe(true);
    expect(readFileSync(goalsPath, 'utf-8')).toContain('New user goal');
  });
});
