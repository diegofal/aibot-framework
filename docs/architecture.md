# Architecture Overview

AIBot Framework is a modular, TypeScript-based system for building AI-powered Telegram bots with a plugin architecture.

## Core Components

### 1. Configuration System (`src/config.ts`)

- **Type-safe configuration** using Zod for validation
- **Environment variable substitution** with `${VAR_NAME}` syntax
- **Centralized settings** for bots, skills, Ollama, and logging

```typescript
const config = await loadConfig('./config/config.json');
```

### 2. Bot Manager (`src/bot.ts`)

- **Multi-bot support**: Run multiple Telegram bots simultaneously
- **Command registration**: Automatically registers commands from enabled skills
- **Authorization**: Per-bot user access control
- **Built with grammY**: Modern Telegram bot framework

### 3. Skill System (`src/core/`)

The skill system is the heart of the framework:

**Skill Loader** (`skill-loader.ts`):
- Dynamically loads skills from the skills directory
- Validates skill manifests
- Manages skill lifecycle

**Skill Registry** (`skill-registry.ts`):
- Maintains loaded skills
- Creates skill contexts with logger, Ollama, Telegram client
- Provides data store for persistent skill data

**Type Definitions** (`types.ts`):
- Defines the `Skill` interface
- Command handlers, job definitions
- Skill context with access to framework services

### 4. Scheduler (`src/scheduler.ts`)

- **Cross-platform job scheduling** using node-cron
- **Job management**: Add, remove, list scheduled jobs
- **Platform-specific exports**: Generate crontab, Task Scheduler XML, launchd plist

### 5. Ollama Client (`src/ollama.ts`)

- **Simple wrapper** around Ollama API
- **Automatic fallbacks**: Try multiple models if primary fails
- **Connection testing**: Ping and list models

### 6. Logger (`src/logger.ts`)

- **Structured logging** with Pino
- **Pretty printing** for development
- **File output** for production
- **Per-skill loggers** with context

## Data Flow

```
┌─────────────┐
│   User      │
│ (Telegram)  │
└──────┬──────┘
       │ /command
       v
┌─────────────┐
│ Bot Manager │  ← Receives command
└──────┬──────┘
       │
       v
┌─────────────┐
│   Skill     │  ← Command handler
│  Registry   │     executes
└──────┬──────┘
       │
       ├──→ Ollama Client ─→ LLM inference
       │
       ├──→ Logger ─→ Structured logs
       │
       └──→ Data Store ─→ Persistent data
```

## Skill Architecture

Each skill is self-contained:

```
src/skills/my-skill/
├── index.ts        # Main skill implementation
├── skill.json      # Manifest
├── README.md       # Documentation
└── ...             # Additional modules
```

**Skill Interface**:
```typescript
interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;

  onLoad?(context: SkillContext): Promise<void>;
  onUnload?(): Promise<void>;

  commands?: Record<string, CommandHandler>;
  jobs?: JobDefinition[];
  onMessage?(message: TelegramMessage, context: SkillContext): Promise<void>;
}
```

**Skill Context**:
Every skill receives a context with:
- `config`: Skill-specific configuration
- `logger`: Contextual logger
- `ollama`: Ollama client for AI inference
- `telegram`: Telegram client for sending messages
- `data`: Key-value store for persistent data

## Configuration Flow

```
config.json
    │
    ├─→ Environment variable substitution
    │
    ├─→ Zod schema validation
    │
    └─→ Typed Config object
         │
         ├─→ Bot Manager (bot configs)
         ├─→ Skill Registry (skill configs)
         ├─→ Ollama Client (ollama config)
         └─→ Logger (logging config)
```

## Execution Modes

### 1. Normal Mode (Bot + Scheduler)
```bash
bun run start
```
- Starts all enabled bots
- Initializes scheduler with all skill jobs
- Runs continuously

### 2. Single Job Mode
```bash
bun run start --job daily-intel-collection
```
- Executes a single scheduled job
- Exits after completion
- Used for cron/Task Scheduler integration

### 3. Development Mode
```bash
bun run dev
```
- Watch mode with auto-reload
- Immediate code changes

## Security Considerations

1. **Secrets Management**: Never commit tokens; use environment variables
2. **Authorization**: Per-bot `allowedUsers` array
3. **Input Validation**: Zod schemas for configuration
4. **Error Handling**: No stack traces to users; log to file
5. **Rate Limiting**: Respect API rate limits in skills

## Scalability

- **Horizontal**: Run multiple instances with different bot tokens
- **Vertical**: Node.js single-threaded but non-blocking I/O
- **Skills**: Add functionality without modifying core
- **Bots**: Add bots without code changes

## Extension Points

1. **New Skills**: Add to `src/skills/` directory
2. **Custom Loggers**: Implement Pino transport
3. **Data Stores**: Replace in-memory store with database
4. **Telegram Clients**: Extend `TelegramClient` interface

## Technology Stack

- **Runtime**: Bun (fast JavaScript runtime)
- **Language**: TypeScript (strict mode)
- **Bot Framework**: grammY
- **Validation**: Zod
- **Logging**: Pino
- **Scheduling**: node-cron
- **AI**: Ollama (self-hosted LLMs)

## Directory Structure

```
aibot-framework/
├── src/
│   ├── index.ts              # Main entry point
│   ├── bot.ts                # Bot manager
│   ├── config.ts             # Configuration
│   ├── logger.ts             # Logging
│   ├── scheduler.ts          # Job scheduling
│   ├── ollama.ts             # Ollama client
│   └── core/
│       ├── types.ts          # Type definitions
│       ├── skill-loader.ts   # Skill loading
│       └── skill-registry.ts # Skill management
├── scripts/
│   ├── setup.ts              # Interactive setup
│   ├── setup-cron.ts         # Cron helper
│   ├── add-skill.ts          # Skill generator
│   └── test-ollama.ts        # Ollama test
├── config/
│   ├── config.example.json   # Config template
│   └── sources.yml           # Intel sources
└── docs/
    ├── architecture.md       # This file
    ├── skills.md             # Skill development
    ├── deployment.md         # Deployment guide
    └── cron-setup.md         # Scheduling guide
```
