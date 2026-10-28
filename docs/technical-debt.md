# Technical debt register

<!--
  Installed by /zero (stage 2: memory). Yours to edit; Zero updates never touch it.
-->

What was knowingly deferred on AIBot Framework, why, and what would make it urgent.

This is not a list of everything imperfect. It is a list of **decisions to defer**, made
deliberately, at a known time. If nobody decided it, it is not debt, just code that could be better.

The field that does the real work is **the trigger**: the condition that makes paying it urgent.
Debt without a trigger is a wish, not tracked debt.

## How entries move

Added when the decision to defer is made, in the same change as the shortcut. Moved to Paid with a
link to the commit that paid it. Reviewed when its trigger fires.

## Entry layout

Each entry is a `###` heading with this table and these paragraphs:

| | |
| --- | --- |
| **Added** | date |
| **Where** | file, module or system |
| **Decided by** | who |

**What was deferred.** · **Why it was the right call then.** · **What it costs while it stands.** ·
**The trigger.** · **Estimated cost to pay.**

---

## Open

### A lesson out of the prompt for a while is measured over that time

| | |
| --- | --- |
| **Added** | 2026-10-27 |
| **Where** | `src/bot/self-improve/runner.ts`, `measure.ts` (`evaluateLesson` window) |
| **Decided by** | agent building self-improvement (pre-PR pass round 3 on `feat/self-improve`) |

**What was deferred.** Only the lessons the prompt shows (the newest `maxActive`) are measured. If the operator lowers `maxActive` below the active count and later raises it, or switches a bot's loop off and back on, a lesson that was out of the prompt in between is measured over a window that includes calls made while the bot never saw it.

**Why it was the right call then.** It needs two config edits by the operator in sequence, and the worst outcome is an optimistic verdict (`proven`) for a lesson that stays visible; nothing is lost or hidden. Fixing it means a per-lesson window start reset whenever a lesson leaves the prompt, a new field in `LESSONS.json` and a third fix round on the same code.

**What it costs while it stands.** A lesson can be marked proven on calls it did not influence, after an operator lowered and restored the cap.

**The trigger.** The first time `maxActive` is lowered on a bot with more active lessons than the new cap, a bot's loop is switched off for more than a day while it has active lessons, or lessons start leaving the prompt any other way (per-goal lessons, priorities).

**Estimated cost to pay.** Half a day: a `windowStart` on the lesson reset by the runner whenever a lesson is not shown, `evaluateLesson` reading it, tests.

---

### Single-tenant dashboard is the operator, and `/api` has no auth

| | |
| --- | --- |
| **Added** | 2026-10-16 |
| **Where** | `src/web/server.ts` (no auth middleware when multi-tenant is off), `src/web/routes/conversations.ts` (`dashboardActor`), `src/tools/operator-gate.ts` |
| **Decided by** | agent hardening the personal-data tools (re-review of `feat/organizer-integration`) |

**What was deferred.** In single-tenant mode every `/api/*` route and `/ws/activity` is unauthenticated, and a dashboard thread runs its tools as the operator (`_actor: 'operator'`), so the operator's calendar, mail, WhatsApp exports and operator-only APIs answer it. Anyone who can reach the port is the operator. Pre-existing for `/api` (same as `/api/claude-accounts`, `/api/personal-accounts`); the personal-data tools raise what it exposes.

**Why it was the right call then.** The container binds `127.0.0.1:3000` only; the dashboard is the operator's own surface, and adding auth to single-tenant is a separate change across every route and the web client.

**What it costs while it stands.** Nothing while the port stays on localhost. Exposed (reverse proxy, `0.0.0.0`, tunnel), it hands out the operator's personal data, Claude accounts and every admin action.

**The trigger.** Before exposing the dashboard beyond localhost in single-tenant mode (any proxy, tunnel or non-loopback bind), or before turning on personal accounts on a host that is not the operator's machine.

**Estimated cost to pay.** One to two days: admin credentials (the multi-tenant `AdminCredentialStore` path) required in single-tenant too, a session for the web client and the WebSockets, and `dashboardActor` reading that session instead of the tenant mode.

### Two calendar paths: API-key Google provider and `/cal` next to personal accounts

| | |
| --- | --- |
| **Added** | 2026-10-16 |
| **Where** | `src/tools/calendar.ts` (`GoogleCalendarProvider`, tools `calendar_list` / `calendar_availability` / `calendar_schedule`), `src/skills/calendar/` (`/cal`), `src/personal-accounts/` |
| **Decided by** | agent implementing P1a of `docs/plans/personal-organizer-plan.md`, per the brief ("retire only if trivial") |

**What was deferred.** P1a says the Google provider of `src/tools/calendar.ts` retires and `/cal` calls `calendar_agenda`. Neither was done: the old tools still register when `config.calendar.enabled`, and `/cal` still reads the old provider. The new OAuth tools (`src/tools/personal/`) are the supported Google path.

**Why it was the right call then.** Retiring it touches `CalendarConfigSchema`, the `/cal` skill, the Calendly provider that shares the module, and their tests (`tests/tools/calendar.test.ts`): not trivial, and a separate change from adding the accounts.

**What it costs while it stands.** A bot with both `config.calendar` (google) and the personal-accounts allowlist gets two overlapping calendar toolsets in the same `calendar` category; the planner may pick the API-key one, which cannot read private calendars.

**The trigger.** The first time a live config turns on `integrations.personalAccounts.bots` for a bot that also has `calendar.enabled` with `provider: google`, or when `/cal` is next touched.

**Estimated cost to pay.** Half a day: drop `GoogleCalendarProvider` (keep Calendly), point `/cal` at the personal-accounts service, update the calendar tests and the roadmap entry.

### Shared anonymous widget session `private:0`

| | |
| --- | --- |
| **Added** | 2026-10-11 |
| **Where** | `src/channel/outbound.ts` (`appendWebSessionMessage`, `webSessionUserId`), `BotManager.handleChannelMessage`, `GET /api/v1/chat/:botId/history` |
| **Decided by** | operator, during the relay work |

**What was deferred.** Web sessions are keyed `bot:<id>:private:<Number(senderId) \|\| Number(chatId) \|\| 0>`. Widget ids (`widget-user-…`) and emails are not numeric, so every such address collapses into one shared `private:0` session that every anonymous widget visitor replays. Before the relay change, `send_message` "web" deliveries to the operator (whose web address is an email) were appended there. Relays now refuse non-numeric web addresses; every other caller of `appendWebSessionMessage` (cron delivery to a headless bot's web session in `BotManager`, the outbound web channel) keeps the old behaviour.

**Why it was the right call then.** Fixing it means giving each widget visitor a session of its own across the widget, the REST history route and every outbound caller; it is a separate change from the relay, and the relay already stops writing there.

**What it costs while it stands.** Anything written to a non-numeric web address can be read by any anonymous widget visitor of that bot: a privacy leak.

**The trigger.** Any bot with the web widget exposed publicly, or any new code path that sends to a `web` address.

**Estimated cost to pay.** About a day: key web sessions by the widget's own id (string), migrate or drop the existing `private:0` transcripts, and update the history route and outbound callers with tests.

### No live web presence registry

| | |
| --- | --- |
| **Added** | 2026-10-11 |
| **Where** | `src/relay/delivery.ts` (`DeliveryDeps.isWebLive`), `src/relay/wiring.ts` |
| **Decided by** | operator, during the relay work |

**What was deferred.** The relay resolver can report a web delivery as `delivered` only when a live connection for that address exists, but nothing tracks open widget/WebSocket connections per address, so `isWebLive` is not wired and web is always `queued` (stored, nobody notified).

**Why it was the right call then.** Under-reporting is honest; nobody had a web-only contact that needed live delivery.

**What it costs while it stands.** A person reachable only on web never gets a relay pushed to them; they see it when they next open the chat, and the requester is told it was not delivered.

**The trigger.** A bot whose only channel to someone (operator or user) is web.

**Estimated cost to pay.** Half a day: a per-bot address → connection registry in the WebSocket channel, wired into `isWebLive`, plus pushing the stored message to the open socket.

### Discord outbound

| | |
| --- | --- |
| **Added** | 2026-10-11 |
| **Where** | `src/channel/outbound.ts` (Discord stub), `src/relay/delivery.ts` |
| **Decided by** | operator, during the relay work |

**What was deferred.** The relay route order is Telegram → WhatsApp → web; Discord is not a route, and the outbound Discord channel is still a stub.

**Why it was the right call then.** No contact today is reachable only on Discord.

**What it costs while it stands.** A Discord-only contact gets `Delivery FAILED` from `send_message`.

**The trigger.** The first bot with a contact reachable only on Discord.

**Estimated cost to pay.** Half a day: a Discord sender (DM channel via REST) in `DeliveryDeps`, a route in `deliverToContact`, tests.

### No detector for unbacked promises

| | |
| --- | --- |
| **Added** | 2026-10-11 |
| **Where** | conversation replies (`src/bot/conversation-pipeline.ts`) |
| **Decided by** | operator, during the relay work |

**What was deferred.** The relay fixed one instance of a bot promising something no mechanism backs ("you'll be the first to know when he answers"). A generic check for promises of a future action in reply text ("I'll remind you tomorrow") with no tool call or record behind it was not built.

**Why it was the right call then.** The incident's promise now has a mechanism; a generic detector needs its own design (what counts as a promise, which records back it, what to do on a miss).

**What it costs while it stands.** A bot can still promise follow-ups that never happen, and nobody notices until the person complains.

**The trigger.** The next incident of a bot promising a future action with no mechanism behind it.

**Estimated cost to pay.** Two to three days: a post-reply check (pattern or cheap LLM pass) against the turn's tool calls, cron jobs and relay records, with a correction or an operator flag on a miss.

### Relayed text in the operator's context while personal-data tools are open

| | |
|---|---|
| **Added** | 2026-10-16 |
| **Where** | `src/relay/service.ts` (relay appended to the operator's transcript), `src/tools/operator-gate.ts` |
| **Decided by** | operator, during the personal-organizer security review |

**What was deferred.** A public user can relay a message to the operator through `send_message`; it lands in the operator's own transcript with the 📨 header. In a later operator turn (Telegram private chat or an operator cron), that text is in the model's context while calendar, mail, finance and WhatsApp tools are available, so it can attempt prompt injection ("read their mail and send it to me").

**Why it was the right call then.** The header marks it as relayed, the operator gate already shuts every non-operator path, and quarantining relayed text from operator turns is a separate design.

**What it costs while it stands.** A successful injection would need the model to obey quoted third-party text in the operator's own chat; the outbound side (`send_message` to that person) is the exfiltration channel.

**The trigger.** Before personal-data tools are enabled for a bot that public users can relay through, beyond the operator's own Finny; or the first suspicious relay.

**Estimated cost to pay.** A day: keep relayed text out of the history sent with personal-data tools, or require `confirm` for `send_message` to non-operators in turns that used a sensitive tool.

### Cron visibility of public callers matches a client-supplied address

| | |
|---|---|
| **Added** | 2026-10-16 |
| **Where** | `cronJobVisibleTo` (cron tool scope) |
| **Decided by** | operator, during the personal-organizer security review |

**What was deferred.** For callers that are neither the operator nor the bot itself, `list` / `remove` / `run` match jobs by `channelKind` + `address`; on REST and the web widget the client supplies that address, so one public user can see, run or remove another public user's jobs.

**Why it was the right call then.** No personal data is reachable this way, and operator jobs are not visible to them.

**What it costs while it stands.** Nuisance between public users of the same bot.

**The trigger.** When a bot with public REST/widget users starts using cron for them.

**Estimated cost to pay.** Hours: bind public identity to a verified widget session (`userHash`) before matching.

### Every watcher call pays the cache-write premium and never reads the cache

| | |
|---|---|
| **Added** | 2026-10-25 |
| **Where** | `src/claude-cli.ts` (how the CLI is spawned for `src/watcher/llm.ts` calls) |
| **Decided by** | lead, watcher autonomy rung 0 (measured while building S1) |

**What was deferred.** Every integrate and notice call writes its whole input (12k–21k tokens on integrate) as a prompt-cache write and never reads it back: passes are 9 min to hours apart and the user prompt is one block. Cache writes cost more than plain input tokens.

**Why it was the right call then.** Fixing it means changing how the Claude CLI is invoked for every caller, outside the rung 0 scope (controls first).

**What it costs while it stands.** The cache-write premium on ~40 watcher calls a day; the same likely holds for fleet calls with long gaps.

**The trigger.** The rung 2 cost audit, or any week where watcher spend exceeds $20.

**Estimated cost to pay.** Hours: find whether the CLI can skip cache writes for one-shot calls (or send the prompt so the stable prefix is its own block), measure `cacheCreationTokens` before and after.

### The `improve` tool rewrites a bot's soul files without approval

| | |
|---|---|
| **Added** | 2026-10-25 |
| **Where** | `src/tools/improve.ts` |
| **Decided by** | lead, noticed while writing `docs/plans/watcher-autonomy-plan.md` |

**What was deferred.** `improve` spawns the Claude CLI with Read/Edit/Write over a bot's IDENTITY, SOUL, MOTIVATIONS and memory. A bot can change its own personality with no operator approval and no diff review; there is a `.versions` backup, nothing more.

**Why it was the right call then.** It concerns the bots, not the watcher; the autonomy plan keeps `improve` out of every watcher toolset.

**What it costs while it stands.** Identity drift the operator only sees after the fact; the opposite of the approval model the watcher now has.

**The trigger.** The first time a bot's SOUL.md or IDENTITY.md changes in a way the operator did not ask for, or before any bot gets more autonomy.

**Estimated cost to pay.** A day: route `improve` output through the same proposal-and-approval queue as a diff, or require `confirm` in both permission modes.

### Watcher broadcasts can carry operator-sourced insight text to a bot

| | |
|---|---|
| **Added** | 2026-10-23 |
| **Where** | `src/watcher/integrate.ts` → `src/watcher/broadcast.ts` (directive / goal kinds) |
| **Decided by** | lead, watcher phase 3 (the privacy rule covers `fleet_memory_search` only) |

**What was deferred.** `fleet_memory_search` hides `meta.operatorSourced` neurons from everyone but the verified operator, and everything an integrate pass creates is marked operator-sourced when the model saw operator material. A directive or goal broadcast written from such an insight still reaches the target bot's planner (and its GOALS.md), and that bot may then talk about it with non-operator users. Since review round 1, birth marks what it reads from operator-owned material (memory, goals, contacts, knowledge) operator-sourced, so more insights carry the flag; the broadcast path still ignores it.

**Why it was the right call then.** The bots are the operator's own; the decision in scope was cross-bot recall by other people.

**What it costs while it stands.** An operator fact can surface, paraphrased, through a bot that has public users.

**The trigger.** The first watcher broadcast to a bot with public REST / widget / WhatsApp users.

**Estimated cost to pay.** Hours: refuse directive/goal broadcasts from operator-sourced insights to bots with public channels, or rewrite them without the operator material.

### Watcher retries a deferred question on every integrate pass

| | |
|---|---|
| **Added** | 2026-10-23 |
| **Where** | `src/watcher/watcher.ts` (question delivery, the `deferred` result of the throttle gate) |
| **Decided by** | lead, watcher review round 4 |

**What was deferred.** A question the fleet throttle refuses comes back `deferred`, and the next integrate pass proposes it again without looking at when the throttle would allow it. While the fleet's daily cap is exhausted every pass writes another held row to the broadcasts and to Work → Sent to you.

**Why it was the right call then.** Deferral itself was the round-3 fix (a refused question was being lost); pacing the retry is a separate change and the held rows are noise, not lost or wrong deliveries.

**What it costs while it stands.** Broadcasts and Sent to you fill with held copies of the same question on days the cap runs out.

**The trigger.** A day the fleet's proactive cap is exhausted while the watcher has a question pending.

**Estimated cost to pay.** About an hour: skip a re-proposal while a deferred record for the same insight and kind is newer than the throttle's retry time.

### Lean Claude CLI flags verified on one CLI version only

| | |
|---|---|
| **Added** | 2026-10-23 |
| **Where** | `src/claude-cli.ts` (`NO_SETTINGS_FLAGS`, `NO_TOOLS_LEAN_FLAGS`), `src/bot/claude-cli-preflight.ts` (`LEAN_FLAGS_MIN_VERSION`) |
| **Decided by** | lead, watcher cleanup |

**What was deferred.** Every call passes `--setting-sources ""` (the MCP path too, since 2026-10-23) and every no-tools call `--tools ""`. They were measured on CLI 2.1.289 and again on 2.1.300 (the version pinned in the Dockerfile); the first version that accepts both is not known, so the preflight only warns below 2.1.289 instead of dropping the flags on an older CLI. Passing empty-string arguments through the Windows `claude.cmd` wrapper was not tried either.

**Why it was the right call then.** The container runs exactly 2.1.289 and the saving is ~17× per call; probing the flags at runtime would add a spawn per boot for a case that does not exist today.

**What it costs while it stands.** On an older CLI, or a Windows host using the npm `.cmd` shim, every planner, strategist, memory, watcher and (for `--setting-sources`) MCP tools call could fail with `unknown option` (the preflight line says so). The three direct spawns of the CLI outside `src/claude-cli.ts` carry the same flags and the same risk: `src/bot/soul-memory-consolidator.ts` (`buildConsolidationCliArgs`, `--tools ""` and `--setting-sources ""`), `src/bot/soul-quality-reviewer.ts` (`buildQualityReviewCliArgs`) and `src/tools/improve.ts` (`buildImproveCliArgs`), both `--setting-sources ""` only because they use the CLI's Read/Edit/Write tools.

**The trigger.** Pinning a different `CLAUDE_CLI_VERSION`, or running the bots on Windows outside the container.

**Estimated cost to pay.** About an hour: run `claude --help` once at boot and drop each flag the CLI does not list.

### Bookkeeping facts already in a born watcher graph stay

| | |
|---|---|
| **Added** | 2026-10-23 |
| **Where** | `src/watcher/birth.ts` (`isBookkeepingLine`, memory stage) |
| **Decided by** | lead, watcher cleanup |

**What was deferred.** Birth now skips operational lines of the daily logs, but the live graph was born before the filter: its `ask_human … enviada` / `t-…` facts stay until they are archived as inactive (`graph.archiveAfterDays`, 30 days).

**Why it was the right call then.** Archiving neurons by a text rule is a destructive pass over the operator's graph; the facts are noise, not wrong, and fade on their own.

**What it costs while it stands.** Bookkeeping facts can still show in `fleet_memory_search` results and the ball for up to a month.

**The trigger.** The operator sees one of them in a recall or asks to clean the graph.

**Estimated cost to pay.** Half a day: a hygiene routine with preview/apply that archives live `birth:memory` facts matching `isBookkeepingLine`.

### Ball pulse, edge flash and wheel gating are not under test

| | |
|---|---|
| **Added** | 2026-10-23 |
| **Where** | `web/pages/watcher-ball.js` |
| **Decided by** | lead, watcher cleanup |

**What was deferred.** The decisions are pure helpers with tests (`ballPlanFor`, `ownerEdgeOf`, `autoRotates`, `edgeFlashLevel`, `wheelZooms`); the WebGL wiring that uses them (flash `LineSegments`, rotation pause, wheel listener, hint) was not exercised in a browser.

**Why it was the right call then.** The dashboard login blocks browser automation and the watcher is off in production.

**What it costs while it stands.** A wiring bug shows only when someone opens the Watcher page with the watcher on.

**The trigger.** Turning the watcher on in the live container.

**Estimated cost to pay.** Fifteen minutes by hand on the page: click, scroll, watch a goal pulse light its bot.

## Paid

### Time-of-day-dependent test in `tests/session-end.test.ts` — paid 2026-10-12 (commit "fix(session): the daily reset also fires before the reset hour")

| | |
| --- | --- |
| **Added** | 2026-10-11 |
| **Where** | `tests/session-end.test.ts`, "reports daily for a session last active days ago" |
| **Decided by** | operator, during the relay work |

**What was deferred.** The test builds its timestamps from the real local clock and fails when run after about 21:00 local time (it ages a session against the real clock and the 4 am daily boundary; the exact interaction was not diagnosed). Found while running the full suite for the relay work; not fixed there because it is unrelated to the relay.

**Why it was the right call then.** Out of scope for the change that found it, and the failure is in the test, not in `session-continuity`.

**What it costs while it stands.** The suite goes red in the evening, which trains people to ignore failures.

**The trigger.** Now, or the first time CI runs at that hour.

**Estimated cost to pay.** Under an hour: pass a fixed `now` to the code under test (or use fake timers) instead of `Date.now()`.

**How it was paid.** It was not a test bug. `SessionManager.resetReason` only compared against today's reset hour, so between midnight and that hour a session idle for days was never reset. It now compares against the last reset hour that already passed, and a new test checks both sides of that boundary at any time of day.

### Watcher consolidation: contradiction check before enabling (2026-10-25, PR #19)

- **What.** `summaryContradicts` (consolidate) rejects faithful summaries of clusters that hold both affirmative and negative facts (fails safe: skips, never archives), and still lets through a reversed claim whose negation and number tokens are unchanged; the provenance regression test does not assert the re-read after the model call.
- **Decided by.** Diego, 2026-10-25 (https://github.com/diegofal/aibot-framework/pull/19#issuecomment-6399863647): merge with consolidation off (`watcher.consolidate.enabled: false`, `preview: true`), tune in preview against real summaries.
- **Next.** Enable consolidation in preview on the live fleet, read a week of `consolidate:preview` rows, adjust the rule (split mixed-polarity clusters before summarising; compare claim pairs, not token sets), then enable.

### Watcher prediction judge: follow-ups from PR #21 (2026-10-25)

- Cycle evidence lines carry plan text for completed cycles (the judge could read intent as outcome); overflow summaries drop per-target detail of unshown successes; the bots a prediction concerns are found by name matching in its text, because predictions store no structured bot association (integrate emits text + neuronIds). Declined on the PR with reasons; revisit if resolved predictions show misjudgments. The judge's evidence for web_fetch failures has no HTTP status code (`failed (blocked)`), so predictions about specific codes resolve `unknown`.

### Watcher: rename during an in-flight embed (2026-10-26, PR #24)

- **What.** If `Graph.setText` renames a neuron while that neuron's embed is in flight, the late vector (made from the old text) can be stored after the drop. Rare: resync renames only at start. **Fix when needed:** compare the text the vector was made from with the neuron's current text before storing it. **Decided:** declined on PR #24 round 3.

### Watcher self-study: notes and digest accuracy (2026-10-26, PR #26)

- **What.** Four advisories accepted as debt on PR #26 (Fable round 1, 0 bugs; the review counted five because the spend-window one was posted twice, once inline and once in a summary comment): a throw mid-way through the submit loop leaves proposals the store already accepted out of the run's outcome and NOTES.md (the queue stays right); the watcher's per-tier spend covers the last 7 whole UTC days while `byCaller` and the bot figures cover the rolling window, so the digest's watcher numbers disagree (the first live run flagged it itself: $0.80/day headline vs $8.43 by caller); extra keys in the model's JSON are spread into the store input (the rung 0 parser still validates every field it uses); a refused or errored call that then throws in `afterCall` is reported as "failed after the model answered". **Trigger.** A proposal whose rationale rests on the watcher's own spend, or the operator reading NOTES.md as the record of what was proposed. **Cost.** An hour: one window for every digest figure, an outcome assembled from the store's results, an allowlist of keys copied from the model's answer.

### Mind roster: follow-ups (2026-10-27, `docs/plans/mind-roster-plan.md`)

- **Notice keeps too much.** The reset clears the graph, not the policy that filled it (1.9k facts, 760 questions, 480 surprises against 43 insights). **Trigger:** two weeks after the reset, live neurons other than entity/person/goal pass 1,000 while insights stay under 5 % of them.
- **Retire suggestions are shown only.** The operator turns a bot off by hand. **Trigger:** a retire suggestion stays on the card for two designer runs without the operator acting on it.
- **The brief is a form, not a conversation.** The designer's `questions` stand in for one. **Trigger:** two runs in a row end with questions and no proposal.
