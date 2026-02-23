# Changelog

## Unreleased

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
