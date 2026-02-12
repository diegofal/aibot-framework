#!/usr/bin/env bun
/**
 * Skill generator CLI
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function log(message: string, color = '') {
  console.log(`${color}${message}${RESET}`);
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${BLUE}${question}${RESET} `);
    process.stdin.once('data', (data) => {
      resolve(data.toString().trim());
    });
  });
}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗', BOLD);
  log('║            AIBot Framework - Skill Generator             ║', BOLD);
  log('╚══════════════════════════════════════════════════════════╝', BOLD);
  log('');

  // Get skill details
  const skillId = await prompt('Skill ID (lowercase, no spaces):');
  if (!skillId || !/^[a-z][a-z0-9-]*$/.test(skillId)) {
    log('❌ Invalid skill ID. Use lowercase letters, numbers, and hyphens only.', RED);
    process.exit(1);
  }

  const skillName = await prompt('Skill name (display name):');
  const skillDescription = await prompt('Description:');
  const skillAuthor = await prompt('Author (optional):');

  // Check if skill already exists
  const skillDir = join('./src/skills', skillId);
  if (existsSync(skillDir)) {
    log(`❌ Skill directory already exists: ${skillDir}`, RED);
    process.exit(1);
  }

  // Create skill directory
  log(`\n📁 Creating skill directory: ${skillDir}`, BLUE);
  mkdirSync(skillDir, { recursive: true });

  // Generate skill.json
  const manifest = {
    id: skillId,
    name: skillName || skillId,
    version: '1.0.0',
    description: skillDescription || 'A new skill',
    author: skillAuthor || '',
    main: './index.ts',
  };

  writeFileSync(join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2));
  log('  Created: skill.json', GREEN);

  // Generate index.ts
  const indexTemplate = `import type { Skill, SkillContext } from '../../core/types';

const skill: Skill = {
  id: '${skillId}',
  name: '${skillName || skillId}',
  version: '1.0.0',
  description: '${skillDescription || 'A new skill'}',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('${skillName || skillId} skill loaded');
  },

  commands: {
    ${skillId.replace(/-/g, '_')}: {
      description: '${skillDescription || 'Main command'}',
      async handler(args: string[], ctx: SkillContext) {
        return \`✅ ${skillName || skillId} command executed!\`;
      },
    },
  },
};

export default skill;
`;

  writeFileSync(join(skillDir, 'index.ts'), indexTemplate);
  log('  Created: index.ts', GREEN);

  // Generate README.md
  const readmeTemplate = `# ${skillName || skillId}

${skillDescription || 'A new skill for AIBot Framework'}

## Commands

### /${skillId}
Main command for this skill.

**Usage**: \`/${skillId}\`

## Configuration

Add to your \`config.json\`:

\`\`\`json
{
  "skills": {
    "enabled": ["${skillId}"],
    "config": {
      "${skillId}": {
        // Your configuration here
      }
    }
  }
}
\`\`\`

## Development

1. Edit \`src/skills/${skillId}/index.ts\` to add functionality
2. Update skill.json if needed
3. Test with: \`bun run dev\`

## Author

${skillAuthor || 'Your Name'}
`;

  writeFileSync(join(skillDir, 'README.md'), readmeTemplate);
  log('  Created: README.md', GREEN);

  // Summary
  log('\n╔══════════════════════════════════════════════════════════╗', BOLD);
  log('║              ✅ Skill created successfully!               ║', GREEN);
  log('╚══════════════════════════════════════════════════════════╝', BOLD);
  log('');
  log('📋 Next steps:', YELLOW);
  log(`  1. Edit src/skills/${skillId}/index.ts to implement your skill`, BLUE);
  log(`  2. Add "${skillId}" to config.json skills.enabled array`, BLUE);
  log('  3. Test with: bun run dev', BLUE);
  log('');
  log(`📂 Skill location: ${skillDir}`, BLUE);

  process.exit(0);
}

process.stdin.setRawMode(false);
main().catch(console.error);
