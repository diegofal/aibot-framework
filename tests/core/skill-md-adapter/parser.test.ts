/**
 * Tests for SkillMdParser
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillMdParser } from '../../../src/core/skill-md-adapter/parser';
import { SkillParseError } from '../../../src/core/skill-md-adapter/types';

describe('SkillMdParser', () => {
  const parser = new SkillMdParser();
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `skill-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic parsing', () => {
    it('should parse valid SKILL.md with minimal content', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: A test skill for parsing
---

# Test Skill

This is a test skill.
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      expect(result.name).toBe('test-skill');
      expect(result.version).toBe('1.0.0');
      expect(result.description).toBe('A test skill for parsing');
      expect(result.instructions).toContain('# Test Skill');
      expect(result.declaredTools).toEqual([]);
    });

    it('should parse SKILL.md with metadata', () => {
      const content = `---
name: weather-checker
version: 1.2.3
description: Check weather conditions
metadata:
  aibot:
    emoji: "🌤️"
    category: web
    maxRetries: 3
---

# Weather Checker

Get weather info.
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      expect(result.metadata?.aibot?.emoji).toBe('🌤️');
      expect(result.metadata?.aibot?.category).toBe('web');
      expect(result.metadata?.aibot?.maxRetries).toBe(3);
    });

    it('should throw on missing frontmatter', () => {
      const content = `# No Frontmatter

This skill has no YAML frontmatter.
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      expect(() => parser.parse(filePath)).toThrow('Missing YAML frontmatter');
    });

    it('should throw on invalid YAML', () => {
      const content = `---
name: [invalid
version: not a version
---

# Invalid
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      expect(() => parser.parse(filePath)).toThrow(SkillParseError);
    });
  });

  describe('Tool declaration parsing', () => {
    it('should parse tool with all fields', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test with tools
---

# Test Skill

## Tools

### get-weather

**Description:** Fetch current weather for a location
**Parameters:**
- \`location\` (string, required): City name or coordinates
- \`units\` (string, optional): Metric or imperial, default: \`metric\`

**Implementation:** \`scripts/get-weather.ts\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      expect(result.declaredTools).toHaveLength(1);

      const tool = result.declaredTools[0];
      expect(tool.name).toBe('get-weather');
      expect(tool.description).toBe('Fetch current weather for a location');
      expect(tool.implementation).toBe('scripts/get-weather.ts');
      expect(tool.parameters).toHaveLength(2);

      const [location, units] = tool.parameters;
      expect(location.name).toBe('location');
      expect(location.type).toBe('string');
      expect(location.required).toBe(true);

      expect(units.name).toBe('units');
      expect(units.type).toBe('string');
      expect(units.required).toBe(false);
      expect(units.default).toBe('metric');
    });

    it('should parse tool without implementation', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### instruction-only

**Description:** A tool with no implementation
**Parameters:**
- \`query\` (string, required): Search query
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      expect(result.declaredTools).toHaveLength(1);
      expect(result.declaredTools[0].implementation).toBeUndefined();
    });

    it('should parse multiple tools', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### tool-one

**Description:** First tool
**Parameters:**
- \`arg1\` (string, required): First argument

### tool-two

**Description:** Second tool
**Parameters:**
- \`arg2\` (number, optional): Second argument

**Implementation:** \`scripts/tool-two.ts\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      expect(result.declaredTools).toHaveLength(2);
      expect(result.declaredTools[0].name).toBe('tool-one');
      expect(result.declaredTools[1].name).toBe('tool-two');
    });

    it('should parse all parameter types', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### multi-type

**Description:** Tool with various parameter types
**Parameters:**
- \`str\` (string, required): String param
- \`num\` (number, required): Number param
- \`bool\` (boolean, optional): Boolean param, default: \`true\`
- \`arr\` (array, optional): Array param, default: \`[]\`
- \`obj\` (object, optional): Object param
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);

      const tool = result.declaredTools[0];
      expect(tool.parameters).toHaveLength(5);

      expect(tool.parameters[0].type).toBe('string');
      expect(tool.parameters[1].type).toBe('number');
      expect(tool.parameters[2].type).toBe('boolean');
      expect(tool.parameters[2].default).toBe(true);
      expect(tool.parameters[3].type).toBe('array');
      expect(tool.parameters[3].default).toEqual([]);
      expect(tool.parameters[4].type).toBe('object');
    });
  });

  describe('Default value parsing', () => {
    it('should parse string defaults', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### test

**Description:** Test tool
**Parameters:**
- \`msg\` (string, optional): Message, default: \`hello\`
- \`quoted\` (string, optional): Quoted, default: \`"world"\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);
      const params = result.declaredTools[0].parameters;

      expect(params[0].default).toBe('hello');
      expect(params[1].default).toBe('world');
    });

    it('should parse numeric defaults', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### test

**Description:** Test tool
**Parameters:**
- \`int\` (number, optional): Integer, default: \`42\`
- \`float\` (number, optional): Float, default: \`3.14\`
- \`neg\` (number, optional): Negative, default: \`-5\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);
      const params = result.declaredTools[0].parameters;

      expect(params[0].default).toBe(42);
      expect(params[1].default).toBe(3.14);
      expect(params[2].default).toBe(-5);
    });

    it('should parse boolean and null defaults', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### test

**Description:** Test tool
**Parameters:**
- \`flag\` (boolean, optional): Flag, default: \`true\`
- \`other\` (boolean, optional): Other flag, default: \`false\`
- \`empty\` (string, optional): Empty, default: \`null\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);
      const params = result.declaredTools[0].parameters;

      expect(params[0].default).toBe(true);
      expect(params[1].default).toBe(false);
      expect(params[2].default).toBeNull();
    });

    it('should parse array/object defaults', () => {
      const content = `---
name: test-skill
version: 1.0.0
description: Test
---

### test

**Description:** Test tool
**Parameters:**
- \`arr\` (array, optional): Array, default: \`[1, 2, 3]\`
- \`obj\` (object, optional): Object, default: \`{"key": "value"}\`
`;
      const filePath = join(tempDir, 'SKILL.md');
      writeFileSync(filePath, content);

      const result = parser.parse(filePath);
      const params = result.declaredTools[0].parameters;

      expect(params[0].default).toEqual([1, 2, 3]);
      expect(params[1].default).toEqual({ key: 'value' });
    });
  });
});
