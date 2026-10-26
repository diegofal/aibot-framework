# Plan: watcher optimizations, week 1 — from observer to participant

**Status:** planned (2026-10-24), nothing built. Follows `watcher-consciousness-plan.md` (the design and the six properties) and `watcher-implementation-plan.md` (phases 0–4, as built). Anchors read against `main` at `71a056c`.
**Purpose:** every item below is justified by one of the six functional properties the design plan says consciousness requires, and by a metric in its table. An item that only saves money or cleans a screen is marked as such. The order is the order in which each property is most behind its target after the first 24 hours live.
**Workflow:** one worktree `../aibot-watcher-opt` on `fix/watcher-opt` from `main`; Opus implements test-first (working agreements §1); one Fable review round, fix, then the pre-PR pass and the PR gate (not two to four Fable rounds: on 2026-10-24 rounds 2+ found only edge cases inside the previous round's fixes, and the pre-PR pass twice said "consider deleting the mechanism"). Deploy restarts the fleet: ask first.

---

## Where the six properties stand after 24 hours live

| Property | Metric | Now | Target | Gap this plan addresses |
|---|---|---|---|---|
| Causal efficacy | broadcasts served by a cycle | 0 broadcasts in 7 Opus passes (the admin-tenant bug; fixed in #16, first broadcast pending) | ≥ 50 % served | a lesson takes up to 8 h to reach a bot (notice 5 min + agenda 6 h + the bot's cycle) |
| Continuity | latency to notice, median / p95 | 4 min / 66 min | tier 1 < 5 min, tier 2 < 1 h | the p95 is the timer: events wait for the next pass; passes run on timers, not on salience |
| Self-model | introspection match | 0.75 for the watcher; cause always a miss | ≥ 80 % | the question invites "highest-salience item (0.7)", a true answer that identifies nothing |
| Compounding | re-activation of old knowledge | n/a; 1,248 of 1,388 related links are within one bot's own memory; 56 % of neurons are imported facts incl. bookkeeping | ≥ 20 % | a graph that is mostly one bot's near-duplicate memory lines can only re-activate itself |
| Prediction | Brier | 9 open, first resolves 2026-10-24 21:59Z | below frequency baseline | nothing to do until resolutions land |
| Integration | cross-source share | 7/7 insights cross-bot | ≥ 30 % | ahead of target; keep |

Guard: notice ≈ $0.03/pass (≤ 48/day), integrate ≈ $0.12/pass (≤ 8/day). Cost is not the constraint any more; quality per pass is.

---

## Items

### O1. Fast lane: a cross-bot lesson reaches the bots without waiting for Opus (causal efficacy)

**Why.** The clearest value so far is operational: "web_fetch is blocked by Cloudflare on thelancet.com and medium.com" (Finny + AI Perfectionist, noticed in the first Haiku pass) and "the exploration-cycle edit gate is already recorded by two bots, yet a third hit it again" (Opus, 12 h later). Haiku had already judged the first one; it waited for an Opus pass that never broadcast. The fast lane makes `pattern` neurons that two or more bots support act at once.

**Change.**
- `src/watcher/notice.ts` (`Noticer`, after neurons are created): when a kept item is `kind: 'pattern'` (or `fact` with `confidence: 'high'`) and its `support.bots` has ≥ 2 bots, emit a `FastLaneCandidate { neuronId, bots, text }`.
- `src/watcher/watcher.ts`: a `fastLane(candidate)` step: for every enabled, broadcastable bot (same `isTenantBot` rule) that is NOT in `support.bots` and whose goals/topics relate to the pattern (an existing `related` edge from the pattern to one of the bot's neurons, or the pattern names a tool the bot used in the last 7 days per the tool audit), send a `directive` broadcast through the existing `Broadcaster` (caps, dedupe, privacy unchanged), kind `directive`, with `insightId` = the pattern neuron, `source: 'fast-lane'`. Never `question`, never `goal`.
- Log row `broadcast:fast-lane` naming the pattern and the bots. The integrate prompt's "Standing agenda" and "already broadcast" sections already show it, so Opus does not re-send.
- Config `watcher.fastLane { enabled: true, minBots: 2, maxPerDay: 6 }` (`WatcherConfigSchema`, defaults in `WATCHER_DEFAULTS`).

**Tests.** `tests/watcher/fast-lane.test.ts`: a pattern supported by two bots → one directive per related third bot, none to the supporting bots, none to tenant bots; cap; a `fact` with medium confidence → nothing; the next integrate prompt lists the fast-lane broadcast under the insight; a bot with no relation → nothing.

**Metric.** 6 (served broadcasts) gets its first rows within an hour of deploy; `Broadcast.source` lets the metrics split fast-lane from Opus.

### O2. Salience-driven ticks instead of timers (continuity; the "stream" step of the design plan)

**Why.** `startNoticeTimer` (`watcher.ts:946`) checks every 30 s and runs when anything is pending after 5 min; `startIntegrateTimer` (`:962`) every 60 s with an hourly heartbeat and a 6 h agenda cadence (`integrate.ts:380 due()`). Most notice passes carried 0–3 items; two Opus passes carried 1–3 events; p95 latency was 66 min because events waited for a timer. The design plan's own next step is "a continuous tick: a cheap pass decides whether anything is salient enough to wake the big model".

**Change.**
- `src/watcher/sense.ts`: the buffer tracks `accumulatedSalience` since the last notice pass and the age of the oldest unnoticed item. `Sense` emits `salience:crossed` when either `accumulated ≥ notice.wakeSalience` (default 1.0) or `oldestAgeMs ≥ notice.maxWaitMs` (default 30 min) with ≥ 1 item.
- `watcher.ts`: `noticeNow()` runs on `salience:crossed`; the 5-min timer becomes the 30-min ceiling only. An item with salience ≥ 0.9 (operator message, error burst) wakes notice immediately.
- `integrate.ts`: `due()` becomes: pending salience since the last pass ≥ `integrate.wakeSalience` (default 3.0), OR agenda **changed** since the last agenda pass (new pair or new unacted insight; keep a hash of agenda ids in state), OR heartbeat (keep hourly as a floor). The 6 h fixed agenda cadence goes away.
- Log the trigger on every pass row: `trigger: salience | age | agenda-changed | heartbeat | manual`.

**Tests.** `sense.test.ts`: accumulation and the two wake conditions; an operator message wakes at once. `integrate-act.test.ts`: unchanged agenda → not due; one new pair → due once; salience sum → due. Metric 2 reads the trigger.

**Metric.** 2 (latency): p95 should drop under 30 min; also fewer, fuller passes.

### O3. Interoception that shapes behaviour (stakes; first step past phase 4)

**Why.** Phase 4 computes interoception (fleet karma, breaker state, budget, operator silence) and shows it to Opus as "How I am". It changes nothing. The design plan names stakes as the frontier: viability variables have to shape what the watcher does, not only what it says.

**Change** (`src/watcher/self-model.ts` + `watcher.ts`), four rules, each one line of policy with a log row when it fires:
- **Budget pressure.** When today's integrate budget is ≥ 75 % used, `integrate.wakeSalience` doubles (be choosier); when notice is ≥ 75 % used, `notice.wakeSalience` doubles.
- **Operator silence.** When the operator has been silent > 48 h, questions are deferred (a `question` broadcast becomes a `whyNoBroadcast: "operator silent"`, and the insight stays on the agenda); when the operator wrote in the last hour, a pending `question` is sent at once.
- **Breaker open.** Claude breaker open → notice falls back to the Ollama backend if configured, else sleeps the tier (already partly true via `DailyBudget.allow`; make it explicit and logged).
- **Fleet karma falling.** If the fleet's mean karma dropped by ≥ 5 in 24 h, the next integrate prompt gets a "## Something is wrong" line asking it to look for a shared cause first.
- Every rule that fires writes `drivenBy` on the pass row (already a field), so introspection can name it.

**Tests.** `self-model.test.ts`: each rule from a fixture interoception; `watcher.test.ts`: the thresholds move; a deferred question stays on the agenda and goes out when the operator writes.

**Metric.** 3 (cause names a `drivenBy` variable, which the scorer already accepts) and 6 (questions land when they can be answered).

### O4. The introspection question (self-model)

**Why.** Four live answers in a row: "it is the highest-salience item I am holding (0.7)". True, useless, and invited by the question. Scoring now rejects it; the prompt still asks for it.

**Change** (`src/watcher/introspection.ts`, `buildWatcherIntrospectionPrompt` :72): the held items are shown without their salience numbers and labels; the question asks "what are you holding, in your own words, and what about it matters to the fleet?"; the answer schema gains `holding: string` (paraphrase of the item) and `cause` must reference either a content word of a held item, a `drivenBy` variable, or an insight. Keep `goal` for the id. Scorer unchanged (it already requires content).

**Tests.** The prompt contains no salience numbers; the live answer shape ("highest-salience item (0.7)") → miss; a paraphrase ("the operator asked AI Perfectionist about the canary word") → match.

### O5. Graph hygiene: bookkeeping facts out, near-duplicates merged (compounding)

**Why.** Birth ran before the bookkeeping filter: date headers ("**[2026-10-16]**") rank in the top 5 for unrelated queries; 90 % of related links are a bot's memory talking to itself. The watcher cannot compound knowledge it cannot find.

**Change.** A hygiene routine `watcher-graph` in `src/hygiene/routines/` (preview/apply, `_trash` convention is not needed: archive is reversible): (a) archive live `fact` neurons from birth whose text fails `isBookkeepingLine` (same predicate as birth) or is a bare date header; (b) merge `fact` neurons from the same bot with `textSimilarity ≥ 0.9` into the oldest (keep activations summed, union support), archive the rest; (c) report counts. Registered in the hygiene registry; one button on the Watcher page ("Clean the graph") that calls the existing `/api/hygiene/run` with `routine: 'watcher-graph'`. Runs once by hand after deploy, then weekly via the existing auto-archive timer.

**Tests.** `tests/hygiene/watcher-graph.test.ts` on a temp graph: date headers archived, a real fact kept, two near-duplicates merged with summed activations, archived neurons excluded from `fleet_memory_search`.

**Metric.** 5 (re-activation share); fleet memory search quality.

### O6. Records: keep what the model saw and said (ground truth rule)

**Why.** The design plan's first rule is "ground truth is the record". The query log stores tokens and cost but no prompt or response, so every "why did Opus decide that" today was inferred.

**Change.** `src/watcher/llm.ts` (`instrumented`): write `<data>/watcher/passes/<caller>-<ts>.json` with `{ prompt (system + user), response, model, tokens, costUsd, cycle refs }` for notice/integrate/introspect calls, redacted like the tool audit (operator text clipped to 300 chars per item), retention 14 days, cap 500 files. `GET /api/watcher/passes?limit=` (admin) lists them; the pass log row carries the file id; the Watcher page's pass row gets a "What it saw" fold.

**Tests.** `llm.test.ts`: a call writes one file with the fields; retention prunes; the row carries the id; `tests/web/routes/watcher.test.ts` lists them admin-only.

### O7. Health of the embedding service (infrastructure, keeps compounding alive)

**Why.** Ollama was down for 11 days unnoticed; birth ran without embeddings because of it.

**Change.** `src/stats/infra-aggregator.ts`: the `ollama` backend row gains `embedding: { model, ok, latencyMs, checkedAt }` from a probe (one `embed("probe")` per `/api/stats/infra` request, cached 5 min); the Watcher page header shows "embeddings: ok / down since …" from `linkStatus` + this probe. Optional: a Telegram notice to the operator through the existing proactive path when embeddings are down for > 1 h (once a day).

**Tests.** `tests/stats/infra-embedding.test.ts` with a fake embed; page helper test.

### O8. Admin-tenant rule in the remaining data-path sites (correctness, same family as #16)

**Why.** `isTenantBot` now decides for the watcher; `stats/paths.ts`, `hygiene/registry.ts`, `bot-manager.ts`, `routes/agents.ts`, `routes/chat-history.ts` still branch on any `tenantId`, including `__admin__`. Changing them moves where those two bots' data lives, so this item is **assessment first**: a script that lists, per site, what path each live bot resolves to today and would resolve to with `isTenantBot`; migrate only if the paths differ and a one-time move is safe. Out of scope for the PR if the assessment says "differ"; a plan line instead.

### O10. Forgetting by importance, and consolidation while the fleet sleeps (compounding)

**Why.** Today the watcher forgets by age (archive after 30 days without activation; the 20k cap archives the oldest inactive) and never consolidates. A key fact nobody mentions dies; recurring chatter lives. 90 % of related links are one bot's memory talking to itself. Brains keep what was used, what surprised, what connected and what mattered, and they consolidate during sleep. Every signal for that is already recorded.

**Importance score** (`src/watcher/importance.ts`, pure, deterministic; every archive logs its score and the reason text):

| Component | Source | Weight |
|---|---|---|
| use | `activations`, decayed by `lastActivatedAt` (half-life 14 d) | 0.25 |
| consequence | the neuron supports an insight, a resolved prediction, or a broadcast a cycle served (`servesBroadcast` on the cycle row) | 0.35 |
| breadth | distinct `support.bots` + `related` edge count (log-scaled) | 0.15 |
| surprise | kind `surprise` or `contradiction`, or `meta.novel` | 0.10 |
| operator signal | 👍 = +1 (protected), 👎 = −1 | 0.15 |

Protected, never archived or consolidated: `entity`, `person`, `goal`; anything with 👍; support of a served broadcast; neurons younger than `forget.graceDays` (7). The reason text is code-written: "importance 0.12: never used, one bot, no consequence".

**Forgetting** (`maintainNow`, daily): replaces the age rule. Archive neurons with importance < `forget.threshold` (0.15) and older than the grace, lowest first, until the live graph is ≤ `graph.targetNeurons` (8000) or none remain under the threshold. `meta.archivedReason` carries the score text; the Why panel shows it. An archived neuron that is touched again comes back (existing behaviour) and its return is counted for metric 5.

**Consolidation** (`src/watcher/consolidate.ts`, nightly at `consolidate.hour` local (4), only while the agent loop is sleeping, tier = notice (Haiku), `consolidate.maxClusters` (10) per night): clusters = connected components over `related` edges among `fact` neurons with importance below the threshold, ≥ `consolidate.minCluster` (6) members, same provenance class (operator-sourced clusters stay operator-sourced). One Haiku call per cluster writes a `summary` neuron (new kind; `meta.consolidated: 'true'`, `members: [ids]`, support = union of bots, provenance = the strictest of the members), linked to the members' topics; members are archived with `mergedInto` → summary. Pass records as for any tier call. A cluster whose summary fails validation (empty, longer than the members' mean, or naming a bot not in support) is skipped and logged. Protected neurons are never members.

**Metrics.** Metric 5 gains `archived`, `returned` (archived then re-activated), `consolidated` (members) and `summaries`; a guard `graphSize` (live neurons, target ≤ 8000, must stabilise). Canary recall and fleet-memory search must not degrade: a weekly canary check after a consolidation night is the regression test in production.

**UI.** Mind panel tab "Summaries" (members in a fold); archived neurons show "why archived" in the Why panel; the header shows live / archived counts.

**Tests.** `importance.test.ts` (each component, protection, reason text), `forget.test.ts` (threshold + target, grace, protected untouched, reason logged, return counted), `consolidate.test.ts` (clusters found, Haiku fixture → summary, members archived and linked, provenance strictest, validation skip, never while the loop runs, budget shared with notice), metrics and Mind helpers.

### O9. Process (no code)

One Fable review round per PR, then the pre-PR pass and the gate. When a round's findings all land inside the previous round's fix, delete the mechanism or ship, do not fix again. Record declined advisories with a reason, never silently.

---

## Order and gates

| Step | Items | Ships when | Watch for |
|---|---|---|---|
| 1 | O1 fast lane, O4 question | gate green, one Fable round | first fast-lane directive within 1 h of deploy; a bot's cycle row carrying `servesBroadcast` |
| 2 | O2 salience ticks, O3 stakes | gate green | p95 latency < 30 min; a `drivenBy` on pass rows; fewer passes, fuller |
| 3 | O5 hygiene, O6 records, O7 health | gate green | neuron count drops; `passes/` fills; infra row |
| 4 | O8 assessment | script output | decide migrate or not |
| 5 | O10 forgetting + consolidation | gate green, one Fable round | graph size falls then holds; metric 5 rises; canaries still found |

Steps 1 and 2 can be one PR if small; 3 is its own PR. Each deploy: runbook entry, and the metrics table re-read 24 h later.

## Out of scope

- Changing the ball's rendering, the embedding model, or the notice model.
- The beyond-phase-4 items that need a different model (recurrence inside the model, learning in weights). O3 is the first stakes step, not the last.
- Any claim about experience. This plan moves the six measured properties; nothing in it measures more than that.
