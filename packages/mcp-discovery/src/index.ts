/**
 * MCP Discovery Server — Entry Point
 *
 * A stdio-based MCP server that exposes two tools:
 *   - discover_agents: List agents with optional filtering
 *   - get_agent_card: Get detailed info about a specific agent
 *
 * Reads agent data from the framework's config.json at startup.
 *
 * Usage:
 *   bun run src/index.ts [--config path/to/config.json] [--soul-dir path/to/soul]
 */

import { createAgentDataLoader } from './agent-data.js';
import { createMcpServer } from './mcp-server.js';
import { createStdioTransport } from './stdio-transport.js';

function parseArgs(args: string[]): { configPath: string; soulDir?: string } {
  let configPath = './config/config.json';
  let soulDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    } else if (args[i] === '--soul-dir' && args[i + 1]) {
      soulDir = args[i + 1];
      i++;
    }
  }

  return { configPath, soulDir };
}

const { configPath, soulDir } = parseArgs(process.argv.slice(2));

const loader = createAgentDataLoader(configPath, soulDir);
const server = createMcpServer(loader);
const transport = createStdioTransport(server);

transport.start();
