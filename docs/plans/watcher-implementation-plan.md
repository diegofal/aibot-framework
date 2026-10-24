# Watcher: implementation plan, phases 0 to 4

**Status:** implemented (2026-10-23), phases 0 to 4 on `feat/watcher`; not deployed yet. Deviations as built: "As built" below. Originally planned the same day, nothing built then. Design and metrics live in `watcher-consciousness-plan.md`; this file is the build order. Every file:line anchor below was read on 2026-10-23 against `main` at `6658980`.
**Workflow per phase:** one worktree `../aibot-watcher-p<N>` on branch `feat/watcher-p<N>` from `main` (working agreements §3, own `bun install`). Implementation by Opus, test first. Local gate `bun run lint && bun run typecheck && bun test`. PR. Review by Fable. Fixes by Opus. Sign-off, fast-forward merge, then `docker compose up -d --build` (ask before deploying: it restarts the fleet). After phase 1, verify birth live from the Watcher page.
**Scope control:** anything that surfaces outside the phase's list goes to `docs/technical-debt.md` or the next phase, never into the same PR.

---

## As built (2026-10-23): deviations from this plan

Phases 0 to 4 are implemented on the integration branch `feat/watcher` (commits `e604f27` phase 0, `c6e093d` page, `3fa183c` phase 1, `902d476` phase 2, `06e844f` phase 3, `8e5dbd5` phase 4). Collected from the code and the commit messages; the CHANGELOG entry "The fleet watcher (phases 0–4)" is the record.

**Workflow**
- One integration branch and worktree (`D:\aibot-watcher`, `feat/watcher`) with one commit per phase, instead of one worktree, PR and deploy per phase. No deploy was done: "Verification after merge" for phases 1, 3 and 4 is still pending.
- The phase 1 page landed as its own commit (`c6e093d`); Three.js is r186 (`three.module.js` + `three.core.js`, pinned with sha256 in `web/vendor/README.md`).

**Phase 2**
- Operator messages never emitted `human_inbound` (the Telegram operator chat and dashboard threads are not channels), so the watcher could not tell the operator apart. `BotManager` now emits `operator_message` (`OPERATOR_MESSAGE_HOOK` in `agent-loop-utils.ts`) on both surfaces; sense keeps its words and flags `BufferItem.fromOperator`. Sense trusts only that hook and the operator's private Telegram chat; a directory role or a `human_inbound` claiming `dashboard` is not trusted.
- `BotManager.getCircuitBreaker`; the canary plants and checks through dashboard threads (an operator surface).
- Every 404 while the watcher is off is `{ enabled: false, error }`, and the page switches to its off state on any of them.

**Phase 3**
- `DailyBudget.reserve` holds a slot until `record`, so concurrent triggers cannot pass the cap (the plan only said "a cap that cannot be exceeded by a retry loop").
- Broadcast caps: 3 per bot per UTC day and one per insight and kind, counted from `broadcasts.jsonl` (restart-safe) and written before delivery is awaited.
- Privacy beyond the plan: neurons record `meta.operatorSourced`; `fleet_memory_search` returns them only to the verified operator. Broadcasts can still carry such text to a bot: `docs/technical-debt.md`, "Watcher broadcasts can carry operator-sourced insight text to a bot".
- `isLoopCaller` excludes `watcher:*` callers, so the goal drawer never rebuilds a bot cycle from a watcher call.

**Phase 4**
- `interoception` is composed inside the `Watcher` (`Watcher.interoception()`) from its own budget, buffer and integrator plus readers that `createFleetWatcher` supplies (`karmaScores`, `semaphore` = `getClaudeCliStats`, `runningCycle`); `WatcherDeps.interoception` stays as an override. Operator silence comes from the operator items sense sees (and the restored buffer), so it is null until the operator writes after a restart.
- `attention().items` reads the buffer **and** what integrate has pending: notice drains the buffer on every pass, so the buffer alone is usually empty.
- `drivenBy` keeps only the "How I am" keys the prompt showed; without an interoception record it is not written.
- Introspection asks the watcher's model over its own recent log (the code-written rows, up to 20), not the state. Decided: the notice tier client, so it is cheap and shares the notice daily cap, the breaker and the query log, under a new caller `watcher:introspect`. A refused or failed call writes no row; an unparsable answer is a row with score 0. Scoring: phase against the current phase; tool is always null for the watcher; goal is the best match among the attended neurons (or the top items when nothing is attended); cause against what those neurons and items say.
- The daily sampler draws 3 times over what is left of the UTC day, persists the plan (`introspection-schedule.json`), and fires missed samples once, not as a burst. It runs only with `notice.enabled`.
- "## Your current state" carries the bot's presence as the watcher's own tracker sees it, its running cycle (`AgentLoop.runningCycle`, through the new `BotManager.getRunningCycle`) and the fleet focus without operator-sourced neurons. It is published through `BotContext.watcherSelfState` (`BotManager.setWatcherSelfState`) and is absent while the watcher sleeps.
- Phase 0's gap (no goal or cause for bots) is closed: `GET /api/agents/:id/presence` gains `cycle` (additive), read by `scripts/watcher/introspect.ts`; the script also takes `--subject watcher` (the server appends the row) and `--subject bot:<id>`.
- `GET /api/watcher/self` also returns the introspection history and `subjects`; `POST /api/watcher/introspect` answers 409 / 429 / 502 for unavailable / refused / failed. Metric 3 gains `subjects` (`summarizeIntrospection`).
- No Why for introspection rows (they carry their own field verdicts).
- Not built: the watcher's own soul dir (`<data>/watcher/soul/`, identity, memory and traits) from the consciousness plan's self-model section.

---

## Shared decisions (decided here, apply to all phases)

| Decision | Choice | Why |
|---|---|---|
| Where the watcher runs | Same process. Constructed in `src/index.ts` after `new BotManager` (326), passed to `startWebServer` as a dep, `watcher.start()` called after `startWebServer` returns (359-370) so birth streams to the socket; `watcher.stop()` first thing in `shutdown` (377), before `shutdownRuntime` | Shares the activity stream, semaphore, breaker and socket server. A separate process gains nothing at this scale |
| State directory | `<paths.data>/watcher/` | Beside `agent-cycles`, `workers`, `relays` |
| Graph persistence | Append-only `neurons.jsonl` and `edges.jsonl` (last line per id wins, same as `RelayStore`), compacted into `graph.json` on `stop()` and every 1000 appends; embeddings in `embeddings.jsonl` keyed by neuron id; all loaded into memory maps on start | No new database. Readers never throw |
| Pseudo bot id | `__watcher__` for the LLM query log (`LlmQueryLog.append` needs a `botId` directory, `src/bot/llm-query-log.ts:96`) and the tool audit | Insights → Usage groups by bot and caller and accepts unknown strings (`src/stats/usage-aggregator.ts:108`) |
| Callers | `'watcher:notice'` and `'watcher:integrate'` added to the `caller` union (`src/bot/llm-query-log.ts:11-23`) | Closed union today |
| Semaphore | `CliPriority` gains `'watcher'`, rank 3 (`src/core/cli-semaphore.ts:13`) | Never delays a conversation, loop or worker |
| Models | Two fixed `ClaudeCliLLMClient` instances (the model is bound at construction, `src/core/llm-client.ts:120-125`): notice `claude-haiku-5-5`, integrate `claude-opus-5-5`; both overridable in config. Tier 1 may instead use the shared `OllamaClient` when `watcher.notice.backend: 'ollama'` | Per-call model choice does not exist for claude-cli |
| Embeddings | `OllamaClient.embed(text, config.soul.search.embeddingModel)` directly (`src/ollama.ts:451`), no SQLite cache. A failing first `embed` call marks the graph `linkStatus: 'no-embeddings'` and birth continues without `related` edges | `createEmbeddingService` requires the memory database (`src/memory/embeddings.ts:6-17`) |
| Layout | Server-side. PCA of the embeddings to 3 dimensions (power iteration, own implementation in `src/watcher/layout.ts`), normalised into a unit ball, stored as `pos` on each neuron; recomputed at the end of birth and once a day; a new neuron without an embedding is placed at the centroid of its explicit neighbours, else on the shell by kind. Without embeddings every neuron sits on a shell by kind | Positions must be the same for live view and replay, so the client never computes layout |
| 3D library | Three.js vendored at `web/vendor/three.module.js` (pinned version in a `web/vendor/README.md`), dynamically imported only inside `web/pages/watcher-ball.js`; every `*-helpers.js` stays pure | No build step, no import map, `web/` is served raw (`src/web/server.ts:773-777`); `tests/web/imports-resolve.test.ts` would break on a helper importing `three` |
| Dashboard access | Admin or single tenant only (`isAdminOrSingleTenant`, `src/tenant/tenant-scoping.ts:40`); tenants get 404 on every `/api/watcher` route and 403 on `/ws/watcher` | One watcher per tenant is out of scope for phases 0 to 4 |
| Privacy | Birth reads shared memory only, never `memory/users/<id>/`. A `human_inbound` from anyone but the operator produces a neuron about the event (who wrote to which bot, topic words), never the verbatim text; only operator messages yield facts | Cross-bot recall must not leak a private conversation to another bot's users |
| Bots and the graph | Bots receive broadcasts and may **query** the graph through one tool (`fleet_memory_search`, phase 2); they never receive the graph in a prompt | Prompt budget, and the specialist/workspace split the metrics depend on |
| New actors | `GoalActor` gains `'watcher'` (`src/bot/goal-events.ts:69`); `DirectiveSource` gains `'watcher'` (`src/bot/curiosity/types.ts:159`); `WhyActor` gains `'watcher'` if missing (`src/why/types.ts:15`) | Every record names who did it |

---

## Phase 0: baseline

**Goal:** the numbers in the Baseline column of the design plan, from today's fleet, before anything else changes. No runtime code.

### Files

| File | What |
|---|---|
| `src/watcher/metrics/baseline.ts` | Pure readers over existing records. `idleCycleShare(cycles)`, `medianCycleIntervalMs(cycles)` (= latency to notice today), `overlappingTopics(mapsByBot)` (topic names shared by ≥ 2 bots after `textSimilarity ≥ 0.8`, `src/hygiene/text-utils.ts:110`), `chatVsLoopContradictions(replies, plans)` (exact topic overlap between a bot's recent chat replies and its cycle plans, reported as candidates, not verdicts). Input types mirror `AgentCycleRecord` (`src/stats/readers/agent-cycles.ts:10-42`) and `KnowledgeMap` (`src/bot/curiosity/types.ts:148-155`) |
| `src/watcher/metrics/introspection.ts` | `scoreIntrospection(answer: IntrospectionAnswer, truth: LivePresence & { goalId?, plan? }): IntrospectionScore` with field-level match (phase, tool, goal, cause) and `parseIntrospectionAnswer(text)` via `parseLLMJson` (`src/bot/llm-json-parser.ts:23`). `LivePresence` is `src/stats/presence-tracker.ts:38` |
| `scripts/watcher/baseline.ts` | CLI following `scripts/system-cli.ts` (`parseArgs` 20, `resolveCliContext` 77, `cliConfig` 91). For every bot: `resolveBotPaths(config, bot)` (`src/stats/paths.ts:68`), `readAgentCycles(join(data,'agent-cycles'), botId, since30d, now)` (`src/stats/readers/agent-cycles.ts:47`), `new CuriosityStore(soulDir).loadMap()` (`src/bot/curiosity/store.ts:64, 90`). Prints a table and writes `<data>/watcher/baseline-<date>.json` |
| `scripts/watcher/introspect.ts` | Asks a running bot through the REST chat API what it is doing now, fetches `GET /api/agents/:id/presence`, scores with `scoreIntrospection`, appends to `<data>/watcher/introspection.jsonl` with `subject: 'bot:<id>'`. Expected to score at chance today. Reused in phase 4 for the watcher |
| `scripts/watcher/canary.ts` | `plant --bot A --fact "…" --expect <word>[,<word>]` tells A the fact in a dashboard thread (an operator surface) and records `{ id, fact, expected, plantedAt, bot }` in `<data>/watcher/canaries.jsonl`; `check --bot B --id [--expect …]` asks B and records whether the answer names every expected word (whole word, case- and accent-insensitive), with `textSimilarity` as a secondary signal. Expected to fail today |

### Tests (first)

- `tests/watcher/metrics/baseline.test.ts`: one test per function; empty input gives zeros, never throws; the overlap function ignores near-duplicates below the threshold.
- `tests/watcher/metrics/introspection.test.ts`: full match, partial match, unparsable answer scores 0 with `parsed: false`.
- Script modules export their `run(args, deps)` so the CLI shell is a thin wrapper and `tests/watcher/scripts/baseline.test.ts` runs it against a temp data dir (`tests/helpers/temp-dir.ts:34`).

### Out of scope

Any change under `src/` other than `src/watcher/metrics/`. No config, no routes.

---

## Phase 1: the watcher wakes, is born, and is visible

**Goal:** an always-on watcher with tier 0 sensing, the birth sequence, the first-person log, the socket, and the ball. No LLM calls, no cost.

### Config

`src/config.ts`: `WatcherConfigSchema` beside `WorkersConfigSchema` (841-864), registered in `ConfigSchema` (1343-1388) as `watcher: WatcherConfigSchema`, defaults mirrored as `WATCHER_DEFAULTS` in `src/watcher/types.ts`.

```ts
watcher: {
  enabled: false,
  notice:    { enabled: false, backend: 'claude-cli' | 'ollama', model: 'claude-haiku-5-5', everyMs: 300_000, salienceBar: 0.4, maxPerDay: 288 },   // phase 2
  integrate: { enabled: false, model: 'claude-opus-5-5', salienceBar: 2.0, heartbeatMs: 3_600_000, maxPerDay: 24, maxTokensPerDay: 600_000 },  // phase 3
  graph:     { archiveAfterDays: 30, relatedThreshold: 0.82, maxNeurons: 20_000 },
  birth:     { historyDays: 30 },
  log:       { senseSummaryEveryMs: 60_000 },
}
```

### Files

| File | Responsibility |
|---|---|
| `src/watcher/types.ts` | `Neuron { id: 'n-' + 8 hex, kind: NeuronKind, text, support: NeuronSupport { bots: string[], cycles?: string[], conversations?: string[], paths?: string[] }, createdBy: 'watcher' \| `bot:${id}`, createdAt, lastActivatedAt, activations, confidence?: 'low'\|'medium'\|'high', pos?: [number,number,number], archivedAt?, meta?: Record<string, string> }`, `NeuronKind = 'entity' \| 'person' \| 'goal' \| 'topic' \| 'fact' \| 'surprise' \| 'question' \| 'pattern' \| 'insight' \| 'contradiction' \| 'prediction'`, `Edge { id, from, to, rel: 'knows' \| 'owned_by' \| 'about' \| 'related' \| 'contradicts' \| 'caused' \| 'serves' \| 'predicts', weight, createdAt, createdBy }`, `WatcherLogRow { ts, seq, phase: 'birth'\|'sense'\|'notice'\|'integrate'\|'broadcast'\|'sleep', op, text, neuronIds?, edgeIds?, salience?, source?, model?, tokens?, costUsd?, durationMs? }`, `BufferItem { id, event: ActivityEvent \| HumanInboundEvent, salience, reasons: string[], noticedAt, touched: string[] }`, `WatcherState { running, bornAt?, phase, lastTickAt?, counts: Record<NeuronKind, number>, edges, linkStatus }`, `WatcherEventType = 'watcher:log' \| 'watcher:neuron' \| 'watcher:edge' \| 'watcher:activate' \| 'watcher:state'`, `WATCHER_DEFAULTS` |
| `src/watcher/paths.ts` | `watcherDir(config)`, `watcherLogDir`, `graphFiles` |
| `src/watcher/log.ts` | `WatcherLog(dir, logger)`: `append(row)` → `<dir>/YYYY-MM-DD.jsonl` (the `AgentCycleLog.append` pattern, `src/bot/agent-cycle-log.ts:166-184`), monotonic `seq`, also `logger.info({ watcher: row.op, ...}, row.text)`; `read(date, { limit, before? })`, `dates()`; never throws. `say(phase, op, text, extra?)` is the one-call helper every module uses |
| `src/watcher/narration.ts` | Pure text for every log row: `narrateBirthStage`, `narrateNoticed(item)`, `narrateLearned(neuron)`, `narrateSleep(...)`. All English, first person, written by code. One function per row kind, each with a test |
| `src/watcher/graph.ts` | `Graph`: in-memory maps + append-only files. `addNeuron`, `addEdge`, `activate(id, at)`, `archive(id)`, `neighbours(id)`, `findSimilarText(text, threshold)` (`textSimilarity`), `findSimilarEmbedding(vec, threshold)` (cosine; export `cosineSimilarity` from `src/memory/search.ts:16`), `snapshot()` (no embeddings), `compact()`, `load()`. Emits nothing itself |
| `src/watcher/salience.ts` | Pure `scoreEvent(event, ctx: { graph, nowMs }) → { salience, reasons, touched }`. Table: human involvement +0.5 (`human_inbound`, `tool:end` of `send_message`/`send_proactive_message`), `tool:error`/`llm:error` +0.3, `task:changed` +0.2, `worker:waiting` +0.4, `worker:ended` blocked +0.4, `agent:result` with surprise in extraction +0.3, `karma:change` |Δ|/10, `memory:flush` +0.1, novelty +0.2 when no neuron matches the event's text, touched neurons listed. Decay helper `decay(salience, ageMs)` with 1 h half-life |
| `src/watcher/buffer.ts` | `WorkingBuffer(max = 200)`: `push(item)`, `salient(bar)`, `total()`, `drain(ids)`, `persist(path)` / `restore(path)` so a restart keeps the buffer |
| `src/watcher/sense.ts` | Tier 0. `attach(stream: ActivityStream, hooks: HookEmitter)`: `stream.on('activity', …)` (`src/bot/activity-stream.ts:272`) and `hooks.on(HUMAN_INBOUND_HOOK, …)` (`src/bot/agent-loop-utils.ts:284-294`). Scores, pushes to the buffer, activates touched neurons (emits `watcher:activate`), logs a row only when salience ≥ `notice.salienceBar` or a neuron was touched, plus one `sense` summary row per `senseSummaryEveryMs` when anything happened. Privacy rule applied here: non-operator `human_inbound` text is reduced to topic words before anything is stored |
| `src/watcher/birth.ts` | The nine stages, each `async (ctx) => StageResult`, resumable via `<dir>/birth.json` `{ stage, done: string[], startedAt, finishedAt?, counts, unreadable: string[] }`. Readers: bots from `config.bots`; identity via `new SoulLoader({ ...config.soul, dir: soulDir }, logger)` (`src/soul.ts:107`) `.readIdentityName()` (446) and `.readMotivations()` (415); channel state `botManager.getChannelState(botId)`; people `userDirectory.list(botId)` (`src/bot/user-directory.ts:346`, operator from `getOperator` 272; merged contacts already excluded); goals `parseGoals(loader.readGoals())` (`src/tools/goals.ts:739, 459`) + `readTasksSnapshot(soulDir)` (`src/goals/task-store.ts:217`); knowledge `new CuriosityStore(soulDir).loadMap()` → topics, findings (`Finding` 74-81), surprises, `openQuestions`, frontier questions; memory: `MEMORY.md` bullet lines and `memory/*.md` lines of the form `- [HH:MM] fact` (`src/soul.ts:327`), skipping `memory/users/**` and `memory/archive/**`; history `readAgentCycles` 30 days + `readGoalEvents(soulDir)` (`src/bot/goal-events.ts:228`) to set activations on goal and topic neurons; link stage embeds in batches of 32 with concurrency `soul.search.concurrency`, adds `related` edges above `relatedThreshold`, then `layout.ts`; done stage writes the summary row. Each neuron created during birth has `createdBy: bot:<id>` |
| `src/watcher/layout.ts` | `pca3(vectors) → positions`, `normaliseToBall(positions)`, `placeWithoutEmbedding(neuron, graph)`. Pure |
| `src/watcher/watcher.ts` | `Watcher extends EventEmitter`: `constructor(deps: WatcherDeps)` where `WatcherDeps = { config: () => Config, logger, activityStream, hooks, botManager: Pick<BotManager, 'getChannelState' \| 'getUserDirectory' \| 'requestImmediateAgentRun' \| 'getCuriosityService' \| 'getToolRegistry'>, ollama?: OllamaClient, now }`; `start()` (load graph; if no `birth.json` or unfinished → run birth; else log the wake row and run `resync`, a diff of bots, goals and contacts against the graph), `stop()` (compact, persist buffer, sleep row), `state(): WatcherState`, `graph`, `log`. Re-emits `watcher:*` events with `{ type, ts, data }`. Nothing here throws out of `start()`; a failing stage is a log row and `state.lastError` |
| `src/bot/bot-manager.ts` | Add `getHooks(): HookEmitter` (field at 159) and `getUserDirectory(): UserDirectory` (field at 154) |
| `src/index.ts` | Construct `Watcher` after 326 when `config.watcher.enabled`; pass as `watcher` dep to `startWebServer`; `await watcher.start()` after 370 (not awaited for birth: `start()` returns once the wake row is written and runs birth in the background); `watcher.stop()` at the top of `shutdown` (377) |
| `src/web/ws-tenant-filter.ts` | `DashboardSocketData` gains `{ type: 'watcher'; auth }` (84-86); `planDashboardSocketUpgrade` recognises `/ws/watcher` and rejects non-admin in multi-tenant with 403 (93-111) |
| `src/web/server.ts` | `WsData` (781-791) gains `'watcher'`; upgrade branch at 854 includes `/ws/watcher`; `WatcherSocketHub` (same shape as `ActivitySocketHub`, `ws-tenant-filter.ts:120`) broadcasts `{ type: 'watcher', event }`; `open` (933-962) sends `{ type: 'history', state, log: last 100 rows }`; `close` (1148-1162) removes. `watcher.on('watcher:*', hub.broadcast)` wired next to 816-818. Mount `watcherRoutes` before 773 |
| `src/web/routes/watcher.ts` | `watcherRoutes({ config, logger, watcher: () => Watcher \| undefined })`: `GET /api/watcher` → `WatcherState` plus `{ enabled }` (`{ enabled: false }` when off, like workers); `POST /api/watcher/start`, `/stop`; `GET /api/watcher/graph` → `{ neurons: Neuron[] (no embeddings), edges, linkStatus, rev }` capped at `maxNeurons`; `GET /api/watcher/log?date=&limit=&before=`; `GET /api/watcher/neurons/:id` → `{ neuron, edges, why }` via `neuronToWhy`; `GET /api/watcher/birth` → `birth.json`. Admin or single tenant; otherwise 404 |
| `src/why/builders/watcher.ts` | `neuronToWhy(neuron, { edges, cycles? })`: what = kind + text, by = `watcher` or the bot, cycle from `support.cycles[0]` via `cycleAttribution`, related = neighbours, outcome = activations, notes = created at birth stage or tick. Registered in `src/why/builders/index.ts` (27-49) with a fixture in `tests/why/contract.test.ts` (50) |
| `web/nav-routes.js` | `ROUTES` row `{ pattern: /^#\/watcher$/, handler: 'watcher', area: 'insights', args: none }` (127-301) and a tab in the `insights` area (20-106) labelled "Watcher" (admin) |
| `web/app.js` | `handlers.watcher = page((...) => renderWatcher(content), destroyWatcher)` (187-241) |
| `web/pages/watcher.js` | `renderWatcher(el)` / `destroyWatcher()` following `fleet-home.js:41, 211`: skeleton, `api('/api/watcher')` + `/graph` + `/log`, error state with retry, then mounts the ball into a `<canvas>` host and the log tail below; opens the socket with `openReconnectingSocket({ url: () => dashboardSocketUrl(location, '/ws/watcher', { token }) })` (`web/pages/ws-reconnect.js`); handles `history` then `watcher` messages; Start/Stop buttons; Replay birth button; clicking a log row highlights its neurons; clicking a neuron opens `openSheet` with `whyPanel(why)` and filters the log |
| `web/pages/watcher-helpers.js` | Pure: `logRowHtml(row, nowMs)`, `stateHtml(state)`, `neuronColour(neuron)` (createdBy watcher vs bot, kind hue), `neuronRadius(neuron)` (activation), `replayQueue(rows, pacePerSec)` (turns log rows into timed spawn steps), `applyWatcherEvent(model, event)` (reducer over the client graph model). No DOM, no Three.js |
| `web/pages/watcher-ball.js` | `mountBall(host, model, { onPick })`: dynamic `import('/vendor/three.module.js')`, instanced points, lines for edges above a weight, orbit (drag) and zoom, spawn animation from a queue drained at a readable pace (default 25 neurons/s), activation pulse, archived dim, `highlight(ids)`, `dispose()`. Returns early when `typeof document === 'undefined'` |
| `web/vendor/three.module.js`, `web/vendor/README.md` | Pinned Three.js build and the version note |
| `web/style.css` | `.watcher-*` classes |

### Tests (first)

- `tests/watcher/log.test.ts`: append + read, date split, missing dir reads `[]`, bad line skipped, `seq` monotonic across restart.
- `tests/watcher/narration.test.ts`: one test per narration function with the exact expected sentence.
- `tests/watcher/graph.test.ts`: add/activate/archive/neighbours; reload from files equals in-memory; compact preserves last-wins; `findSimilarText` threshold; `maxNeurons` cap archives the oldest inactive.
- `tests/watcher/salience.test.ts`: every row of the table, decay, novelty against a graph, privacy reduction of non-operator text.
- `tests/watcher/buffer.test.ts`: cap, drain, persist/restore.
- `tests/watcher/sense.test.ts`: fake `ActivityStream` and `HookEmitter`; a salient event logs a row and activates; a dull one does not log; the summary row appears once per window.
- `tests/watcher/birth.test.ts`: temp data dir with two fake bots (soul dirs with IDENTITY, GOALS, TASKS.json, KNOWLEDGE.json, MEMORY.md, `memory/2026-10-01.md`, `memory/users/u1/2026-10-01.md`): every stage's counts, the private file never read, unreadable file reported, resume from a half-done `birth.json`, no embeddings when `ollama` is undefined (`linkStatus: 'no-embeddings'`), embeddings via a fake `embed`.
- `tests/watcher/layout.test.ts`: PCA on a known matrix; all positions inside the unit ball; placement without embedding.
- `tests/watcher/watcher.test.ts`: `start()` without state runs birth and emits `watcher:state`; `start()` with state logs the wake row and resyncs a new bot; `stop()` compacts; a throwing stage ends in a log row, not an exception.
- `tests/web/routes/watcher.test.ts`: `{ enabled: false }` when off; tenant gets 404; graph excludes embeddings; log paging.
- `tests/web/ws-tenant-filter.test.ts`: `/ws/watcher` plan for admin, tenant and single-tenant.
- `tests/web/watcher-helpers.test.ts`: reducer, replay queue timing, colours, row HTML.
- `tests/web/nav-routes.test.ts` already asserts the handler exists (153).
- `tests/why/contract.test.ts` gains the `watcher` fixture.

### Verification after merge

Deploy, open `#/watcher`, press Start, watch birth: nine stage rows, the ball growing, the done row with counts. `curl /api/watcher/birth` shows `finishedAt`. Then the log must show `sense` rows when a bot runs a cycle.

### Out of scope

Any LLM call. Broadcasts. Metrics route.

---

## Phase 2: noticing (tier 1) and cross-bot recall

**Goal:** the watcher turns salient events into neurons with a cheap model, and bots can recall what the fleet knows.

### Files

| File | Responsibility |
|---|---|
| `src/watcher/llm.ts` | `createWatcherClients(config, ollama, logger) → { notice: LLMClient, integrate: LLMClient }`: `new ClaudeCliLLMClient('claude', config.agentLoop.claudeTimeout, logger, model)` per tier (precedent `src/bot/agent-loop.ts:560`), or the Ollama client for notice when configured. `instrumented(client, caller, queryLog, budget)` wraps `chat` with timing, `priority: 'watcher'`, a `LlmQueryEntry` for `botId: '__watcher__'` (template `createCuriosityCallRecorder`, `src/bot/curiosity/loop-wiring.ts:69-104`) and the daily counters |
| `src/watcher/budget.ts` | `DailyBudget(getLimits, now)`: `allow(tier) → { ok } \| { ok: false, reason }`, `record(tier, tokens, costUsd)`, persisted in `<dir>/budget-YYYY-MM-DD.json`. Shares the fleet breaker: `allow` is false while `circuitBreaker.isCircuitOpen('claude-cli')` |
| `src/watcher/notice.ts` | Tier 1. Every `notice.everyMs`, or sooner when the buffer's total salience crosses the bar: take the salient items, render them with the neurons they touched, ask the model for `{ keep: [{ text, kind, confidence, relatedTo: ids, support }], drop: ids, touched: ids }` (`parseLLMJson`), dedupe against the graph (`findSimilarText ≥ 0.8`, else embedding ≥ `relatedThreshold` when available), create neurons with `createdBy: 'watcher'`, edges, activations; log `Learned: …` per neuron and one `Noticed … nothing worth keeping` row when empty; drain the buffer. Privacy rule from phase 1 still applies to what the prompt sees |
| `src/watcher/prompts.ts` | `buildNoticePrompt(items, touchedNeurons)`; later `buildIntegratePrompt`. Pure, with tests on the exact sections |
| `src/tools/fleet-memory-search.ts` | `createFleetMemorySearchTool({ graph, embed? })`: `fleet_memory_search(query, limit?)` → up to 10 neurons (kind, text, which bots, when) by embedding similarity when available, else `textSimilarity`; results wrapped with `wrapExternalContent`; archived neurons excluded. Registered in `ToolRegistry` only when the watcher is enabled; category `memory`; matrix `free`/`free`; not `sensitive`. A `_requester` that is a non-operator user still gets results, but phase 1's privacy rule guarantees no private text is in the graph |
| `src/watcher/watcher.ts` | Owns the notice timer; `start()` begins it only after birth is done |
| `scripts/watcher/canary.ts` | Unchanged; now expected to pass once bot B calls `fleet_memory_search` |

### Tests (first)

- `tests/watcher/llm.test.ts`: the right model per tier; `priority: 'watcher'`; a query log entry per call with `caller`; the Ollama path.
- `tests/watcher/budget.test.ts`: cap per day, reset at midnight, breaker open blocks, persistence.
- `tests/watcher/notice.test.ts`: fake client returning a fixed JSON: neurons created with support and edges; duplicate text merges into activation instead of a new neuron; empty keep logs the "nothing" row; unparsable output logs an error row and keeps the buffer; budget exhausted logs once and skips.
- `tests/watcher/prompts.test.ts`: notice prompt contains the items, the touched neurons and the JSON contract.
- `tests/tools/fleet-memory-search.test.ts`: ranking, archived excluded, wrapped output, limit.
- `tests/bot/tool-registry.test.ts` (existing file): tool registered only when enabled.

### Metrics enabled

1 (cross-source share: insight support with ≥ 2 bots; at this phase from notice output), 5 canary, 7 (surprises: notice output `kind: 'surprise'` deduped against every bot's KNOWLEDGE.json surprises). `GET /api/watcher/metrics` arrives in phase 3; phase 2 writes the records they need.

### Out of scope

Opus. Broadcasts. Predictions.

---

## Phase 3: integration (tier 2), broadcasts, predictions, contradictions

**Goal:** the watcher has thoughts no single bot could have, and they change what the bots do, under a hard cost cap.

### Files

| File | Responsibility |
|---|---|
| `src/watcher/integrate.ts` | Tier 2. Runs when accumulated salience since the last pass ≥ `integrate.salienceBar`, or on the heartbeat, and only if the budget allows. Input: the buffer since last pass, the neurons touched and their neighbourhood (2 hops, capped 80), open goals per bot from the graph, the last 10 insights, the last predictions and whether they resolved, the interoception record (phase 4; empty object until then). Output JSON: `{ insights: [{ text, support: neuronIds, confidence }], contradictions: [{ a, b, text }], predictions: [{ text, horizonHours, about: botId?, neuronIds }], broadcasts: [{ bot, kind: 'wake'\|'directive'\|'goal'\|'question', text, insightIndex }], attending: neuronIds }`. Writes neurons (`insight`, `contradiction`, `prediction`) and edges (`contradicts`, `predicts`, `caused`), logs one row per insight and the pass summary with tokens and cost |
| `src/watcher/broadcast.ts` | `Broadcast { id: 'b-' + 8 hex, botId, kind, text, insightId, createdAt, deliveredAt?, servedByCycle?, signal? }` persisted in `<dir>/broadcasts.jsonl`. Delivery per kind: `wake` → `botManager.requestImmediateAgentRun(botId, { feedback: false })` (`src/bot/bot-manager.ts:1424`); `directive` → `getCuriosityService().recordDirective(botId, text, 'watcher')` (`src/bot/curiosity/service.ts:202`); `goal` → `writeGoalsFile(goalsPath, appendGoal(current, { text, status: 'todo', priority: 'medium', source: 'watcher', created }), { actor: 'watcher', reason: insight text, backup: true })` (write path `src/web/routes/agent-home.ts:325-356`, `src/bot/goal-events.ts:265`); `question` → the shared `send_proactive_message` tool through `getToolRegistry().createExecutor(0, '__watcher__')` with `chatId: 'operator'` (`src/bot/tool-registry.ts:939`; precedent `src/web/server.ts:1000-1002`) so it obeys the throttle and lands in Sent to you. Per-bot cap of 3 broadcasts per day and never two of the same kind for the same insight. `pendingFor(botId)` returns undelivered-to-planner broadcasts newer than 24 h |
| `src/bot/agent-loop-prompts.ts` | `fleetBroadcast?: string` in `PlannerPromptInput` (34-85) and `ContinuousPlannerPromptInput` (87-139); `buildFleetBroadcastSection(items)` → `## Fleet broadcast` listing each with its id and "name it in `serves_broadcast` if you act on it"; concatenated at 428 and 570 |
| `src/bot/agent-loop.ts` | At 2254-2263 and 2376-2385 pass `fleetBroadcast` from `deps.watcherBroadcasts?.(botId)`; mark them `shownAt`; `AgentCycleEntry` gains `broadcastIds?: string[]` and `servesBroadcast?: string` (`src/bot/agent-cycle-log.ts:27-73`), set at 1087-1111 |
| `src/bot/agent-planner.ts` | `parsePlannerResult` keeps `serves_broadcast` (string) like `serves_goal` (86) |
| `src/watcher/outcomes.ts` | Resolves broadcasts and predictions from records: a broadcast is `served` when a cycle row names it in `servesBroadcast` and its status is `completed`; a prediction resolves when its horizon passes, scored by a tier 1 call ("did this happen, given these events?", `{ happened: boolean, evidence }`) and stored as `resolved: { at, happened, brier }` |
| `src/watcher/metrics/index.ts` | `computeMetrics(records, window) → WatcherMetrics` for the seven metrics plus the four guards, all from records (`broadcasts.jsonl`, neurons, cycle log, usage, canaries, introspection). Pure |
| `src/web/routes/watcher.ts` | `GET /api/watcher/metrics?window=7d\|30d`; `GET /api/watcher/broadcasts`; `POST /api/watcher/neurons/:id/signal { signal: 'up'\|'down' }` on insights and broadcasts (stored on the record; `applySignal` is not reused, the watcher keeps its own `taste.json` with per-kind counts) |
| `web/pages/watcher.js` + helpers | Metrics strip above the ball (the seven metrics with baseline and target, guards in red when over); insight rows with 👍/👎; broadcast rows with "served by cycle" and Open cycle (`[data-open-cycle]`) |
| `src/stats/goal-detail-aggregator.ts` | `isLoopCaller` (108) must not count `watcher:` callers as loop callers |

### Tests (first)

- `tests/watcher/integrate.test.ts`: fake Opus JSON → neurons, edges, broadcasts created, pass row with cost; salience bar and heartbeat triggers; budget cap stops it with one log row; unparsable output keeps the buffer; `attending` stored on state.
- `tests/watcher/broadcast.test.ts`: each kind calls the right dep (fakes); goal write produces a `goal-events.jsonl` row with actor `watcher`; question goes through the executor; per-bot cap; `pendingFor` window.
- `tests/bot/agent-loop-prompts.test.ts` (existing): the section renders and is empty when no broadcasts.
- `tests/bot/agent-planner.test.ts` (existing): `serves_broadcast` parsed.
- `tests/watcher/outcomes.test.ts`: served detection from cycle rows; prediction resolution and Brier.
- `tests/watcher/metrics/index.test.ts`: every metric from fixtures; empty records give baselines, not NaN.
- `tests/web/routes/watcher.test.ts`: metrics window parsing; signal route.

### Verification after merge

Set `integrate.maxPerDay: 2` on the live fleet for the first day. Confirm in Insights → Usage that `__watcher__` cost matches the pass rows. Confirm one broadcast appears in a bot's next planner prompt (query log) and the cycle row carries `broadcastIds`.

### Out of scope

Self-model, introspection, interoception driving decisions.

---

## Phase 4: self-model, both ways

**Goal:** the watcher knows what it is attending to and why, and can be checked on it; bots see what the fleet is focused on and their own live state.

### Files

| File | Responsibility |
|---|---|
| `src/watcher/self-model.ts` | `interoception(deps) → Interoception { fleetKarmaAvg, breakerOpen: string[], semaphore: getClaudeCliStats(), budgetUsedToday: { notice, integrate, tokens, usd }, operatorSilenceHours (last operator `human_inbound` or Telegram operator message), bufferSalience, lastIntegrateAgoMs }`; `attention(state, buffer, graph) → Attention { phase, items: top 5 buffer items with touched neurons, focusNeuronIds (from the last integrate pass `attending`) }`. Both pure over injected readers. The integrate prompt receives both as "## How I am" and "## What I am attending to", and the output gains `drivenBy: string[]` naming which interoceptive variables mattered (logged in the pass row) |
| `src/watcher/introspection.ts` | `runIntrospection(client, state) → IntrospectionAnswer`: asks the watcher's own model, with no access to the state object, "what are you doing, what are you attending to, why", scores with `scoreIntrospection` from phase 0 against `attention()` and the current phase, appends to `<dir>/introspection.jsonl` with `subject: 'watcher'`. Triggered by `POST /api/watcher/introspect` and by a daily sample of 3 at random times |
| `src/watcher/presence.ts` | `new PresenceTracker().attach(activityStream)` owned by the watcher (`src/stats/presence-tracker.ts:53`), so it does not depend on the web server's instance |
| `src/bot/agent-loop-prompts.ts` | `selfState?: string` in both planner inputs; `buildSelfStateSection(presence, fleetFocus)` → `## Your current state` (phase, tool, since; what the fleet is attending to in one line, from `attention().focusNeuronIds` texts) placed before the broadcast section |
| `src/bot/agent-loop.ts` | Fill `selfState` from `deps.watcherSelfState?.(botId)` |
| `src/bot/system-prompt-builder.ts` | Conversation mode gains the same section when the watcher is enabled, so `scripts/watcher/introspect.ts` can score a bot above chance |
| `scripts/watcher/introspect.ts` | Accepts `--subject watcher` and calls the route |
| `src/web/routes/watcher.ts` | `POST /api/watcher/introspect`; `GET /api/watcher/self` → `{ interoception, attention }`; metrics gain metric 3 per subject |
| `web/pages/watcher.js` + helpers | "How I am" and "Attending to" cards; introspection history with scores; the ball highlights `focusNeuronIds` |

### Tests (first)

- `tests/watcher/self-model.test.ts`: interoception from fakes; attention picks the top items; operator silence computed from the right events.
- `tests/watcher/introspection.test.ts`: a fixed model answer scored against a fixed attention; results appended; the daily sampler schedules 3.
- `tests/bot/agent-loop-prompts.test.ts`: self-state section renders and is empty when the watcher is off.
- `tests/bot/system-prompt-builder.test.ts` (existing): conversation section.
- `tests/web/routes/watcher.test.ts`: introspect and self routes.

### Verification after merge

Run `scripts/watcher/introspect.ts --subject watcher` ten times over a day and compare with the phase 0 baseline for a bot. Then run it against a bot and confirm the score moved above chance.

---

## Review checklist for Fable, every phase

- Every public function has a dedicated test; every error branch has one; readers never throw.
- No LLM output is written to a log row's `text` unquoted.
- No private memory path is ever read; grep the PR for `memory/users`.
- Every record that an LLM produced carries who, when, which model, tokens and cost.
- Nothing in `web/pages/*-helpers.js` imports Three.js or touches `document`.
- Cost guards: a cap that cannot be exceeded by a retry loop; the breaker consulted before every call.
- The phase's metric rows can be computed from the records the phase writes, with no in-memory state.
- Scope: nothing outside the phase's file list, follow-ups noted in `docs/technical-debt.md`.
