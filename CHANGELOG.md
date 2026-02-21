# Changelog

## Unreleased

### Added
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
