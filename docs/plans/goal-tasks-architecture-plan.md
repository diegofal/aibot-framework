# Goal tasks and task workers — architecture plan

Status: **design** (2026-10-12), revision 4. Diagrams: [goal-tasks-architecture.html](goal-tasks-architecture.html).

- Revision 2 made tasks the unit of work (own store, attribution, settle) and was checked against the code by an adversarial review.
- Revision 3 adds **workers**, at the operator's request. A cycle can spin up workers that each work one task until it is finished, possibly across cycles and in parallel, and the operator watches active workers live.
- Revision 4 applies a second review against the code (changes in "What the reviews changed").

## Problem

Tasks shipped on 2026-10-12 (`ebeb4af`) as data: lanes, author and id on `- task:` lines in GOALS.md, `manage_goals add_task / update_task`, and a board on Agent Home. Nothing in the agent loop uses them, and nothing can work on a task for longer than one cycle.

**Planning.**
- No prompt asks the agent to break a goal down. The only task rule appears when an operator goal already has tasks (`src/bot/agent-loop-prompts.ts:287-304`).
- The strategist's free-text focus (`agent-scheduler.ts:537-541`) is a second, parallel plan.

**Attribution.**
- A cycle has a goal (`CycleAttribution`, `agent-loop.ts:103-114`) but no task.
- A cycle whose only goal signal is a task action is unattributed (`goals.ts:326` → `agent-cycle-log.ts:126-145`).

**Storage and writes.**
- Both boards PATCH whole task lists from the client's copy (`agent-home.ts:415-419`, `fleet-board.js:228-232`), so concurrent agent writes are lost.
- The task line suffix only takes `[\w.:-]+` (`goals.ts:169`).
- The 10-completed-goals cap deletes tasks (`goals.ts:730`).

**Prompts.** Every prompt reads raw GOALS.md, and the executor reads it twice (`agent-loop-prompts.ts:627-630`, `soul.ts:221-225`).

**No runtime for long work.**
- Collaboration and delegation are synchronous single calls (`collaboration.ts:521-563`, 60 s race).
- A2A and the MCP bridge are request/response.
- Claude CLI runs are one-shot `-p` with `--no-session-persistence` and no resume (`claude-cli.ts:630-638`).
- `LLMResponse` is text only (`llm-client.ts:34-39`).
- A cycle timeout is a `Promise.race` that does not cancel (`agent-loop.ts:1082-1090`): stray work already outlives cycles, uncontrolled.

**One run per bot is assumed throughout.**
- The `cycleAttribution` / `runningCycle` map keyed by bot.
- `PresenceTracker`: one state per bot.
- `consumeAnswersForBot` / `consumeDecisionsForBot` drain everything for a bot.
- The scheduler's per-bot guard and the fleet `maxConcurrent` 2 (`agent-scheduler.ts:415-433`).

**Gaps in rails and visibility.**
- The agent-loop executor does not enforce `confirm` tools, and pre-selection skips `blocked` (`agent-loop.ts:2295-2305, 2328-2345`).
- `/ws/activity` is an unfiltered firehose with no tenant filter (`web/server.ts:776-778`).
- Activity events carry no run id; executor `tool:*` events drop `cycleId` (`tool-executor.ts:250-277`).

**Restarts.** SIGTERM abandons in-flight cycles (`index.ts:353-365` → `stopAll`), and nothing is resumable.

## What OpenClaw does (local source)

1. **`progress_card`.** A per-session checklist that allows at most one item in progress, and reconciles once at the end of the run.
2. **Workboard + sub-agents.** This is the model for workers.
   - **Sub-agents.** A sub-agent is a separate session in the same process, with its own context and a restricted tool set. Spawn, list, messaging, cron and gateway tools are denied (`src/agents/agent-tools.policy.ts:61-92`). Concurrency: 8 per spawner, 5 children, depth 5.
   - **Workboard dispatcher.**
     - It starts at most 3 workers per pass and one per owner.
     - It serializes passes and claims cards with a UUID token that has a TTL (30 min default) and is extended by `workboard_heartbeat`.
     - The worker prompt is a protocol plus a bounded card context.
     - Workers report **only** through `workboard_complete` (summary + proof) or `workboard_block`.
     - Lifecycle hooks plus a 60 s sweep map a dead run to blocked and an idle one to stale (30 min).
     - A worker that ends without complete/block is a `protocol_violation`.
   - **UI.** Board change events refresh the board live. A card shows the session badge, claim, last heartbeat and attempts. You can open the worker's transcript or stop it (`chat.abort`).
   - **Known gaps in its own code:**
     - past `maxRuntimeSeconds` the card is only blocked, the run is never aborted;
     - no token or turn budget, only time;
     - after a restart interrupted runs are finalized, not resumed.

What we take:
- a worker = a background run of the same agent with a restricted tool set, a protocol, a bounded context and report-only-through-tools;
- claims with expiry, refreshed by progress;
- caps per pass, per owner and fleet-wide;
- a sweep for dead and stale workers, and protocol-violation detection;
- live change events and a Stop.

What we do differently, because of our runtime and their gaps:
- **a worker is a loop of bounded steps with a persisted step log** (our LLM calls cannot be resumed);
- Stop and timeouts really abort;
- workers have step and tool budgets, not just time;
- interrupted workers resume from their last step.

## Design

**The cycle orchestrates; workers do task work.**
1. The cycle's planner reviews tasks and the workers' reports.
2. It breaks goals down and dispatches tasks to workers.
3. Each worker works one task, step by step, until it reports done or blocked, or its budget ends.
4. Everything a worker does carries `{ runId, taskId, goalId, cycleId }`.
5. The operator sees every active worker live and can stop it.

### Components

**Tasks** (revision 2, kept)

| # | Component | What |
|---|---|---|
| C1 | **Task store** `src/goals/task-store.ts` | `<soulDir>/TASKS.json` `{ version, rev, tasks: [...] }`. Each task: `{ id, goalId, text, lane, order, by, createdAt, createdCycle?, startedBy?, startedAt?, note?, doneAt?, claim?, cycles[] }`. `claim = { runId, token, expiresAt }`. One writer, `apply(ops, { actor, cycleId?, runId?, expectedRev?, claimToken? })`: atomic write, backup, exported with the soul dir. Caps: 12 open tasks per goal, 200 chars per text or note. Dedupe on add. Orphans are filtered on read and reported by lint. |
| C2 | **Task ops** | `add`, `move`, `edit`, `note`, `remove`, `reorder`, plus `claim(id, runId)` (compare-and-swap: fails if a live claim exists), `renew(id, token)` and `release(id, token, lane, note)`. While a claim is live, only the claim holder or the operator can move the task. An operator move releases the claim and stops the worker. |
| C3 | **Task events** | `task-*` rows in `goal-events.jsonl` with `taskId`, `runId`, actor and cycle. |
| C4 | **Migration** | Lifts `- task:` lines out of GOALS.md once. The parser keeps reading old lines. |
| C5 | **Goals view** `renderGoalsForPrompt` | Goals plus open tasks (id, lane, note, a "worker running" marker), bounded. Used everywhere goals are read: planner, strategist, executor (once), feedback, navigator, conversations, `manage_goals list`. |
| C6 | **Op API + both boards** | Task op endpoints with `rev` / 409. Agent Home and the Fleet Board drawer send ops. `PATCH /goals { tasks }` is retired. |
| C7 | **Agent tools** | `manage_goals add_task / update_task` (id alone is enough) / `note_task` for the cycle and conversations. Workers use the worker tools (C11). |

**Workers** (new; revision 4 applies the second review)

| # | Component | What |
|---|---|---|
| C8 | **Planner as dispatcher** | Both planner modes get C5 plus a "Workers" block: runs that are going (task, step, last report) and runs that ended since the last cycle, with their outcome. Optional outputs: `new_tasks` (2–5 steps for a goal with no open task) and `dispatch` (task ids). The loop dispatches only tasks the planner named: never on explore or idle cycles, and never a content task under the hard engagement gate. The cycle's own executor stays for work that is not a task (maintenance, outreach). |
| C9 | **WorkerRun store** `src/workers/run-store.ts` | `<data>/workers/<botId>/runs.json` holds active runs. `<data>/workers/<botId>/<runId>.jsonl` is the append-only journal: step start, every `tool:end` (name, target, ok, side-effect class), step report, step end. `runs-YYYY-MM-DD.jsonl` holds ended runs. Each run: `{ runId, botId, taskId, goalId, dispatchCycleId, status: queued\|running\|waiting\|done\|blocked\|failed\|stopped\|interrupted, attempt, step, budget { steps, toolCalls, wallMs }, used, startedAt, heartbeatAt, currentTool?, outcome?, error? }`. |
| C10 | **WorkerPool** `src/workers/pool.ts` | The only place workers start. Admission checks, all required:<br>• fleet cap `workers.maxConcurrent` (default **2**);<br>• per bot `workers.maxPerBot` (default **1**);<br>• one run per task (C2 claim);<br>• the `workers.dailyStepsPerBot` budget;<br>• tenant quota;<br>• the shared circuit breaker (C17) is closed for the bot's backend.<br>A queue ordered by goal priority, then task order. A run that ends calls `requestImmediateRun` for its bot (debounced), so the planner reads the outcome soon instead of after an idle backoff. Exposes `list`, `get`, `stop`, `retry`, `abortAll`. |
| C11 | **Worker step loop** `src/workers/worker.ts` | Built on **`runExecutorTurn()`**, extracted from the cycle executor (`agent-loop.ts:2257-2470`): system prompt, tool definitions, `ToolExecutor`, audit subscription, `withTimeout` + abort, `llm:*` events, query log. The cycle executor and worker steps share it.<br><br>Each step is one turn:<br>• **Prompt:** the worker protocol, goal and task, task notes, answers to its asks, and the step log. Each step's log entry is built from its report note plus the journal's tool list, since the response text alone loses the tool trace on claude-cli (`llm-client.ts:187`).<br>• **Tool budget:** enforced by wrapping the executor callback with a counter; past the budget a call returns "budget used — report now". This works on both backends: `maxToolRounds` alone is ignored on claude-cli (`llm-client.ts:172-185`).<br>• **Step timeout:** from the abort signal (C12), not the client's fixed timeout.<br>• **Working directory:** the task's own `productions/<bot>/tasks/<taskId>/` as cwd and write root, so parallel runs never overwrite each other (OpenClaw gives each card its own worktree).<br>• **Ending a step:** with `task_progress(note)`, `task_done(note)` or `task_blocked(why)`. No report is a protocol violation; two in a row ends the run `blocked` ("worker stopped reporting"). A used-up budget releases the task to To do with a note. |
| C12 | **Real cancellation** | `signal` in `ChatOptions`. `signal.aborted` is checked before **every fallback branch** (`ollama.ts:229`, `llm-client.ts:280, 389`), so a Stop never replays the tool loop on a fallback model or backend. Also:<br>• passed to `runWithModelFallback` and `NativeToolStrategy`;<br>• checked between rounds in `tool-runner.ts`;<br>• claude-cli: kill the child, then wait (bounded) for the tool callback already in flight;<br>• opt-in `_signal` injected into long tools: `exec`, `web_fetch`, `browser`, MCP.<br>Used by Stop, step timeout, shutdown and the cycle `maxDurationMs` race, which today leaves stray executors running. |
| C13 | **Worker tool context** | Own `ToolExecutor` and loop detector. `permissionMode: 'agent-loop'` enforced at execution and in pre-selection. Attribution `{ runId, taskId, goalId, dispatchCycleId }`. **Denied:** `manage_goals` goal ops, `collaborate`, `delegate_to_bot`, `create_agent`, `cron`, `send_proactive_message`; in phase 2a also `ask_human` and every `confirm` tool. **Added:** the three report tools. |
| C14 | **Permissions never block outside conversations** | A `confirm` tool in the agent loop or a worker never awaits. With a recent approval it runs. Otherwise it files the request (`{ cycleId \| runId }`) and returns a non-success "approval requested (id)"; a worker then goes `waiting`. Enforcement ships behind a per-bot flag, after auditing the live `toolPermissions` (today `exec`, `file_edit`, `browser` are `confirm` for the agent loop but unenforced: switching on the blocking path would stall every cycle). |
| C15 | **Asks and approvals per run** (phase 2b) | `PendingQuestion` and permission requests gain `runId`. The one-pending-question limit becomes per `(botId, runId \| cycle)` instead of per bot (`ask-human.ts:487-498`). `recordAnswer` and resolved permissions with a `runId` go to `pool.onAnswer(runId)`, not to the cycle's `consume*ForBot` (no double execution). `autoAttachFiles` targets the question id from the tool result, not "the last pending". The Telegram reply fallback that assumes a single pending question matches by message id only. Dismiss, close-stale and clear end the run `blocked`. |
| C16 | **Sweep, shutdown, resume** | **Sweep every 60 s:**<br>• no heartbeat for 2 × step timeout → abort, `failed`, task To do with a note;<br>• expired claim → released;<br>• ≥ 2 failed attempts → task Blocked.<br>**Shutdown:** `pool.abortAll('shutdown')` writes `interrupted` synchronously, then `stopAll`, within 20 s (compose grace is 30 s; a claude-cli step can run 300 s, so waiting for a step is not an option).<br>**Boot:** load runs and **re-bind claims of interrupted runs before `startAgentLoop()`** (`index.ts:333`), so the first cycle cannot dispatch the task twice. Resume at the last finished step, `attempt + 1`, max 2. A step whose journal shows a non-idempotent tool (send, post, call, exec) resumes as `blocked` for the operator, never re-run. |
| C17 | **Shared state made run-safe** | • Worker rows carry `runId` + `dispatchCycleId`, **never `cycleId`**: the goal drawer builds cycle windows from row times and would stretch a cycle over hours.<br>• `PresenceTracker` branches on `runId`: the bot's phase and tool stay the cycle's; workers go in a `workers` map.<br>• `BackendCircuitBreaker` moves from `AgentLoop` into `BotContext`; worker and executor failures feed it.<br>• Metering per step (`tenantFacade.recordUsage`), not only at cycle end.<br>• A **global claude-cli semaphore** in `ClaudeCliLLMClient` covers every caller (cycles, workers, conversations, feedback, curiosity), with workers at the lowest priority. Each call spawns a process plus an MCP bridge, and nothing limits them today.<br>• TaskStore writes are synchronous with a revision; daily memory appends are synchronous (safe). |

**Live visibility**

| # | Component | What |
|---|---|---|
| C18 | **Socket tenant filter** (phase 0) | Bind `tenantId \| admin` to `ws.data` at upgrade. Filter every broadcast and the history replay by bot → tenant from `config.bots`; the same for `/ws/logs`. Clients reconnect. This lands before any worker exists, because every `ToolExecutor` already bridges `tool:*` to the socket (`tool-executor.ts:246`). |
| C19 | **Events + API** | Events gain `runId` / `taskId` (`tool:*` keeps its ids). New: `worker:queued \| started \| step \| tool \| waiting \| ended`, `task:changed`. API, all tenant-scoped:<br>• `GET /api/agents/:id/workers` (active + last 20);<br>• `GET /api/workers/:runId` (run, journal, steps);<br>• `POST /api/workers/:runId/stop`;<br>• `POST /api/workers/:runId/retry`. |
| C20 | **UI** | Event-driven refetch plus a slow poll (today's `live-presence.js` pattern), not push-only.<br>• **Board:** a worker badge on the task: step n / budget, current tool, elapsed.<br>• **Agent Home:** an "Active workers" strip.<br>• **Fleet:** a Workers view across bots.<br>• **Worker sheet:** journal per step, budget used, Stop, Retry.<br>• **Needs You:** `waiting` workers with their ask or approval. |

**Upkeep** (revision 2, adapted)

| # | Component | What |
|---|---|---|
| C21 | **Strategist** | Goal ops may carry tasks. `single_deliverable` becomes a task only when `serves_goal` resolves, else `lastFocus` stays. A goal completed or removed releases its claims and stops its workers. |
| C22 | **Lint, karma, Why** | Goal-lint: In progress without a run or event for ≥ 3 cycles, Blocked > 72 h without an ask, done without a note, orphans. Karma per run outcome (protocol violation = tool error); repetition karma exempts dispatch cycles. Why builders: `taskEventToWhy`, `workerRunToWhy` (dispatching cycle, reason, steps, outcome); the cycle Why lists its runs. |

### Decisions

- **D1 Tasks get their own store, `TASKS.json`.** Notes, claims and revisions don't fit a GOALS.md line, and the completed-goals cap deletes tasks.
- **D2 The planner chooses; the loop and pool act; the worker reports.** Gate, explore and idle rules apply at dispatch.
- **D3 A worker is an in-process step loop of the same agent, on the shared `runExecutorTurn()`.** Rejected:
  - **worker as a cycle variant:** scheduler, `cycleAttribution` and `runningBotIds` are keyed by bot and would need the same re-keying, plus strategist and planner cost on every step;
  - **a long Claude CLI session:** one-shot `-p`, no resume;
  - **a separate bot or collaboration:** synchronous, split identity.

  What is worth reusing — failure classification, the breaker, metering — moves into `BotContext`.
- **D4 Budgets:** steps, tool calls (enforced in the callback), wall time, and a daily step budget per bot. Cost: one full-prompt call per step, so an 8-step task costs about 2–3 of today's cycles; the daily budget is required.
- **D5 Caps start at 1 per bot and 2 fleet-wide.** A global claude-cli semaphore covers every caller.
- **D6 Interrupted workers resume from the journal, at most 2 attempts.** A step that sent or executed something never auto-resumes.
- **D7 Permissions never block outside conversations** (C14). Enforcement is behind a flag.
- **D8 Done asks for a note.** No auto-complete of goals, no dependencies, no cross-bot workers.
- **D9 The socket tenant filter ships in phase 0, before any worker event.**

### What the reviews changed

| Earlier | Found in the code | Now |
|---|---|---|
| r1: tasks in GOALS.md with a note in the line | The suffix grammar breaks on free text; the completed cap deletes tasks | Own store (C1) |
| r1: reconcile = a follow-up LLM turn | No transcript to continue | The worker protocol makes every step report (C11) |
| r1: the loop starts a fallback task | Would start work under the gate, explore or idle | Dispatch only what the planner named (C8) |
| r1: ops inside `writeGoalsFile` fix the race | The stale data is the client's list | Op API + revisions + claims (C2, C6) |
| r2: the cycle works one task | Operator: longer, parallel, visible work | Workers (C8–C20) |
| r3: `maxToolRounds` 12 bounds a step | Ignored on claude-cli | Callback counter (C11) |
| r3: abort through the client | Abort triggers model and backend fallbacks that replay tools | Abort guards on every fallback (C12) |
| r3: workers use `ask_permission` for `confirm` | Blocks with no timeout; would stall every cycle | Non-blocking confirm behind a flag (C14) |
| r3: answers route to a run | One pending question per bot; resolved approvals are re-planned by the cycle | Per-run asks and approvals (C15) |
| r3: shutdown finishes the current tool call | 30 s grace vs 300 s steps | Abort and persist in 20 s; journal; non-idempotent steps don't re-run (C16) |
| r3: a lock for production numbering | Renumbering is synchronous; the real race is parallel runs in one workDir | A directory per task (C11) |
| r3: worker rows carry the dispatching `cycleId` | Stretches cycle windows in the goal drawer; presence mixes workers in | `runId` + `dispatchCycleId`; presence by run (C17) |
| r3: tenant filter in phase 3 | Executors already stream tool events | Phase 0 (C18) |
| r3: 3 fleet / 2 per bot | No claude-cli limiter; worker 429s never open the breaker | 2 / 1, global semaphore, shared breaker (C17) |
| r3: "no polling" | Today's live link is refetch + poll, with no reconnect | Refetch + slow poll + reconnect (C20) |

## Phases

0. **Foundations** — no change to how agents plan. Each item fixes or prevents a live bug:
   - C1–C7: TaskStore, migration, op API, both boards, goals view;
   - C18: socket tenant filter;
   - C12: real cancellation, with fallback guards;
   - C14: non-blocking confirm behind a flag;
   - extract `runExecutorTurn()`;
   - C17: the shared breaker and the claude-cli semaphore.
1. **Planner uses tasks** — `new_tasks`, `taskId` on cycle work, the cycle Why names its tasks. Watch the breakdown quality on live cycles before any worker runs.
2. **Workers.**
   - **2a:** pool, step loop, run store and journal, report tools, sweep, wake-on-end, per-task directories. Workers get no `ask_human` and no `confirm` tools.
   - **2b:** asks and approvals per run (C15); shutdown, resume and boot re-bind (C16).

   Behind `workers.enabled` (default off), one bot first.
3. **Live visibility** — C19 events and API, C20 UI.
4. **Strategist and upkeep** — C21, C22.

After each phase: deploy, watch real cycles and workers, then start the next.

## Tests (written first, per phase)

- **Phase 0.**
  - Task store: ops, revisions, claims (compare-and-swap, expiry, only the holder moves the task), caps, dedupe.
  - Migration is idempotent; the API returns 409 on a stale revision; both boards send ops; renderer size.
  - Abort never triggers a model or backend fallback; a kill mid-tool waits for the callback.
  - Confirm returns "approval requested" and never awaits; `blocked` is enforced in pre-selection and at execution.
  - A tenant-B client gets neither broadcasts, the history replay nor `/ws/logs` lines from tenant A.
  - The semaphore queues claude-cli calls past the limit.
- **Phase 1.** `new_tasks` only from explicit output; none on explore, idle or gated cycles; `taskId` on audit, productions and asks.
- **Phase 2a.**
  - Pool admission (both caps, one run per task, daily budget, breaker open).
  - The claude-cli tool budget cuts off; a report every step; two protocol violations end the run; budget end releases the task; a step timeout aborts.
  - Two runs never share a write root.
  - Goal-drawer cycle windows and bot presence stay correct with worker rows.
  - Worker 429s open the shared breaker; the cycle wakes when a run ends.
- **Phase 2b.**
  - The cycle and two runs ask at once and every answer reaches its asker.
  - Attachments go to the right question.
  - A worker's approved permission is not re-planned by the cycle.
  - Shutdown persists within 20 s; resume skips a non-idempotent step; the boot re-bind prevents a second dispatch.
- **Phase 3.** Event shapes, API tenant scoping, the board badge from an event, Stop from the sheet.
- **Phase 4.** Deliverable → task only with a resolved goal, lint findings, karma per outcome, Why contract fixtures for both new builders.

## Out of scope

Task dependencies and decompose trees, cross-bot workers, worker model overrides, messaging a running worker (stop it, note the task, retry), per-user goals.
