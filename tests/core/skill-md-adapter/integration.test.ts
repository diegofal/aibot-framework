/**
 * Integration tests for skill-md-adapter
 * Tests the full flow: parse → validate
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SkillMdParser } from '../../../src/core/skill-md-adapter/parser';
import { SkillValidator } from '../../../src/core/skill-md-adapter/validator';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('Integration: Parse + Validate', () => {
  const parser = new SkillMdParser();
  const validator = new SkillValidator();

  describe('weather-checker fixture', () => {
    it('should parse successfully', () => {
      const filePath = join(FIXTURES_DIR, 'weather-checker.md');
      const result = parser.parse(filePath);

      expect(result.name).toBe('weather-checker');
      expect(result.version).toBe('1.0.0');
      expect(result.declaredTools).toHaveLength(2);
    });

    it('should validate successfully', () => {
      const filePath = join(FIXTURES_DIR, 'weather-checker.md');
      const doc = parser.parse(filePath);
      const result = validator.validate(doc);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should extract correct tool definitions', () => {
      const filePath = join(FIXTURES_DIR, 'weather-checker.md');
      const doc = parser.parse(filePath);

      const [current, forecast] = doc.declaredTools;

      expect(current.name).toBe('get-current-weather');
      expect(current.parameters).toHaveLength(2);
      expect(current.implementation).toBe('scripts/fetch-weather.ts');

      expect(forecast.name).toBe('get-forecast');
      expect(forecast.parameters[1].default).toBe(3);
    });
  });

  describe('minimal fixture', () => {
    it('should parse successfully', () => {
      const filePath = join(FIXTURES_DIR, 'minimal.md');
      const result = parser.parse(filePath);

      expect(result.name).toBe('minimal-skill');
      expect(result.declaredTools).toHaveLength(0);
    });

    it('should validate successfully', () => {
      const filePath = join(FIXTURES_DIR, 'minimal.md');
      const doc = parser.parse(filePath);
      const result = validator.validate(doc);

      expect(result.valid).toBe(true);
    });
  });

  describe('invalid fixtures', () => {
    it('should reject invalid YAML', () => {
      const filePath = join(FIXTURES_DIR, 'invalid-yaml.md');

      expect(() => parser.parse(filePath)).toThrow();
    });

    it('should reject missing frontmatter', () => {
      const filePath = join(FIXTURES_DIR, 'no-frontmatter.md');

      expect(() => parser.parse(filePath)).toThrow('Missing YAML frontmatter');
    });
  });
});
