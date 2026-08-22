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
- **Multi-backend LLM** — Ollama (local) + Claude CLI with model failover orchestrator, cooldown tracking, and error classification. The Docker image ships the `claude` CLI pinned and preflighted at boot; authenticate it once with `docker compose exec -it aibot claude auth login`
- **Lifecycle hooks** — 8 EventEmitter-based hooks (message, LLM, tool, compaction, agent loop) for skill/extension integration
- **Streaming responses** — Token-by-token streaming for Ollama with progressive Telegram message editing and WebSocket chunk events
- **A2A Protocol** — Agent-to-agent communication (v0.3.0) with JSON-RPC server, client, agent directory, and skill-to-tool adaptation
- **Multi-channel** — Telegram, WhatsApp (Cloud API), REST, WebSocket widget, Discord (Gateway + REST)
- **Stats & Behaviour** — Read-only fleet/bot/behaviour/infra aggregations over the on-disk telemetry (LLM calls, tools, outputs, asks, goals, karma, traits, backends, cron, channel state) with a one-word posture per bot
- **Hygiene routines** — Deterministic, LLM-free maintenance for souls, memory logs, productions and the data directory; preview is side-effect free, apply backs up and never deletes
- **Agent-loop resilience** — Planner/strategist pinned to a backend (`agentLoop.plannerBackend`), a fleet-wide per-backend circuit breaker for 429/quota errors, and a hard engagement gate fed by real human feedback

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

**Or run it containerised** (recommended for an always-on cloud host):

```bash
cp .env.example .env    # fill in secrets
docker compose up -d --build
```

See [docs/deployment-cloud.md](docs/deployment-cloud.md) for the full VPS runbook.

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
├── bot/                    # Bot core (42 modules)
│   ├── bot-manager.ts      #   Facade: constructor, start/stop, sendMessage
│   ├── auto-start.ts       #   Boot-time start of enabled bots, `enabled` guard
│   ├── telegram-errors.ts  #   Shared Telegram failure diagnosis (409/401)
│   ├── conversation-pipeline.ts  #   Session expiry, RAG, LLM call, reply
│   ├── conversation-gate.ts      #   Auth, group, bot-to-bot gates
│   ├── context-compaction.ts     #   LLM-based context summarization
│   ├── collaboration.ts    #   Bot-to-bot collaboration modes
│   ├── agent-loop.ts       #   Autonomous agent orchestrator
│   ├── agent-planner.ts    #   LLM planner with retry + planner backend selection
│   ├── agent-strategist.ts #   Goal reflection and cadence
│   ├── agent-retry-engine.ts #  Retry with backoff + fleet-wide backend circuit breaker
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
├── system/                 # Whole-instance export/import
│   ├── tar-archive.ts      #   Pure-JS tar + gzip (no tar binary, no /tmp)
│   ├── config-sanitizer.ts #   Secret redaction → ${VAR}, machine-specific drops
│   ├── system-export-service.ts  #   Bundle assembly + manifest/checksums
│   ├── system-import-service.ts  #   Validation, collision planning, restore
│   └── effective-config.ts #   Zod-free config slice for disaster recovery
├── stats/                  # Stats & Behaviour aggregations (read-only, 60 s cache)
│   ├── types.ts            #   Frozen API contract: FleetResponse, BotDetailResponse, ...
│   ├── posture.ts          #   computePosture(): dormant/unknown/blocked/idle/standby/active
│   ├── readers/            #   One reader per on-disk source (llm-query-log, tool-audit, souls, ...)
│   ├── fleet-aggregator.ts #   /api/stats/fleet + /api/stats/bots/:botId
│   ├── behaviour-aggregator.ts # /api/stats/behaviour
│   └── infra-aggregator.ts #   /api/stats/infra
├── hygiene/                # Deterministic maintenance routines (preview + apply)
│   ├── registry.ts         #   HygieneRegistry + HygieneHistory (runs.jsonl)
│   ├── fs-safe.ts          #   .versions backups, _trash batches, path guards
│   └── routines/           #   goal-lint, soul-structure, memory-hygiene, productions-triage, data-cleanup
├── core/                   # Skill loader, registry, config schemas, SKILL.md adapter
├── karma/                  # Per-bot quality scoring (0-100)
├── productions/            # Bot output tracking & review
│   ├── service.ts          #   Slim facade (~800 lines)
│   ├── paths.ts            #   Path resolution + traversal guard
│   ├── frontmatter.ts      #   YAML frontmatter read/write
│   ├── summary.ts          #   Daily summary I/O
│   ├── html.ts             #   Index.html emitter (no JS)
│   ├── files.ts            #   File I/O (archive, read, write, renumber)
│   ├── changelog.ts        #   JSONL parse / filter / stats
│   ├── tree.ts             #   Directory walker with enrichment
│   └── types.ts            #   ProductionEntry, TreeNode, Evaluation
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

Three resilience mechanisms guard the `generate()` phases (planner + strategist):

- **Planner backend pinning** — `agentLoop.plannerBackend: 'inherit' | 'ollama' | 'claude-cli'` (global, per-bot override). `inherit` follows the bot's `llmBackend`, and the planner always runs on the *bare* client for that backend: `LLMClientWithFallback` used to re-issue any failed Claude CLI `generate()` to Ollama silently, which is how claude-cli bots exhausted the Ollama Cloud weekly quota. The executor keeps the full wrapper because tool calling needs it.
- **Backend circuit breaker** — `agentLoop.circuitBreaker { enabled, threshold: 3, cooldownMs: 30 min, weeklyQuotaCooldownMs: 6 h }`, fleet-wide per backend. After `threshold` consecutive 429/quota errors the circuit opens and every bot on that backend skips its cycle (`skippedReason: 'circuit-open:<backend>'`) with one info log, no retries and no `[ERROR]` spam in daily memory; one half-open probe is let through after the cooldown.
- **Engagement gate (hard by default)** — after `threshold` (5) outputs with zero human feedback, CONTENT plans are downgraded to idle until the bot earns feedback with OUTREACH/ASSESSMENT work. Feedback is counted from production approvals/rejections, answered `ask_human` questions, dashboard feedback and human inbound messages — never from the bot's own action log. Output is counted from **durable** state (the outcome ledger, falling back to the production changelog) since the last feedback signal, inside `bots[].agentLoop.engagementGate.lookbackHours` (default `168`); the in-memory action window it used to count resets on every restart, which left the gate inert.

A quota outage is not always visible as one: `classifyError()` reads the structured `apiErrorStatus` before any text matching (a Claude CLI 429 blob contains `"permission_denials":[]`, which used to make it look permanent), and when the CLI names a reset time the circuit breaker uses that instant as the cooldown end, clamped to `[1 min, weeklyQuotaCooldownMs]`. An identical error is appended to a bot's daily memory at most once every 6 hours.

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

**Headless bots run cron instructions too.** `handleCronInstruction()` no longer needs the bot's own Telegram connection: delivery resolves own instance → any live fleet instance → the bot's web session, and the synthetic message carries the real `channelKind`. A `null` outbound channel now means genuinely undeliverable. The trade-off to know about: a headless bot's cron reply delivered through another bot's Telegram connection arrives **from that other bot's account**.

A human message arriving on REST, WebSocket, WhatsApp or Discord emits the `human_inbound` event from `handleChannelMessage()`, which `AgentScheduler` turns into an engagement-gate feedback signal and `humanReply` karma. Peer agents, MCP traffic, synthetic messages and cron-generated messages are excluded.

### A2A Protocol

Agent-to-Agent communication following the v0.3.0 spec. JSON-RPC server (`message/send`, `tasks/get`, `tasks/cancel`) with `.well-known/agent.json` discovery. Agent directory with registration, heartbeat, stale pruning, and skill search. HTTP client + client pool for connecting to external A2A agents. Tool adapter converts external agent skills into framework tools (`a2a_{agent}_{skill}`).

### Security Audit

Automated security checks on bot startup (24h cooldown): filesystem permissions, config secrets, dangerous config flags, model hygiene, and optional tool source scanning. Results logged and surfaced in the activity stream. Configurable via `security.auditOnStartup`.

### Model Failover

`FailoverLLMClient` wraps LLM calls with ordered candidate chains, error classification (auth/billing/rate_limit/timeout/context_length/format), cooldown tracking, and smart skip/abort logic. Backend-scoped errors (auth, billing) skip all models on that backend. Format/context_length errors abort the chain. Configurable via `failover` config block.

**Chains lead with the bot's own backend.** `orderCandidatesByBackend()` reorders the resolved candidates so a `claude-cli` bot tries Claude first, and `resolveOllamaModels()` reads the Ollama client's configured models — the primary used to be `ollamaClient.toString()`, i.e. the literal string `[object Object]`.

**Fallback ordering: fastest first, not roomiest first.** This was inverted on 2026-08-11. A context_length error aborts the chain, so the old rule was to order fallbacks from the largest context window down — which forced `nemotron-3-super:cloud` (256K, but a reasoning model measured at **35.6 s** to first token) ahead of `gpt-oss:120b-cloud` (128K, **836 ms**), taxing every primary failure with a ~35 s stall. Instead, `resolveContextWindow()` now clamps the compaction budget to the **smallest context window in the active chain** (`src/bot/model-failover/model-context-windows.ts`), so no candidate can overflow and ordering is free to follow latency. When you add a model the table does not know, register it in `conversation.compaction.modelContextWindows` — unknown tags impose no clamp rather than a guessed one. See `docs/deployment-cloud.md` §5.

### Ollama Cloud Direct Auth

`ollama.apiKey` (optional, env-substitutable as `${OLLAMA_API_KEY}`) sends `Authorization: Bearer <key>` on every Ollama call — `/api/chat`, `/api/generate`, `/api/embed`, `/api/tags`, both streaming variants, the native tool-calling path and the startup probe. With no key configured the header is omitted entirely, so local-daemon usage is unchanged. This lets `ollama.baseUrl` point at `https://ollama.com` directly, making the Ollama daemon sidecar optional (`docker compose --profile local-ollama`) and dropping ~2 GB from the deployment. **Caveat: Ollama Cloud hosts no embedding models**, so `soul.search` requires a local daemon; the mismatch is reported explicitly at startup rather than failing per-file at runtime.

### Bot Lifecycle & Boot-Time Auto-Start

`bots[].enabled` is the runtime authority for whether a bot runs. On every process start, `autoStartEnabledBots()` (`src/bot/auto-start.ts`) starts every enabled bot — sequentially, catching per-bot failures so one bad bot takes neither the others nor the process down — so a host reboot or redeploy brings agents back without a human. `BotManager.startBot()` refuses a bot whose config says `enabled: false`, from any caller (boot, dashboard route, multi-tenant path, poller auto-restart), and `POST /api/agents/:id/start` reports that as `409 agent_disabled` rather than a generic error. Because the dashboard has both a Start button and an Enabled toggle, a disabled agent shows **Enable & Start**, which calls `?enable=true` to set and persist `enabled` before starting — so going live is one click and survives the next restart. Stop is transient and does not clear `enabled`; the toggle is how an agent stays down. Auto-start defaults on and can be suppressed for a cutover with `startup.autoStartBots: false` or `AIBOT_AUTOSTART_BOTS=false` (the env var wins). Telegram 409 — a second consumer on the same token, the likely failure of an unattended start mid-cutover — is diagnosed in one shared place (`src/bot/telegram-errors.ts`) so the log names the cause instead of saying "polling failed". See `docs/deployment-cloud.md` §4.1.

### Startup Model Validation

Probes every configured model at boot (primary, fallbacks, `soul.healthCheck.model`, per-bot overrides) with a one-token generation, concurrently and deduplicated. A real inference call is required because retired Ollama cloud tags keep appearing in `/api/tags` after the hosted backend stops serving them. Failures are graded: a retired or unknown model (`410`/`404`) logs at `error`, while a busy or slow one (`503`/`429`/timeout) logs at `warn`. An unreachable daemon produces one message rather than one per model. Non-fatal by default; configurable via `ollama.startupValidation` (`enabled`, `timeoutMs`, `strict`, `modelTimeoutMs`). `modelTimeoutMs` gives a single slow tag a longer budget — `nemotron-3-super:cloud` otherwise exceeds the 20 s default on every boot, and a permanent warning is one nobody reads.

### Claude CLI Backend

The image installs Claude Code at a pinned version (`ARG CLAUDE_CLI_VERSION`), as the unprivileged
`bun` user, with `RUN claude --version` as a build-time gate. `claude-cli` is in the model failover
chain by default, and soul quality review, memory consolidation and the improve tool all shell out
to it, so the binary being absent used to mean a backend that could never answer.

Credentials live in `CLAUDE_CONFIG_DIR=/app/data/claude`, inside the data volume rather than the
CLI default `~/.claude` — the latter is in the container layer and is destroyed by every rebuild.
One `docker compose exec -it aibot claude auth login` therefore survives redeploys.

A boot preflight (`src/bot/claude-cli-preflight.ts`) reports the binary, its version and whether a
login is present, warning only when the backend is actually in the failover chain. This matters
because an unauthenticated CLI fails *silently from the operator's point of view*: it exits 1, so
`claudeGenerate` throws and the failover chain quietly moves on to Ollama — the backend never
contributes and nothing in the logs says why. Opt out with `claudeCli.enabled: false`. See
[docs/deployment-cloud.md](docs/deployment-cloud.md) §11.1.

**Cross-backend fallback is opt-in and off by default** (`claudeCli.crossBackendFallback`, default
`false`). With no `failover` chain configured, `createLLMClient()` used to wrap every
`llmBackend: 'claude-cli'` bot in `LLMClientWithFallback(claude, ollama)`, so *any* failed Claude
call was silently re-issued to Ollama — the reflection skill, the soul health check, the quality
reviewer, the memory consolidator and the whole conversation path, not just the agent-loop planner.
A `claude-cli` bot now gets the bare client unless the flag is turned on. Errors from the CLI arrive
as `ClaudeCliError`, carrying `exitCode`, `apiErrorStatus`, `terminalReason` and the parsed
`resetsAt` instant, so a rate limit is classified and cooled down correctly instead of looking
permanent.

### Tools

41 LLM-callable tools across 11 categories: web (search, fetch, browser), files (read, write, edit), execution, soul/memory management, goals, collaboration, cron, social media (Reddit, Twitter), calendar, core memory, permissions, productions, and MCP. Dynamic tool creation allows bots to build new tools at runtime (with human approval). Per-bot `disabledTools` filtering. Tool categories enable pre-selection by domain. Tool loop detection (4 strategies) prevents LLMs from getting stuck in repetitive patterns.

### Bot-to-Bot Collaboration

Three modes: **visible** (public multi-turn with @mentions), **internal** (behind-the-scenes with tools), and **delegation** (one-shot). Agent discovery, session management, rate limiting, and collaboration-safe tool filtering.

### Web Dashboard & API

Hono-based server with SPA frontend and WebSocket log streaming. Pages: Dashboard (agent loop status), Agents (CRUD, soul generation), Stats & Behaviour (fleet, bot detail, behaviour, infra, hygiene), Sessions, Cron, Tools (dynamic tool approval), Skills, Productions (review & feedback), Karma, Integrations, Settings. 25+ REST API endpoints.

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

Portable `.tar.gz` archives for full bot backup and restoration via `BotExportService`. Includes manifest, sanitized config (no tokens, no WhatsApp/Discord credentials), soul directory, core memory (JSONL), productions, conversations, karma, and Telegram sessions (extras included by default; pass `false` to omit). Import supports ID/name overrides, conflict detection, and post-import RAG reindexing. Archiving is pure JS — no `tar` binary and no temp-directory staging.

### System Export/Import

Whole-instance backup: global config, the agent roster, every agent's soul and core memory, cron jobs, sessions, dynamic tools, agent proposals, karma, contacts and tenant state, in one `.tar.gz`. Composes `BotExportService` per agent rather than duplicating it.

**No secret value ever enters a bundle** — credentials become `${VAR}` placeholders listed in `REQUIRED_ENV.txt`, and credentials embedded in file content are scrubbed. Machine-specific settings (`ollama.baseUrl`, `improve.claudePath`, `web.host`/`port`, absolute paths) and the regenerable vector index are left out on purpose. Restored agents always land `enabled: false` with an empty token.

```bash
bun run export:system -- --out ../backup.tar.gz
bun run import:system -- --in ../backup.tar.gz        # prints the plan
bun run import:system -- --in ../backup.tar.gz --yes  # applies it
```

Also at `GET /api/system/export` and `POST /api/system/import`, and in the dashboard under Settings → System Backup & Restore. **Never expose `/api/system/*` publicly** — see [docs/system-backup-restore.md](docs/system-backup-restore.md).

### Productions & Karma

Productions track and review bot outputs with approve/reject, ratings, and threaded feedback. Karma is a time-decayed quality score (0-100) that is **outcome-based**: every credit or debit is an outcome kind whose delta comes from `config.karma.rewards` — defaults `productionApproved: 3`, `productionRejected: -1`, `askAnswered: 2`, `humanReply: 3` (at most once per bot per `humanReplyCooldownHours`, 6), `toolError: -1`, `novelAction: 0`, `collaborateCompleted: 0`. A kind worth 0 is never written, so a completed cycle earns nothing unless an operator turns it back on. `GET /api/karma/:botId` returns a `breakdown` (raw deltas by source and by kind over 30 days) that the dashboard shows as "Score composition". Injected into planner prompts so bots learn from their track record.

Personality traits (`TRAITS.json`, eight 0.1–0.9 registers that mechanically tune temperature, tool rounds and check-in cadence) can be guarded per bot with `bots[].traits { pinned: { sociability: 0.3 }, locked: ["independence"] }`: pinned values always win, locked traits ignore strategist/reflection deltas, and the strategist prompt no longer prescribes a universal "low engagement → more sociable" direction — a delta needs a concrete observation about this agent and must agree with its identity.

### Stats & Behaviour

`src/stats/` aggregates the telemetry the framework already writes (llm-query-log, tool-audit, outcome ledger, karma, scheduler state, conversations, sessions, cron, knowledge mesh, soul files, log tail) into four read-only, tenant-scoped endpoints cached for 60 s: `GET /api/stats/fleet?window=24h|7d|30d` (one row per bot: backend, channel state, posture, LLM/tool/output/engagement/goals/karma/traits/soul/cycle stats), `GET /api/stats/bots/:botId` (goal detail, trait history, recent cycles, daily series, asks, top errors), `GET /api/stats/behaviour` (production without feedback, ask economics by question length, collaboration graph, mesh output, trait variance/drift) and `GET /api/stats/infra` (backend 429/401, security audit, cron, Telegram channel states, log noise, boots). Nothing throws on missing data; a fresh bot yields zeros. `computePosture()` summarises each bot as `dormant`, `unknown`, `blocked`, `idle`, `standby` or `active` (first matching rule wins).

### Hygiene Routines

`src/hygiene/` holds deterministic, LLM-free maintenance with `preview` (no writes) and `apply`: `goal-lint` (archived goals under Active, duplicate titles, oversized notes, stale blocks, dead triggers), `soul-structure` (soul lint, SOUL = MOTIVATIONS, missing MEMORY.md/TRAITS.json, stale Current Focus, failed last review), `memory-hygiene` (PII redaction, stale "tool unavailable" constraints, pending daily logs), `productions-triage` (stale unreviewed, duplicate numbering, orphan changelog refs, unnumbered files) and the fleet-wide `data-cleanup` (orphan karma/soul dirs, legacy config souls, old Claude CLI transcripts; config findings are report-only). Apply backs up every soul file to `.versions/<file>.<ISO>.bak` and **never deletes** — cleanup moves paths into `data/_trash/<stamp>/` with a `manifest.json`. Runs are logged to `data/hygiene/runs.jsonl`. API: `GET /api/hygiene/routines`, `POST /api/hygiene/run { routine, botId?, apply?, options? }`, `GET /api/hygiene/history`.

Routine options are surfaced as checkboxes on each routine card at `#/stats/hygiene`: `productions-triage` takes `archiveStale` and `pruneOrphans` (the latter rewrites `changelog.jsonl` without its orphan lines after backing it up to `.versions/`, keeping every other line byte-identical), `memory-hygiene` takes `redactCustody`. `data-cleanup`'s `skills-are-tools` finding no longer fires for a name that is both a real skill and a tool — `improve` is both, and was being reported on six bots every run.

### Channel State, Operator Contact & ask_human Protocol

- **Channel state** — every bot start records `ChannelState = 'ok' | 'revoked' | 'placeholder' | 'missing' | 'error'`. A placeholder (`"nothing"`, the bot id) or missing token never calls Telegram and starts headless at `info`; a real-shaped token that Telegram rejects is `revoked` (401) or `error`. `bots[].token: null` is the explicit "headless on purpose" value. Exposed as `channel` on `GET /api/agents` and `bots.channels[]` on `GET /api/status`.
- **Operator contact** — `config.operator { name, telegramChatId, email, notifyOnAsk, proactiveCooldownMinutes, proactiveDailyCap }`. `send_proactive_message` and `cron` accept `chatId: "operator"` (or the operator's email) so bots stop copying numeric chat ids from other jobs; unset contact returns `Operator chat id not configured (config.operator.telegramChatId)`.
- **Proactive-message throttle** — one `send_proactive_message` per bot per `proactiveCooldownMinutes` (60 when unset) and `proactiveDailyCap` messages fleet-wide per rolling 24 h (10 when unset); `0` disables either limit. A throttled call returns `success: false` naming the ISO time the bot may send again, and quota is only consumed once a delivery succeeds. Added after one bot sent the operator three Telegram messages in thirteen minutes.
- **ask_human protocol** — `config.askHuman { maxChars: 600, autoCloseHours: 72 }`. Questions over `maxChars` are rejected, `options` (2–4 short strings) become quick-reply buttons in the inbox, multi-question asks get a tip, and pending asks older than `autoCloseHours` are closed (`inboxStatus: 'closed'`) with a daily-memory note so a forgotten ask cannot block a bot. With `operator.notifyOnAsk: true` the configured operator is also pinged with the bot name, the question (truncated to 300 chars) and the options — deduped against the asking bot's own notification, and a failed notification never fails the ask.

## Configuration

Configuration lives in `config/config.json`, validated at startup by Zod schemas in `src/config.ts`. Key sections:

- **`bots[]`** — Per-bot: token (`null` = headless on purpose; a non-token-shaped string is reported as `placeholder` and never sent to Telegram), `enabled` (starts at boot; a disabled bot cannot be started at all), model, allowedUsers, disabledTools, disabledSkills, workDir, llmBackend, tts overrides, `agentLoop.plannerBackend`, `agentLoop.engagementGate { enabled, mode, threshold, lookbackHours: 168 }` (per-bot only — there is no global `agentLoop.engagementGate`), `traits { pinned, locked }`
- **`startup`** — `autoStartBots` (default `true`): start every enabled bot at boot. Override with `AIBOT_AUTOSTART_BOTS`
- **`operator`** — The human the bots report to: `name`, `telegramChatId`, `email`, `notifyOnAsk`, `proactiveCooldownMinutes` (60 when unset), `proactiveDailyCap` (10 when unset) — all optional. `chatId: "operator"` in `send_proactive_message` / `cron` resolves to `telegramChatId`; `notifyOnAsk` also pings the operator on every `ask_human`
- **`claudeCli`** — `enabled` (default `true`), `model`, `crossBackendFallback` (default **`false`**: a failed `claude-cli` call is *not* silently re-issued to Ollama)
- **`askHuman`** — `maxChars` (default `600`), `autoCloseHours` (default `72`)
- **`karma`** — `enabled`, `baseDir`, `initialScore`, `decayDays`, `dedupCooldownMinutes`, `rewards` (delta per outcome kind: `novelAction: 0`, `productionApproved: 3`, `productionRejected: -1`, `askAnswered: 2`, `humanReply: 3`, `collaborateCompleted: 0`, `toolError: -1`), `humanReplyCooldownHours: 6`
- **`ollama`** — URL, primary/fallback models, timeout, embedding model, `startupValidation` (boot-time model probe)
- **`agentLoop`** — Interval, maxDuration, retry, concurrency, idle suppression, `plannerBackend` (`inherit` | `ollama` | `claude-cli`), `circuitBreaker` (`enabled`, `threshold: 3`, `cooldownMs: 1800000`, `weeklyQuotaCooldownMs: 21600000`)
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
Stats & Behaviour — Fleet table (posture, channel, LLM/tool/output/engagement per bot, 24h/7d/30d),
                   Bot detail (goals, traits, cycles, daily series, asks, errors, hygiene panel),
                   Behaviour (production without feedback, ask economics, collaboration graph, drift),
                   Infra (backends, security audit, cron, Telegram states, log noise), Hygiene (preview/apply, history)
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
- **[docs/deployment-cloud.md](docs/deployment-cloud.md)** — Cloud/VPS runbook: Docker Compose, Ollama Cloud, SSH-tunnelled dashboard, backups, log rotation
- **[docs/architecture-docs/](docs/architecture-docs/)** — Interactive HTML documentation with dependency graphs and diagrams

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Container | Docker + Compose (`Dockerfile`, `docker-compose.yml`) |
| Language | TypeScript |
| Bot framework | [grammY](https://grammy.dev) |
| Web server | [Hono](https://hono.dev) |
| Database | SQLite (via bun:sqlite) |
| LLM (local) | [Ollama](https://ollama.ai) |
| LLM (cloud) | Claude CLI (shipped in the Docker image, pinned to 2.1.237) |
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
