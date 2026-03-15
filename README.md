# AIBot Framework

Autonomous AI agent framework with Telegram, semantic memory, and multi-bot collaboration.

Built with TypeScript and Bun. Agents have persistent personalities, goals, and memory — they plan, execute, learn from feedback, and collaborate with each other.

## Key Highlights

- **Multi-bot orchestration** — Run multiple Telegram bots from a single instance, each with its own personality, goals, and memory
- **Autonomous agent loop** — Planner-executor pattern with configurable cadence, retry, and idle detection
- **Soul & memory system** — Layered personality files (IDENTITY, SOUL, MOTIVATIONS, GOALS) + semantic search (RAG) over daily memory logs
- **Bot-to-bot collaboration** — Visible, internal, and delegation modes with multi-turn session support
- **Web dashboard** — Real-time monitoring, agent CRUD, session viewer, cron manager, productions review, karma scores
- **Skills & tools** — 15 bundled skills, 41 LLM-callable tools, dynamic tool & agent creation at runtime
- **Multi-tenant BaaS** — Shared-infrastructure multi-tenancy with tenant isolation, quota enforcement, rate limiting, and per-tenant config overrides
- **Username/password auth** — Session-based dashboard login with admin setup, dual auth (session tokens for UI, API keys for programmatic access)
- **Bot export/import** — Portable `.tar.gz` archives for full bot backup and restoration (soul, config, memory, productions)
- **AI Coach/Student platform** — Per-user goals, topic guard, proactive messaging, identity verification, REST Chat API, and agent loop user awareness for building coaching/tutoring bots
- **Context compaction** — LLM-based conversation summarization to stay within token limits
- **MCP tool bridge** — Claude CLI can call framework tools natively via Model Context Protocol
- **Activity stream** — Real-time event feed with WebSocket streaming
- **TTS & STT** — ElevenLabs voice responses + Whisper transcription for voice messages
- **Permissions system** — Human-in-the-loop approval queue for sensitive agent actions
- **Productions & karma** — Track and review bot outputs, score quality with time-decayed karma
- **Multi-backend LLM** — Ollama (local) + Claude CLI with model failover orchestrator, cooldown tracking, and error classification
- **Lifecycle hooks** — 8 EventEmitter-based hooks (message, LLM, tool, compaction, agent loop) for skill/extension integration
- **Streaming responses** — Token-by-token streaming for Ollama with progressive Telegram message editing and WebSocket chunk events
- **A2A Protocol** — Agent-to-agent communication (v0.3.0) with JSON-RPC server, client, agent directory, and skill-to-tool adaptation
- **Multi-channel** — Telegram, WhatsApp (Cloud API), REST, WebSocket widget, Discord (Gateway + REST)

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
│  ContextCompactor      │  MCP Bridge                    │
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
├── bot/                    # Bot core (40 modules)
│   ├── bot-manager.ts      #   Facade: constructor, start/stop, sendMessage
│   ├── conversation-pipeline.ts  #   Session expiry, RAG, LLM call, reply
│   ├── conversation-gate.ts      #   Auth, group, bot-to-bot gates
│   ├── context-compaction.ts     #   LLM-based context summarization
│   ├── collaboration.ts    #   Bot-to-bot collaboration modes
│   ├── agent-loop.ts       #   Autonomous agent orchestrator
│   ├── agent-planner.ts    #   LLM planner with retry
│   ├── agent-strategist.ts #   Goal reflection and cadence
│   ├── tool-registry.ts    #   Tool init, executor, filtering
│   ├── system-prompt-builder.ts  #   Prompt composition
│   ├── ask-permission-store.ts   #   Human-in-the-loop approval queue
│   ├── bot-export-service.ts    #   Bot backup/restore as .tar.gz
│   ├── bot-reset.ts             #   22-step comprehensive bot reset
│   ├── tool-loop-detector.ts    #   4-strategy tool loop detection
│   ├── soul-health-check.ts     #   Soul lint + consolidation
│   └── ...                 #   25+ more focused modules
├── tools/                  # 41 LLM-callable tools
│   ├── browser.ts          #   Playwright browser automation
│   ├── web-search.ts       #   Web search
│   ├── web-fetch.ts        #   Web fetch + markdown conversion
│   ├── file.ts             #   file_read, file_write, file_edit
│   ├── exec.ts             #   Shell execution (sandboxed)
│   ├── soul.ts             #   update_soul, update_identity
│   ├── goals.ts            #   manage_goals
│   ├── collaborate.ts      #   Bot-to-bot collaboration
│   ├── delegate.ts         #   One-shot delegation
│   ├── core-memory.ts      #   Structured core memory CRUD
│   ├── recall-memory.ts    #   Recall from daily memory logs
│   ├── memory-search.ts    #   Semantic memory search (RAG)
│   ├── ask-permission.ts   #   Request human approval
│   ├── production-log.ts   #   Log productions for review
│   ├── create-agent.ts     #   Propose new agents (human-approved)
│   ├── reddit.ts           #   Reddit API integration
│   ├── twitter.ts          #   Twitter/X API integration
│   ├── calendar.ts         #   Google Calendar integration
│   └── ...                 #   15+ more tools
├── skills/                 # 15 bundled skills (plugin system)
│   ├── reflection/         #   Nightly 4-phase personality evolution
│   ├── intel-gatherer/     #   News & intelligence collection
│   ├── improve/            #   Self-improvement via Claude Code CLI
│   ├── calibrate/          #   Personality calibration
│   ├── humanizer/          #   Anti-AI-writing guidelines
│   ├── phone-call/         #   Twilio voice calls
│   ├── mcp-client/         #   MCP server integration
│   ├── daily-priorities/   #   Daily goal prioritization
│   ├── daily-briefing/     #   Morning briefing generation
│   ├── quick-notes/        #   Quick note-taking
│   ├── reminders/          #   Scheduled reminders
│   ├── task-tracker/       #   Task management
│   ├── reddit/             #   Reddit browsing & posting
│   ├── calendar/           #   Calendar management
│   └── example/            #   Template for new skills
├── channel/                # Channel adapters (multi-platform)
│   ├── telegram.ts         #   Grammy Context adapter
│   ├── whatsapp.ts         #   WhatsApp Cloud API (images, buttons, status)
│   ├── discord.ts          #   Discord REST API adapter
│   ├── discord-gateway.ts  #   Discord Gateway WebSocket
│   ├── websocket.ts        #   Widget chat + streaming
│   ├── rest.ts             #   REST API adapter
│   └── outbound.ts         #   Proactive message delivery factory
├── a2a/                    # Agent-to-Agent Protocol (v0.3.0)
│   ├── server.ts           #   JSON-RPC handler + directory endpoints
│   ├── client.ts           #   HTTP client for external agents
│   ├── directory.ts        #   Agent registry with heartbeat/discovery
│   ├── task-store.ts       #   In-memory task lifecycle
│   ├── executor.ts         #   Headless LLM message processor
│   └── tool-adapter.ts     #   A2A skills → framework tools
├── mcp/                    # Model Context Protocol (bidirectional)
│   ├── client.ts           #   Connect to external MCP servers
│   ├── client-pool.ts      #   Multi-server connection pool
│   ├── server.ts           #   Expose tools to external clients
│   ├── agent-bridge.ts     #   Agent-to-agent via MCP
│   ├── tool-adapter.ts     #   MCP ↔ framework tool conversion
│   └── tool-bridge-server.ts  #   Claude CLI ↔ framework tools
├── memory/                 # Semantic search & RAG (with temporal decay)
│   └── manager.ts          #   Hybrid vector + FTS5 search (SQLite)
├── core/                   # Skill loader, registry, config schemas, SKILL.md adapter
├── karma/                  # Per-bot quality scoring (0-100)
├── productions/            # Bot output tracking & review
├── tenant/                 # Multi-tenant BaaS infrastructure
│   ├── manager.ts          #   Tenant CRUD & API key management
│   ├── rate-limiter.ts     #   Sliding-window rate limiting
│   ├── tenant-config.ts    #   Per-tenant config overrides
│   ├── session-store.ts    #   In-memory session management
│   └── admin-credentials.ts #  Admin password hashing (argon2id)
├── web/                    # Hono-based dashboard + REST API
├── cron/                   # Scheduled jobs engine
├── ollama.ts               # Ollama client (chat, embeddings, vision)
├── claude-cli.ts           # Claude CLI subprocess client
├── tts.ts                  # ElevenLabs TTS client
├── config.ts               # Zod-validated config loader
└── index.ts                # Entry point
```

## Core Systems

### Bot Core & Conversation Pipeline

The conversation pipeline handles session management, RAG prefetch, LLM calls, tool execution, and message splitting for Telegram limits. Each message goes through `ConversationGate` (auth, group activation, bot-to-bot checks) before reaching the pipeline.

### Agent Loop

Autonomous planner-executor pattern running on configurable intervals. The **planner** decides what to do based on goals, memory, karma, and recent actions. The **strategist** handles goal reflection and focus. The **executor** runs plans with full tool access. Includes exponential backoff retry, idle detection, and novelty enforcement to prevent busywork.

### Soul & Memory

Each bot has layered personality files (`IDENTITY.md`, `SOUL.md`, `MOTIVATIONS.md`, `GOALS.md`) in `souls/<botId>/`. Daily memory logs capture facts with timestamps. Memory consolidation merges daily logs into `MEMORY.md` via Claude CLI. Semantic search uses hybrid vector + FTS5 via SQLite for RAG-augmented conversations with exponential temporal decay scoring (recent memories ranked higher, configurable half-life).

### Context Compaction

LLM-based conversation summarization when sessions approach token limits. The `ContextCompactor` estimates token counts, truncates old messages, and generates summaries to keep conversations within bounds. Includes overflow retry — if an LLM call fails due to context size, it compacts and retries automatically.

### MCP Tool Bridge

Claude CLI can call framework tools natively via Model Context Protocol. The bridge server (`src/mcp/tool-bridge-server.ts`) exposes framework tools as MCP tools, so Claude CLI subprocess calls go through the same tool registry, executor, and permission system as regular LLM tool calls.

### Activity Stream

Real-time event feed with WebSocket streaming at `/ws/activity`. Captures tool calls, agent loop events, collaboration, and system events. Used by the dashboard Activity page for live monitoring.

### TTS & STT

ElevenLabs voice responses when users send voice messages. Whisper transcription converts incoming voice to text. Per-bot voice configuration (voice ID, model, stability, speed). Config in `tts` and `whisper` sections.

### Permissions System

Human-in-the-loop approval queue via the `ask_permission` tool. Agents request permission for sensitive actions, humans approve/deny through the dashboard Permissions page or Telegram. The `AskPermissionStore` manages the request lifecycle.

### Skills System

Plugin architecture with `skill.json` manifests and declarative `SKILL.md` format (auto-discovered on boot alongside `.ts` skills). Skills register commands, scheduled jobs, message handlers, and callback handlers. External skills from configurable directories are loaded with namespace isolation. Per-bot `disabledSkills` control. The framework includes a skill page discovery system for browsing available skills.

### Lifecycle Hooks

EventEmitter-based `HookEmitter` with 8 typed events: `message_received`, `message_sent`, `before_llm_call`, `after_llm_call`, `before_tool_call`, `after_tool_call`, `before_compaction`, `agent_loop_cycle`. Skills and extensions register listeners via `ctx.hooks?.onHook(event, handler)`. Wired into ConversationPipeline, ToolExecutor, and AgentLoop.

### Streaming Responses

Token-by-token streaming for Ollama backend (opt-in via `conversation.streaming`). Telegram messages are sent once then progressively edited with throttling. WebSocket channels receive `stream_start`/`stream_chunk`/`stream_end` events. Claude CLI falls back to non-streaming behavior. Tool-calling and voice conversations always use non-streaming.

### Multi-Channel Support

Channel-agnostic architecture with adapters for Telegram (grammy), WhatsApp Cloud API (images, interactive buttons, status tracking), Discord (REST API + Gateway WebSocket, no discord.js), REST API, and WebSocket widget. Outbound channel factory enables proactive messaging across all channels via the `send_message` tool with contact directory lookup.

### A2A Protocol

Agent-to-Agent communication following the v0.3.0 spec. JSON-RPC server (`message/send`, `tasks/get`, `tasks/cancel`) with `.well-known/agent.json` discovery. Agent directory with registration, heartbeat, stale pruning, and skill search. HTTP client + client pool for connecting to external A2A agents. Tool adapter converts external agent skills into framework tools (`a2a_{agent}_{skill}`).

### Security Audit

Automated security checks on bot startup (24h cooldown): filesystem permissions, config secrets, dangerous config flags, model hygiene, and optional tool source scanning. Results logged and surfaced in the activity stream. Configurable via `security.auditOnStartup`.

### Model Failover

`FailoverLLMClient` wraps LLM calls with ordered candidate chains, error classification (auth/billing/rate_limit/timeout/context_length/format), cooldown tracking, and smart skip/abort logic. Backend-scoped errors (auth, billing) skip all models on that backend. Format/context_length errors abort the chain. Configurable via `failover` config block.

### Tools

41 LLM-callable tools across 11 categories: web (search, fetch, browser), files (read, write, edit), execution, soul/memory management, goals, collaboration, cron, social media (Reddit, Twitter), calendar, core memory, permissions, productions, and MCP. Dynamic tool creation allows bots to build new tools at runtime (with human approval). Per-bot `disabledTools` filtering. Tool categories enable pre-selection by domain. Tool loop detection (4 strategies) prevents LLMs from getting stuck in repetitive patterns.

### Bot-to-Bot Collaboration

Three modes: **visible** (public multi-turn with @mentions), **internal** (behind-the-scenes with tools), and **delegation** (one-shot). Agent discovery, session management, rate limiting, and collaboration-safe tool filtering.

### Web Dashboard & API

Hono-based server with SPA frontend and WebSocket log streaming. Pages: Dashboard (agent loop status), Agents (CRUD, soul generation), Sessions, Cron, Tools (dynamic tool approval), Skills, Productions (review & feedback), Karma, Integrations, Settings. 25+ REST API endpoints.

### Multi-Tenant BaaS

Complete shared-infrastructure multi-tenancy across 6 phases:

- **Security** — Admin auth middleware, tenant auth (Bearer tokens), 3-tier route protection (public → tenant → admin)
- **Config isolation** — Per-tenant LLM/BYOK/features/branding overrides with global → tenant → bot config merge
- **Data isolation** — `data/tenants/{tenantId}/bots/{botId}/` path resolution, sandbox validation, tenant-scoped collaboration
- **Quota & rate limiting** — Sliding-window rate limiter (20–500 req/min by plan), per-tenant quotas with 80%/90% warning headers
- **Onboarding & billing** — Email signup with dedup, first-bot wizard, Stripe webhook integration
- **Per-user isolation** — `user_id` column on core memory for per-user data scoping within shared bots

### AI Coach/Student Features

Purpose-built infrastructure for coaching, tutoring, and mentoring bots:

- **Per-user goals** — `manage_goals` tool with `scope:"user"` stores goals per end-user in `memory/users/{userId}/GOALS.md`. System prompt injection ensures goal awareness.
- **Topic guard** — LLM-based pre-filter blocks off-topic messages before the full pipeline. Configurable `botPurpose`, `allowedTopics`, `blockedTopics`, `strictness` (loose/moderate/strict), and `failOpen`. Tenant customization overlay merges topic guard settings.
- **Identity verification** — HMAC-SHA256 `userHash` prevents senderId spoofing in Widget and REST API. Tenants auto-receive `identitySecret`; WebSocket verifies on connect.
- **REST Chat API** — `POST /api/v1/chat/:botId` for sync HTTP integration with mobile apps and backend services. Supports multi-tenant auth + identity verification.
- **Proactive messaging** — `send_proactive_message` tool sends follow-ups via Telegram or widget sessions from the agent loop.
- **Agent loop user awareness** — `agentLoop.userAwareness` injects active users summary into planner prompts for personalized outreach decisions.
- **Chat history persistence** — Widget persists `chatId`/`senderId` in localStorage; `GET /api/v1/chat/:botId/history` loads previous messages on reconnect.

### Authentication

Dual auth system supporting both human users and programmatic access:

- **Session tokens** (`sess_`) — Email + password login, argon2id hashing, 24h TTL, first-run admin setup
- **API keys** (`aibot_`) — Programmatic access for integrations, unchanged from pre-auth system
- **WebSocket auth** — Session tokens in `?token=` query param
- **Admin middleware** — Accepts both session tokens (admin role) and `ADMIN_API_KEY`

### Bot Export/Import

Portable `.tar.gz` archives for full bot backup and restoration via `BotExportService`. Includes manifest, sanitized config (no tokens), soul directory, core memory (JSONL), and optionally productions, conversations, and karma. Import supports ID/name overrides, conflict detection, and post-import RAG reindexing.

### Productions & Karma

Productions track and review bot outputs with approve/reject, ratings, and threaded feedback. Karma is a time-decayed quality score (0-100) based on production evaluations, tool errors, novelty, and manual adjustments. Injected into planner prompts so bots learn from their track record.

## Configuration

Configuration lives in `config/config.json`, validated at startup by Zod schemas in `src/config.ts`. Key sections:

- **`bots[]`** — Per-bot: token, model, allowedUsers, disabledTools, disabledSkills, workDir, llmBackend, tts overrides
- **`ollama`** — URL, default model, timeout, embedding model
- **`agentLoop`** — Interval, maxDuration, retry, concurrency, idle suppression
- **`soul`** — Health check, memory consolidation, search config
- **`conversation.compaction`** — Token limit, max summary tokens, truncation strategy
- **`productions`** — Base dir, track-only mode
- **`browserTools`** — Enabled, headless, timeouts, URL allow/block lists
- **`skillsFolders`** — External skill directory paths
- **`tenant`** — Multi-tenant mode, billing, metering, plan limits
- **`tts`** — ElevenLabs API key, voice ID, model, voice settings (stability, speed, etc.)
- **`whisper`** — Whisper model and transcription settings
- **`twitter`** — Twitter/X API credentials (apiKey, apiSecret, accessToken, accessSecret)
- **`reddit`** — Reddit API credentials (clientId, clientSecret, username, password)
- **`calendar`** — Google Calendar credentials and calendar ID
- **`mcp`** — MCP server connections and tool exposure settings
- **`agentProposals`** — Agent self-creation: enabled, maxAgents, maxProposalsPerBot
- **`collaboration`** — Bot-to-bot rate limits, visible max turns, session TTL
- **`failover`** — Model failover candidates, cooldown, enable/disable
- **`security`** — Startup audit enable/disable, cooldown
- **`a2a`** — A2A protocol: basePath, maxTasks, taskTtlMs, external agent URLs
- **`conversation.streaming`** — Streaming responses: enabled, editIntervalMs, minChunkChars

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
| `daily-priorities` | Daily goal prioritization based on goals, karma, and context |
| `daily-briefing` | Morning briefing generation with news, reminders, and agenda |
| `quick-notes` | Quick note-taking via Telegram commands |
| `reminders` | Scheduled reminders with natural language parsing |
| `task-tracker` | Task management with status tracking |
| `reddit` | Reddit browsing, monitoring, and posting |
| `calendar` | Google Calendar event management |
| `example` | Template for creating new skills |

## Web Dashboard

```
Dashboard        — Agent loop schedules, last results, run-now, safe stop
Agents           — Bot CRUD, soul generation, start/stop, tools config, export/import
Sessions         — Conversation transcripts with pagination
Conversations    — Web-based chat interface for direct bot conversations
Cron             — Job management, force-run, run logs
Tools            — Dynamic tool approval/rejection queue
Tool Runner      — Execute tools manually with parameter forms
Skills           — Built-in + external skills browser with SKILL.md viewer
Activity         — Real-time event feed (Events + System Logs tabs)
Permissions      — Human-in-the-loop approval queue (approve/deny)
Inbox            — Pending ask_human requests from agents
Productions      — File explorer with tree view, evaluation, and discussion threads
Karma            — Per-bot quality scores, trends, manual adjustment
Agent Proposals  — Review and approve/reject agent self-creation proposals
Agent Feedback   — Submit operator feedback to agents
Integrations     — Ollama diagnostic chat
Settings         — Session, collaboration, skill folders, MCP servers, memory search
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
| TTS | [ElevenLabs](https://elevenlabs.io) |
| STT | [Whisper](https://platform.openai.com/docs/guides/speech-to-text) (OpenAI) |
| Validation | [Zod](https://zod.dev) |
| Logging | [pino](https://getpino.io) |
| Browser | [Playwright](https://playwright.dev) |
| Scheduling | [croner](https://github.com/hexagon/croner) |

## License

MIT

## Author

Diego Falciola
