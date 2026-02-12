import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../logger';
import type { Skill, SkillManifest } from './types';

export class SkillLoader {
  constructor(
    private skillsPath: string,
    private logger: Logger
  ) {}

  /**
   * Load a skill from disk
   */
  async loadSkill(skillId: string): Promise<Skill> {
    const skillDir = join(this.skillsPath, skillId);

    try {
      // Load manifest
      const manifest = await this.loadManifest(skillDir);

      // Validate manifest
      if (manifest.id !== skillId) {
        throw new Error(
          `Skill ID mismatch: expected ${skillId}, got ${manifest.id}`
        );
      }

      // Load skill module
      const mainPath = resolve(join(skillDir, manifest.main));
      // Use file:// URL for dynamic import
      const fileUrl = `file://${mainPath}`;
      const module = await import(fileUrl);

      // Get default export
      const skill: Skill = module.default;

      if (!skill) {
        throw new Error('Skill module must have a default export');
      }

      // Merge manifest data
      skill.id = manifest.id;
      skill.name = manifest.name;
      skill.version = manifest.version;
      skill.description = manifest.description;

      this.logger.info(
        { skillId: skill.id, version: skill.version },
        'Skill loaded successfully'
      );

      return skill;
    } catch (error) {
      this.logger.error({ error, skillId }, 'Failed to load skill');
      throw new Error(`Failed to load skill ${skillId}: ${error}`);
    }
  }

  /**
   * Load skill manifest (skill.json)
   */
  private async loadManifest(skillDir: string): Promise<SkillManifest> {
    const manifestPath = join(skillDir, 'skill.json');

    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest: SkillManifest = JSON.parse(content);

      // Validate required fields
      if (!manifest.id || !manifest.name || !manifest.version || !manifest.main) {
        throw new Error('Manifest missing required fields');
      }

      return manifest;
    } catch (error) {
      throw new Error(`Failed to load manifest: ${error}`);
    }
  }

  /**
   * List available skills
   */
  async listSkills(): Promise<string[]> {
    try {
      const { readdirSync } = await import('node:fs');
      const { statSync } = await import('node:fs');

      const entries = readdirSync(this.skillsPath);
      const skills: string[] = [];

      for (const entry of entries) {
        const fullPath = join(this.skillsPath, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          const manifestPath = join(fullPath, 'skill.json');
          try {
            statSync(manifestPath);
            skills.push(entry);
          } catch {
            // No manifest, skip
          }
        }
      }

      return skills;
    } catch (error) {
      this.logger.error({ error }, 'Failed to list skills');
      return [];
    }
  }
}
