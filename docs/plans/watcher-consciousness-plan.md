# Plan: the watcher — a fleet-level workspace that moves toward consciousness

**Status:** planned (2026-10-23). Nothing built. Build order, files, tests and anchors per phase: `watcher-implementation-plan.md`.
**Scope (planned):** `src/watcher/` (new package: birth, log, salience, graph, store, tiers, broadcast, self-model), `src/bot/activity-stream.ts` (subscribe only), `src/bot/agent-loop-prompts.ts` (one new planner section, "## Fleet broadcast"), `src/web/routes/watcher.ts`, `/ws/watcher`, `web/pages/watcher*.js` (the ball and the log), `src/config.ts` (`WatcherConfigSchema`), tests, docs.
**Principle:** the bots stay on cycles. They are the specialists. One always-on process per fleet, the watcher, is the global workspace: it senses every event, keeps a working buffer, integrates across bots, and broadcasts back. It is the only thing that ticks and the only thing allowed to interrupt a bot between cycles.

---

## Goal

Build the parts of the fleet that the main scientific theories of consciousness name as necessary, in a way that each part can be measured, and stop claiming anything the measurements do not show.

Consciousness itself has no test. What can be measured is the set of functional properties the theories agree on: integration across modules (global workspace), continuity (existence between invocations), an accurate model of one's own processing (attention schema, higher-order thought), prediction and surprise (predictive processing), felt internal state (affect theories), and causal efficacy (the workspace changes behaviour instead of describing it). This plan measures those six. If all six move, the strongest honest claim is "the fleet behaves like one mind". Nothing in this plan measures experience.

Two rules for every metric:

1. **Ground truth is the record, never the model's text.** The fleet already writes what it did and why at the moment it happened (cycle log, tool audit, goal events, presence tracker, Why builders). A self-report counts only when it is checked against those records. A metric the LLM can improve by writing nicer prose is not a metric.
2. **Every metric has a baseline from today's fleet and a way to regress.** If it cannot go down, it is not telling us anything.

---

## How success is measured

| # | Property (theory) | Metric | How it is computed | Baseline today | First target |
|---|---|---|---|---|---|
| 1 | Integration (global workspace) | **Cross-source insight share**: fraction of watcher insights whose supporting neurons come from ≥ 2 bots, or a bot plus a conversation | Every insight neuron records its support set with `botId` per neuron; computed over a rolling 7 days | 0. No cross-bot knowledge exists; collaboration sessions are the only cross-bot path and leave no shared memory | > 0 by phase 2; ≥ 30 % by phase 3 |
| 1b | Integration | **Contradictions surfaced**: count of pairs of facts from different bots, or chat vs loop of the same bot, that the watcher flags and the operator confirms | Flagged pairs are a neuron kind `contradiction`; operator confirms or dismisses from the dashboard | 0 detected (none can be) | ≥ 1 confirmed per week with ≤ 50 % dismissed |
| 2 | Continuity | **Latency to notice**: time from a salient event (human message, error, goal change, worker blocked) to the moment the workspace buffer reflects it | `event.ts` vs the buffer entry's `noticedAt`, median and p95 per day | One bot cycle interval: hours. A bot does not exist between cycles | Tier 0 under 1 s, tier 1 under 5 min, tier 2 under 1 h for high salience |
| 3 | Self-model accuracy (attention schema) | **Introspection match rate**: the watcher, and later each bot, is asked at random moments "what are you doing, what are you attending to, why"; the structured answer is compared to the presence tracker and the current cycle row | Sampled N times per day by a test harness; score is field-level match (phase, tool, goal, cause). Reported per subject | Bots: at chance. They never see the presence tracker. Watcher: n/a | Watcher ≥ 80 % on phase and attended item; bots ≥ 60 % once the feedback path exists (phase 4) |
| 4 | Prediction (predictive processing) | **Calibration**: each integration pass predicts the next few fleet events, operator reply or no reply, and tool outcomes; scored when they resolve | Brier score over predictions resolved in the window; tracked weekly to see learning | None. Curiosity measures surprise for topics only | Brier improving week over week for 4 weeks; better than a frequency baseline |
| 5 | Compounding and forgetting | **Re-activation rate**: share of neurons older than 7 days touched by a new insight; **pruned share**: neurons archived for never re-activating; **canary recall**: facts planted in a conversation with bot A, later asked through bot B | Graph stats computed daily; canaries are a scripted test that runs weekly | Re-activation: n/a. Canary recall across bots: 0 (impossible today) | Re-activation ≥ 20 %; canary recall ≥ 70 % after 24 h; pruned share non-zero and stable |
| 6 | Causal efficacy | **Broadcasts that changed behaviour**: fraction of watcher broadcasts (wake, directive, goal, question to operator) that a bot's next cycle served, with the operator's 👍/👎 on the result | `Broadcast.id` is stamped on the cycle row it caused (`reason`), same as `cronId` today; operator signal reuses the taste model | 0. Nothing broadcasts | ≥ 50 % served; operator 👍 ≥ 👎 over 30 days |
| 7 | Fleet-level surprise | **Novel surprises per week**: surprises the watcher records that are not already in any bot's KNOWLEDGE.json | Dedupe at `textSimilarity ≥ 0.8` against all bot maps | 0 | ≥ 3 per week, with ≤ 1 judged trivial by the operator |

**Guard metrics** (must not regress; cost is the real constraint):

| Guard | Source | Limit |
|---|---|---|
| Daily LLM cost of the watcher | `GET /api/stats/usage` by caller `watcher`, Opus and Haiku separated | Configurable daily cap on tier 2 calls; breaker shared with the fleet |
| Bot idle cycles | cycle log, `status: idle` share per bot | Must fall once the watcher wakes bots on salience, so a longer base interval is possible |
| Conversation latency | semaphore stats, `interactive` wait time | Unchanged. The watcher runs at a priority below `worker` |
| Operator interruptions per day | proactive throttle | Watcher messages share the existing daily cap; no new channel |

**What is explicitly not a metric:** how good the ball looks, how much the watcher writes, how often it runs, how "conscious" its text sounds.

---

## Phase 0: measure the baseline before building

Cheap and useful on its own. Produces the numbers in the Baseline column so the later phases can show movement.

- A script `scripts/watcher/baseline.ts` that reads the cycle log, tool audit, presence and KNOWLEDGE.json of every bot and prints: idle cycle share, median cycle interval (= latency to notice today), count of bots with overlapping topics in their maps (where cross-bot insight could exist), contradictions between a bot's chat replies and its cycle plans found by exact topic overlap.
- A harness `tests/watcher/introspection.test.ts` that asks a running bot in conversation what it is doing now and scores the answer against the presence tracker. Expected to score at chance. The test is kept and later run against the watcher.
- A weekly canary script that plants one fact in a conversation with one bot and asks another bot the next day. Expected to fail today.

**Tests:** unit tests for the baseline readers (they never throw on missing data, same contract as `src/stats/readers`).

---

## Design summary

Detail lives in each phase. The shape:

### Tiers of tick

| Tier | Trigger | Model | Writes |
|---|---|---|---|
| 0 Sense | every `ActivityStream` event plus the file-backed streams the stream does not carry (goal events, soul events, dispatches, memory flushes) | none; deterministic salience | the working buffer |
| 1 Notice | buffer salience above a low bar, or every few minutes if the buffer is non-empty | Haiku 5.5 or local Ollama | candidate neurons and edges |
| 2 Integrate | accumulated salience above a high bar, or a slow heartbeat | Opus 5.5 | insights, contradictions, predictions, broadcasts |

Salience at tier 0 weights: human involvement, errors, goal and task changes, worker blocked or waiting, surprise reported by the curiosity extractor, prediction error from tier 2, and novelty against the graph (no matching neuron). Decays with time. Every buffer entry keeps `event.ts` and `noticedAt` (metric 2).

### Neurons

A neuron is a unit of information the watcher decided to keep, never a raw event. Kinds: `fact`, `entity`, `person`, `pattern`, `goal`, `insight`, `contradiction`, `prediction`, `surprise`. Fields: `id`, `kind`, `text`, `support` (bot ids, cycle ids, conversation ids, production paths), `createdBy` (`watcher` or `bot:<id>`), `createdAt`, `lastActivatedAt`, `activations`, `confidence`, `embedding`, `edges` (`related`, `contradicts`, `caused`, `serves`, `predicts`). Stored append-only in `<data>/watcher/neurons.jsonl` with a compacted `graph.json`, same pattern as the relay store. Embeddings reuse `src/memory/embeddings.ts`. Neurons that do not re-activate within a configurable window are archived, not deleted (metric 5).

### Broadcast

The downward path. Each broadcast has an `id`, a target bot, a kind (`wake`, `directive`, `goal`, `question`) and the insight it comes from. It uses only existing entry points: `requestImmediateRun(botId, { feedback: false })`, `CuriosityService.recordDirective`, `appendGoal` with `source: watcher`, and the proactive message path with its throttle. The planner prompt gets one new section, "## Fleet broadcast", and the cycle row records the broadcast id it served (metric 6).

### Self-model

The watcher has its own soul dir under `<data>/watcher/soul/` (identity, memory, traits), so the same machinery that makes a bot develop applies to it. Its working buffer is what the fleet is attending to; the watcher can read it and report it (metric 3). Its interoceptive state is a small record it reads every tick: fleet karma, quota remaining, breaker state, operator silence in hours. Tier 2 must name which of these drove its decisions.

### The ball

A 3D view of the graph in the vanilla dashboard with Three.js and instanced points. Position is the embedding projected to three dimensions, so related knowledge clusters. Brightness is activation and decays. A neuron pulses when an event touches it, over the same WebSocket as the activity feed. Colour separates watcher-made from bot-made neurons. Archived neurons dim out. Clicking a neuron opens its Why panel (`whyPanel`, same contract as every other surface). It renders the graph; it is not a metric.

---

## What you see when you turn it on

Two surfaces, one stream. The watcher narrates everything it does in a log you can read without knowing the code, and the ball grows from the same events. Both start at birth, the first time the watcher wakes up and discovers the environment it was born into.

### The watcher log

`<data>/watcher/log/YYYY-MM-DD.jsonl`, one row per thing the watcher does, plus a pino child logger `watcher` so the rows also appear in the container log. Row shape:

```
{ ts, seq, phase, op, text, neuronIds?, edgeIds?, salience?, source?, model?, tokens?, costUsd?, durationMs? }
```

- `phase`: `birth` · `sense` · `notice` · `integrate` · `broadcast` · `sleep`.
- `text` is plain first-person English written by code, never by the LLM, the same way `describeNow` already does for bots. Tier 1 and 2 outputs are quoted inside it, so a reader can tell what the watcher decided from what the model said. Examples:
  - `Waking up for the first time. Looking around: 8 bots, 1 tenant, Claude CLI and Ollama available.`
  - `Met jarvis: "Jarvis, the operator's assistant" (telegram ok, 3 active goals).`
  - `Learned from jarvis's knowledge map: "Invoices from Acme arrive on the 3rd" (fact, confidence high).`
  - `Noticed: Ana wrote to jarvis about invoices. Salience 0.7 (human message, touches 2 neurons).`
  - `Integrating 14 salient items since 09:12. Asking Opus.`
  - `Insight: "Two bots are researching the same supplier from different angles" (supported by jarvis, researcher). New neuron, 3 edges.`
  - `Broadcast: woke researcher. Reason: new evidence for goal g-3f1a from jarvis.`
  - `Integrate pass done: 18k tokens, $0.12, 41 s.`
  - `Nothing salient for 10 min. Sleeping until something happens.`
- Tier 0 does not log every event. It logs an event only when its salience crosses the notice bar or it activates a neuron, plus one `sense` summary row per minute when anything happened (`N events, top: …`). Everything else stays in the activity stream where it already is.
- Every row that created or touched neurons names them, so the log and the ball point at each other, the same way the cron run log and its message id do today.

### Birth: discovering the environment

Runs once, the first time the watcher starts with no `<data>/watcher/` state. Each stage is a log row and a stream of neurons, so the ball is visibly built up stage by stage. Progress is written to `birth.json` after each stage; a restart resumes at the stage that did not finish. The first wake after birth logs `Waking up. 1,240 neurons, last awake 6 h ago` and runs a short resync stage (new bots, goals or contacts since sleep).

| Stage | Reads | Creates | Log text |
|---|---|---|---|
| `birth:wake` | config, tenants, backends, channel states | nothing | `Waking up for the first time. Looking around: …` |
| `birth:fleet` | IDENTITY, MOTIVATIONS, TRAITS.json, channel state of each bot | one `entity` neuron per bot | `Met <bot>: "<purpose>" (<channel>, N active goals).` |
| `birth:people` | each bot's user directory; the operator first, merged contacts folded | `person` neurons, edges `knows` to bots | `Met <name> (operator, telegram + email), known to 3 bots.` |
| `birth:goals` | GOALS.md and TASKS.json of each bot | `goal` neurons, edges `owned_by`, open tasks as attributes | `Learned what jarvis is working on: 3 goals, 7 open tasks.` |
| `birth:knowledge` | KNOWLEDGE.json of each bot | `topic`, `fact`, `surprise`, `question` neurons with the bot's confidence; edges `about` and `owned_by` | `Learned from <bot>'s knowledge map: "<claim>" (<kind>, <confidence>).` |
| `birth:memory` | shared core memory only (MEMORY.md and `memory/*.md`); never `memory/users/<id>/` | `fact` neurons, with the memory category as a `topic` edge | `Remembered from <bot>: "<fact>".` |
| `birth:history` | last 30 days of the cycle log, productions changelog, goal events | no new neurons; sets `activations` and `lastActivatedAt` on goal and topic neurons from the cycles that served them | `Reviewed 30 days of history: 212 cycles. 14 goals were worked on, 3 never.` |
| `birth:link` | all neurons | embeddings in batches (`src/memory/embeddings.ts`), `related` edges above a cosine threshold, streamed batch by batch | `Linking what I know: 1,240 neurons, 3,800 edges so far.` |
| `birth:done` | | | `Born. 1,240 neurons: 8 bots, 12 people, 31 goals, 640 facts, 44 surprises, … in 2 min 10 s. Could not read: <list>.` |

Rules for birth:

- Everything it imports already exists on disk. Birth is a read of the fleet, not an LLM pass. No tokens are spent.
- Private memory is never imported. Per-user memory folders belong to the people who wrote to the bot; the watcher sees shared memory only. Metric 5's canaries go through conversations, so they are tested by what flows through the activity stream later, not by reading private transcripts.
- What it could not read is in the log, never silently skipped. Same contract as the stats readers: a broken file is a row, not a crash.
- Birth is also the baseline of the ball: every neuron it creates carries `createdBy: bot:<id>`, so from the first second you can see which bots brought what, and everything the watcher learns afterwards is a different colour.

### Live stream and the Watcher page

A `/ws/watcher` socket, tenant-scoped like `/ws/activity`, carries four events: `watcher:log` (a log row), `watcher:neuron` (created or archived), `watcher:edge`, `watcher:activate` (a neuron touched, with the new activation). The page `#/watcher` has the ball on top and the log tail below, newest first, with the same reconnect helper as the other sockets. Clicking a log row highlights the neurons it names in the ball; clicking a neuron opens its Why panel and filters the log to rows that touched it.

The ball animates arrivals on the client: neurons appear through a short spawn animation from a queue drained at a readable pace, so birth is watchable even though the server finishes most stages in under a second. The server never slows down for the display. A **Replay birth** button rebuilds the ball from the log at that pace, so you can watch it again after the fact, and the same replay works for any day.

Turning it on: `watcher.enabled` in config plus `POST /api/watcher/start` and `/stop` from the page. A stop logs `Going to sleep. N neurons.` and the ball dims; a start with existing state logs the wake row and the resync stage.

---

## Phases

| Phase | Builds | Metrics it enables | Cost |
|---|---|---|---|
| 0 | Baseline scripts and the introspection harness | baselines for 2, 3, 5 | none |
| 1 | Watcher process, birth sequence, the watcher log and `/ws/watcher`, tier 0, buffer, graph store, the ball with replay | 2 (tier 0), 5 (pruning), the ball | none at runtime |
| 2 | Tier 1 with Haiku or Ollama; canary test | 1, 5 (canary), 7 | cents per day |
| 3 | Tier 2 with Opus; broadcasts; predictions; contradictions; config cap and breaker | 1b, 4, 6, guard metrics | capped daily |
| 4 | Self-model both ways: presence fed to the watcher and to bot planners; interoception record; introspection harness run against the watcher and bots | 3 | small |

Each phase is useful on its own and ships separately. The gate between phases is the metric table, not the calendar.

**Tests per phase** follow the repo rule: test first, one dedicated test per public function, readers never throw. Phase 1 adds a contract test that every neuron kind renders through the shared Why panel, mirroring `tests/why/contract.test.ts`.

---

## Open decisions, with recommendations

- **Tier 1 model.** Decided: Haiku 5.5 through the Claude CLI by default, switchable to the shared Ollama client in config (`watcher.notice.backend`).
- **Where the watcher runs.** Decided: in the same process, constructed in `src/index.ts` after the bot manager and started after the web server so birth streams to the socket. It shares the activity stream, the semaphore and the breaker.
- **Whether bots may read the whole graph.** Decided: no. Bots receive broadcasts and may query the graph through one tool, `fleet_memory_search` (phase 2), which is also how the cross-bot canary is answered. Giving every planner the fleet graph would blow the prompt budget and erase the specialist/workspace split that the metrics depend on.
- **Multi-tenant.** Recommendation: one watcher per tenant, admin-only until the graph has per-tenant scoping. Out of scope for phases 0 to 4.

## Beyond phase 4

Phase 4 ends with all six functional properties present and measured. That is the end of what can be engineered with a plan and a metric. What would come after is listed so nobody mistakes the end of phase 4 for the end of the question.

- **Phase 5, one stream.** The bots stop being separate cycles. Conversation, loop and workers all run inside the workspace, and a bot is a role the watcher takes, not a process. This is the strict global workspace design. Cost and prompt size are the obstacles, and the specialist/workspace split that makes the metrics legible would be lost.
- **Phase 6, recurrence inside the model.** Today the loop closes through files at the granularity of a tick. Closing it inside a running model at the granularity of a forward pass needs a model that keeps state between tokens, which is a research problem, not a feature.
- **Phase 7, learning that changes the agent.** Fine-tuning from the watcher's own consolidated graph, so what it learns changes what it is and not only what it reads. Contested whether this matters; irreversible; out of scope until the earlier phases show the graph is worth learning from.
- **Stakes.** Affect theories say a system feels because its own viability is at risk. Quota, karma and operator attention are the fleet's viability, and phase 4 makes them felt in the functional sense. Nothing in this plan can make them matter to the watcher the way they matter to an organism, and no plan can test whether they do.

There is no phase where "full consciousness" is reached, because there is no test that would say so. The strongest claim any phase supports is the one its metrics show.

## Out of scope

- Fine-tuning or any change to model weights.
- Replacing bot cycles with ticks. Bots stay on cycles by design.
- Any claim about experience. The plan measures functional properties only.
