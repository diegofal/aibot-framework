/**
 * Tests for framework-bridge.ts
 * Verifies integration between SkillMdLoader and external-skill-loader
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkillDirsExtended,
  hasSkillMd,
  loadDeclarativeSkill,
} from '../../../src/core/skill-md-adapter/framework-bridge';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

describe('framework-bridge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bridge-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('hasSkillMd', () => {
    it('should return true when SKILL.md exists', () => {
      const skillDir = join(tempDir, 'has-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: test\n---\n');

      expect(hasSkillMd(skillDir)).toBe(true);
    });

    it('should return false when SKILL.md is missing', () => {
      const skillDir = join(tempDir, 'no-skill');
      mkdirSync(skillDir, { recursive: true });

      expect(hasSkillMd(skillDir)).toBe(false);
    });
  });

  describe('loadDeclarativeSkill', () => {
    it('should load a skill and return in external format', async () => {
      const skillDir = join(tempDir, 'my-skill');
      mkdirSync(skillDir, { recursive: true });

      const content = `---
name: my-skill
version: 1.0.0
description: A test skill
metadata:
  aibot:
    emoji: "🎯"
    category: web
---

# My Skill

Test skill instructions.

### do-something

**Description:** Does something useful
**Parameters:**
- \`input\` (string, required): Input to process

**Implementation:** \`scripts/do.ts\`
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      const result = await loadDeclarativeSkill(skillDir, mockLogger as any);

      expect(result.manifest.id).toBe('my-skill');
      expect(result.manifest.name).toBe('my-skill');
      expect(result.manifest.description).toBe('A test skill');
      expect(result.manifest.tools).toHaveLength(1);
      expect(result.manifest.tools[0].name).toBe('my-skill.do-something');
      expect(result.manifest.tools[0].description).toBe('Does something useful');
      expect(result.dir).toBe(skillDir);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(typeof result.handlers['my-skill.do-something']).toBe('function');
    });

    it('should throw when SKILL.md is missing', async () => {
      const skillDir = join(tempDir, 'empty');
      mkdirSync(skillDir, { recursive: true });

      expect(loadDeclarativeSkill(skillDir, mockLogger as any)).rejects.toThrow(
        'SKILL.md not found'
      );
    });

    it('should include binary requirements in warnings', async () => {
      const skillDir = join(tempDir, 'needs-binary');
      mkdirSync(skillDir, { recursive: true });

      // Use a binary that definitely doesn't exist
      const content = `---
name: needs-binary
version: 1.0.0
description: Needs a binary
metadata:
  aibot:
    requires:
      anyBins: ["definitely_not_a_real_binary_12345"]
---

# Needs Binary
`;
      writeFileSync(join(skillDir, 'SKILL.md'), content);

      const result = await loadDeclarativeSkill(skillDir, mockLogger as any);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Missing binary');
    });
  });

  describe('discoverSkillDirsExtended', () => {
    it('should discover both skill.json and SKILL.md directories', () => {
      const parentDir = join(tempDir, 'skills');

      // Create skill.json skill
      const jsonSkill = join(parentDir, 'json-skill');
      mkdirSync(jsonSkill, { recursive: true });
      writeFileSync(
        join(jsonSkill, 'skill.json'),
        JSON.stringify({ id: 'json-skill', tools: [{ name: 'tool1' }] })
      );

      // Create SKILL.md skill
      const mdSkill = join(parentDir, 'md-skill');
      mkdirSync(mdSkill, { recursive: true });
      writeFileSync(join(mdSkill, 'SKILL.md'), '---\nname: md-skill\n---\n');

      // Create directory without skill
      const noSkill = join(parentDir, 'no-skill');
      mkdirSync(noSkill, { recursive: true });

      const results = discoverSkillDirsExtended([parentDir]);

      expect(results).toHaveLength(2);

      const jsonResult = results.find((r) => r.dir === jsonSkill);
      const mdResult = results.find((r) => r.dir === mdSkill);

      expect(jsonResult?.type).toBe('json');
      expect(mdResult?.type).toBe('skillmd');
    });

    it('should prefer SKILL.md over skill.json when both exist', () => {
      const parentDir = join(tempDir, 'skills');
      const bothSkill = join(parentDir, 'both');
      mkdirSync(bothSkill, { recursive: true });

      // Create both files
      writeFileSync(join(bothSkill, 'skill.json'), JSON.stringify({ id: 'both', tools: [] }));
      writeFileSync(join(bothSkill, 'SKILL.md'), '---\nname: both\n---\n');

      const results = discoverSkillDirsExtended([parentDir]);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('skillmd');
    });

    it('should return empty array for non-existent paths', () => {
      const results = discoverSkillDirsExtended(['/non/existent/path']);
      expect(results).toEqual([]);
    });
  });
});
