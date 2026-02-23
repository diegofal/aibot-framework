# AIBot Framework

Autonomous AI agent framework with Telegram, semantic memory, and multi-bot collaboration.

Built with TypeScript and Bun. Agents have persistent personalities, goals, and memory — they plan, execute, learn from feedback, and collaborate with each other.

## Key Highlights

- **Multi-bot orchestration** — Run multiple Telegram bots from a single instance, each with its own personality, goals, and memory
- **Autonomous agent loop** — Planner-executor pattern with configurable cadence, retry, and idle detection
- **Soul & memory system** — Layered personality files (IDENTITY, SOUL, MOTIVATIONS, GOALS) + semantic search (RAG) over daily memory logs
- **Bot-to-bot collaboration** — Visible, internal, and delegation modes with multi-turn session support
- **Web dashboard** — Real-time monitoring, agent CRUD, session viewer, cron manager, productions review, karma scores
- **Skills & tools** — 8 bundled skills, 20+ LLM-callable tools, dynamic tool creation at runtime
- **Productions & karma** — Track and review bot outputs, score quality with time-decayed karma
- **Multi-backend LLM** — Ollama (local) + Claude CLI with automatic fallback

## Quick Start

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Run setup wizard:**
   ```bash
   bun run setup
   ```

3. **Start:**
   ```bash
   bun run start
   ```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      BotManager                         │
│                     (facade)                            │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ Tenant   │ Tool     │ System   │ Memory   │ Group       │
│ Facade   │ Registry │ Prompt   │ Flusher  │ Activation  │
│          │          │ Builder  │          │             │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│  ConversationPipeline  │  CollaborationManager          │
│  ConversationGate      │  (visible/internal/delegation) │
├────────────────────────┴────────────────────────────────┤
│                    Agent Loop                           │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐ │
│  │ Scheduler│ │ Planner  │ │Strategist │ │RetryEngine│ │
│  └──────────┘ └──────────┘ └───────────┘ └───────────┘ │
├─────────────────────────────────────────────────────────┤
│          LLM Backends: Ollama │ Claude CLI              │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── bot/                    # Bot core (30+ modules)
│   ├── bot-manager.ts      #   Facade: constructor, start/stop, sendMessage
│   ├── conversation-pipeline.ts  #   Session expiry, RAG, LLM call, reply
│   ├── conversation-gate.ts      #   Auth, group, bot-to-bot gates
│   ├── collaboration.ts    #   Bot-to-bot collaboration modes
│   ├── agent-loop.ts       #   Autonomous agent orchestrator
│   ├── agent-planner.ts    #   LLM planner with retry
│   ├── agent-strategist.ts #   Goal reflection and cadence
│   ├── tool-registry.ts    #   Tool init, executor, filtering
│   ├── system-prompt-builder.ts  #   Prompt composition
│   ├── soul-health-check.ts     #   Soul lint + consolidation
│   └── ...                 #   20+ more focused modules
├── tools/                  # 20+ LLM-callable tools
│   ├── browser.ts          #   Playwright browser automation
│   ├── web-search.ts       #   Web search
│   ├── web-fetch.ts        #   Web fetch + markdown conversion
│   ├── file.ts             #   file_read, file_write, file_edit
│   ├── exec.ts             #   Shell execution (sandboxed)
│   ├── soul.ts             #   update_soul, update_identity
│   ├── goals.ts            #   manage_goals
│   ├── collaborate.ts      #   Bot-to-bot collaboration
│   ├── delegate.ts         #   One-shot delegation
│   └── ...                 #   10+ more tools
├── skills/                 # Extensible plugin system
│   ├── reflection/         #   Nightly 4-phase personality evolution
│   ├── intel-gatherer/     #   News & intelligence collection
│   ├── improve/            #   Self-improvement via Claude Code CLI
│   ├── calibrate/          #   Personality calibration
│   ├── humanizer/          #   Anti-AI-writing guidelines
│   ├── phone-call/         #   Twilio voice calls
│   ├── mcp-client/         #   MCP server integration
│   └── example/            #   Template for new skills
├── memory/                 # Semantic search & RAG
│   └── manager.ts          #   Hybrid vector + FTS5 search (SQLite)
├── core/                   # Skill loader, registry, config schemas
├── karma/                  # Per-bot quality scoring (0-100)
├── productions/            # Bot output tracking & review
├── tenant/                 # Multi-tenant billing & metering
├── web/                    # Hono-based dashboard + REST API
├── cron/                   # Scheduled jobs engine
├── ollama.ts               # Ollama client (chat, embeddings, vision)
├── claude-cli.ts           # Claude CLI subprocess client
├── config.ts               # Zod-validated config loader
└── index.ts                # Entry point
```

## Core Systems

### Bot Core & Conversation Pipeline

The conversation pipeline handles session management, RAG prefetch, LLM calls, tool execution, and message splitting for Telegram limits. Each message goes through `ConversationGate` (auth, group activation, bot-to-bot checks) before reaching the pipeline.

### Agent Loop

Autonomous planner-executor pattern running on configurable intervals. The **planner** decides what to do based on goals, memory, karma, and recent actions. The **strategist** handles goal reflection and focus. The **executor** runs plans with full tool access. Includes exponential backoff retry, idle detection, and novelty enforcement to prevent busywork.

### Soul & Memory

Each bot has layered personality files (`IDENTITY.md`, `SOUL.md`, `MOTIVATIONS.md`, `GOALS.md`) in `souls/<botId>/`. Daily memory logs capture facts with timestamps. Memory consolidation merges daily logs into `MEMORY.md` via Claude CLI. Semantic search uses hybrid vector + FTS5 via SQLite for RAG-augmented conversations.

### Skills System

Plugin architecture with `skill.json` manifests. Skills register commands, scheduled jobs, message handlers, and callback handlers. External skills from configurable directories are loaded with namespace isolation. Per-bot `disabledSkills` control.

### Tools

20+ LLM-callable tools covering web (search, fetch, browser), files (read, write, edit), execution, soul/memory management, goals, collaboration, cron, and more. Dynamic tool creation allows bots to build new tools at runtime (with human approval). Per-bot `disabledTools` filtering.

### Bot-to-Bot Collaboration

Three modes: **visible** (public multi-turn with @mentions), **internal** (behind-the-scenes with tools), and **delegation** (one-shot). Agent discovery, session management, rate limiting, and collaboration-safe tool filtering.

### Web Dashboard & API

Hono-based server with SPA frontend and WebSocket log streaming. Pages: Dashboard (agent loop status), Agents (CRUD, soul generation), Sessions, Cron, Tools (dynamic tool approval), Skills, Productions (review & feedback), Karma, Integrations, Settings. 25+ REST API endpoints.

### Tenant System

Multi-tenant billing and metering delegated from BotManager via `TenantFacade`.

### Productions & Karma

Productions track and review bot outputs with approve/reject, ratings, and threaded feedback. Karma is a time-decayed quality score (0-100) based on production evaluations, tool errors, novelty, and manual adjustments. Injected into planner prompts so bots learn from their track record.

## Configuration

Configuration lives in `config/config.json`, validated at startup by Zod schemas in `src/config.ts`. Key sections:

- **`bots[]`** — Per-bot: token, model, allowedUsers, disabledTools, disabledSkills, workDir, llmBackend
- **`ollama`** — URL, default model, timeout, embedding model
- **`agentLoop`** — Interval, maxDuration, retry, concurrency, idle suppression
- **`soul`** — Health check, memory consolidation, search config
- **`productions`** — Base dir, track-only mode
- **`browserTools`** — Enabled, headless, timeouts, URL allow/block lists
- **`skillsFolders`** — External skill directory paths
- **`tenant`** — Billing and metering settings

Copy `config/config.example.json` to `config/config.json` and run `bun run setup` for guided configuration.

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `reflection` | Nightly 4-phase cycle: analysis, web exploration, personality evolution |
| `intel-gatherer` | Multi-source intelligence collection and trend analysis |
| `improve` | Self-improvement via Claude Code CLI with restricted permissions |
| `calibrate` | Personality and behavior calibration |
| `humanizer` | Anti-AI-writing guidelines injected into system prompt |
| `phone-call` | Voice calls via Twilio |
| `mcp-client` | MCP (Model Context Protocol) server integration |
| `example` | Template for creating new skills |

## Web Dashboard

```
Dashboard    — Agent loop schedules, last results, run-now triggers
Agents       — Bot CRUD, soul generation, start/stop, tools config
Sessions     — Conversation transcripts with pagination
Cron         — Job management, force-run, run logs
Tools        — Dynamic tool approval/rejection queue
Skills       — Built-in + external skills browser
Productions  — Bot output review, ratings, threaded feedback
Karma        — Per-bot quality scores, trends, manual adjustment
Integrations — Ollama diagnostic chat
Settings     — Session, collaboration, skill folders config
```

## Development

```bash
# Run in development mode with auto-reload
bun run dev

# Run tests
bun test

# Type check (no build step — Bun runs TS directly)
npx tsc --noEmit

# Lint
bun run lint

# Format
bun run format
```

## Documentation

- **[docs/architecture.md](docs/architecture.md)** — System architecture overview
- **[docs/features.md](docs/features.md)** — Complete feature catalog
- **[docs/skills.md](docs/skills.md)** — Skills development guide
- **[docs/tools.md](docs/tools.md)** — Tools reference
- **[docs/soul-and-memory.md](docs/soul-and-memory.md)** — Memory and personality system
- **[docs/deployment.md](docs/deployment.md)** — Deployment and configuration guide
- **[docs/architecture-docs/](docs/architecture-docs/)** — Interactive HTML documentation with dependency graphs and diagrams

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| Bot framework | [grammY](https://grammy.dev) |
| Web server | [Hono](https://hono.dev) |
| Database | SQLite (via bun:sqlite) |
| LLM (local) | [Ollama](https://ollama.ai) |
| LLM (cloud) | Claude CLI |
| Validation | [Zod](https://zod.dev) |
| Logging | [pino](https://getpino.io) |
| Browser | [Playwright](https://playwright.dev) |
| Scheduling | [croner](https://github.com/hexagon/croner) |

## License

MIT

## Author

Diego Falciola
