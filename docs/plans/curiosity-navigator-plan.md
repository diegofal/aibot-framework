# Plan: curious bots — the navigator, the knowledge map, and the dispatch

**Status:** implemented (2026-10-03), C0–C8 done; not committed, pending deploy (`docker compose up -d --build`). See the Status table at the end. Sections below describe the design as built; where the original proposal differed, the implementation wins and the text says so.
**Scope:** `src/bot/curiosity/` (new package: types, config, knowledge-map, store, cycle, directives, taste, dna, extractor, navigator, dispatch, runner, loop-wiring, service), `src/bot/agent-loop.ts`, `src/bot/agent-loop-prompts.ts`, `src/bot/agent-strategist.ts`, `src/bot/bot-manager.ts`, `src/config.ts` (`CuriosityConfigSchema`), `src/web/routes/curiosity.ts`, `src/web/routes/agents.ts`, `web/pages/curiosity*.js`, `web/pages/dispatches.js`, `web/pages/agent-home.js`, `web/pages/agents.js`, tests, docs.
**Principle:** curiosity and insight are DNA, not a preset. Every bot gets the navigator, the knowledge map and the dispatch. Per-bot config only decides *how far* a bot may roam and *how often* it explores.

---

## Goal

A bot should get smarter about its world over weeks, follow what surprises it, and bring back findings good enough that the operator looks forward to them. "Addictive" comes from insight density and from reliable surprise. Hype, volume and clickbait don't count.

Three questions every bot must be able to answer at any time:
1. **What have I learned?** (knowledge map)
2. **What surprised me, and what don't I know yet?** (frontier)
3. **Where am I going next, and why?** (navigator direction)

---

## Diagnosis (2026-10-03, AI Perfectionist live soul)

- The strategist's only view of the past is 7 days of raw daily logs (`agent-strategist.ts:216`). Nothing builds up a running record of what the bot has learned, so the most recent topic dominates every strategic review.
- Novelty is checked by **action type** (CONTENT/RESEARCH/…) and by **exact action repeat**, never by **topic**. 10 of 18 productions are harness eval or the bot's own tooling. Each was a "new" action.
- The prompts punish divergence. `agent-loop-prompts.ts:312-317` says "exploration ONLY within stated purpose / if unsure choose inaction". A low `alignment_confidence` retries the strategist at **temperature 0** (`agent-strategist.ts:144`). When the operator is silent, "production without feedback is waste" leaves two options: ask, or obey the last directive.
- Directives never expire. A 15-day-old message ("research Jev use cases") became the permanent route.
- Most closed goals are bookkeeping about the bot itself (send log, inbox plumbing, note-writing rules).
- Outputs are written for the bot itself: long, measurement-heavy, defensive. They are not written to catch a reader.
- Side issues to verify before building: 6 `ask_human` asks pending since 09-16 with the 72 h auto-close apparently not firing, and the bot reports it has no tool to read operator replies.

---

## Design

### 1. Knowledge map — `KNOWLEDGE.json` in the soul dir (every bot)

A distilled, persistent model of the bot's domain, stored as JSON (`KnowledgeMap` in `curiosity/types.ts`; atomic writes via `CuriosityStore`). It lives in the soul dir, so it travels with the export. Each topic records:

- `name`, `depth` (0–3), `firstSeen`, `lastTouched`, `cycles`, `outputs` (productions/paths that support it)
- **findings**: claim + evidence + confidence (`low`/`medium`/`high`)
- **surprises**: things that contradicted what the bot expected
- **open questions**

The same file holds the **frontier** and the bot's grown **interests**. Caps (`KNOWLEDGE_CAPS`): 40 topics, 20 findings, 10 surprises, 8 open questions and 20 outputs per topic, 30 frontier items, 12 interests. Updated by a **post-cycle extractor** (one LLM call after every non-idle executor run, on the planner backend; `mergeExtraction` dedupes at `textSimilarity ≥ 0.8`) and pruned on every merge. A rendered slice (`renderKnowledgeForPrompt`) goes into the strategist, planner and navigator prompts; raw daily logs stay as secondary context.

### 2. Frontier — candidate directions

Generated from the map's surprises and open questions, plus adjacent fields the navigator proposes. Each item has:

- `question`, `whyInteresting` (expected surprise / information gain)
- `bridge`: one sentence on how it connects to the bot's purpose. An item without a bridge crosses the `purpose` dial (there is no `roam` setting; the limit dials in §7 replaced it).
- `distance`: hops from the core topics (0 = core, 1 = adjacent, 2+ = far). Distance ≥ 2 crosses the `topic` dial.
- `surpriseScore` (0–1), `status` (`open` / `exploring` / `explored` / `dropped`)
- `operatorSignal`: `up` / `down` / none. `up` approves an item gated by an `ask` dial; `down` always blocks it.

### 3. Navigator — new layer above the strategist

Runs every `navigatorEvery` (default `1d`; also on the first curious cycle), inside `beginCuriosityCycle` before the strategist. It runs a retrospective over the knowledge map, the frontier, the directives, the taste profile, the last dispatches and the cycle log:

> what did I do · what did I learn · what surprised me · what changed in how I see the domain · what landed with the operator · where next

Output: a **direction** (up to 3 bets, each tagged exploit or explore) stored with the rest of the navigator state in `NAVIGATOR.json` (direction, directives, cycle log, `cyclesSinceExplore`, `noSurpriseStreak`), plus frontier adds/drops, served directives, interests (per the `identity` dial) and goal operations (closing self-referential bookkeeping goals). Temperature 0.7, retry at 0.3. `lastNavigatorAttemptAt` records every attempt: after a failed one the navigator backs off min(`navigatorEvery`, 2 h) (`NAVIGATOR_RETRY_MS`) instead of retrying every cycle. The strategist turns the current bet into the next single deliverable. Three levels: navigator (days) → strategist (hours) → executor (steps).

As built it does not reuse `src/skills/reflection/`; the navigator is its own LLM call in `curiosity/navigator.ts`.

### 4. Curiosity as mechanics, not as a slogan

- **Explore budget**: a share of cycles (`exploreRatio`, default 0.25) is an *exploration cycle* (one every `round(1/ratio)` cycles; half that period while the operator is silent). It picks the frontier item with the highest expected surprise that the limit dials allow (`selectFrontierItem`; operator 👍 +0.2, items from the dominant topic −0.2, taste ±0.3; items already `exploring` stay selectable at +0.1 and render as "in progress", so nothing is stranded). An exploration cycle does **not** force a strategist pass: the strategist keeps its own cadence; when it happens to run on an explore cycle it gets the DNA block and `skipAlignmentRetry`, and when it does not the planner focus becomes `EXPLORATION: <frontier question>`. Cycles that are idle or whose extraction fails still advance the explore counter (`noteCycle`; the finish step runs for idle cycles too), so the decision never freezes.
- **Topic concentration**: every cycle (not every production) is tagged with the topic the extractor names, in `NAVIGATOR.json`'s cycle log. If more than `maxTopicShare` (default 0.6) of the last `topicWindow` (default 8) cycles share one topic, and the window is at least 75% full, the cycle explores — but only once at least one cycle has passed since the last exploration (`cyclesSinceExplore >= 1`), so a stuck window cannot explore every cycle. This replaces the action-type-only rut check.
- **Surprise as currency**: the post-cycle extractor must answer "what did I not expect?". `noSurpriseStreak` (default 3) cycles in a row without a surprise force an exploration (same `cyclesSinceExplore >= 1` guard); an exploration cycle resets the streak.
- **Directive decay**: directives come only from operator surfaces — answered ask_human questions, dashboard agent feedback, messages from the operator's private Telegram chat (`config.operator.telegramChatId`; `ConversationPipeline.handleConversation` calls `ctx.recordOperatorMessage`) and messages the operator types in a dashboard conversation thread (`POST /api/conversations/:botId/:id/messages` → `BotManager.recordOperatorMessage`). `CuriosityService.recordOperatorMessage` ignores messages under 15 chars and bots with curiosity disabled. Public users (REST, widget, WhatsApp, Discord) never steer; the earlier `HUMAN_INBOUND_HOOK` listener was removed (the event still carries an optional `text`, unused by curiosity). In prompts each directive is clipped to 300 chars and the block stays ≤ 2500 chars (≤ 1500 inside the curiosity block, which is itself capped at 6000 — `CURIOSITY_BLOCK_MAX_CHARS`). Each tracks how many outputs answered it. After `directiveHalfLifeOutputs` (default 3) outputs or `directiveHalfLifeDays` (default 7) days, whichever first, it moves from "steer by this" to "served" (context). A near-identical new message re-anchors it.
- The existing `curiosity` trait becomes meaningful: it scales `exploreRatio` by 0.6×–1.4× (0.5 = unchanged), capped at 0.6.

### 5. The dispatch — insight that catches attention (every bot)

What the operator receives is a **dispatch**. It isn't an artifact dump. Format contract:

1. **Hook**: one non-obvious claim, in one sentence, up front
2. **Why you should care**: tied to the operator's actual work
3. **The evidence**: short, with one link to the full artifact
4. **What to do with it** / what the bot will do next
5. Optional: one question that invites a reply

Rules:
- **Editor gate** before any send: a separate LLM pass (temperature 0.2) scores insight, novelty against the knowledge map, and backing; `score = 0.5·insight + 0.3·novelty + 0.2·backed`, and `backed < 0.5` drops the dispatch. A deterministic hype detector (`findHypeWords`, es/en) docks 0.1 per hit. An insight is sent only with verdict `send` and `score ≥ dispatch.minEditorScore` (default 0.7); otherwise it is `held` for a digest. At most one dispatch per cycle, chained insight → interest proposal → frontier proposal → digest. With the cadence closed an insight is held **without** an editor call (heuristic score: 0.5 minus 0.1 per hype word).
- **Kinds**: `insight`, `proposal` (asks to cross an `ask` dial, or proposes an identity interest; 👍 approves the frontier item) and `digest` (held findings, after `maxIntervalHours` without a send, and at most once per `maxIntervalHours`). Approving an identity proposal adds the `interest` to the knowledge map.
- **Length cap** `dispatch.maxChars` (default 1,200). Depth lives in the linked artifact.
- **Taste model** `TASTE.json` in the soul dir: learned from 👍 / 👎 / "more like this" on dispatches and from silence (a sent dispatch with no signal after 48 h). It records per-topic and per-kind counts and liked/disliked hooks; it does not track length or time of day. The navigator, the editor and frontier ranking read it.
- **Cadence** is earned: 👍/more shrink the interval ×0.75, 👎 grows it ×1.25, ignored dispatches ×1.5, clamped to `[minIntervalHours 4, maxIntervalHours 168]` from `baseIntervalHours` 12. Repeat clicks of the same signal don't compound taste or cadence. A fleet-wide daily cap applies on top: a separate in-memory counter the same size as `operator.proactiveDailyCap` (not shared with `send_proactive_message`, reset on restart). Delivery returns `'telegram' | 'inbox' | false` and the dispatch records `deliveredVia`: the bot's own Telegram instance, else any live fleet instance, to `operator.telegramChatId`; without a Telegram route the dashboard inbox is the channel; tenant bots (multi-tenant) never ping the instance operator's Telegram, only the inbox. Inbox-only dispatches are not counted as ignored. `DISPATCHES.jsonl` is trimmed to the newest 500 (`DISPATCH_KEEP`). Quality over volume, always.

### 6. The DNA — six genes, every bot

| Gene | Behaviour | Mechanism |
|---|---|---|
| **Curious** | chases surprise, not just assignments | post-cycle "what didn't I expect?", surprise ranks the frontier |
| **Compounding** | gets smarter over weeks | knowledge map (findings, confidence, open questions) |
| **Self-directed** | owns its direction, changes course on evidence | navigator; directives get served, then decay to context |
| **Captivating** | brings back things worth stopping for | the dispatch format + editor gate |
| **Honest** | calibrated, backed claims | editor gate rejects claims not backed in the map |
| **Bold** | pushes past its limits as far as config allows | the six limit dials below |

### 7. Limits — six dials per bot, one floor for all

Each dial is `closed` (stays inside), `ask` (proposes crossing it in a dispatch, operator approves) or `open` (crosses it and reports afterwards).

| Dial | Crossing it means |
|---|---|
| `topic` | studies subjects outside its field |
| `purpose` | side quests that do not serve its job, because they would interest the operator |
| `instructions` | challenges the operator's direction ("you asked X, I think Y matters more, here's why") |
| `method` | new output forms: experiments, code, visualisations, debate with another bot |
| `capability` | learns skills, builds tools, asks for access it doesn't have |
| `identity` | lets traits and interests drift with what it learns (pins/locks still win) |

```jsonc
// bots[].agentLoop.curiosity (all optional; global defaults in agentLoop.curiosity)
{
  "preset": "explorer",       // "focused" | "explorer" | "wild" — fills dials not set explicitly
  "limits": { "topic": "open", "purpose": "ask", "instructions": "ask",
              "method": "open", "capability": "ask", "identity": "closed" },
  "exploreRatio": 0.25,       // 0–0.6 share of exploration cycles (scaled by the curiosity trait)
  "maxTopicShare": 0.6,       // topic-concentration trigger
  "directiveHalfLifeOutputs": 3,
  "directiveHalfLifeDays": 7,
  "navigatorEvery": "1d",
  "topicWindow": 8,           // cycles considered for topic concentration
  "noSurpriseStreak": 3,      // cycles without a surprise before exploring
  "enabled": true,            // false turns the whole DNA off for this bot (or fleet-wide)
  "dispatch": { "enabled": true, "maxChars": 1200, "minEditorScore": 0.7,
                "baseIntervalHours": 12, "minIntervalHours": 4, "maxIntervalHours": 168 }
}
```

Values shown are the code defaults (`CURIOSITY_DEFAULTS` in `curiosity/config.ts`); the schema is `CuriosityConfigSchema` in `src/config.ts`. Resolution: defaults → global → per bot for scalars; dials = preset (per bot ?? global ?? `explorer`) → global dials → per-bot dials; then the trait scales `exploreRatio`. Mechanically, `topic` and `purpose` gate frontier items and `identity` gates interests; `instructions`, `method` and `capability` are prompt-level.

| Preset | topic | purpose | instructions | method | capability | identity |
|---|---|---|---|---|---|---|
| `focused` | closed | closed | closed | open | closed | closed |
| `explorer` (default) | open | ask | ask | open | ask | closed |
| `wild` | open | open | open | open | open | ask |

**The floor — no dial unlocks it:** safety and legality; no contact with anyone but the operator without approval; spend/quota/rate limits; no destructive actions or writes outside the bot's own paths; existing approval gates (`create_tool`, `ask-permission`, tool-permission matrix) stay in force at `capability: open`; honesty — no fabricated evidence or hype.

Prompt changes (all conditional on the curiosity block, so a bot with curiosity off sees the old prompts): the planner's SOUL ALIGNMENT rule ("if unsure, choose inaction") becomes PURPOSE ALIGNMENT ("does this serve the purpose or the operator's interest, within the dials?"); the strategist's engagement check accepts EXPLORATION and its rule 6 becomes Purpose Alignment; the temperature-0 retry is skipped on exploration cycles (`skipAlignmentRetry`); the engagement-gate note says the gate blocks artifacts, not curiosity. When the operator is silent, the bot explores sooner instead of idling.

### Anti-goals

- No novelty karma (it would teach novelty spam). Reward only operator signals on dispatches and directions.
- No manipulation: no cliffhangers, no withholding to drive opens, no unbacked claims.
- No new governance goals about the bot's own process. The navigator can close self-referential goals that don't serve the purpose or the operator.

---

## Dashboard

As built:

- Agent Home: a **Mind** section with a DNA line (preset, six dials, explore target, explore/exploit mix, top-topic share) and four cards: **Direction** (bets, retrospective, 👍/👎), **Knowledge** (topics with depth, findings, surprises, open questions, interests), **Frontier** (Approve / Drop) and the latest **Dispatches**.
- Dispatch inbox: a **Dispatches tab in the Work area** at `#/work/dispatches` (no sidebar entry of its own; legacy `#/dispatches` redirects), filters All / Sent / Held / Proposals, 👍 / 👎 / "more like this", which feeds `TASTE.json`.
- Agent edit form: a **Curiosity** section (on/off, preset, per-dial overrides, exploration share, dispatch on/off and max chars); `PATCH /api/agents/:id` and `/bulk` validate it with `validateCuriosityPatch`.
- API: `GET /api/curiosity/:botId`, `GET /api/curiosity/dispatches`, `POST /api/curiosity/:botId/{dispatches/:id,frontier/:id,direction}/signal`.
- Runner concurrency: begin and finish run under a per-bot lock (`CuriosityService.runExclusive`) and re-read state after every LLM await; begin is cancellable — on timeout the agent loop sets a flag and nothing is written afterwards.
- Observability: curiosity LLM calls go to the LLM query log with callers `curiosity:navigator`, `curiosity:extractor`, `curiosity:editor`. Tenant usage metering does not count them yet (follow-up).
- Not built: Stats views for per-bot topic diversity over time, explore/exploit mix and dispatch landing rate (follow-up).

---

## Steps (TDD, one session each)

| # | Step | Depends |
|---|---|---|
| C0 | Verify the plumbing: ask_human auto-close, operator replies reaching the loop. Fix if broken | — |
| C1 | `curiosity/knowledge-map.ts` (merge/prune/render) + `store.ts` + post-cycle extractor + strategist reads the map | C0 |
| C2 | Topic tagging of productions + topic-concentration check + directive decay | C1 |
| C3 | `curiosity` config schema + limit dials and presets (were "roam levels") + prompt loosening (no temp-0 on exploration cycles) | C1 |
| C4 | Navigator layer: retrospective, direction in `NAVIGATOR.json`, frontier, explore budget | C2, C3 |
| C5 | Dispatch: format contract, editor gate, length cap, cadence | C4 |
| C6 | Taste model from operator signals | C5 |
| C7 | Dashboard: Knowledge / Frontier / Direction panels, dispatch feedback, Stats diversity | C4–C6 |
| C8 | Docs: CHANGELOG, `docs/architecture-docs/agent-loop.html`, README, roadmap, CLAUDE.md module table | all |

## Status

| Step | Status | Notes |
|---|---|---|
| C0 | done | `AskHumanStore` persists pending asks (`pending.json`), boot reconciliation re-attaches inbox asks, every answer is also written to daily memory; `tests/tools/ask-human-restart.test.ts` |
| C1 | done | `KNOWLEDGE.json` via `knowledge-map.ts` + `store.ts`; `extractor.ts` runs after every non-idle cycle; map injected through `curiosityBlock` |
| C2 | done | Cycle topic log + `computeTopicConcentration` / `decideCycleMode` in `cycle.ts` (per cycle, not per production); `directives.ts` decay with `directiveHalfLifeOutputs` / `directiveHalfLifeDays` |
| C3 | done | `CuriosityConfigSchema` (global + per bot), presets + six dials + floor (`config.ts`, `dna.ts`); PURPOSE ALIGNMENT, EXPLORATION in the engagement check, `skipAlignmentRetry` |
| C4 | done | `navigator.ts` (every `navigatorEvery`, default 1 d) with direction/bets in `NAVIGATOR.json`, frontier add/drop, goal ops; explore budget in `cycle.ts`; `runner.ts` wired into `agent-loop.ts` |
| C5 | done | `dispatch.ts`: format, editor gate + hype penalty, `maxChars`, cadence, proposals and digest; `loop-wiring.ts` delivery + fleet daily cap |
| C6 | done | `taste.ts` → `TASTE.json` from 👍/👎/more and ignored dispatches; `CuriosityService.signalDispatch` |
| C7 | done | `/api/curiosity` routes, Agent Home Mind section, Work → Dispatches tab, edit-form Curiosity section. Stats diversity views not built (follow-up) |
| C8 | done | CHANGELOG, CLAUDE.md "Módulos Curiosity", `docs/architecture-docs/` (agent-loop, configuration, web-dashboard, bot-core), README, roadmap (Proyecto 11), this plan |
