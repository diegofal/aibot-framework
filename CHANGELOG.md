# Changelog

## Unreleased

### Docs
- **Architecture docs refresh** — Updated `tools-skills.html` (27→41 tools, 8→15 skills, added 6 missing skills, moved Planned Integrations to Implemented, added `signal_completion` tool), `index.html` (20→40 modules, 27→41 tools, 8→15 skills), `bot-core.html` (30→40 modules, ~7.2K→~14.5K lines, added `BotExportService`, `BotResetService`, `ToolLoopDetector`, `LlmResilience` module docs). Added Backlog link to all 12 sidebar navs.
- **New Backlog page** (`docs/architecture-docs/backlog.html`) — Feature backlog imported from `docs/roadmap.md` with status tracking: Audio I/O, Twitter, Reddit, Calendar (pending testing), WhatsApp and Discord (research/deferred), plus Ideas section.
- **README.md updated** — Added multi-tenant BaaS (6-phase), authentication (dual auth), bot export/import sections. Updated tool count (35→41), skill count (16→15), module count (38→40). Expanded MCP and tenant project structure. Added missing dashboard pages (Agent Proposals, Feedback). Added new config sections (mcp, agentProposals, collaboration). Removed non-existent twitter skill.
- **roadmap.md** — Fixed Project 4 (Twitter) status: skill directory `src/skills/twitter/` does not exist (was incorrectly listed as implemented). Updated date to 2026-03-05.

### Added
- **Per-bot `maxToolRounds` for conversations** — Each bot can now override the global `webTools.maxToolRounds` limit via `maxToolRounds` in its bot config. This controls how many tool call rounds the LLM can execute during a conversation or collaboration turn. Also raised the global ceiling from 10 to 50.
- **Chatless cron scheduling (`memory_note` payload)** — Bots in agent-loop mode (no Telegram chat) can now schedule cron reminders. Previously, `cron add` rejected with "missing chat context" because all jobs required a `chatId` for Telegram message delivery. New `kind: 'memory_note'` payload writes the reminder text to the bot's daily memory log when it fires, so the bot picks it up on its next agent loop iteration.

### Fixed
- **`__admin__` tenant blocked by quota checks** — Bots with `tenantId: "__admin__"` were permanently blocked from running agent loops and conversations because `__admin__` is a synthetic super-tenant (not a real tenant in TenantManager), causing `checkQuota` to always return `false`. Fixed by exempting `__admin__` from quota checks, usage recording, and bot-limit validation in `TenantFacade`, consistent with how it's already exempted from tenant scoping.
- **`manage_goals` alias expansion** — Added `jobId`, `job`, and `id` to goal parameter aliases. LLMs used these names for `complete` and `update` actions, causing "Missing required parameter: goal" errors.
- **`manage_goals` fuzzy matching (Jaccard similarity)** — Added 5th matching strategy using Jaccard word similarity scoring (threshold ≥0.3) as fallback when substring, slug, and word-based strategies all fail. Also strips filler words (`goal`, `task`, `objective`, `item`, `todo`) from slug-normalized searches so inputs like `"goal-audit-presencia-digital"` match `"Auditar presencia digital"`.
- **`file_read` directory listing on errors** — When a file is not found, the error now includes a listing of files in the parent directory (up to 20 entries) so the LLM can self-correct. When reading a directory, returns its contents instead of a generic "Directories cannot be read" error.
- **`ask_permission` duplicate request spam** — Bots re-requested the same permission 5-6 times per run because dedup only checked the `pending` queue. Once a permission was approved and consumed, the guard dropped and the bot asked again. Extended dedup to check `resolved` queue + `history` (24h window). Also added resource path normalization so `/home/diego/projects/aibot-framework/src/bot/tool-executor.ts` and `src/bot/tool-executor.ts` are recognized as the same resource.
- **Duplicate skills in agent edit UI** — `GET /api/skills` concatenated built-in and external skill lists without deduplication, causing skills present in both registries to appear twice in the edit form. Added dedup by skill ID (builtin preferred over external, plus external-to-external dedup). Also added `[...new Set()]` dedup on PATCH/POST agent save to prevent duplicate IDs from being persisted.

### Changed
- **New bots default to all skills** — `POST /api/agents` now defaults the `skills` array to all available skills (built-in + external, deduplicated) when `skills` is not provided in the request body.

### Added
- **Soul status banner on agent edit screen** — The edit agent form now checks soul file status on load via `GET /api/agents/:id/soul-status`. If soul files are missing or incomplete (e.g. generation failed during bot creation), a prominent warning banner is shown with a "Generate Soul" button for easy retry.
- **Select all / unselect all for skills** — Agent edit form now has "Select all" and "Unselect all" links above the skills checkbox group.

### Fixed
- **`manage_goals` — "No active goal matching" false negatives** — LLMs frequently call `manage_goals` with numeric IDs (`"4"`), slug-style keys (`"establish-autonomy-loop-for-idle-periods"`), or verbose text that doesn't exactly substring-match the stored goal. Added `findGoalIndex()` with 4-tier matching: (1) numeric 1-based index, (2) direct substring, (3) slug-normalised (dashes/underscores → spaces), (4) word-based fallback. Error messages now include the active goal list so the LLM can self-correct. Also: `updateGoal` with `status: completed` now auto-moves the goal to the Completed section instead of leaving it stranded under Active Goals.
- **External skill tool crash (`ctx.tools.execute` undefined)** — Reddit, calendar, and daily-briefing skills had `handlers` that tried to delegate to other tools via `ctx.tools.execute`, but neither `SkillContext` nor `TscSkillContext` provided a `tools` property. This caused `reddit_hot`, `reddit_search`, `calendar_list`, etc. to throw `"undefined is not an object (evaluating 'ctx.tools.execute')"` when called through the external tool adapter. Root causes and fixes:
  - **Reddit/calendar**: Removed broken delegator `handlers` and `tools[]` from `skill.json` — these created duplicate wrapper tools (`reddit_reddit_hot`, etc.) that shadowed the real tools in `src/tools/`. Command handlers now use `ctx.tools?.execute?.()` safely.
  - **Daily-briefing**: Fixed unsafe property chain (`ctx.tools.execute` → `ctx.tools?.execute?.()`).
  - **`TscSkillContext`**: Added `tools.execute` capability to the external-tool-adapter context, wired via a lazy tool executor that resolves tools at call time.
  - **`SkillContext`**: Added optional `tools` property; `SkillRegistry.setToolExecutor()` patches all existing contexts after tools are initialized.
- **Tool parameter alias normalization** — LLMs (qwen3.5, qwen3-coder) frequently call tools with wrong parameter names, wasting an entire LLM round-trip on self-correction (5-20s each). Added alias resolution across the most-affected tools:
  - `save_memory`: accepts `content`, `value`, `text`, `memory`, `note`, `message` as aliases for `fact` (7 errors)
  - `manage_goals`: accepts `goalId`, `name`, `title`, `text`, `description` as aliases for `goal` (17 errors — most common tool error)
  - `file_read`/`file_write`: accepts `file_path`, `filepath`, `file` as aliases for `path`
  - `file_edit`: accepts `old_string`/`oldText`/`search` for `old_text`; `new_string`/`newText`/`replace` for `new_text`
  - Canonical parameter names always take priority over aliases.
- **read_production_log crash on malformed JSONL entries** — `e.timestamp.slice()` threw when JSONL entries had missing `timestamp`, `action`, or `path` fields. Added null-coalescing guards.
- **manage_goals SoulLoader race condition** — `getSoulLoader(botId)` was called outside the try/catch block, causing an unhandled throw when tools executed for bots not yet started (e.g. during collaboration). Moved into try/catch so the error returns `{success: false}` gracefully.
- **External skill adapter tools context hardening** — Froze the `tools` bridge object passed to external skill handlers via `Object.freeze()` to prevent accidental nullification of `ctx.tools.execute`.
- **Phantom memory saves** — LLM sometimes responded with "guardado en memoria" or "saved" without actually calling `save_memory` or `core_memory_append`, leading to silently lost data. Two-pronged fix: (1) system prompt now explicitly forbids claiming a save without a tool call, (2) `runToolLoop` detects phantom save patterns in the response and logs a warning when no memory tool was called.

### Added
- **Configurable LLM backend for soul health check / quality review** — Quality review and memory consolidation now support both Claude CLI and Ollama backends. New `soul.healthCheck.llmBackend` and `soul.healthCheck.model` config fields let you choose which model runs the review. Configurable via the Settings page in the web dashboard ("Soul Health Check / Quality Review" card). When Claude CLI is out of quota, switch to Ollama to keep quality reviews running. Also improved failure logging: Claude CLI errors now include stdout in the log (previously only stderr was captured, which was empty for quota errors).
- **`create_agent` system prompt instructions** — The `create_agent` tool was registered but never surfaced in the system prompt, so no bot knew it existed. Added `createAgentInstructions()` to `SystemPromptBuilder` (injected when the tool is present) listing the current ecosystem agents and guidelines for when to propose a new one. Also added `create_agent` to the `communication` category description in agent-loop planner prompts.
- **Soul generation model selector** — Users can now choose which LLM to use for soul generation (Claude CLI or any available Ollama model) in both the "New Agent" and "Generate Soul" modals. The selection persists through regeneration. Previously, soul generation was hardcoded to Claude CLI with no fallback.
- **Web conversation logging** — `generateBotReply()` and `webGenerate()` now log detailed info to the console: generation start (botId, botName, type), LLM call (promptLen, messageCount, backend, model, toolCount), and completion (durationMs, responseLen). Previously only 1-2 lines were logged, making web conversations invisible in `bun run start` output.
- **Username/password auth for web dashboard** — Replaces API-key login with email + password for human users:
  - **Session store** (`src/tenant/session-store.ts`): In-memory sessions with `sess_` prefix, 24h TTL, periodic cleanup
  - **Admin credential store** (`src/tenant/admin-credentials.ts`): First-run admin setup, argon2id password hashing via `Bun.password`
  - **Dual auth**: Session tokens (`sess_`) for dashboard, API keys (`aibot_`) for programmatic access. Middleware accepts both
  - **New auth endpoints**: `POST /api/auth/login` (email+password → session), `POST /api/auth/logout`, `POST /api/auth/admin-setup` (first-run), `GET /api/auth/status` (multiTenant + adminSetupRequired flags)
  - **Tenant password support**: `passwordHash` field on Tenant, `getTenantByEmail()`, `emailIndex` for fast lookup
  - **Onboarding signup** now requires password (min 8 chars), returns `sessionToken` for auto-login alongside `apiKey`
  - **Admin middleware** accepts session tokens with admin role (not just `ADMIN_API_KEY`)
  - **WebSocket auth** accepts session tokens in `?token=` param
  - **Login form** rewritten: email + password fields, admin setup form for first run
  - **`/api/status`** no longer exposes `multiTenant` (moved to `/api/auth/status`)
  - Removed `/api/auth/validate` endpoint (replaced by `/api/auth/login`)
  - 33 new tests across 4 test files. API keys still work for programmatic access. Single-tenant mode fully backward compatible
- **Multi-Tenant BaaS infrastructure** — Complete shared-infrastructure multi-tenancy system across 6 phases:
  - **Phase 6 — Per-user isolation within bots**: Core memory now supports `user_id` column for per-user data isolation. `userIsolation.enabled` config flag gates the feature. Memory tools, search, daily logs, system prompts, and indexer all support per-user scoping. Shared categories (null userId) visible to all users.
  - **Phase 1 — Security foundation**: Admin auth middleware (`ADMIN_API_KEY`), tenant auth middleware (Bearer token), tenant scoping helpers (`scopeBots`, `isBotAccessible`, `getTenantId`). All 7 route handlers scoped per-tenant. Server.ts restructured with 3 auth tiers (public, tenant-auth, admin-auth).
  - **Phase 2 — Tenant config layer**: Zod-validated `TenantConfigSchema` for per-tenant LLM/BYOK/features/branding overrides. File-based `TenantConfigStore`. Config merge: global → tenant → bot. API routes for GET/PUT config and masked API key management.
  - **Phase 3 — Data isolation**: `resolveTenantPaths()` resolves `data/tenants/{tenantId}/bots/{botId}/`. Path sandbox validation via `isPathWithinTenant()`. `_tenantRoot` injected into tool args. Agent registry filters collaboration by `tenantId`. Headless bots registered with tenant.
  - **Phase 4 — Quota enforcement & rate limiting**: In-memory sliding window `RateLimiter` with per-plan limits (free: 20/min → enterprise: 500/min). Rate limit Hono middleware with 429 + Retry-After. Quota checks in `ConversationPipeline` (pre-LLM) and `AgentLoop` (pre-cycle). Usage recording for messages, LLM requests, API calls, tool executions. Graceful degradation: X-Quota-Warning headers at 80%/90%.
  - **Phase 5 — Onboarding & billing**: Enhanced signup with email dedup and auto-directory creation. First-bot onboarding wizard. Billing routes (status, upgrade, downgrade). Stripe webhook endpoint. `handleWebhook` delegate on BotManager.
- **New files**: `src/tenant/rate-limiter.ts`, `src/tenant/rate-limit-middleware.ts`, `src/tenant/tenant-paths.ts`, `src/tenant/tenant-config.ts`, `src/tenant/tenant-config-store.ts`, `src/tenant/admin-middleware.ts`, `src/tenant/tenant-scoping.ts`, `src/web/routes/tenant-config.ts`, `src/web/routes/billing.ts`, `src/web/routes/webhooks.ts`, `src/web/routes/onboarding.ts`
- **93 new tests** across 11 test files covering all multi-tenant features

### Fixed
- **Unified web/Telegram conversation pipeline** — Web dashboard conversations now use the same `SystemPromptBuilder.build()` and `prefetchMemoryContext()` path as Telegram. Previously the web route built a stripped-down prompt manually (truncated soul files, no MEMORY.md, no core memory, no RAG, no humanizer, no karma, no tool instruction blocks). Now both channels produce identical system prompts with full memory access. New `buildSystemPrompt()` and `prefetchMemoryContext()` facade methods on `BotManager`. `webGenerate()` supports multi-turn `messages[]` arrays.
- **Bot import: soul files now re-indexed for RAG search** — After importing a bot, soul files (IDENTITY.md, MEMORY.md, legacy.md, etc.) were not re-indexed in the search database, making them invisible to RAG queries ("te acordás de X?"). Import now triggers a full reindex via a new `MemoryManager.reindex()` method.
- **Bot import: core_memory fallback without Ollama** — When `MemoryManager` is not available (e.g. `soul.search.enabled: false` or Ollama down), the import now creates a standalone `CoreMemoryManager` via direct SQLite access instead of silently skipping `core_memory.jsonl`.
- **Export manifest accuracy** — `manifest.includes.coreMemory` now reflects whether entries were actually exported, not just whether the callback function was injected.
- **Admin sees all bots** — In multi-tenant mode, admin (tenantId `__admin__`) now sees and can access all bots, including legacy bots without `tenantId`. `scopeBots` and `isBotAccessible` in `src/tenant/tenant-scoping.ts` treat `__admin__` as a super-tenant.
- **Coherence check always shows explanation** — Coherence check explanation is now always visible: thread auto-posts "Coherence Check (OK): ..." for coherent results (previously only incoherent results posted), and the "Checked" badge now shows the explanation as a tooltip on hover.

### Added
- **Coherence check persistence + visual indicators** — Coherence check results now persist in the JSONL changelog (survive server restarts). New `setCoherenceCheck()` method in `ProductionsService`. Tree view shows a second dot per file: celeste for coherent, red for incoherent. File viewer shows "Checked" badge alongside "Unreviewed"/"Approved"/"Rejected". New "Checked" filter option in the status dropdown. `getStats()` now includes a `checked` counter. `CoherenceCheck` interface added to `types.ts`.

### Added
- **Productions YAML frontmatter** — New `.md` production files now get `created_at` YAML frontmatter injected automatically after file creation. `ProductionsService.injectFrontmatter()` and `parseFrontmatter()` static methods handle injection/extraction. Existing files without frontmatter fall back to changelog timestamp or stat.birthtime (no retroactive migration).
- **Productions chronological index** — `INDEX.md` now includes a `## All Files (chronological)` section at the end showing all non-archived files sorted by creation date with sequential numbering. Date format upgraded from `YYYY-MM-DD` to `YYYY-MM-DD HH:mm` across all index sections. `resolveCreatedAt` resolves dates with priority: YAML frontmatter > changelog timestamp > stat.birthtime.
- **Productions auto-cleanup** — `rebuildIndex` now runs a throttled cleanup (1 hour cooldown) that auto-archives: (1) tiny files <50 bytes, (2) incoherent `.md` files (via `checkCoherence`), (3) duplicate files (SHA-256 hash). Approved files are never auto-archived. `archiveFile` accepts optional `skipRebuild` parameter to batch multiple archives efficiently.

### Fixed
- **Agent loop cadence enforcement** — Fixed 3 bugs causing bots to run outside their configured schedules:
  1. **Global `wakeUp()` no longer triggers out-of-schedule runs** — `runBotLoop()` now re-checks `nextRunAt` after waking from sleep. If the bot was woken early by a global `wakeUp()` (triggered by dashboard interactions like ask_human replies, permission approvals, or agent feedback), it goes back to sleep for the remaining time instead of immediately re-executing. Only bots targeted by `requestImmediateRun()` bypass the guard.
  2. **Stale `nextCheckIn` reconciled on startup** — `loadFromDisk()` now compares each bot's persisted `nextCheckIn` against the current config and corrects mismatches (e.g., selfimprove had `nextCheckIn: "6h"` on disk while config said `every: "2h"`). Also recalculates `nextRunAt` based on the corrected interval.
  3. **Concurrency starvation mitigated** — The cadence guard (fix 1) reduces unnecessary wakeups that flood the concurrency queue, giving high-frequency bots (e.g., monetize at 30m) fairer access to execution slots.

### Added
- **Productions URL state persistence** — Selected production file is now encoded in the URL hash as query parameters (`?bot=...&file=...` for all-bots view, `?file=...` for single-bot view). Refreshing the page restores the selected file, expanding parent directories as needed. Archive/delete operations clear the URL params. Uses `history.replaceState` to avoid polluting browser history.

### Added
- **Bot Export/Import system** — New `BotExportService` (`src/bot/bot-export-service.ts`) enables full bot backup and restoration as portable `.tar.gz` archives. Exports include: manifest, sanitized config (no tokens), soul directory (excludes `.versions/`), core memory (JSONL), and optionally productions, conversations, and karma. Import supports ID/name overrides, conflict detection (409), and overwrite mode. API routes: `GET /api/agents/:id/export` (download), `POST /api/agents/import` (multipart upload). Dashboard UI: Export button per agent (with modal for optional inclusions), Import Agent button in header (with file upload and ID override fields).
- **Memory consolidation safety guard** — `soul-memory-consolidator.ts` now validates LLM output before overwriting `MEMORY.md`: rejects output missing the `<!-- last-consolidated: -->` header, and rejects output that is less than 50% of the existing file size. Prevents accidental data loss from LLM returning summaries instead of full consolidated documents.

### Fixed
- **Finny's MEMORY.md restored** — Restored `config/soul/default/MEMORY.md` from backup (`.versions/MEMORY.md.2026-03-01T01-47-04.bak`, 12.7KB) after the consolidator overwrote it with a 10-line summary. Updated with data from daily logs 2026-03-01 and 2026-03-02 (inventory discrepancy, filesystem bug, self-reflection).

### Changed
- **Bots extracted to `config/bots.json`** — The `bots` array (containing Telegram tokens) now lives in a separate `config/bots.json` file instead of inside `config/config.json`. This makes `config.json` token-free and safe to commit. **Auto-migration**: on first run, if `bots.json` doesn't exist but `config.json` has a `bots` key, bots are automatically migrated to the new file. A shared `persistBots()` export in `src/config.ts` replaces the duplicated local functions in `agents.ts` and `agent-proposals.ts`. The `.gitignore` now ignores `config/bots.json` instead of `config/config.json`. New `config/bots.example.json` provided as a template.

### Added
- **Structured logging for 6 high-severity gaps** — Added ~33 log lines across `tenant-facade.ts` (security audit trail for CRUD, API key regeneration, quota checks, billing), `mcp/client.ts` (handshake timing, tool filtering stats, tool call duration/audit), `agent-planner.ts` (LLM call visibility, fallback warnings), `agent-strategist.ts` (goal operations audit, goals file state), `conversation-pipeline.ts` (compaction results, emergency overflow stats, session persistence), `collaboration.ts` (MCP tool discovery, missing tool warnings, response extraction), and `web/server.ts` (WebSocket connect/disconnect counts, broadcast failure logging). No new dependencies or infrastructure — just `logger.info`/`warn`/`debug` calls filling visibility gaps.

### Added
- **`agentProposals` enabled in config** — Added `"agentProposals": { "enabled": true }` to `config/config.json`, enabling the `create_agent` tool registration at startup.
- **Comprehensive `config.example.json`** — Rewrote the example config from 78 lines to a full template covering all config sections (agentProposals, dynamicTools, collaboration, agentLoop, mcp, productions, karma, browserTools, web, reddit, twitter, calendar). All secrets use `${VAR_NAME}` placeholders. Includes 2 example bots with placeholder tokens.

### Changed
- **Permissions never expire** — Removed timeout mechanism from `AskPermissionStore`. Pending permission requests now persist indefinitely until the human approves or denies them. The `timeout_minutes` parameter has been removed from the `ask_permission` tool. The `expired` status is no longer used.
- **Pending permissions persist across restarts** — `AskPermissionStore.dispose()` now persists pending entries to disk before clearing memory. On restart, pending requests are restored from disk and remain visible in the dashboard. Previously, restarting the bot would lose all pending permission requests.
- **PERMISSION PROTOCOL explicit with allowed paths** — The planner prompt now explicitly lists which paths are allowed for writes without permission (default: `productions/`) and which actions require `ask_permission`. New `allowedWritePaths` config field per bot.

### Added
- **Tool loop detection for agent-loop** — New `ToolLoopDetector` class (`src/bot/tool-loop-detector.ts`) with 4 detection strategies: global circuit breaker, known poll no-progress, ping-pong alternation, and generic repeat. Adapted from OpenClaw's `tool-loop-detection.ts` with fixes for consecutive streak counting, warned-pattern cleanup, result-aware generic repeat, and configurable poll tool matching. Integrated into `ToolExecutor` via optional injection — critical detections block tool execution with an error message visible to the LLM; warnings append a notice to tool results. New `loopDetection` config section in `agentLoop` with per-bot overrides.
- **`allowedWritePaths` per-bot config** — New optional `allowedWritePaths: string[]` field in bot config. Defaults to `["productions/"]` at runtime. Paths listed here do not require `ask_permission` for file writes. The PERMISSION PROTOCOL in the planner prompt dynamically reflects each bot's allowed paths.
- **Web dashboard tool support** — Production threads, conversations, and agent-feedback interactions now have access to bot tools (web_search, web_fetch, file tools, memory, etc.) via `LLMClient` abstraction. New shared `webGenerate()` helper in `src/web/routes/web-tool-helpers.ts` replaces direct `claudeGenerate()` calls. Dashboard-unsafe tools (delegate_to_bot, collaborate, ask_human, etc.) are filtered out. Text-only call sites (coherence check, summaries) explicitly opt out with `enableTools: false`. Falls back gracefully to text-only when no LLMClient or no tools are available.
- **Activity page: infinite scroll (scroll-up to load older)** — Both Events and System Logs tabs now support scrolling up to load older entries from the server. Backend: `ActivityStream.getSlice(limit, offset)` method + `GET /api/activity?limit=&offset=` updated with pagination + new `GET /api/logs?limit=&offset=` endpoint for paginated log access. Frontend: scroll-up detection at `scrollTop < 80px`, loading indicator, prepend with scroll-position preservation. Activity buffer increased from 200 to 2000. DOM limits raised to 2000 events / 5000 log lines. Clear resets pagination state.

### Changed
- **Productions: LLM-based coherence check** — Replaced heuristic coherence check with an LLM-based evaluation via Claude CLI. The `GET /:botId/:id/coherence` endpoint is now async (fire-and-forget + polling pattern). When content is flagged incoherent, an explanation is automatically posted to the production's discussion thread (with duplicate prevention). Dashboard shows "Checking..." badge during evaluation, then "Incoherent" with tooltip if issues are found.

### Added
- **MMR diversity re-ranking for memory search** — Opt-in Maximal Marginal Relevance (MMR) post-processing step in `hybridSearch()`. When enabled (`soul.search.mmr.enabled: true`), re-ranks results to balance relevance with diversity, reducing near-duplicate chunks that waste context slots. Configurable lambda parameter (0 = max diversity, 1 = max relevance, default 0.7). Algorithm transplanted from OpenClaw.
- **Memory Search settings in dashboard** — New "Memory Search" card in Settings page exposes MMR (enabled + lambda) and Auto-RAG (enabled, maxResults, minScore, maxContentChars) controls. Backend: `GET/PATCH /api/settings/memory-search` endpoints.
- **`create_agent` tool — Agent self-creation proposals** — Agents can now propose new agents for the ecosystem via the `create_agent` tool. Proposals include agent ID, name, role, personality description, skills, and justification. All proposals require human approval in the web dashboard before creation.
- **Agent Proposals dashboard page** — New `#/agent-proposals` page with pending proposal cards (approve/reject), resolved history table, and badge polling for pending count in the sidebar.
- **Agent Proposals web API** — `GET /api/agent-proposals` (list), `GET /api/agent-proposals/count` (badge), `POST /:id/approve` (create agent + generate soul), `POST /:id/reject`, `DELETE /:id`.
- **Approval pipeline** — Approving a proposal creates a `BotConfig` entry (disabled, no token), soul directory with `IDENTITY.md`, attempts AI soul generation via Claude CLI (with graceful fallback), and saves baseline backups.
- **`AgentProposalStore`** — Disk-based persistent store for proposals at `data/agent-proposals/{uuid}/meta.json`, following the `DynamicToolStore` pattern.
- **Config: `agentProposals`** — New config section: `enabled`, `storePath`, `maxAgents` (default 20), `maxProposalsPerBot` (default 3).

### Fixed
- **Karma/Activity consistency** — Tool errors now appear in both Karma and Activity event log. Previously, only ToolExecutor instances created by the agent-loop bridged events to the activity stream; conversation pipeline and collaboration executors were invisible. Auto-bridging is now built into the ToolExecutor constructor, so all instances publish `tool:start`, `tool:end`, and `tool:error` to the activity stream automatically.
- **Broken skills (`daily-priorities`, `reminders`, `task-tracker`)** — These skills existed in `./src/skills` with valid `skill.json` manifests but were never discovered because `skillsFolders.paths` only pointed to `./productions/tsc/src/skills`. Added `./src/skills` to the configured paths. The `reminders` skill's `ctx.cron.add/remove` calls are now wired to the real `CronService` instead of a no-op, enabling actual job scheduling.

### Added
- **`karma:change` activity event type** — Non-tool karma changes (production evaluations, agent-loop novel/repetitive action tracking) are now published to the activity stream as `karma:change` events. The Activity UI renders them with a yellow badge.
- **Production evaluation → Activity stream** — Approving/rejecting a production now publishes a `karma:change` event to the activity stream with delta, reason, and file path.

### Changed
- **External tool adapter: real cron support** — `adaptExternalTool()` accepts optional `cronDeps` with a `CronService` reference. When provided, `ctx.cron.add()` creates actual scheduled jobs (with proper `chatId`/`botId` from ToolExecutor context injection) and `ctx.cron.remove()` looks up jobs by name or ID before removing.

### Added
- **Productions: per-directory auto-numbered filenames** — New files created by bots via `file_write` are automatically renamed with a `01_`, `02_`, etc. prefix for chronological ordering within each directory. Already-numbered and excluded files (INDEX.md, changelog.jsonl, etc.) are skipped. New methods: `getNextNumber()`, `renumberFile()`.
- **Productions: richer INDEX.md descriptions** — INDEX.md now shows "Title -- First sentence" descriptions (up to 120 chars) extracted from file content instead of just the first heading. Humanized filename fallback strips number prefixes.
- **Productions: AI-generated strategy/plan section in INDEX.md** — The "Generate Summary" button now also generates a strategic plan section analyzing themes, gaps, and next priorities. The plan is cached in `summary.json` and rendered as "Strategy & Plan" in INDEX.md.
- **Productions: coherence checking** — New `checkCoherence()` method performs heuristic checks (template ratio, content size, heading/paragraph balance) without LLM. New `GET /:botId/:id/coherence` API route. Dashboard shows an "Incoherent" badge on files that fail checks.
- **Productions: archive from dashboard** — New `POST /:botId/:id/archive` API route exposes the existing `archiveFile()` method to the web. Dashboard file viewer now has an "Archive" button that shows a modal for entering an archive reason, then moves the file to `archived/`.
- **Tool Runner: MCP tools separated by server** — MCP tools now appear in their own "MCP Servers" section in the Tool Runner sidebar, sub-grouped by server prefix (e.g., `github`, `everything`). The `/api/tools/all` endpoint returns `source: 'mcp'` and `category` (server prefix) for MCP tools. Detail view shows a distinct `mcp: <server>` badge.
- **Productions explorer: Expand all / Collapse all buttons** — Both the all-trees and bot-level explorer views now have Expand all / Collapse all buttons. Expand state is persisted to `localStorage` per view (all-trees and per-bot) so it survives page navigations and refreshes.

### Fixed
- **Collaboration tools crash in autonomous mode** — `collaborate send` crashed with `handler.isTargetAvailable is not a function` because the handler object wired in `bot-manager.ts` was missing `isTargetAvailable`. Added the missing property to the collaborate handler. This restores all bot-to-bot communication in autonomous mode (`collaborate send`, `delegate_to_bot` fallback).
- **`signal_completion` tool never registered** — `signal_completion` was listed in `TOOL_CATEGORIES.production` but never imported or instantiated in `tool-registry.ts`. Now registered alongside other production tools when `productionsService` is available.
- **Productions explorer: auto-expand all directories** — In all-trees view (`#/productions`), bot folders AND all subdirectories are now auto-expanded so files are visible immediately. In bot-level view, auto-expand threshold raised from 5 to 20 dirs to cover bots with many subdirectories.
- **Productions explorer: INDEX.md now visible in tree** — `INDEX.md` was incorrectly excluded from the file tree display. Added a separate `TREE_EXCLUDES` set (without `INDEX.md`) for tree rendering while keeping `INDEX_EXCLUDES` (with `INDEX.md`) for `rebuildIndex()`.
- **MCP tools not visible after dynamic add/remove via Settings UI** — `registerMcpTools()` is now idempotent: it removes existing MCP tool entries before re-registering, so calling it after add/remove doesn't duplicate tools. The Settings route now calls `registerMcpTools()` after POST (add server) and DELETE (remove server), so MCP tools appear/disappear in the Tool Runner immediately without requiring a restart.
- **Graceful handling of collaborate tool when target bot is offline** — When a bot tries to collaborate with an offline target, the tool now returns a clean `{ success: false }` with an actionable message ("not currently running, use discover") instead of throwing an error that gets caught and logged as ERROR. Added `isTargetAvailable()` method to `CollaborationManager` and a pre-check in the collaborate tool's send action.
- **Productions explorer: directories now visible and clickable** — `matchesFilters()` no longer hides directories when no search/status filters are active, fixing two bugs: root-level folders not appearing and folder clicks not expanding/collapsing.
- **Productions explorer: cross-bot expand key collision** — In all-bots view, expanding `cultural/` in bot A no longer affects `cultural/` in bot B. Expand keys now use `botId/path` composite keys for non-top-level directories.

### Added
- **Markdown preview in Productions** — Files with `.md` extension are now rendered as formatted HTML (headings, lists, code blocks, tables, blockquotes) instead of raw text. Applies to file viewer in both explorer views, detail modal, and shared file preview modal. Uses `marked` library via CDN. Non-markdown files continue to render as `<pre>` blocks.

### Changed
- **Unified Activity & Logs into a single dashboard page** — The separate Logs page has been merged into the Activity page as a "System Logs" tab alongside the existing "Events" tab. Both WebSocket streams run in parallel so neither loses data while viewing the other tab. Pause/Resume and Clear act on the active tab. The sidebar nav no longer shows a separate "Logs" link, and `#/logs` redirects to `#/activity?tab=logs`.

### Added
- **MCP Agent Collaboration** — External MCP agents can now participate in the collaboration system:
  - `CollaborationManager.collaborationStep()` detects external MCP agents (registered via `McpAgentBridge` with `mcp-external` skill) and routes messages through `McpAgentBridge.callTool()` instead of the internal LLM path.
  - Supports `collaborate`, `chat`, `message`, or `ask` tool names on the external agent, with descriptive fallback when no suitable tool is available.
  - Rate limiting, session management, and activity events apply equally to MCP and internal collaborations.
  - `McpAgentBridge` is now part of `BotContext` and initialized/cleaned up by `BotManager`.
  - Discover action no longer shows `@undefined` for MCP agents without a Telegram username.
  - 7 new tests covering MCP routing, rate limiting, error handling, and discover display.
- **MCP Server Settings UI** — Add/remove/view MCP server connections from the web dashboard Settings page:
  - New routes: `GET /api/settings/mcp`, `POST /api/settings/mcp/servers`, `DELETE /api/settings/mcp/servers/:name`.
  - Live connect/disconnect: adding a server immediately connects it; removing disconnects it.
  - Config persistence: changes are written to `config.json` for persistence across restarts.
  - Settings UI card shows server list with name, transport type, and status badge (connected/disconnected/error), plus add/remove controls.
  - 10 new tests covering CRUD operations, validation, persistence, and error cases.
- **Productions File Explorer UI** — Replaced flat table views with interactive file explorers:
  - **Bot-level explorer**: tree sidebar with expand/collapse directories, status dots (approved/rejected/unreviewed), text and status filters. Content panel with file preview, inline evaluation (approve/reject/rate), and discussion thread. Bot selector dropdown to switch bots.
  - **All-bots explorer**: main productions page shows a unified tree rooted at bot folders, with the same file viewer, evaluation, and thread capabilities. Replaces the flat "All Entries" table.
  - New backend: `GET /:botId/tree`, `GET /:botId/file-content`, `GET /all-trees` endpoints. `getDirectoryTree()`, `getFileContentByPath()`, and `getAllDirectoryTrees()` on `ProductionsService`. `TreeNode` interface.
  - `destroyProductions()` cleanup for polling intervals on navigation
  - Auto-expands bot folders (all-bots view) and directories when tree has 5 or fewer folders (bot view)
  - Summary and Productions Chat sections preserved below the explorer
- **MCP Bidirectional Interoperability** — Full Model Context Protocol support:
  - **MCP Client** (`src/mcp/client.ts`, `client-pool.ts`) — Connect to external MCP servers (GitHub, Linear, Notion, etc.) via stdio or SSE transport. Auto-reconnect, tool filtering (allow/deny lists), per-server namespacing.
  - **MCP Server** (`src/mcp/server.ts`) — Expose bot tools to external clients (Claude Desktop, Cursor, other frameworks). Auth token, rate limiting, tool hide/expose lists.
  - **MCP Agent Bridge** (`src/mcp/agent-bridge.ts`) — Agent-to-agent communication via MCP. External agents register with `AgentRegistry` and become discoverable by internal bots.
  - **MCP Client Skill** (`src/skills/mcp-client/`) — `list_mcp_servers` and `call_mcp_tool` handlers for bot-level MCP interaction.
  - **Shared MCP types** (`src/mcp/types.ts`) — `JsonRpcMessage`, `McpToolDef`, `McpToolCallResult`, protocol helpers. Existing `tool-bridge-server.ts` refactored to import shared types.
  - **MCP Tool Adapter** (`src/mcp/tool-adapter.ts`) — Converts MCP tools to framework `Tool` objects with `mcp_<prefix>_<tool>` naming convention.
  - **Config** — New `mcp.servers[]` and `mcp.expose` config sections with Zod validation.
  - **Web routes** — `GET /api/mcp/servers`, `GET /api/mcp/expose/status`, `POST /api/mcp/expose/start|stop`.
  - **Tool category** — New `mcp` tool category in `TOOL_CATEGORIES` for agent loop pre-selection.
  - **67 new tests** across 7 test files covering types, client, pool, adapter, server, and agent bridge.

### Docs
- **README.md full refresh** — Updated skills count (8→16), tools count (20+→34), added new core systems (context compaction, MCP tool bridge, activity stream, TTS/STT, permissions), updated architecture diagram, project structure, config sections, built-in skills table, web dashboard pages, and tech stack.
- **CLAUDE.md** — Added rule to keep `README.md` in sync when skills, tools, core systems, dashboard pages, project structure, or tech stack change.

### Changed
- Moved `mcp-servers/aibot-discovery/` to `packages/mcp-discovery/` for cleaner project structure.

### Changed (Breaking)
- **botId is now required for all memory operations** — Removed `DEFAULT_BOT` constant
  and all implicit fallbacks from `CoreMemoryManager`, `MemoryManager.search()`,
  `MemoryManager.getFileLines()`, and `hybridSearch()`. Missing botId is now a
  compile-time error, not a silent fallback to another bot's data.
- **Removed `defaultSoulLoader` and `defaultLLMClient`** — `BotManager` no longer
  accepts a root-level `SoulLoader` constructor parameter. `getSoulLoader(botId)` and
  `getLLMClient(botId)` now throw if no loader/client is registered for the given bot
  (i.e., `startBot()` was not called). The root-level `SoulLoader` in `src/index.ts`
  has been removed.
- **Memory tools validate `_botId` context** — `memory_search`, `memory_get`,
  `recall_memory`, `core_memory_append`, `core_memory_replace`, and
  `core_memory_search` now return an error if `_botId` is missing from the tool
  execution context, preventing unscoped queries.
- **Soul migration cleans leftover root files** — `migrateSoulRootToPerBot()` now
  deletes root-level soul files (e.g., `config/soul/MOTIVATIONS.md`) when a per-bot
  copy already exists, preventing stale data from leaking into other bots.

### Fixed
- **Claude CLI context leakage between bots** — All Claude CLI spawn sites
  (`claudeGenerate`, `claudeGenerateWithTools`, `runImprove`, `runQualityReview`)
  used `cwd: resolve('.')` (project root), causing Claude CLI to inherit
  project-level CLAUDE.md and auto-memory (~50KB of Finny's data). This leaked
  one bot's personality, relationships, and cultural intel into other bots'
  conversations and soul file edits. Fix: `claudeGenerate`/`claudeGenerateWithTools`
  now use `cwd: tmpdir()` (isolated, no CLAUDE.md); `runImprove`/`runQualityReview`
  now use `cwd: resolve(soulDir)` (needs file access but avoids project root).
- **Bot reset did not clear session transcripts from memory index** —
  `clearIndexForBot()` only matched `${botId}/%` paths but search also queries
  `sessions/bot-${botId}-%`. Session transcripts survived bot resets and could
  leak into subsequent search results. Now also clears the session prefix pattern.
- **Root-level orphan soul files** — Startup cleanup now removes leftover
  root-level soul files (`MOTIVATIONS.md`, `IDENTITY.md`, `SOUL.md`, `GOALS.md`)
  and empty `memory/` directory from `config/soul/` root, preventing stale data
  from leaking into search results.
- **Per-bot skill cron job isolation** — Cron-triggered skills (reflection, calibrate,
  improve) were registered once globally and wrote to a shared `./config/soul` root
  directory, causing cross-bot data leakage. Now each skill cron job is registered
  per-bot with `botId` in the payload. `resolveSkillHandler` injects the correct
  per-bot `soulDir` via `resolveAgentConfig`. Legacy botId-less skill jobs are
  automatically cleaned up on startup. Skills error instead of falling back to the
  shared root directory. The improve skill's concurrency lock is now per-bot
  (Set-based) instead of a single global boolean.
- **Per-bot memory isolation** — Memory was written per-bot (`config/soul/{botId}/`)
  but searched globally. RAG search, core memory lookup, and memory tools returned
  results from ALL bots, violating agent separation. Now `core_memory` has a `bot_id`
  column (`UNIQUE(bot_id, category, key)`), `hybridSearch` filters chunks by path
  prefix, and all memory tools (`memory_search`, `memory_get`, `recall_memory`,
  `core_memory_*`) pass `_botId` from `ToolExecutor` injection. Schema migration
  rebuilds existing `core_memory` tables (defaulting to `'default'`).
  `clearCoreMemoryForBot()` now uses `WHERE bot_id = ?` instead of deleting all.
  `SystemPromptBuilder` and `ConversationPipeline` pass `botId` for scoped RAG
  and core memory rendering.
- **Bot reset now clears only the target bot's memory from shared DB** — Previously
  `clearIndex()` and `clearCoreMemory()` wiped ALL bots' data from the shared
  `data/memory.db`. Now uses `clearIndexForBot(botId)` which filters by path
  prefix (`botId/`), leaving other bots' indexed data intact. Also cleans
  orphaned `embedding_cache` entries (previously never cleaned, accumulating
  indefinitely). New integration tests in `tests/integration/memory-reset.test.ts`.

### Added
- **Context compaction** — LLM-based conversation compaction that summarizes older
  messages when approaching context window limits, preserving key facts and decisions
  instead of silently dropping history. Configurable via `conversation.compaction` with
  per-backend context windows (ollama/claude-cli), threshold ratio, and recent message
  retention. Overflow retry loop automatically triggers emergency compaction on
  `context_length` errors. Older messages are flushed to Core Memory before compaction.
  New module `src/bot/context-compaction.ts`, session layer support for
  `[CONTEXT_SUMMARY]` messages, and `rewriteWithSummary()` persistence.
- **LLM diagnostics** — per-bot LLM stats tracking via `LlmStatsTracker` in
  `ActivityStream`. Tracks `totalCalls`, `successCount`, `failCount`,
  `fallbackCount`, `avgDurationMs`, `lastError`, and per-caller breakdown
  (conversation/planner/strategist/executor/feedback). New event types
  `llm:error` and `llm:fallback`. Existing `llm:start`/`llm:end` events now
  include `backend` and `caller` fields. Agent loop emits LLM events around all
  4 call sites (planner, strategist, executor, feedback). `BotScheduleInfo` now
  includes `backend` field. New API endpoints: `GET /api/agent-loop/llm-stats`
  (all bots) and `GET /api/agent-loop/llm-stats/:botId` (single bot).
  `LLMClientWithFallback.onFallback` callback fires on primary→fallback
  transitions, wired to activity stream in `BotManager`.
- **Comprehensive bot reset** — `BotResetService.reset()` now clears 22 categories
  of bot-specific data (up from 15). New steps: conversations (`deleteAllForBot`),
  tool audit logs (entire `data/tool-audit/{botId}/` dir), productions (entire
  `productions/{botId}/` dir, not just skills), agent scheduler state
  (`clearForBot`), collaboration tracker records, collaboration sessions, and
  activity stream events. All new steps are optional — missing deps skip gracefully.
  Added `clearForBot()` methods to `ToolAuditLog`, `AgentScheduler`,
  `CollaborationTracker`, `CollaborationSessionManager`, and `ActivityStream`.
- **Reset unloads production skill tools from runtime** — On bot reset,
  `ToolRegistry.clearExternalSkillsForBot(botId)` removes all external skill
  tools belonging to that bot from `ctx.tools[]` and `ctx.toolDefinitions[]`.
  This reduces the tool count passed to Claude CLI (from ~60-79 down to ~40 core
  tools), fixing MCP timeout issues caused by uncategorized production skill
  tools bypassing category filtering.
- **Reset cleans production skills** — `BotResetService` now deletes the
  `productions/<botId>/src/skills/` directory on reset and removes stale references
  from `config.skills.enabled`, `botConfig.skills`, and `config.skills.config`.
  Production-only skills (not in built-in `src/skills/`) are cleaned; built-in skills
  are preserved. The config is persisted to disk so the next startup won't try to load
  missing skills. The `cleared` result now includes a `productionSkills` string array.

### Fixed
- **Resilient skill loading** — `SkillRegistry.loadSkills()` now logs a warning instead
  of an error when a skill cannot be found, preventing noisy `ERROR: Failed to load skill`
  logs for skills that were removed during a bot reset.

### Added
- **Reset clears dynamic tools and karma** — `BotResetService` now deletes all dynamic tools
  created by the bot being reset (step 12) and clears karma events (step 13). New
  `DynamicToolStore.deleteByCreator(botId)` removes tools from disk, and
  `DynamicToolRegistry.clearForBot(botId)` also unloads them from runtime. Tools created by
  other bots are unaffected. The `cleared` result now includes `dynamicTools` count and `karma` flag.
- **Bulk delete conversations** — New "Delete All" button on the conversations index page to wipe
  all conversations across all bots, and per-bot delete buttons on each row. Backed by new
  `deleteAllForBot()` / `deleteAll()` service methods and `DELETE /api/conversations[/:botId]`
  endpoints. Both actions require confirmation before executing.
- **Claude CLI native tool calling via MCP bridge** — Bots configured with `llmBackend: "claude-cli"`
  now handle tool execution natively through an MCP (Model Context Protocol) bridge instead of
  falling back to Ollama. New `claudeGenerateWithTools()` spawns a lightweight MCP tool server
  (`src/mcp/tool-bridge-server.ts`) that Claude CLI connects to via `--mcp-config`. The bridge
  translates tool calls back to the main process callback server, preserving bot context, karma,
  and audit logging. Removed the `LLMClientWithFallback` bypass that routed all tool-based calls
  to Ollama — Claude CLI now tries tools natively with Ollama as error fallback only.
- **Claude CLI integration test UI** — Three new endpoints (`GET /claude-cli/status`,
  `POST /claude-cli/chat`, `POST /claude-cli/chat-with-tools`) and corresponding UI panels
  on the Integrations page. Test Claude CLI connectivity, simple chat, and full MCP tool bridge
  end-to-end from the browser.

### Changed
- **processFeedback() uses getLLMClient()** — Agent loop feedback processing now uses the
  bot's configured LLM client (with fallback) instead of a bare `ClaudeCliLLMClient`, getting
  MCP tool support and Ollama fallback for free.

### Removed
- **TextToolStrategy** — Deleted `src/core/text-tool-strategy.ts`. The XML-based `<tool_call>`
  protocol was brittle (re-serialized history per round, regex parsing, subprocess-per-round
  timeouts) and is fully replaced by the MCP bridge approach.

### Added (prior)
- **Immediate agent loop trigger** — New `requestImmediateRun(botId)` on `AgentScheduler`,
  `AgentLoop`, and `BotManager`. Every user conversation now triggers an immediate agent loop
  cycle so bots act on requests without waiting for the next scheduled cycle. If the bot is
  already executing, the request is queued as a pending wake (Set-based dedup) and the bot
  skips its inter-cycle sleep once the current cycle finishes. 10 new tests.

### Changed
- **Auto-restart timer tracking** — `BotManager` now tracks `setTimeout` timer IDs for
  auto-restart. `stopBot()` and `cleanupBot()` cancel pending restart timers, preventing
  ghost restarts after explicit stops. 5 new tests.
- **Collaboration task tracking** — `CollaborationManager.sendVisibleMessage()` fire-and-forget
  promise is now tracked in a per-bot `pendingTasks` set. New `drainPending(botId)` method
  awaits all pending tasks, called from `cleanupBot()` before unregistering. 4 new tests.
- **Cron error logging** — `resolveChain` in `cron/locked.ts` now logs swallowed errors
  via `console.error` instead of silently discarding them. 4 new tests.
- **Type safety fixes** — Eliminated 6 `as any` casts: `tool-executor.ts` productions
  logging uses proper `Record<string, unknown>` access, `bot-manager.ts` messageBuffer
  uses typed null instead of `null as any`, `BotContext.messageBuffer` is now
  `MessageBuffer | null`. Added `category` field to `ToolExecutionRecord`.
- **Circuit breaker deduplication** — `ConversationPipeline` now uses `DEFAULT_CIRCUIT_CONFIG`
  from `llm-resilience.ts` instead of hardcoded values, centralizing the configuration.
- **Agent loop phase timeouts configurable** — Hardcoded timeouts (30s feedback, 60s
  strategist/planner, 90s executor) moved to `agentLoop.phaseTimeouts` in config schema
  with per-bot override support via `botConfig.agentLoop.phaseTimeouts`.
- **Soul module test coverage** — Added 18 tests for `soul-health-check.ts` (cooldown logic,
  concurrent steps, failure isolation) and `soul-memory-consolidator.ts` (log detection,
  consolidation, archiving, error handling).
- **ConversationsService resilience** — JSONL parsing now skips corrupt lines instead of
  crashing the service. Writes use atomic rename (write-to-tmp-then-rename). `attachFiles`
  preserves corrupt lines verbatim to prevent data loss. 16 new tests.
- **Per-bot browser/process isolation** — Browser sessions (`browser-session.ts`) and process
  sessions (`process.ts`) are now keyed by `botId` instead of global singletons. Two bots
  running simultaneously no longer share browser state, element refs, or process registries.
  Ownership validation prevents cross-bot access to sessions. 16 new tests.
- **BotManager decomposition** — Extracted `TelegramPoller` (112 lines) and `BotResetService`
  (125 lines) from `BotManager`, reducing it from 1005 to 823 lines. Both modules are
  independently testable with cleaner dependency injection.
- **server.ts ESM cleanup** — Replaced 7 `require('fs')` calls with proper `node:fs` imports.

### Added
- **SKILL.md declarative skill adapter (core)** — Migrated the SKILL.md adapter from
  `productions/openclone/` to `src/core/skill-md-adapter/`. Skills can now be defined
  declaratively using Markdown + YAML frontmatter instead of `skill.json` + `index.ts`.
  - Parser (`parser.ts`): extracts YAML frontmatter manifest + Markdown tool declarations
  - Validator (`validator.ts`): Zod-based validation of manifest, tools, and parameters
  - Loader (`loader.ts`): full load pipeline (parse → validate → check requirements → generate tools → register)
  - Framework bridge (`framework-bridge.ts`): converts declarative skills to `LoadedExternalSkill` format
  - Integrated into `external-skill-loader.ts`: `discoverSkillDirs()` and `loadExternalSkill()` now
    detect and load SKILL.md skills automatically (SKILL.md takes priority over skill.json)
  - 56 tests covering parser, validator, loader, framework bridge, and integration fixtures

- **Activity Stream (real-time bot visibility)** — New unified real-time activity feed showing
  everything the bot does as it does it. Events include tool calls, LLM requests, agent loop
  phases (strategist/planner/executor), memory operations, and collaboration sessions.
  - `ActivityStream` module (`src/bot/activity-stream.ts`): EventEmitter + circular buffer (200 events)
  - Event types: `tool:start/end/error`, `llm:start/end`, `agent:phase/idle/result`, `memory:flush/rag`, `collab:start/end`
  - Events emitted from `agent-loop.ts`, `conversation-pipeline.ts`, `memory-flush.ts`, `collaboration.ts`
  - WebSocket endpoint `/ws/activity` with auto-reconnect and history-on-connect
  - REST endpoint `GET /api/activity?count=N` for initial load
  - Web UI page (`#/activity`): real-time timeline with color-coded badges, bot/type filters,
    expandable event details, pause/resume, 500-event DOM limit

- **Moltbook registration tool** — `moltbook_register` tool allows the bot to register as
  "NodeSpider" on the Moltbook agent directory. Checks for existing registration, saves
  credentials to `~/.config/moltbook/credentials.json`, returns claim URL for human verification.
  Added to `communication` tool category.

- **Requeue/retry failed permission requests** — Failed or stuck-consumed permission requests
  can now be retried from the web UI or API. A "Retry" button appears on failed history cards
  in the Permissions page. The `POST /api/ask-permission/history/:id/requeue` endpoint pushes
  the entry back into the resolved queue for the next agent loop cycle.
  - `AskPermissionStore.requeueById()` resets history entry and re-creates resolved permission
  - `BotManager.requeuePermission()` delegates to store and wakes agent loop
  - Only approved entries with `executionStatus: 'failed'` or `'consumed'` can be requeued

- **File attachments on bot messages** — Bot messages can now include file references that
  are displayed as clickable chips in the web UI. Files are structurally tracked via a new
  `files` field on `ThreadMessage` (not auto-detected from text).
  - `FileRef` interface (`path`, `size?`) added to `src/types/thread.ts`
  - `ConversationsService.addMessage()` accepts optional `files` parameter
  - `ConversationsService.attachFiles()` method for retroactive file attachment
  - `ask_human` tool accepts a `files` array parameter for explicit file references
  - `ToolExecutor.getFileOperations()` extracts file_write/file_edit paths from execution log
  - Agent loop auto-attaches file operations to ask_human inbox messages
  - `GET /api/files/:botId/*path` endpoint serves files from bot workDir with security checks
    (path traversal, denied patterns, symlink escape, 1MB size cap)
  - Frontend: "Files" section below messages with clickable chips and modal preview
  - `botId` passed to `renderThread()` from conversations, inbox, and productions pages

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
