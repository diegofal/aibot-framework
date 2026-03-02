#!/usr/bin/env bun
/**
 * Interactive setup wizard for AIBot Framework
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  log('║        AIBot Framework - Setup Wizard v1.0.0             ║', BOLD);
  log('╚══════════════════════════════════════════════════════════╝', BOLD);
  log('');

  // Check if config already exists
  if (existsSync('./config/config.json') || existsSync('./config/bots.json')) {
    log('⚠️  config.json / bots.json already exist!', YELLOW);
    const overwrite = await prompt('Overwrite? (yes/no):');
    if (overwrite.toLowerCase() !== 'yes') {
      log('Setup cancelled.', RED);
      process.exit(0);
    }
  }

  log('This wizard will help you configure your AIBot Framework.\n', GREEN);

  // Load example config + bots
  const exampleConfig = JSON.parse(readFileSync('./config/config.example.json', 'utf-8'));
  const exampleBots = JSON.parse(readFileSync('./config/bots.example.json', 'utf-8'));

  // Telegram Bot Token
  log('═══ Telegram Configuration ═══', BOLD);
  const botToken = await prompt('Enter your Telegram bot token:');
  if (botToken) {
    exampleBots[0].token = botToken;
  }

  const allowedUsers = await prompt('Allowed user IDs (comma-separated, or leave empty for all):');
  if (allowedUsers) {
    exampleBots[0].allowedUsers = allowedUsers.split(',').map((id) => Number.parseInt(id.trim()));
  }

  // Ollama Configuration
  log('\n═══ Ollama Configuration ═══', BOLD);
  const ollamaUrl = await prompt('Ollama base URL (default: http://127.0.0.1:11434):');
  if (ollamaUrl) {
    exampleConfig.ollama.baseUrl = ollamaUrl;
  }

  const primaryModel = await prompt('Primary model (default: llama3.3):');
  if (primaryModel) {
    exampleConfig.ollama.models.primary = primaryModel;
  }

  // Test Ollama connection
  log('\n🔌 Testing Ollama connection...', BLUE);
  try {
    const res = await fetch(`${exampleConfig.ollama.baseUrl}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      log(`✅ Ollama connected! Available models: ${data.models?.length || 0}`, GREEN);
    } else {
      log(`⚠️  Ollama not responding (${res.status})`, YELLOW);
    }
  } catch (error) {
    log("⚠️  Could not connect to Ollama. Make sure it's running.", YELLOW);
  }

  // Skills Configuration
  log('\n═══ Skills Configuration ═══', BOLD);
  const enableExample = await prompt('Enable example skill? (yes/no):');
  const enableIntel = await prompt('Enable intel-gatherer skill? (yes/no):');

  const enabledSkills: string[] = [];
  if (enableExample.toLowerCase() === 'yes') enabledSkills.push('example');
  if (enableIntel.toLowerCase() === 'yes') enabledSkills.push('intel-gatherer');

  exampleConfig.skills.enabled = enabledSkills;
  exampleBots[0].skills = enabledSkills;

  // Intel-gatherer specific config
  if (enableIntel.toLowerCase() === 'yes') {
    log('\n═══ Intel-Gatherer Configuration ═══', BOLD);
    const intelChatId = await prompt('Telegram chat ID for daily reports (optional):');
    if (intelChatId) {
      exampleConfig.skills.config['intel-gatherer'].telegramChatId = Number.parseInt(intelChatId);
    }
  }

  // Logging
  log('\n═══ Logging Configuration ═══', BOLD);
  const logLevel = await prompt('Log level (debug/info/warn/error, default: info):');
  if (logLevel && ['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    exampleConfig.logging.level = logLevel;
  }

  // Create directories
  log('\n📁 Creating directories...', BLUE);
  const dirs = [
    './data',
    './data/logs',
    './data/intel',
    './data/intel/raw',
    './data/intel/trends',
    './data/intel/highlights',
    './data/intel/html',
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log(`  Created: ${dir}`, GREEN);
    }
  }

  // Save configuration
  log('\n💾 Saving configuration...', BLUE);
  writeFileSync('./config/config.json', `${JSON.stringify(exampleConfig, null, 2)}\n`);
  log('  Saved: ./config/config.json', GREEN);
  writeFileSync('./config/bots.json', `${JSON.stringify(exampleBots, null, 2)}\n`);
  log('  Saved: ./config/bots.json', GREEN);

  // Create .env file
  log('\n📝 Creating .env file...', BLUE);
  const envContent = `# Telegram Bot Tokens
TELEGRAM_BOT_TOKEN=${botToken || 'your-telegram-bot-token'}

# Ollama Configuration
OLLAMA_BASE_URL=${exampleConfig.ollama.baseUrl}

# Logging
LOG_LEVEL=${exampleConfig.logging.level}
`;
  writeFileSync('./.env', envContent);
  log('  Saved: ./.env', GREEN);

  // Summary
  log('\n╔══════════════════════════════════════════════════════════╗', BOLD);
  log('║                 ✅ Setup Complete!                        ║', GREEN);
  log('╚══════════════════════════════════════════════════════════╝', BOLD);
  log('');
  log('📋 Next steps:', YELLOW);
  log('  1. Review ./config/config.json', YELLOW);
  log('  2. Customize ./config/sources.yml (for intel-gatherer)', YELLOW);
  log('  3. Run: bun run start', YELLOW);
  log('');
  log('📚 Documentation: ./docs/', BLUE);
  log('❓ Need help? Check README.md', BLUE);

  process.exit(0);
}

process.stdin.setRawMode(false);
main().catch(console.error);
