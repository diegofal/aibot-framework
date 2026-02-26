# Changelog

## Unreleased

### Fixed
- **Collaborate tool: graceful fallback to invisible mode in agent loop** — When `visible=true`
  is requested but no Telegram chat context exists (autonomous agent loop mode), the collaborate
  tool now automatically falls back to invisible collaboration instead of returning an error.
  The delegate_to_bot tool now returns a helpful message guiding the bot to use `collaborate`
  with `visible=false` as an alternative.

### Added
- **Skills page: show all built-ins + auto-discover production skills** — The `#/skills` page now
  shows ALL available built-in skills (with enabled/disabled badges) instead of only loaded ones.
  External skills from production directories (`productions/*/src/skills/`) are auto-discovered
  and tagged with their bot origin name.
  - `SkillLoader.readManifest()` reads skill.json without importing the module
  - `SkillRegistry.listAvailable()` lists all built-in skill IDs with manifests
  - `discoverProductionSkillPaths()` scans production dirs for skill folders
  - `ToolRegistry.initializeExternalSkills()` now merges configured + production paths
  - `GET /api/skills` returns `enabled` field for built-ins and `botName` for external skills
  - `GET /api/settings/skills-folders` includes auto-discovered production paths
  - UI: green/dim enabled/disabled badges, bot origin badge, muted row styling for disabled skills

- **Tool Runner page** — New `#/tool-runner` page in the web UI that lists ALL tools (built-in +
  dynamic), lets you select one, fill in parameters via a dynamically generated form, execute it
  directly (no LLM), and see the result with success/failure badge and duration.
  - `GET /api/tools/all` returns every tool with full parameter schemas and source type
  - `POST /api/tools/execute` runs a tool directly with a 30s timeout
  - Searchable tool list grouped by source (built-in vs dynamic)
  - Parameter form auto-generated from JSON schema (string, number, boolean, enum, object/array)

- **Graceful stop & loop execution visibility** — New "Stop All Safe" button on the Dashboard that
  drains running agent loop cycles before stopping Telegram polling, preventing in-flight tool calls
  from failing. Per-bot execution indicators (pulsing dot + "Executing" / "Idle" labels) now appear
  in both Dashboard bot schedules table and Agents list/detail views. Dashboard auto-refreshes every
  5s while bots are running or draining. New API endpoint: `POST /api/agent-loop/stop-safe`.
  - Backend: `AgentScheduler.gracefulStop()` sets a `draining` flag, wakes sleeping bots, waits for
    executing cycles to finish (with configurable timeout), then calls `stop()`.
  - `BotScheduleInfo.isExecutingLoop` and `AgentLoopState.draining` fields exposed via API.
  - `BotManager.gracefulStopAll()` orchestrates drain → cleanup sequence.
  - CSS: `.badge-draining` style with orange pulse animation.


- **Tool pre-selection for agent loop** — The planner now selects which tool categories the executor
  needs, reducing the number of tool definitions sent to Ollama by ~2,500-3,500 tokens per call.
  This prevents 503 errors when tool definitions + context exceed model context windows.
  - 10 built-in tool categories: `web`, `memory`, `soul`, `files`, `system`, `social`, `calendar`,
    `communication`, `browser`, `production`
  - `ALWAYS_INCLUDED_TOOLS` (`get_datetime`, `ask_human`, `ask_permission`) are always sent regardless
    of category selection
  - External/dynamic tools (uncategorized) always pass through
  - Falls back to sending all tools when planner doesn't return categories or when disabled
  - Config toggle: `agentLoop.toolPreSelection` (default: `true`)
  - New observability fields in `AgentLoopResult`: `selectedToolCategories`, `executorToolCount`

- **Error detection + retry for all conversation-like interfaces** — All bot reply generation
  flows now detect failures and expose them to the frontend instead of silently dropping.
  - Backend: `Set<string>` tracking replaced with `Map<string, { status, error? }>` in all 3
    route files (`conversations.ts`, `agent-feedback.ts`, `productions.ts`). Generation logic
    extracted into reusable helpers shared by message-send and retry endpoints. New retry
    endpoints: `POST /:botId/:id/retry` (conversations), `POST /:botId/:id/retry-reply`
    (agent-feedback), `POST /:botId/:id/retry-response` and `POST /:botId/:id/retry-thread`
    (productions). Status endpoints now return `{ status: 'error', error }` on failure.
  - Frontend: `renderThread()` in `shared.js` extended with `error` + `onRetry` props. Error
    banner with retry button shown on failure. All 4 pages (`conversations.js`, `inbox.js`,
    `productions.js`, `feedback.js`) updated with poll timeout (3 min / 90 polls at 2s),
    `status === 'error'` handling, and retry-on-click. Polling extracted into `startPolling()`
    functions reused by both send and retry flows.
  - CSS: `.thread-error` class with red border and error badge styling.
  - Tests: Error state + retry tests added to all 3 route test files.


- **Declarative Skills Support (SKILL.md)** — New adapter allowing skills to be defined via YAML frontmatter + Markdown instead of TypeScript code. Transplanted from OpenClaw's pattern.
  - `SkillMdParser`: Parses YAML frontmatter and Markdown content from SKILL.md files
  - `SkillValidator`: Validates skill manifests against strict schema (name, semver, tools, parameters)
  - `SkillMdLoader`: Orchestrates loading, validation, and tool generation
  - `framework-bridge.ts`: Integration point with `external-skill-loader.ts` for seamless discovery
  - Supports: skills with metadata, multiple tools, typed parameters, default tool implementations
  - Location: `src/skills/skill-md-adapter/` with 56 tests

- **Inbox as conversation type** — `ask_human` questions now create persistent inbox conversations
  (type `'inbox'`) with JSONL-backed threaded chat. The inbox page is a conversation list (pending
  vs previous) instead of ephemeral cards. Clicking opens a full chat thread with `renderThread`.
  First human reply still unblocks the agent loop (backward compatible), but the conversation
  persists for follow-up discussion. Supports `inboxStatus` field (`pending`/`answered`/`dismissed`/
  `timed_out`) with automatic status transitions via `AskHumanStore` callbacks.
  - `ConversationsService`: extended with `'inbox'` type, `askHumanQuestionId`/`inboxStatus` fields,
    `markInboxStatus()`, `countByInboxStatus()`, `findByQuestionId()` methods
  - `AskHumanStore`: `conversationId` field on questions, `setConversationId()`, `HandleReplyResult`
    return type, `onTimeout`/`onDismiss` callbacks
  - `ask_human` tool: creates inbox conversation with bot question as first message
  - `BotManager`: owns shared `ConversationsService`, wires timeout/dismiss callbacks, writes
    human answers to conversation on `answerAskHuman()`
  - `ConversationGate`: writes Telegram replies to inbox conversations
  - Web routes: `/api/ask-human/count` uses conversation-based pending count, `/api/conversations`
    supports `'inbox'` type, first reply to pending inbox resolves `ask_human`
  - Frontend: `inbox.js` rewritten as conversation list + `renderInboxChat()` chat view,
    `app.js` route `#/inbox/:botId/:id`, status badge CSS

- **Persist in-memory state to disk** — All transient Maps/Sets now survive app restarts:
  - `AskPermissionStore`: history + resolved decisions persisted to `data/ask-permission/history.json`
  - `AskHumanStore`: answered questions persisted to `data/ask-human/answered.json`
  - `AgentScheduler`: bot schedules persisted to `data/agent-scheduler/schedules.json` (debounced 10s flush)
  - `CollaborationTracker`: exchange records persisted to `data/collaboration/tracker.json`
  - `CollaborationSessionManager`: sessions persisted to `data/collaboration/sessions.json`
  - `ToolAuditLog` (new): append-only daily JSONL files at `data/tool-audit/{botId}/YYYY-MM-DD.jsonl`
  - All stores are backward-compatible (`dataDir` is optional)
  - Pending entries with Promises are NOT persisted (treated as expired on restart)

### Fixed
- **fix(tool-registry):** remove dead facilita tool imports — bot-specific tools should use external skills or dynamic tool registry

### Changed
- **Full bot reset with baseline restore** — `resetBot()` now restores soul files (IDENTITY.md,
  SOUL.md, MOTIVATIONS.md) from `.baseline/` copies saved at apply-soul time, instead of preserving
  evolved versions. Also clears MEMORY.md at soul root, recursively deletes memory/ (including
  archive/ subdirs and non-.md files), deletes feedback.jsonl, and clears ask-human, ask-permission,
  and agent-feedback in-memory stores. Added `clearForBot(botId)` to AskHumanStore,
  AskPermissionStore, and AgentFeedbackStore.

### Added
- **Soul generation from agent edit screen** — "Generate Soul" button added to the agent edit form,
  wiring the existing `showGenerateSoulModal` so existing agents can generate/regenerate their soul
  without going through the new-agent flow. Edit page refreshes after applying.
- **Production Index & Archival System** — Auto-generated `INDEX.md` per production directory.
  `ProductionsService.rebuildIndex(botId)` scans the directory tree, reads `changelog.jsonl` for
  descriptions (falls back to first markdown heading or humanized filename), and generates a
  grouped-by-directory index with tables. Triggered automatically after every `logProduction()`.
  Files excluded from index: `changelog.jsonl`, `summary.json`, `INDEX.md`, `node_modules/`, `venv/`.
- **Production archival** — `ProductionsService.archiveFile(botId, path, reason)` moves files to
  `archived/` subdirectory with a tracked reason. New `archive` action type in `ProductionEntry`
  with `archivedFrom` and `archiveReason` fields. Archived files get a different table format in
  INDEX.md showing original path, reason, and date.
- **archive_file tool** — New LLM tool for bots to archive production files with reasons.
  Registered alongside `read_production_log` when productions are enabled.
- **Production directory rules in prompts** — Executor prompt now includes mandatory directory
  structure rules (use subdirectories, descriptive names), archival protocol (archive before
  replacing, never delete), and anti-duplication checks (read INDEX.md before creating files).
  Planner prompts include new anti-patterns: creating duplicates and dumping files at root.
- **Better production descriptions** — Tool executor now extracts the first markdown heading
  from file content for changelog descriptions instead of generic `"file_write: path"`.
  INDEX.md logging is skipped to prevent circular entries.
- **INDEX.md priority in file tree** — `scanFileTree()` sorts INDEX.md first so it's visible
  even when the tree is truncated at 100 entries.
- **Production cleanup script** — `scripts/cleanup-productions.ts` reorganizes all existing
  production directories. Supports `--execute` flag (dry-run by default). Categorizes 227 files
  across 8 productions into subdirectories and archives 21 duplicates/stale files. Deletes
  orphaned Python venv in default production. Rebuilds INDEX.md for all productions after cleanup.

- **Permission execution feedback** — Permission decisions now track a full lifecycle:
  `pending → decided → consumed → executed/failed`. After approving or denying on the web
  dashboard, the card transitions in-place showing processing status with a pulse animation.
  The agent loop reports execution results (summary, tool calls, success/failure) back to the
  store. History section on the Permissions page shows recent decisions with colored status
  badges and execution details. New API endpoints: `GET /api/ask-permission/history`,
  `GET /api/ask-permission/history/:id`. History is bounded (100 entries, 24h TTL).

### Fixed
- **Telegram 409 polling conflict — custom polling loop + inter-poll delay** — replaced grammy's
  `bot.start()` entirely with a custom polling loop (`pollLoop`) that calls `bot.api.getUpdates()`
  directly and feeds updates to `bot.handleUpdate()`. grammy's `handlePollingError` treated 409 as
  fatal (throws immediately, killing the poll loop), and the previous API transformer approach
  (5 retries) was insufficient — the 409 is persistent enough to exhaust all retries.
  The new loop handles 409 with escalating backoff (3s × attempt, capped at 30s) and only
  gives up after sustained failure (20 consecutive 409s OR 5 minutes). 401 throws immediately
  (bad token), 429 respects `retry_after`, update processing errors are caught (never kill
  the loop), and offset advances before handling (prevents infinite crash on poisoned updates).
  Cleanup uses `AbortController` instead of `bot.stop()` (which could itself issue a
  conflicting `getUpdates`). Retained sliding-window restart limit (3 in 5 min) as fallback.
  **Root cause fix**: Added 500ms inter-poll delay (`POLL_INTERVAL_MS`) between `getUpdates`
  cycles. Telegram's server-side session has a brief teardown window after a long-poll returns;
  Bun's fetch reuses TCP connections so the next request arrives nearly instantly, hitting the
  session overlap window → 409. The 500ms pause eliminates the 409-per-cycle pattern entirely.
  First 2 consecutive 409s now log at `debug` level (only `warn` after 3+) to reduce log noise
  for occasional transient overlaps.
  File: `src/bot/bot-manager.ts`. Tests: `tests/bot/poll-loop.test.ts`.

### Added
- **Reddit integration** — 3 new LLM tools (`reddit_search`, `reddit_hot`, `reddit_read`) + Telegram
  skill (`/reddit hot <subreddit>`, `/reddit search <query>`). OAuth2 script-app auth with promise-based
  mutex for token refresh. Responses wrapped with `wrapExternalContent()`, cached via `TtlCache`.
  Rate limited at 100 req/min. Config: `reddit` section in `config.json` (disabled by default).
- **Twitter/X integration** — 3 new LLM tools (`twitter_search`, `twitter_read`, `twitter_post`) +
  Telegram skill (`/twitter search`, `/twitter trending`, `/twitter post`). Read ops use Bearer Token
  (app-only auth), write ops use OAuth 1.0a signature (built-in, no deps). `twitter_post` requires
  `ask_permission` approval before posting. Post tool only registered when write credentials present.
  Rate limited at 300/15min (search) and 200/15min (tweets). Config: `twitter` section (disabled by default).
- **Calendar integration** — 3 new LLM tools (`calendar_list`, `calendar_availability`, `calendar_schedule`) +
  Telegram skill (`/cal today`, `/cal availability`, `/cal schedule`). Provider abstraction supports
  Calendly and Google Calendar. `calendar_schedule` requires `ask_permission` approval. Calendly
  gracefully reports that direct scheduling is not supported (use scheduling links).
  Config: `calendar` section (disabled by default).
- **Shared API client** — `src/tools/api-client.ts` with `apiRequest<T>()` (authenticated fetch with
  timeout, JSON parsing, structured errors) and `RateLimiter` (token-bucket). Used by all 3 integrations.
- **`ask_permission` tool + Permissions dashboard** — Bots can now request permission
  before performing sensitive actions (file writes, command execution, external API calls,
  resource modifications). Mirrors the `ask_human` lifecycle: bot calls `ask_permission`
  (non-blocking) → request appears in the "Permissions" dashboard page → human approves
  or denies with optional note → decision injected into bot's next agent loop cycle.
  - New store: `src/bot/ask-permission-store.ts` (dedup, timeout, consume-on-read)
  - New tool: `src/tools/ask-permission.ts` (action, resource, description, urgency, timeout)
  - New API routes: `GET/POST /api/ask-permission` (list, count, approve, deny)
  - New dashboard page: `web/pages/permissions.js` with urgency badges, approve/deny buttons
  - Sidebar link with live badge polling (10s interval)
  - Agent loop integration: resolved/pending permissions injected into planner prompts
  - PERMISSION PROTOCOL paragraph added to both planner prompt templates
  - Soul generator updated: new bots auto-include Permission Protocol in Boundaries
  - All 11 existing bot SOUL.md files updated with Permission Protocol section
  Files: `src/bot/ask-permission-store.ts`, `src/tools/ask-permission.ts`,
  `src/web/routes/ask-permission.ts`, `web/pages/permissions.js`, `src/bot/types.ts`,
  `src/bot/bot-manager.ts`, `src/bot/tool-registry.ts`, `src/bot/agent-loop.ts`,
  `src/bot/agent-loop-prompts.ts`, `src/web/server.ts`, `web/index.html`, `web/app.js`,
  `src/soul-generator.ts`, `config/soul/*/SOUL.md`.
  Tests: `tests/ask-permission-store.test.ts` (24 tests),
  `tests/web/routes/ask-permission.test.ts` (7 tests).
- **Test Chat with Tools (integrations page)** — New card on the integrations page sends
  messages with tool definitions attached, using the same `ollamaClient.chat()` + tool
  executor code path as the agent loop. Lets you verify whether a model supports native
  tool calling without waiting for a full agent cycle. Includes model selector, per-tool
  checkboxes with Select All/None toggle, and detailed result display (tool calls executed
  with args/result, final LLM response, duration).
  Backend: `GET /api/integrations/ollama/tools`, `POST /api/integrations/ollama/chat-with-tools`.
  New public method: `BotManager.getToolRegistry()`.
  Files: `src/bot/bot-manager.ts`, `src/web/routes/integrations.ts`,
  `web/pages/integrations.js`, `tests/web/routes/integrations.test.ts`.
- **TTS voice picker in agent edit screen** — New "Voice (TTS)" section in the agent edit form
  lets operators select an ElevenLabs voice per bot from a dropdown, plus speed and stability
  sliders. "Load Voices" button fetches available voices from ElevenLabs (API key stays
  server-side). Includes global defaults display and clear-to-reset-to-global behavior.
  Backend: `GET /api/integrations/elevenlabs/voices` proxy endpoint, `tts` support in
  `PATCH /api/agents/:id`, `ttsEnabled`/`ttsVoiceId` in `/api/agents/defaults`.
  Files: `src/web/routes/integrations.ts`, `src/web/routes/agents.ts`, `web/pages/agents.js`,
  `tests/web/routes/integrations.test.ts`, `tests/web/routes/agents-tts.test.ts`.
- **Per-bot TTS voice configuration** — Each bot can now override the global TTS voice
  settings (`voiceId`, `modelId`, `outputFormat`, `languageCode`, `maxTextLength`,
  `voiceSettings`) via a per-bot `tts` block in config. Follows the existing
  `global defaults + per-bot optional overrides` pattern (like `conversation` and
  `agentLoop`). API key and provider remain global. New `resolveTtsConfig()` resolver
  in `src/config.ts` merges global and per-bot settings at runtime. The conversation
  pipeline now uses the resolved config when generating voice replies.
  Files: `src/config.ts`, `src/bot/conversation-pipeline.ts`, `config/config.json`,
  `tests/tts.test.ts`, `src/bot/__tests__/conversation-pipeline.test.ts`.
- **Audio Output: ElevenLabs TTS (inbound mode)** — When a user sends a voice message,
  the bot now responds with a voice note (OGG/Opus) instead of text. Uses ElevenLabs API
  with configurable voice, model, language, and voice settings. Inbound-only: TTS only
  triggers when the user's input was a voice message. Falls back to text on TTS failure
  or when TTS is not configured. Added `isVoice` flag to `BufferEntry` and pipeline,
  `TtsConfigSchema` to media config, and new `src/tts.ts` module with `generateSpeech()`.
  Created 22 unit tests in `tests/tts.test.ts` and 4 pipeline integration tests.
  Files: `src/tts.ts`, `src/message-buffer.ts`, `src/bot/media-handlers.ts`,
  `src/bot/conversation-pipeline.ts`, `src/bot/bot-manager.ts`, `src/config.ts`,
  `config/config.json`, `tests/tts.test.ts`,
  `src/bot/__tests__/conversation-pipeline.test.ts`.
- **Audio Input: OpenAI Whisper API key support** — Added optional `apiKey` field to
  `WhisperConfigSchema` and conditional `Authorization: Bearer` header in `processVoice()`.
  Endpoints without auth (e.g. local whisper.cpp) continue to work unchanged.
  Added whisper block to `config/config.json` pointing to OpenAI API with `${OPENAI_API_KEY}`.
  Created comprehensive test suite for `processVoice()` (13 test cases) in `tests/media.test.ts`.
  Files: `src/config.ts`, `src/media.ts`, `config/config.json`, `tests/media.test.ts`.
- **Roadmap: external integrations planned** — Added Projects 4-7 to `docs/roadmap.md`:
  Twitter/X (search, post, read), Reddit (search, hot, read), Calendly/Calendars
  (availability, schedule, list), and Discord (deferred, needs multi-channel abstraction).
  Each integration follows the tool + skill + external skill pattern.
  Updated `docs/architecture-docs/tools-skills.html` with a "Planned Integrations" section.
  Added `CLAUDE.md` rule to consult roadmap before proposing new features.
- **Web Conversations** — Chat with bots directly from the web dashboard. Two conversation types:
  `general` (discuss goals, motivations, behavior) and `productions` (discuss production work).
  Conversations are JSONL-backed under `data/conversations/{botId}/`, use the same
  `renderThread()` chat UI as production threads, and fire-and-forget bot replies via Claude CLI.
  Bot replies include soul context (identity, motivations, goals). Productions-type chats also
  inject recent production stats. All conversations are visible from a unified "Conversations"
  screen. Productions page now includes a "Productions Chat" section inline.
  Files: `src/conversations/service.ts`, `src/web/routes/conversations.ts`, `src/web/server.ts`,
  `src/config.ts`, `web/pages/conversations.js`, `web/pages/productions.js`, `web/app.js`,
  `web/index.html`, `web/style.css`.

### Fixed
- **`file_edit` false-positive template penalty (critical)** — Every `file_edit` operation was
  penalized -3 karma for "empty template" because the quality gate read `args.content` (which
  only exists for `file_write`). For `file_edit`, `args.content` is always `undefined`, producing
  an empty string that `assessContentQuality('')` flagged as a template. Now reads `args.new_text`
  for `file_edit`. When neither content field exists, the quality gate is skipped entirely.
  This was the #1 cause of karma bleeding across all bots (-44 on default, -25 on Therapist).
  Files: `src/bot/tool-executor.ts`.
- **Karma dedup keys not normalizing paths** — Dedup key extraction for production events used
  the raw file path from the LLM, so `./manuscrito.md` and `manuscrito.md` produced different
  keys, bypassing the cooldown window. Now strips leading `./` and collapses duplicate slashes
  before building the dedup key. Files: `src/karma/service.ts`.
- **Bots reading wrong file paths (workDir unawareness)** — Autonomous bots tried to read
  framework source files (e.g. `src/tenant/billing.ts`) which resolved inside their sandbox
  and failed. Added a "File Sandbox" section to autonomous mode prompts explaining that all
  file operations are sandboxed to their workDir and they cannot access files outside it.
  Files: `src/bot/system-prompt-builder.ts`.
- **Ollama timeout resilience** — Fallback models now use a reduced timeout (60s instead of
  the primary's 300s) to avoid stacking retries that multiply wait times. `embed()` now logs
  elapsed time on failure (matching `generate()` and `chat()`). Added `qwen3:8b` as a default
  fallback model in config.json so `kimi-k2.5:cloud` failures don't block all LLM paths.
  Files: `src/ollama.ts`, `config/config.json`.
- **Tool loop exhaustion — loop detector now active in all LLM paths** — The existing
  `createLoopDetector()` (repeat-detector, no-progress-detector, global circuit breaker) was
  only wired into the Claude CLI path. Now also active in the Ollama chat tool loop, which
  covers both conversation pipeline and agent-loop executor phases. Repeated identical tool
  calls (4+) or identical results (3+) now break the loop early instead of exhausting all
  rounds silently. Files: `src/ollama.ts`.
- **External skills with missing requirements no longer loaded** — Skills requiring env vars
  (`GITHUB_TOKEN`, `LINEAR_API_KEY`, etc.) or binaries that aren't available are now skipped
  at startup instead of being registered as tools that fail at runtime. Warnings with
  `Missing env var` or `Missing binary` prefixes trigger the skip. Also downgraded the noisy
  "Skill not found" warning (80+ per startup) to debug level — this is expected for
  external-only skills listed in bot config but not in the built-in skill registry.
  Files: `src/bot/tool-registry.ts`, `src/bot/handler-registrar.ts`.

### Fixed
- **Karma dedup cooldown** — Negative karma events are now deduplicated within a configurable
  cooldown window (default 60 minutes). The same error on the same file/tool no longer fires
  a penalty every cycle — only the first occurrence within the window is recorded. Dedup key
  extraction: production events keyed by file path, tool events by tool name + error prefix,
  agent-loop events by action prefix. Positive events and manual adjustments are never deduped.
  All bot karma event files reset to start fresh after the fix.
  Config: `karma.dedupCooldownMinutes` (default 60).
  Files: `src/karma/service.ts`, `src/config.ts`.
- **Bots not using `ask_human` — proactive human check-in** — Five improvements to make bots
  proactively consult their human operator instead of running fully autonomously:
  1. **Strategist**: Added ask_human deliverable examples ("Ask the operator which social channels
     to prioritize") and a "Human Check-In Cadence" rule requiring check-in deliverables every
     3-5 sessions.
  2. **Planner** (both periodic and continuous): Rewrote `HUMAN COLLABORATION` block from
     "if you cannot determine on your own" (too high a threshold) to "proactively ask when the
     human's preference matters". Added "When unsure between two approaches, ask the human
     instead of guessing".
  3. **Planner priority "none"**: Tightened from "genuinely impossible AND can't ask human" to
     "ONLY after you have already called ask_human and are waiting". Bots that haven't asked
     must use at least priority "low" with an ask_human step.
  4. **Autonomous cycle counter**: New `cyclesSinceAskHuman` counter on `BotSchedule` tracks
     non-idle cycles without ask_human. After `askHumanCheckInCycles` (default 5, configurable
     1-50), the planner receives an "Autonomous Run Notice" nudging a check-in.
  5. **Planner examples**: Changed from "need human input on API key" (reactive) to
     "asking operator for preference" (proactive decision-making pattern).
  Files: `agent-loop-prompts.ts`, `agent-loop.ts`, `agent-scheduler.ts`, `config.ts`.
- **Karma -1 per tool error** — Every tool execution or validation error now produces a karma -1
  event via `ToolExecutor.buildFailResult()`. Previously, tool errors only had karma tracking in the
  agent loop via post-hoc batch analysis with a >50% majority threshold (so minority failures got
  delta=0), and `karmaService` was never wired to `ToolExecutor` in any code path (conversation
  pipeline, agent loop, collaboration). Now all three paths receive `karmaService` through
  `ToolRegistry`, `AgentLoop`, and `CollaborationManager`. Lookup errors (disabled/unknown tools)
  are excluded from karma penalties.

### Changed
- **README.md full rewrite** — Replaced outdated minimal README with comprehensive documentation
  reflecting the current autonomous agent platform: architecture diagram, updated project structure
  (30+ bot modules, 20+ tools, 8 skills), core systems overview (agent loop, soul/memory, collaboration,
  productions, karma), configuration reference, tech stack, and links to interactive docs.

### Fixed
- **86 failing tests now skip gracefully** — Tests that depend on external dependencies (Chromium
  browser, CWD-relative skill paths) now use `describe.skipIf` guards instead of failing. Affected:
  4 production skill registry tests (github, linear, obsidian, playwright-browserless) skip when
  `skill.json` not found at CWD-relative path; 2 Playwright MCP test suites skip when Chromium
  not installed; browser-tool `act` test now resets browser state before asserting.
- **CLAUDE.md test enforcement rule** — Added rule requiring AI-generated code to produce passing
  tests. `bun test` must be verified before considering work done. Pre-existing failures from
  external dependencies are excluded.

### Added
- **Enhanced collaboration logging** — Structured logging at key decision points in
  `collaboration.ts`: session create/resume lifecycle, rate-limit pass/block visibility,
  model/timeout/totalMessages in collaboration step logs, timeout warnings with context
  (both target-side and source-side), visible collaboration receiver turn logging,
  `runVisibleTurn` entry logging, delegation model field, and session end logging.

### Refactored
- **Agent loop monolith split** — `agent-loop.ts` (1,482→724 lines) split into 6 focused modules:
  `agent-scheduler.ts` (scheduling, concurrency, sleep), `agent-retry-engine.ts` (retry logic,
  error classification), `agent-planner.ts` (LLM planner with retry), `agent-strategist.ts`
  (strategist, goal operations), `agent-loop-utils.ts` (pure utility functions),
  `llm-json-parser.ts` (generic LLM JSON parser). All backward-compat re-exports preserved.
- **Soul health check split** — `soul-health-check.ts` (575→121 lines) split into
  `soul-lint.ts`, `soul-memory-consolidator.ts`, `soul-quality-reviewer.ts`.
- **ConversationGate extraction** — `handler-registrar.ts` conversation handler (180→25 lines)
  extracted into `conversation-gate.ts` with `ConversationGate` class.
- **ToolExecutor error consolidation** — 6 duplicated error blocks replaced with
  `buildFailResult()` helper.
- **BotManager tenant extraction** — 15 tenant/billing/metering methods (200 lines)
  extracted into `tenant-facade.ts`.

### Fixed
- **handler-registrar.ts runtime crash** — Fixed `sessionConfig is not defined` ReferenceError
  in `registerConversationHandler` (leftover from ConversationGate extraction).

### Changed
- **Removed `nomic-embed-text` hardcoded default** — The embedding model is no longer
  hardcoded as a fallback. `OllamaClient.embed()` now requires an explicit `model` parameter.
  Config `soul.search.embeddingModel` defaults to `''` (empty string) instead of
  `'nomic-embed-text'`. Callers must provide a model name — no code path silently assumes
  a specific embedding model is installed.

### Added
- **Ollama diagnostic chat in web dashboard** — New Integrations page (`#/integrations`)
  with Ollama status card (connection check, latency, available models) and test chat
  form that proxies messages through the same `OllamaClient` code path the bots use.
  Backend: `GET /api/integrations/ollama/status`, `POST /api/integrations/ollama/chat`.

### Changed
- **Ollama timeout default bumped to 300s** — Cloud-routed models like `kimi-k2.5:cloud`
  need more headroom. Default `ollama.timeout` changed from 120s to 300s in both schema
  and config.json.

### Fixed
- **Ollama timeout for cloud-routed models** — All Ollama `fetch()` calls now use
  `AbortSignal.timeout()` to prevent Bun's default ~30s timeout from killing requests
  to slow cloud-routed models (e.g. `kimi-k2.5:cloud`). Configurable via
  `ollama.timeout` in config (default: 300s). Ping uses 5s, listModels uses 10s.

### Added
- **Unified filterable productions list** — The main Productions page now shows a unified
  "All Entries" table below the per-bot summary, aggregating entries from all enabled bots.
  Filter by bot (dropdown) and status (All/Approved/Rejected/Unreviewed), sorted newest
  first. "Load More" button for pagination. Row click opens the existing detail modal;
  delete from unified list refreshes correctly via `onDelete` callback. Backend:
  `ProductionsService.getAllEntries()` merges changelogs across bots with optional
  `botId`, `status`, `limit`, `offset` filters. New `GET /api/productions/all-entries`
  endpoint.

### Fixed
- **Productions thread UX bugs** — Fixed 3 issues that prevented using the Discussion thread:
  1. `statusBadge()` showed "Rejected" for entries with thread-only evaluation (no status).
     Now correctly shows "Unreviewed" when `evaluation.status` is absent.
  2. Removed the old "Feedback" textarea that blocked UX with "Please select Approve or Reject"
     alert. The Discussion thread replaces it. Save Evaluation now works without requiring a
     status — saves rating alone if set.
  3. Hoisted `threadGenerating` state outside `render()` so clicking stars or Approve/Reject
     no longer resets thread polling state. Reordered modal: Discussion section now appears
     above evaluation controls.
- **Bots not asking humans questions (`ask_human` suppressed by SINGLE-FOCUS prompts)** —
  The agent loop prompts systematically prevented `ask_human` usage: the strategist required
  deliverables with "No Dependencies" (no external input), the planner returned `priority: "none"`
  when blocked on human input (skipping executor entirely), and the executor had zero mention
  of `ask_human`. Four prompt-only fixes in `agent-loop-prompts.ts`:
  1. **Strategist**: "No Dependencies" → "Self-Contained OR Ask" — deliverables can now include
     asking the human for input via `ask_human`.
  2. **Planner** (both variants): New `HUMAN COLLABORATION` block instructs the LLM to use
     `ask_human` instead of going idle. `priority: "none"` definition tightened to require
     trying `ask_human` first. Example changed from idle/blocked to ask_human pattern.
  3. **Executor**: Added `ask_human` reminder so the executor knows it's a valid action.

### Added
- **Conversational feedback threads** — Both Productions and Agent Feedback now support
  iterative back-and-forth conversations instead of one-shot feedback. New `ThreadMessage`
  type (`src/types/thread.ts`) with `thread?: ThreadMessage[]` on both `ProductionEvaluation`
  and `AgentFeedback`. Users can comment on productions without approving/rejecting first
  (discuss first, decide later). New API endpoints:
  - `POST /api/productions/:botId/:id/thread` + `GET .../thread-status`
  - `POST /api/agent-feedback/:botId/:id/reply` + `GET .../reply-status`
  - Shared `renderThread()` component in `web/pages/shared.js` renders chat-like threads
  - Bot replies generated via Claude CLI with thread context (last 10 messages)
  - Backward compatible: existing `feedback`/`aiResponse` fields preserved as legacy

### Fixed
- **Timestamps 3 hours ahead (UTC → local time)** — Logs and date calculations used UTC
  instead of the configured timezone (`America/Argentina/Buenos_Aires`). Three changes:
  1. **`process.env.TZ`** set from `config.datetime.timezone` at startup, before logger init.
  2. **Pino `translateTime`** changed from `'HH:MM:ss'` to `'SYS:HH:MM:ss'` so log timestamps
     use system time.
  3. **New `src/date-utils.ts`** with `localDateStr()` / `localTimeStr()` — replaces all
     `toISOString().slice(0, 10)` and `.split('T')[0]` patterns across 13 files. Near-midnight
     UTC the date was wrong (e.g. 01:30 UTC = previous day in ART).
- **Agent loop timeout storms** — Multiple bots (tsc, myfirstmillion, job-seeker) were
  timing out simultaneously with "Executor phase timed out" due to Ollama resource
  contention. Three-pronged fix:
  1. **Increased `maxDurationMs`** from 300s (5min) to 600s (10min) in `config.json`,
     giving each bot more headroom when Ollama is under load.
  2. **Startup stagger** — `syncSchedules()` now offsets each new bot's `nextRunAt` by
     `botIndex × 30s`, preventing all bots from hitting Ollama simultaneously on startup.
  3. **Concurrency limiter** — New semaphore in `runBotLoop()` limits simultaneous agent
     loop executions to `maxConcurrent` (default: 2). Queued bots wait in FIFO order.
     Configurable via `agentLoop.maxConcurrent` (1–10).

### Added
- **Agent loop retry on error** — Exponential-backoff retry inside `runBotLoop()` for
  transient errors (timeouts, network failures, rate limits). Each retry gets a fresh
  `maxDurationMs` budget. Error classification via `isRetryableError()` skips retries
  for permanent errors (auth, permission). Intermediate retries suppress `logToMemory()`
  and `sendReport()` to avoid memory spam. Config: `agentLoop.retry` with `maxRetries`
  (default 2), `initialDelayMs` (10s), `maxDelayMs` (60s), `backoffMultiplier` (2).
  Per-bot overrides supported. Dashboard shows retry count in schedules table and retry
  attempt badge in last results.
- **AI responses to production feedback** — When a user evaluates a production with
  text feedback, the bot now generates an AI response acknowledging the feedback and
  describing what it will improve. Uses fire-and-forget Claude CLI pattern (same as
  summary generation). New `setAiResponse()` method on `ProductionsService`, new
  `GET /:botId/:id/response-status` polling endpoint, and `RESPONSE_SYSTEM_PROMPT`.
  Frontend keeps the modal open after evaluation with feedback, polls for the response,
  and displays it with green left border styling. Evaluations without text feedback
  close the modal as before. AI response is also written to bot daily memory.
- **Skills Dashboard page** — Unified `#/skills` page in the web UI that merges
  built-in skills (from SkillRegistry) and external skills (from skillsFolders)
  into a single browsable list. Built-in skills are read-only; external skills
  support full CRUD with view, edit, create, and delete operations. Includes
  AI-powered skill scaffolding via Claude CLI (`POST /api/skills/generate`) with
  preview-then-apply workflow. New `src/skill-generator.ts` follows the
  soul-generator pattern. Eight new API endpoints under `/api/skills`. Security:
  all write operations validate target directories against `skillsFolders.paths`.
- **Dashboard: retry button for errored agent loop results** — The Last Results table
  on the dashboard now shows a per-bot "Retry" button on rows with `error` status.
  Clicking it calls `POST /api/agent-loop/run/:botId`, shows a "Running..." state,
  then updates the row inline with the new result. Errors display a temporary inline
  message that auto-dismisses after 5 seconds. Retry clicks don't expand/collapse
  the detail row.

### Fixed
- **Strategist parser: accept `single_deliverable` field** — `parseStrategistResult()`
  now accepts both `single_deliverable` and `focus` fields from the LLM response. The
  strategist prompt instructs the LLM to use `single_deliverable` but the parser only
  checked for `focus`, causing every strategist call to fail validation and get retried
  uselessly. Both fields are now populated in the result for backwards compatibility.
- **Executor prompt: file tree context** — The executor prompt now scans the bot's
  `workDir` (max depth 3, max 100 entries) and includes the file listing. Previously
  the prompt claimed "You already know the project structure" without providing any
  file listing, causing the LLM to blindly attempt `file_read`/`file_edit` on
  non-existent files. When the directory is empty, the prompt explicitly says so and
  instructs the LLM to use `file_write` only.
- **Proportional karma penalty for tool errors** — Tool errors now use proportional
  scoring: if >50% of a tool's calls failed, delta is -1 (real problem); if <=50%
  failed, delta is 0 (minor, logged but no score impact). Previously every tool error
  group got a blanket -1 regardless of success ratio. Format changed from
  `Tool error: file_edit (x3)` to `Tool error: file_edit (3/4 failed)`.

### Changed
- **Karma log display** — `getRecentEvents` default limit increased from 10 to 25.
  Agent detail page now shows 15 karma events instead of 5.

### Added
- **Configurable skill folders with per-bot control** — External skill packages (TSC format:
  `skill.json` manifest + `index.ts` handlers) can now be loaded from configurable directories.
  New `skillsFolders.paths` config array specifies extra folders to scan. Tools are namespaced
  as `${skillId}_${toolName}` (e.g. `github_repo_list`) and land in the existing `ctx.tools[]`
  pipeline. Per-bot `disabledSkills` array disables all tools from a skill for a specific bot.
  Settings UI includes a "Skill Folders" card for managing paths. Agent edit form shows
  "External Skills" checkbox section for per-bot enable/disable. New files:
  `src/core/external-skill-loader.ts`, `src/core/external-tool-adapter.ts`.
  Tests: `tests/core/external-skill-loader.test.ts` (20 tests),
  `tests/core/external-tool-adapter.test.ts` (16 tests).
- **Karma reset** — New "Reset Karma" button on the karma detail page (`#/karma/:botId`)
  clears all events for a bot, returning its score to the initial value (50). Confirmation
  dialog prevents accidental resets. Backend: `DELETE /api/karma/:botId/events`.
  `KarmaService.clearEvents()` truncates the JSONL event file.
- **Karma web page** — New `web/pages/karma.js` with full frontend for the karma system.
  List view shows all bots with score bars (0–100), trend badges, and event counts.
  Detail view shows large score gauge, trend, manual adjustment form (delta + reason),
  and paginated event history with source badges and relative timestamps.
  Wired into sidebar nav and app router (`#/karma`, `#/karma/:botId`).
  Route tests added in `tests/web/routes/karma.test.ts` (16 tests).
- **Karma in agents page** — Agent list table now shows a Karma column with
  color-coded score and trend arrow, linked to the bot's karma detail page.
  Agent detail view includes a Karma card with score bar, trend badge, and
  last 5 events with delta, source, reason, and relative timestamp.
- **Architecture documentation site** — Self-contained HTML documentation in
  `docs/architecture-docs/` with 10 navigable pages + shared CSS. Covers architecture
  overview with SVG dependency graph, 20 bot core module deep dives, 4 data flow diagrams,
  27 tools & 8 skills reference, 4-layer memory system, agent loop phases, web dashboard
  API reference, configuration schema reference, and 10 simplification proposals. Dark theme
  matching dashboard, responsive sidebar, inline SVG diagrams, no external dependencies.
- **Tools UI in agent edit page** — New "Tools" checkbox section in the agent edit form
  allows toggling tools on/off per bot. Checked = enabled, unchecked = disabled.
  `GET /api/agents/defaults` now returns `availableTools` array.
  `BotManager.getAvailableToolNames()` exposes the full tool list.

### Fixed
- **Tool error karma dedup** — Agent loop now deduplicates tool error karma by tool
  name. Previously, 10 `file_read` failures cost -10 karma (one event each); now they
  produce a single -1 event with reason `Tool error: file_read (x10)`. Different tools
  still get one event each.

### Changed
- **All tools enabled by default** — Removed `disabledTools` from Therapist config.
  All bots now have access to all tools unless explicitly disabled via the UI.
- **Persistent background summary generation** — "Generate Summary" on the productions
  page is now fire-and-forget: `POST` returns immediately with `{ status: 'generating' }`,
  the backend generates asynchronously and persists the result to `summary.json`. New
  `GET /:botId/summary-status` polling endpoint returns `idle | generating | done | error`.
  Frontend polls every 3s during generation, surviving page navigation and re-entry.
  Duplicate generation guarded by in-memory `Set<string>`. Errors persisted so the UI
  can show "Retry Summary" on failure.

### Added
- **Novelty Imperative (replaces Survival Imperative)** — Planner prompts now enforce
  originality over repetition. ANTI-PATTERNS list bans common busywork (reviewing goals
  without changes, saving empty reflections, re-verifying documents). Boundary-pushing
  activities replace self-improvement suggestions when idle.
- **Repetition tracker** — `BotSchedule` tracks `recentActions` (last 24h / 20 entries)
  with plan summaries and tools used. `buildRecentActionsDigest()` generates a block
  injected into the planner prompt, tagging repeated patterns and listing exhausted actions.
- **Idle support (priority "none")** — Planner can now return `{"plan":[],"priority":"none"}`
  when genuinely idle. Parser accepts empty plans with `"none"` priority. Executor phase
  is skipped entirely for idle cycles. Retry fallbacks return idle instead of busywork.
- **Memory dedup & idle suppression** — `isSimilarSummary()` deduplicates consecutive
  identical memory entries (ignoring timestamps). Idle suppression: first idle cycle logs
  once, subsequent idle cycles are silent. Active cycle after idle streak logs resume count.
  Configurable via `agentLoop.idleSuppression` (default: true).
- **Production quality gates** — `ProductionsService.assessContentQuality()` detects
  template-heavy content (empty headings, TBD/TODO placeholders, unchecked checkboxes).
  Content with < 30% real lines is flagged as template. Templates are not logged as
  productions (file still written, just not counted). Karma penalty (-3) for templates.
- **Karma system** — New `KarmaService` (`src/karma/`) with JSONL-based per-bot event
  storage. Score computed from event deltas with time decay (50% after 30d, 25% after 90d),
  clamped to 0-100. Events tracked: production evaluations, template detection, novel/
  repetitive actions, tool errors, manual adjustments. Trend computed from last 7 days.
  `renderForPrompt()` generates full karma block for planner; `renderShort()` for
  conversation system prompts. Integrated into agent-loop, tool-executor, productions
  service, and system-prompt-builder.
- **Karma API** — `GET /api/karma/` (all bots), `GET /api/karma/:botId` (score + events),
  `GET /api/karma/:botId/history` (paginated), `POST /api/karma/:botId/adjust` (manual).
- **Dashboard idle state** — `BotScheduleInfo` now exposes `isIdle`, `consecutiveIdleCycles`,
  and `recentActionsSummary`. `AgentLoopResult` includes `isIdle` and `consecutiveIdleCycles`.

### Changed
- **Planner prompt rewrite** — Both `buildPlannerPrompt` and `buildContinuousPlannerPrompt`
  updated with novelty-first framing, anti-patterns list, karma block injection,
  recent actions digest injection, and `"none"` priority option.
- **Priority type widened** — `PlannerResult.priority` now accepts `'none'` in addition
  to `'high' | 'medium' | 'low'`. All related interfaces updated accordingly.
- **Planner fallback on parse failure** — Returns `{plan:[], priority:"none"}` instead
  of `{plan:["Review current goals..."], priority:"low"}`.

### Fixed
- **Productions page "File not found or empty"** — `getFileContent()` and `updateContent()`
  resolved relative paths against `process.cwd()` instead of the bot's productions directory,
  causing all file views to fail. Now uses the same dir-aware resolution as `deleteProduction()`.
- **Feedback processing returns "(no response)"** — `processFeedback()` now uses a direct
  `ClaudeCliLLMClient` instead of going through `LLMClientWithFallback`, which was routing
  tool-based calls to the Ollama fallback and producing empty responses for `claude-cli` bots.

### Added
- **Generate Summary button on Productions page** — New "Generate Summary" button on the
  per-bot productions page. Calls Claude CLI to analyze the bot's recent productions, soul
  context, goals, and memory, then displays a read-only summary card explaining what the bot
  is currently working on. Backend: `POST /api/productions/:botId/generate-summary`.
- **Generate Feedback button** — New "Generate Feedback" button on the agent feedback
  dashboard page. Calls Claude CLI to analyze the bot's soul files, productions, memory,
  goals, and feedback history, then produces harsh, actionable feedback that the operator
  can review and edit before submitting. Backend: `POST /api/agent-feedback/:botId/generate`.
  Uses `config.improve.claudePath` and `config.improve.timeout` for CLI configuration.
- **Agent-level feedback system** — New dashboard page lets operators submit high-level
  directives to individual bots (e.g. "focus more on X", "change your tone"). Feedback is
  persisted as JSONL in each bot's soul directory. The agent loop processes pending feedback
  before each cycle: an LLM call with restricted soul-modifying tools (`manage_goals`,
  `update_soul`, `update_identity`, `save_memory`) autonomously applies changes, and the
  bot's response is recorded. Dashboard shows feedback history with status badges (pending,
  applied, dismissed) and the bot's response for applied items. Badge polling in nav shows
  pending count. API: `GET/POST /api/agent-feedback/:botId`, `DELETE /api/agent-feedback/:botId/:id`,
  `GET /api/agent-feedback/count`.
- **`allowedPaths` for file tools** — New `fileTools.allowedPaths` config option adds
  read-only access to extra directories (e.g. reference codebases). `file_read` checks
  `basePath` first, then each allowed path. `file_write` and `file_edit` remain restricted
  to `basePath` only, keeping extra paths strictly read-only.
- **Dynamic tool scope filtering** — Dynamic tools with a `scope` field (specific bot ID)
  are now enforced at runtime. Tools scoped to a bot are only visible to that bot (and its
  creator). Previously all approved dynamic tools were visible to all bots regardless of
  scope. Filtering applies to conversation pipeline, agent loop, and collaboration contexts.
- **Soul health check on startup** — Non-blocking background task runs on each bot
  startup (24h cooldown). Performs structural lint of soul files (missing files, duplicated
  sections, stale placeholders) then spawns Claude CLI for quality review (personality
  drift, contradictions, vague language) with `--allowedTools Read,Edit,Write`. Files are
  backed up before any edit. Config: `soul.healthCheck.enabled` (default true),
  `soul.healthCheck.cooldownMs` (default 24h).
- **Memory consolidation on startup** — Merges daily memory logs older than today into a
  single `MEMORY.md` file via Claude CLI. Deduplicates facts, removes agent-loop noise,
  organizes by natural categories. Processed daily logs are archived to `memory/archive/`.
  System prompt now loads `MEMORY.md` for Core Memory (falls back to `legacy.md`) and
  only today's daily log for Recent Memory. Config: `soul.healthCheck.consolidateMemory`
  (default true).

### Fixed
- **Unhandled promise rejection on ask-human dismiss/timeout** — The `ask_human` tool
  now captures and `.catch()`-es the store promise, so dismiss and timeout rejections
  are logged at info level instead of crashing as unhandled rejections.
- **Therapist SOUL.md duplicate motivations** — Removed embedded motivations section
  (lines 54-83) from SOUL.md that duplicated MOTIVATIONS.md content. Updated stale
  auto-observaciones in MOTIVATIONS.md with evolved content.
- **Root-level orphaned soul files** — Archived `config/soul/{IDENTITY,SOUL,MOTIVATIONS,GOALS,MEMORY}.md`
  to `config/soul/.archived/` — these were leftovers from the pre-per-bot migration.

### Changed
- **Per-bot working directory (`workDir`)** — Each bot now has a configurable `workDir`
  that sandboxes all file operations (`file_read`, `file_write`, `file_edit`) and sets the
  default `cwd` for `exec`. Defaults to `productions/<botId>/`, preserving directory
  structure (no more path flattening). Set `workDir` in the agent edit form or via
  `PATCH /api/agents/:id`. The agent loop executor prompt now shows the actual working
  directory. The directory is auto-created on bot startup and on first tool execution.
- **Browser automation tool** — New `browser` tool powered by Playwright that lets the LLM
  interact with dynamic, JavaScript-rendered web pages. Uses an accessibility snapshot model:
  the page's accessibility tree is rendered as indented text with `[ref=eN]` tags for interactive
  elements (buttons, links, textboxes, etc.), fitting naturally into the text-based `ToolResult`
  interface. Actions: `navigate` (go to URL, auto-snapshot), `snapshot` (re-read current page),
  `act` (click, type, fill, press, hover, select by element ref), `screenshot` (save PNG to disk),
  `status`, `close`. Includes SSRF protection, configurable URL allow/block lists, singleton
  browser with idle auto-close, and per-action timeout. Config: `browserTools.enabled` (default
  false). New files: `src/tools/browser.ts`, `src/tools/browser-session.ts`,
  `src/tools/browser-snapshot.ts`.
- **Reset bot** — New "Reset" action on the agent detail page clears all transient
  state (sessions, daily memory logs, goals, core memory, version backups, embedding
  index) while preserving the bot's identity (IDENTITY.md, SOUL.md, MOTIVATIONS.md).
  API: `POST /api/agents/:id/reset` (requires bot to be stopped). Frontend shows a
  danger-styled button with confirmation dialog when the bot is stopped.
- **Productions system** — Channels bot file outputs (`file_write`, `file_edit`) to a
  configurable `productions/<botId>/` directory with append-only JSONL changelog for
  traceability. Supports two modes: redirect (files go to productions dir) and `trackOnly`
  (files stay in codebase but are logged for review). Dashboard "Productions" page lets
  operators browse bot outputs, view file content, and evaluate productions with
  approve/reject, 1-5 star rating, and feedback. Evaluation results are written back to the
  bot's daily memory so bots learn from scores. New `read_production_log` tool lets bots
  read their own changelog and evaluations. Config: `productions.enabled`, `productions.baseDir`,
  per-bot `productions.trackOnly`.

### Fixed
- **Tool scoping: disabledTools ignored in system prompt** — `SystemPromptBuilder` was
  using `ctx.toolDefinitions` (all tools) instead of `toolRegistry.getDefinitionsForBot(botId)`,
  causing every bot to see all tools in its prompt even when `disabledTools` was configured.
  Reverted to per-bot filtered definitions.
- **Malformed production test file causing 3 test errors** — Deleted
  `productions/myfirstmillion/tests__mcp-client.test.ts` (syntax error, not a project test).
- **Failing integration/reset tests** — Mock configs in `core-memory-pipeline.test.ts`,
  `memory-pipeline.test.ts`, and `reset.test.ts` were missing required `conversation` fields
  (`systemPrompt`, `temperature`, `maxHistory`) needed by `resolveAgentConfig`. Also fixed
  missing `await` on async `coreMemory.set()` calls and mock `ToolRegistry` missing
  `getDefinitionsForBot` method.
- **ask_human: answers lost due to agent loop timeout** — The `ask_human` tool blocked
  (`await promise`) waiting for the human's reply, but the agent loop's `Promise.race`
  timeout (default 5 min) always won. Now `ask_human` is non-blocking: it queues the
  question to the inbox and returns immediately. Answered questions are stored durably
  and injected into the planner prompt on the next agent loop cycle so the bot can act
  on them.

### Changed
- **Agent loop: independent parallel bot loops** — Each bot (periodic and continuous) now
  runs in its own independent async loop, eliminating the serial `executeDueBots()` bottleneck.
  Previously, if bot A took 5 minutes, bots B/C/D waited. Now all bots execute concurrently
  with their own sleep cycles. `runNow()` also runs bots in parallel via `Promise.allSettled()`.
- **Agent loop: removed skip gate from periodic bots** — Periodic bots now always produce
  a plan, matching continuous mode behavior. Bots that have nothing urgent invest in
  self-improvement: reviewing goals, saving insights, or asking the human for guidance.
  Priority field (high/medium/low) added to all planner output.

### Fixed
- **Agent loop: per-bot `every` ignored when planner returns `next_check_in`** — The planner's `next_check_in` was only clamped against global `minInterval`/`maxInterval`, so a bot configured with `every: "1h"` could sleep for 8h if the LLM suggested it. Now `botEvery` acts as an upper bound on the planner's suggestion. The planner prompt also tells the LLM the configured interval so it avoids suggesting longer durations.
- **Agent loop: shared `sleepController` race condition** — The single shared `AbortController` was overwritten by concurrent `interruptibleSleep()` callers (main periodic loop + continuous bot loops), causing orphaned controllers, wrong-target aborts, and `.finally()` nulling out live controllers. Replaced with a `Set<AbortController>` so each sleeper gets its own controller. `stop()` and `wakeUp()` now abort all active sleepers.
- **Agent loop: bots started during execution not picked up** — When new bots started while `executeDueBots()` was running, `wakeUp()` was a no-op (loop wasn't sleeping). After execution, `computeSleepMs()` used stale schedules, causing the loop to sleep for hours while new bots waited. Added `continue` after `executeDueBots()` to re-sync schedules before sleeping.
