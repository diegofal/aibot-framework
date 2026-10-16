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
