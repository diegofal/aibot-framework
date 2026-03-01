#!/usr/bin/env bun
/**
 * Test Ollama connection and list available models
 */

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function log(message: string, color = '') {
  console.log(`${color}${message}${RESET}`);
}

async function main() {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

  log('╔══════════════════════════════════════════════════════════╗', BOLD);
  log('║            Ollama Connection Test                        ║', BOLD);
  log('╚══════════════════════════════════════════════════════════╝', BOLD);
  log('');
  log(`Testing connection to: ${baseUrl}\n`, BLUE);

  try {
    // Test connection
    log('🔌 Connecting to Ollama...', BLUE);
    const res = await fetch(`${baseUrl}/api/tags`);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    log('✅ Connection successful!\n', GREEN);

    // List models
    if (data.models && data.models.length > 0) {
      log(`📦 Available models (${data.models.length}):\n`, BOLD);

      for (const model of data.models) {
        log(`  • ${model.name}`, GREEN);
        log(`    Size: ${(model.size / 1024 / 1024 / 1024).toFixed(2)} GB`, BLUE);
        if (model.modified_at) {
          log(`    Modified: ${new Date(model.modified_at).toLocaleString()}`, BLUE);
        }
        log('');
      }
    } else {
      log('⚠️  No models found. Pull a model with: ollama pull llama3.3', 'yellow');
    }

    // Test generation (quick test)
    log('🤖 Testing text generation...', BLUE);
    const testRes = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: data.models[0]?.name || 'llama3.3',
        prompt: 'Say "Hello" in one word',
        stream: false,
      }),
    });

    if (testRes.ok) {
      const testData = await testRes.json();
      log(`✅ Generation test passed: "${testData.response.trim()}"\n`, GREEN);
    } else {
      log('⚠️  Generation test failed (but connection is OK)\n', 'yellow');
    }

    log('╔══════════════════════════════════════════════════════════╗', BOLD);
    log('║                 ✅ All tests passed!                     ║', GREEN);
    log('╚══════════════════════════════════════════════════════════╝', BOLD);
  } catch (error: any) {
    log('╔══════════════════════════════════════════════════════════╗', BOLD);
    log('║                  ❌ Connection failed                    ║', RED);
    log('╚══════════════════════════════════════════════════════════╝', BOLD);
    log('');
    log(`Error: ${error.message}\n`, RED);
    log('Troubleshooting:', BOLD);
    log('  1. Make sure Ollama is running: ollama serve', BLUE);
    log('  2. Check if the URL is correct:', BLUE);
    log(`     ${baseUrl}`, BLUE);
    log('  3. Try pulling a model: ollama pull llama3.3', BLUE);
    log('');
    process.exit(1);
  }
}

main().catch(console.error);
