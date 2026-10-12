# Plan: "Why this?" everywhere

**Goal.** Everything the dashboard shows that an agent (or the system acting on it) produced or
decided says where it came from, in one consistent fold, so the operator can judge it without
digging: what produced it, the cycle and goal behind it, the stated reasoning, the rule that
fired, what happened to it.

**Starting point.** Dispatch cards have it since `285b768` (`dispatchWhy` in
`web/pages/curiosity-helpers.js`, `Dispatch.origin`, `src/bot/curiosity/origin.ts`). This plan
turns that into a shared model and component and applies it to the 17 other surfaces an audit
found (three read-only agents, 2026-10-11; key claims spot-checked, see "Verified").

## Principles

1. **Recorded fact, never after-the-fact narration.** A Why is assembled from what was written
   when the thing happened (cycle log, tool audit, goal events, editor notes, the strategist's own
   words). No LLM is asked later to explain something. Where nothing was recorded, the fold says
   so ("No record of the cycle that produced it").
2. **One model, one component, one order.** Server builders return the same `Why` shape; the
   client renders it with one helper. Rows always appear in the same order and only when they
   have data.
3. **Inferred is labelled.** Anything reconstructed (cycle matched by time, digest sources)
   carries `inferred` and the fold says how it was matched.
4. **The cycle is the hub.** Almost every Why points at an agent-loop cycle; "Open cycle" opens
   one shared cycle sheet (plan, goal, LLM calls, tools, files, asks, karma) from anywhere.
5. **Cheap lists.** List endpoints embed the compact `Why` (ids and short strings). The heavy
   cycle detail is fetched only when "Open cycle" is clicked.

## The shared model

`src/why/types.ts`:

```ts
export type WhyActor =
  | 'agent' | 'strategist' | 'navigator' | 'curiosity' | 'reflection'
  | 'lint' | 'hygiene' | 'operator' | 'cron' | 'peer' | 'system';

export interface WhyCycle {
  id: string;
  botId: string;
  startedAt?: string;
  plan?: string;          // what the cycle set out to do (capped)
  mode?: 'explore' | 'exploit';
  modeReason?: string;
  inferred?: boolean;     // matched by time, not recorded
}

export interface Why {
  what: string;                                // one line: what produced this
  by?: WhyActor;
  cycle?: WhyCycle;
  goal?: { id?: string; title: string };
  reason?: { text: string; source: string };   // stated reasoning + who stated it
  rule?: string;                               // deterministic rule that fired, plain words
  related?: { label: string; items: Array<{ text: string; at?: string; href?: string }> };
  outcome?: string;                            // one sentence: what happened to it
  notes?: Array<{ label: string; text: string }>;
  missing?: string;                            // what we cannot know, said plainly
}
```

`WhySchema` (Zod, same file) validates it in tests.

Rendering order (fixed): **What · By · Goal · Working on (+ Open cycle) · Mode · Reason · Rule ·
Related · Outcome · Notes**, then a dim footnote for `inferred` / `missing`. The summary line is
`Why this?` + the shortest useful gist (goal head, else rule, else actor), clipped to 60 chars.

## Shared pieces (phase 0)

| Piece | File | What |
|---|---|---|
| Model | `src/why/types.ts` | `Why`, `WhyCycle`, `WhyActor`, `WhySchema` |
| Cycle index | `src/why/cycle-index.ts` | `CycleIndex` over `<data>/agent-cycles` (reader: `src/stats/readers/agent-cycles.ts`): `byId(botId, cycleId)`, `atTime(botId, iso)` (the containment match now in `curiosity/origin.ts`), one read per bot per request; `toWhyCycle(row)` |
| Builders | `src/why/builders/*.ts` | One pure function per surface: record → `Why`. The dispatch one replaces `inferOrigin`'s output shape (`origin.ts` stays the matcher) |
| Cycle detail | `src/stats/cycle-detail.ts` + `GET /api/agents/:id/cycles/:cycleId` in `src/web/routes/agent-home.ts` | Extract the per-cycle assembly out of `buildGoalDetail` (`src/stats/goal-detail-aggregator.ts:463`, `GoalCycle` in `src/stats/types.ts:471`) so both the goal drawer and the new route use it. Tenant-scoped, cache 15 s |
| Component | `web/ui/why.js` (exported from `web/ui/index.js`) | `whyPanel(why, { nowMs })` → the `<details class="why">` fold; `clip`, row order, footnotes |
| Cycle sheet | `web/ui/cycle-sheet.js` | `openCycleSheet(botId, cycleId)` over `web/ui/sheet.js`; renders with the goal drawer's cycle markup (moved from `web/pages/goal-detail-helpers.js` into a shared helper). One delegated click handler in `web/app.js` for `[data-open-cycle]`, so every page gets it for free |
| CSS | `web/style.css` | `.why*` classes replace `.curio-origin*` |
| Migration | `web/pages/curiosity-helpers.js` | `dispatchWhy` becomes `whyPanel(dispatchToWhy(d))`; the existing dispatch tests keep passing unchanged (contract) |

Tests: `tests/why/cycle-index.test.ts`, `tests/why/builders/dispatch.test.ts`,
`tests/stats/cycle-detail.test.ts` (goal-detail tests stay green: the extraction is a refactor),
`tests/web/routes/cycle-detail.test.ts` (404 across tenants), `tests/web/why.test.ts` (row
order, escaping, clipping, inferred/missing footnotes, omitted empty rows).

**Consistency test** (`tests/why/contract.test.ts`): a registry `WHY_BUILDERS` lists every
surface builder with a fixture; the test runs each, validates the result with `WhySchema`, and
renders it with `whyPanel`. Adding a surface without registering it fails a grep check over
`web/pages/*.js` for `<details class="why"` outside `web/ui/why.js`.

## Surfaces

**Data** = is the provenance already written to disk? **Capture** = what has to start being
recorded. S/M/L = effort.

### Phase 1: data already recorded, display only

| # | Surface | Data today | Change | Effort |
|---|---|---|---|---|
| 1 | **Needs You** (questions, productions, permissions in one list) | asks and production rows carry `cycleId`/`goalId` (`src/bot/ask-human-store.ts:19-35`, `src/productions/types.ts:53-55`); `NeedsYouItem.meta` drops them (`src/web/routes/needs-you.ts:94-101`, `buildAsks` `:430`, `buildProductions` `:680`) | add `why` to `NeedsYouItem` via builders `askToWhy` / `productionToWhy`; render with `whyPanel` in `web/pages/needs-you-helpers.js` | S |
| 2 | **Inbox threads** (ask_human) | conversation carries the ids (`src/conversations/service.ts:32-34`) | same `askToWhy`; `web/pages/inbox.js` thread header | S |
| 3 | **Productions page** | changelog rows carry the ids | `productionToWhy` (cycle that created / last edited the file, its goal, the tool); `web/pages/productions.js` file panel | S |
| 4 | **Dispatches** | done | migrate onto the component (phase 0) | S |
| 5 | **Goal timeline** (goal drawer) | `goal-events.jsonl` has `actor` + `cycleId` (`src/bot/goal-events.ts:59-68`); the aggregator drops `cycleId` and sets `note: null` (`src/stats/goal-detail-aggregator.ts:229-237`) | per-event `why` (actor, cycle, plan, goal op); reason arrives in phase 2 | S |
| 6 | **Agent Home timeline** | tool/LLM/outcome rows carry `cycleId` (`src/bot/tool-audit-log.ts:41`, `src/bot/llm-query-log.ts:35`); `TimelineItem` has no field (`src/stats/agent-home-aggregator.ts:59-65`) and cycle rows come from scheduler `recentActions` | add `cycleId` to `TimelineItem`, group rows under their cycle, cycle rows from the cycle log with goal + plan; one `why` per cycle group | M |
| 7 | **Fleet feed idle lines** | `agent:idle` carries `data.reasoning` (`src/bot/agent-loop-utils.ts:437-453`); the feed ignores it (`web/pages/fleet-home-helpers.js:370`) | show the reason; `why` with the gate rule when it was the engagement gate | S |
| 8 | **Posture** (standby / blocked / idle) | the rule is computed and discarded (`src/stats/posture.ts:36-54`) | `computePostureWithRule` → `{ posture, rule, inputs }` (keep `computePosture` as its `.posture`); `why.rule` in plain words ("5 idle cycles in a row", "no output in 48 h") | S |
| 9 | **Karma events** | events keep `metadata.cycleId` for loop-driven kinds | `karmaToWhy`; `web/pages/karma.js` rows get the fold | S |
| 10 | **Proactive messages the agent sent you** | tool audit has message, recipient, result, `cycleId`/`goalId`; throttle refusals audited as `failureKind: 'policy'` | new list "Sent to you" in the Conversations tab (`web/pages/`… next to Dispatches), built from the tool audit; `proactiveToWhy` | M |

### Phase 2: start recording, then display

| # | Surface | Capture | Display | Effort |
|---|---|---|---|---|
| 11 | **Cycle log row** (feeds 6, 7, 12, 13) | `AgentCycleEntry` (`src/bot/agent-cycle-log.ts:17-34`) gains `reason` (idle reasoning / `skippedReason` such as `circuit-open:claude-cli` / engagement-gate verdict), `strategistRan`, `reflection` (capped 600), `traitAdjustments` | cycle sheet header; idle and skipped cycles in the timeline explain themselves | S |
| 12 | **Goal changes with a reason** | `GoalChange` / goal event gains `reason`: the strategist/navigator op `notes`, goal-lint's outcome text + hygiene `runId`, reflection's source day, the operator's action | goal timeline `why.reason` | S–M |
| 13 | **Trait changes** | strategist prompt asks one short reason per adjustment (`src/bot/agent-loop-prompts.ts:923-928`); `TraitSnapshot` (`src/bot/trait-registers.ts:69`) gains `cycleId` + `reasons`; pinned/locked rejections recorded as such | Agent Home traits: history list with a fold per change (today only a count, `web/pages/agent-home-helpers.js:410`) | M |
| 14 | **Permission requests** | `PermissionRequest` (`src/bot/ask-permission-store.ts:10-21`) + `request()` (`src/tools/ask-permission.ts:87`) store `_cycleId`/`_goalId`; history keeps `executionSummary` as the outcome | Needs You + permission history | S–M |
| 15 | **Agent proposals** | `AgentProposal` (`src/tools/agent-proposal-store.ts:5-29`) stores `cycleId`/`goalId` from `create-agent.ts:207` | `web/pages/agent-proposals.js`: justification becomes `why.reason` | S |
| 16 | **Cron jobs and runs** | `CronJob` (`src/cron/types.ts:42-53`) gains `createdBy { botId, cycleId, goalId }` (tool path `src/tools/cron.ts`) or `operator` (dashboard path); run rows and the synthetic message id carry `jobId` | Automations page: per job "created by", per run the reply it produced | M |
| 17 | **Collaboration** | `collab:*` events and the karma outcome carry the initiating `cycleId` and the opening message (`src/bot/collaboration.ts:59,389,501,534,612,725`) | fleet feed collab lines | M |
| 18 | **Feedback replies** | `markApplied` (`src/bot/agent-loop.ts:2696-2704`, `src/bot/agent-feedback-store.ts:147`) stores the `cycleId` that handled it | feedback page: "handled in cycle …" | S |

### Phase 3: new logs

| # | Surface | Capture | Display | Effort |
|---|---|---|---|---|
| 19 | **Navigator direction history** | append each direction to `<soul>/DIRECTIONS.jsonl` (today overwritten, `src/bot/curiosity/navigator.ts:437`) with `learned`/`surprised` (computed, never stored, `:243-246`) and what triggered the run; frontier items record the run that added them and why one was dropped (`:396`, `:404-414`) | Mind section: previous directions, frontier item folds | M |
| 20 | **Soul / memory edits** | `<soul>/soul-events.jsonl` in the style of `goal-events.jsonl`: memory consolidation (what merged, what dropped — `src/bot/soul-memory-consolidator.ts:288-312`), memory flush (facts written, from which conversation), hygiene fixes (`runId`) | Agent Home → Memory: a history with folds | L |

## Order and size

Phase 0 first (everything depends on it), then phase 1 in table order (Needs You first: one
panel covers three item kinds), then 11 (unblocks 12, 13 and the idle/skip reasons), then the
rest of phase 2, then phase 3. Each numbered row is its own worktree and merge, with its tests,
CHANGELOG entry and docs (`CLAUDE.md` tables, `docs/architecture-docs/`) in the same change.

Rough total: phase 0 ≈ 1 day; phase 1 ≈ 2 days; phase 2 ≈ 2–3 days; phase 3 ≈ 2 days.

## Decisions (recommendation first)

1. **Embed `why` in list responses** (recommended) vs. fetch on expand. Embedding keeps the fold
   instant and the code uniform; the cost is one cycle-log read per bot per list request, which
   the dispatch route already does. The full cycle stays on demand.
2. **The cycle sheet is the one deep link** (recommended): `[data-open-cycle]` anywhere opens
   it; the goal link keeps going to the agent's home. This also closes the "no deep link into
   the goal drawer" gap from the dispatch work, since the sheet shows the goal.
3. **The strategist states reasons for goal ops and trait changes** (recommended): one short
   field each in its JSON. Without it, rows 12 and 13 can only show *who* and *when*, not *why*.
   Cost: a few dozen output tokens per strategist run.
4. **Legacy data is matched by time where a cycle log exists** (since 2026-10-06), otherwise the
   fold says there is no record. No backfill job.
5. **Phase 3 row 20 (soul/memory events)** is the largest and least visible; recommended last,
   and it can be cut without affecting the rest.

## Out of scope

- Changing what agents decide or how often they act; this only records and shows why.
- LLM-written explanations of past events (principle 1).
- Backfilling records that were never written.
- Telegram: dispatches and asks sent there keep their current text; the Why lives in the
  dashboard.

## Verified while planning

Spot-checked on `main` at `285b768`: asks and productions carry `cycleId`/`goalId`;
`ask-permission-store.ts`, `agent-proposal-store.ts`, `cron/types.ts` and `collaboration.ts`
have no `cycleId`; `computePosture` returns only the word; `TimelineItem` has no cycle field;
`GoalCycle` (`src/stats/types.ts:471`) already holds the per-cycle detail the sheet needs. The
other anchors come from the audit and are re-checked when each row is picked up.
