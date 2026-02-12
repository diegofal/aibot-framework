# AIBot Framework

AI-powered skills framework with Telegram integration, built with TypeScript and Bun.

## Features

- **Multi-Bot Support**: Run multiple Telegram bots simultaneously
- **Skills System**: Extensible plugin architecture for adding new capabilities
- **AI Integration**: Ollama integration for LLM-powered features
- **Cross-Platform**: Works on Linux, macOS, and Windows
- **Type-Safe**: Full TypeScript implementation with strict typing
- **Scheduled Jobs**: Built-in cron-like scheduler for automated tasks

## Quick Start

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Run setup wizard**:
   ```bash
   bun run setup
   ```

3. **Start the bot**:
   ```bash
   bun run start
   ```

## Project Structure

```
aibot-framework/
├── src/
│   ├── index.ts              # Main entry point
│   ├── bot.ts                # Telegram bot manager
│   ├── config.ts             # Configuration loader
│   ├── logger.ts             # Logging utility
│   ├── scheduler.ts          # Job scheduler
│   ├── ollama.ts             # Ollama client
│   ├── core/                 # Core skill system
│   │   ├── types.ts
│   │   ├── skill-loader.ts
│   │   └── skill-registry.ts
│   └── skills/               # Skills directory
│       ├── example/          # Example skill
│       └── intel-gatherer/   # Intelligence gathering skill
├── config/
│   ├── config.example.json   # Configuration template
│   └── sources.yml           # Intel sources configuration
├── scripts/
│   ├── setup.ts              # Setup wizard
│   ├── setup-cron.ts         # Cron setup helper
│   └── test-ollama.ts        # Ollama connection test
└── docs/                     # Documentation
```

## Configuration

Copy `config/config.example.json` to `config/config.json` and update with your settings:

- **Telegram Bot Tokens**: Get from [@BotFather](https://t.me/botfather)
- **Ollama**: Ensure Ollama is running locally or update the URL
- **Skills**: Enable/disable skills and configure per-skill settings

See [docs/deployment.md](docs/deployment.md) for detailed configuration guide.

## Available Skills

### Example Skill
Basic demonstration skill with:
- `/ping` - Responds with pong
- `/echo <message>` - Echoes your message
- `/ai <question>` - Ask the AI a question

### Intel Gatherer
Intelligence collection and analysis from multiple sources:
- `/intel collect` - Run data collection
- `/intel analyze` - Analyze trends
- `/intel today` - Show today's report

## Creating Skills

See [docs/skills.md](docs/skills.md) for a guide on creating new skills.

Quick start:
```bash
bun run add-skill
```

## Scheduling

Set up automated jobs using the built-in scheduler or system cron:

```bash
bun run setup-cron
```

See [docs/cron-setup.md](docs/cron-setup.md) for platform-specific instructions.

## Development

```bash
# Run in development mode with auto-reload
bun run dev

# Run linter
bun run lint

# Format code
bun run format

# Run tests
bun run test
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed architecture documentation.

## License

MIT

## Author

Diego Falciola
