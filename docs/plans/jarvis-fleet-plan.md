# Plan: the Jarvis fleet — beautiful, alive, simple, powerful, connected

**Status:** in execution — S0–S8 and S3.5 done, next up S9. The status table at the bottom is the source of truth.
**Scope:** `web/` (dashboard), `src/web/routes/`, `src/a2a/`, `src/channel/`, `src/core/llm-client.ts`, `src/tools/`, `config/`, tests, docs.
**Executed as a chain of Claude Code sessions.** One session = one numbered step below. Every session starts by reading this file, `CLAUDE.md` (Arquitectura del Bot), and the **Handoff** block of the session it depends on. Every session ends by filling in its own Handoff block and its row in the status table. Changes are left uncommitted for review, per `CLAUDE.md`.

---

## Goal

Turn AIBot from an ops console over nine bots into a fleet of personal agents that feel alive, are trivial to create and talk to, can be reached from anywhere, and can find and talk to agents outside this instance.

Five questions from the kickoff, and the phase that answers each:

| Question | Phase |
|---|---|
| How do we give the agents life? | 1 — Life |
| How do we make usage simpler? | 2 — Simple |
| How do we make them more powerful? | 4 — Power |
| How do we talk to them from the outside world? | 3 — Outside world (inbound) |
| How do they find and talk to other agents out there? | 3 — Outside world (A2A) |

---

## Findings that shape the plan (2026-09-13)

- **Dashboard**: 18.7k lines of string-template vanilla JS in `web/pages/*.js`, 27 sidebar entries, dark-only, one `@media` rule at `web/style.css:1535`, nearly every page is a table. The agent is a config form plus a row. No build step: the Docker image does `COPY web ./web` and `docker-compose.override.yml` bind-mounts `./web` read-only, so **the no-build setup must stay**.
- **Life data already exists, scattered over eight pages**: posture (`src/stats/posture.ts`), traits (`TRAITS.json`), karma (`/api/karma/:botId`), goals (`tools/goals.ts` parser), memory, productions, asks. Live events already stream on `/ws/activity` (`src/web/server.ts:673`).
- **Roster**: 9 bots in `config/bots.json`, 2 enabled. Headless bots (`token: null`) are supported by the runtime; the UI still treats Telegram as the default.
- **A2A**: `src/a2a/` implements v0.3.0 but the `a2a` block is absent from `config/config.json`, so `src/web/server.ts:418` never mounts it. The card advertises all tools as skills (`agent-card-builder.ts`), tasks and the directory are in-memory, no auth, no streaming. The protocol shipped **v1.0 on 2026-03-12** (three bindings, `rejected` / `auth-required` states, push notifications, signed cards, extensions) and joined the Agentic AI Foundation on 2026-08-27. The client still fetches `/.well-known/agent.json`; v0.3+ moved to `agent-card.json`.
- **Channels**: inbound Telegram, WhatsApp, Discord, REST, WebSocket widget. No email, no generic inbound webhook, no Slack, no inbound voice. Outbound (`src/channel/outbound.ts`) reaches Telegram, WhatsApp, web; Discord is a stub.
- **LLM backends**: only Ollama and the Claude CLI subprocess (`createLLMClient`, `src/core/llm-client.ts:492`). No native Anthropic or OpenAI HTTP client, so no true streaming, vision or prompt caching on the Claude side. `src/bot/model-failover/` is a model-level orchestrator, not a provider.
- **Outside ecosystem**: discovery is unsettled (NANDA index, AGNTCY directory, IETF Agent Name Service draft, MCP registry). The A2A Agent Card is the common denominator; publish cards first, register in directories later. Moltbook is alive under Meta (acquired 2026-03-10); `src/tools/moltbook.ts` hardcodes the agent name `NodeSpider` and stores credentials under the home directory.
- **Tests**: `bun test`, suites under `tests/` (`tests/web/` for dashboard helpers imported as `../../web/pages/*.js`, `tests/web/routes/`, `tests/a2a/`, `tests/channel/`, `tests/bot/`). Lint is `biome check .`.

---

## Rules every session follows

1. **TDD gate from `CLAUDE.md`**: red → green → refactor, one dedicated test per new public function, `bun test` clean before "done". Frontend helpers go in importable modules (`web/ui/*.js`, `web/pages/*-helpers.js`) so `tests/web/` can cover them.
2. **No build step in `web/`.** Plain ES modules, CDN scripts only if pinned. Verify a UI change reached the container with `curl -s http://127.0.0.1:3000/<asset> | grep <change>`.
3. **Feature flags.** Every new backend surface lands behind a config flag that defaults off, except pure dashboard work.
4. **Old routes keep working** until the status table says a page was retired. Old hash routes redirect to the new place.
5. **Docs in the same session**: `CHANGELOG.md` entry, the matching `docs/architecture-docs/*.html` page, `README.md` when the list of pages, tools, channels or backends changes, and the `CLAUDE.md` module table when a module is added.
6. **No commits** unless asked.
7. **Session size**: a session should fit in one sitting (roughly 2–4 hours of agent work). If a session grows past that, split it and add the new session to the status table rather than stretching.
8. **Every session ships something you can open and see.** Each session has a **Demo** block: what to open, what to do, what you should see. A session whose demo cannot be performed at the end is not done; a session that cannot have a demo must be folded into one that can.
9. **Handoff block is mandatory.** It lists: what shipped, what was left out and why, exact new file paths and exported names, config keys added, and anything the next session must know.

---

## Session graph

```
Phase 0        Phase 1 (Life)            Phase 2 (Simple)              Phase 3 (Outside)         Phase 4 (Power)

S0 tokens ──┬─► S1 presence ─► S2 Agent Home ─► S3 Fleet Home + nav ─┬─► S5 Needs You ─► S3.5 old pages ─► S9 PWA+push
            │                       │                                │
            │                       ├─► S4 face+voice                ├─► S6 wizard ─► S7 presets
            │                       │                                │
            │                       │                                └─► S8 NL automations + palette ─► S13 webhooks in
            │                       │
            │                       └──────────────────────────────────────────────────► S17 durable tasks ─► S19 sub-agents
            │                                                                                  ▲
            └─► S12 email channel                              S10 A2A v1.0 ─► S11 discovery ──┘
                                                                     │              │
                                                                     │              └─► S15 Moltbook/social
                                                                     └─► S14 inbound voice (stretch)

Independent: S16 native Anthropic client, S18 sandboxed exec
```

Critical path for "feels alive": **S0 → S1 → S2 → S3 → S5**. Everything else can interleave.

---

## Phase 0 — Foundation

### S0 — Design tokens, component layer, responsive shell

**Depends on:** nothing.
**Kickoff prompt:**
> Execute session S0 of `docs/plans/jarvis-fleet-plan.md`. Read the plan, its Rules, and `CLAUDE.md`. Do not rewrite any page; build the foundation only.

**Goal.** Give the dashboard a real visual system without touching page logic, so later sessions build on shared pieces instead of inline styles.

**Reads first.** `web/style.css`, `web/index.html`, `web/app.js`, `web/pages/shared.js` (`showModal`, `api`, `escapeHtml`, `timeAgo`, `renderThread`), `tests/web/`.

**Steps.**
1. Screenshot every page of the running dashboard (logged in) into `docs/plans/ui-baseline/` for before/after comparison. If login blocks automation, take them manually and note it.
2. Replace the `:root` palette in `web/style.css` with a token set: color scale (bg/surface/elevated/border/text/muted/accent/ok/warn/danger/info), spacing scale, radius scale, type scale, shadows, motion durations. Light theme on `:root`, dark under `prefers-color-scheme: dark` and `[data-theme="dark"]`, with a theme toggle stored in `localStorage`. Load Inter from Google Fonts with a system fallback.
3. Create `web/ui/` with small pure functions returning HTML strings (they must stay testable in Bun without a DOM): `card.js`, `badge.js`, `emptyState.js`, `skeleton.js`, `toast.js`, `sheet.js` (side panel), `tabs.js`, `kpi.js`, `avatar.js` (deterministic SVG from a seed; S4 adds uploads), `sparkline.js`, `radar.js` (inline SVG). Export them from `web/ui/index.js`.
4. Make the shell responsive: sidebar collapses to a top bar with a drawer under 900px; `#content` gets a max width and side gutters; tables get an `overflow-x: auto` wrapper class.
5. Keep every existing class name working. Old pages must render unchanged except for the new palette and font.

**Tests.** `tests/web/ui-components.test.ts`: each component renders expected markup, escapes user text, and handles empty input. `tests/web/theme.test.ts` for the toggle helper.

**Exit criteria.** `bun test` clean, every existing page still renders, light and dark both readable, the shell usable at 400px width, `curl` confirms the served CSS carries the tokens.

**Demo.** Open the dashboard: new palette and typography on every page, a theme toggle at the bottom of the sidebar that switches light/dark and survives reload, and at phone width the sidebar becomes a top bar with a drawer. The login page shows the new skin too.

**Handoff (S0, done 2026-09-13).**
```
Shipped:
- web/style.css: token set on :root (dark native) + light theme via [data-theme="light"] and
  prefers-color-scheme; legacy names (--bg-card, --green, --red, --orange, --celeste,
  --text-secondary) kept as aliases; all 38 rgba() tints replaced by --*-bg / --*-border /
  --overlay / --shadow-* tokens; Inter loaded from Google Fonts with system fallback; content
  column centred with gutters that grow past 1480px; responsive shell at <=900px (sticky
  #topbar, off-canvas #sidebar.open, #drawer-backdrop.show, body.unauthed hides chrome);
  component CSS under "UI component layer" (class prefix ui-*).
- web/index.html: inline theme bootstrap (key aibot.theme), font links, #topbar with
  #nav-toggle and #topbar-status, #drawer-backdrop, .nav-foot with [data-theme-toggle].
- web/app.js: imports initTheme from ./ui/theme.js, setDrawer() wiring, closes the drawer on
  navigate, toggles body.unauthed around the login gate, mirrors bot count into #topbar-status.
- web/ui/: escape.js (esc, cx), badge.js (badge, toneFor, BADGE_TONES), card.js (card),
  empty-state.js (emptyState), skeleton.js (skeleton), kpi.js (kpi, deltaLabel), tabs.js
  (tabs), avatar.js (avatar, avatarHue, hashSeed, initials), sparkline.js (sparkline,
  sparklinePath), radar.js (radar, radarPoints), toast.js (toastMarkup, showToast), sheet.js
  (sheetMarkup, openSheet, closeSheet), theme.js (THEME_KEY, resolveTheme, nextTheme,
  themeToggleLabel, readStoredTheme, storeTheme, currentTheme, applyTheme, toggleTheme,
  initTheme), index.js barrel. All string-returning functions are pure; only showToast,
  openSheet/closeSheet and initTheme/toggleTheme touch the DOM and no-op without one.
- tests/web/ui-components.test.ts (35 tests), tests/web/theme.test.ts (9 tests). Full suite:
  5028 pass; the one failure (tests/web/log-tail.test.ts rotation case) imports nothing from
  this session and fails identically on its own — pre-existing, timing-based.
- CHANGELOG entry, docs/architecture-docs/web-dashboard.html "Design system & shell" section,
  README Web Dashboard paragraph.
Left out:
- Baseline screenshots (step 1): the dashboard needs a login and the automation cannot enter
  credentials; the operator should capture docs/plans/ui-baseline/ manually if wanted.
- Phone-width visual check: this machine's Chrome ignores window resizes and screenshots time
  out; the 900px media rule was verified as served and parsed (selectors listed) and the drawer
  JS verified by toggling classes, not by eye. First thing S1 should do on a real phone/devtools:
  open the drawer, close it via the backdrop, confirm #topbar shows and hides on login.
- Existing pages still carry ~32 inline hex colours in web/pages/*.js; they read fine in dark
  and acceptably in light. Replace with tokens as each page is touched, not in bulk.
- Existing tables are not wrapped in .table-scroll; wrap as pages are rewritten (S2/S3).
Config keys: none.
Notes for S1/S2/S3/S12:
- Import components from './ui/index.js' (relative to web/pages/ use '../ui/index.js').
- Presence dot: avatar({ status: toneFor(posture) }) — posture words map: active->ok,
  standby/idle->warn, blocked->danger, dormant/unknown->muted (toneFor handles 'blocked',
  'active', 'idle', 'standby'; add 'dormant'/'unknown' to toneFor when S1 needs them).
- Toasts: showToast(text, { tone }) replaces ad-hoc status divs.
- Side panels: openSheet({ title, body, footer }) returns the body element to wire events.
- Do not add a build step; keep everything importable by Bun tests.
```

---

## Phase 1 — Life

### S1 — Presence API and a live presence header

**Depends on:** S0 (only for conventions; no UI here).
**Kickoff prompt:**
> Execute session S1 of `docs/plans/jarvis-fleet-plan.md`. Read the plan, S0's Handoff, and the Stats and Karma sections of `CLAUDE.md`. Ship the home endpoint, the live "now" events, and a presence header on the existing agent page.

**Goal.** One endpoint that returns everything the Agent Home page needs, live "what I'm doing now" events, and a first visible sign of life: the current agent page gets a presence header that moves while a cycle runs. S2 then builds the full page on top.

**Reads first.** `src/stats/fleet-aggregator.ts` (`buildBotDetail`), `src/stats/posture.ts`, `src/stats/readers/*`, `src/karma/service.ts`, `src/bot/trait-registers.ts`, `src/tools/goals.ts` parser, `src/bot/agent-loop.ts` (where cycles emit), `src/web/server.ts:673` (activity WS), `src/web/routes/stats.ts` for tenant scoping.

**Steps.**
1. New route file `src/web/routes/agent-home.ts` mounted at `/api/agents/:id/home`, tenant-scoped like `/api/stats`. Response shape (freeze it, S2 depends on it):
   ```
   { identity: { id, name, description, avatarSeed, channelState },
     presence: { posture, since, nowLine, nextRunAt, lastRunAt },
     goals: { active[], blocked[], completedRecently[] },
     traits: { values, drift },
     karma: { score, trend, history30d[] },
     timeline: [{ ts, kind: 'llm'|'tool'|'outcome'|'production'|'ask'|'cycle'|'message', title, detail?, ok? }],
     needsYou: { asks, permissions, productionsPending } }
   ```
   Compose it from the existing stats readers and aggregators; do not read files the stats module does not already read.
2. `nowLine` is a first-person sentence derived deterministically from state (no LLM): current plan step while a cycle runs, otherwise "Idle since …", "Waiting for you on …", "Blocked: …". Put the derivation in a pure function `describeNow(state)` in `src/stats/now-line.ts`.
3. Emit a `cycle_step` event on the activity stream when the executor advances to a plan step (hook into where `agent_loop_cycle` is emitted in `src/bot/hooks.ts` / `agent-loop.ts`) carrying `{ botId, step, index, total }`. Emit `posture_changed` when `computePosture` output differs from the last value for a bot.
4. Cache the home payload 15 s per bot (reuse `TtlCache`).
5. Presence header on the existing `renderAgentDetail` in `web/pages/agents.js`: avatar from `web/ui/avatar.js`, posture dot (tone from posture), `nowLine`, next run, Start/Stop/Run now moved into it. Subscribe to `/ws/activity` and update the line on `cycle_step` / `posture_changed`; poll `/home` every 30 s as fallback. Extract `presenceHeader(home)` into `web/pages/agent-home-helpers.js` so S2 reuses it.

**Tests.** `tests/web/routes/agent-home.test.ts` (shape, tenant scoping, unknown bot 404, missing data never throws), `tests/stats/now-line.test.ts` (one test per branch), an agent-loop test asserting `cycle_step` emission.

**Exit criteria.** `curl /api/agents/<id>/home` returns the frozen shape for an enabled and a disabled bot; `bun test` clean; `docs/architecture-docs/operator-api.html` documents the endpoint.

**Demo.** Open any agent at `#/agents/:id`: a presence header with avatar, posture dot and a first-person "now" line. Click "Run now" and watch the line change step by step while the cycle runs, without refreshing. `curl /api/agents/<id>/home` returns the full payload.

**Handoff (S1, done 2026-09-13).**
```
Shipped:
- src/stats/now-line.ts: describeNow(NowInput) -> { text, tone }, relativeIn(nowMs, ts),
  phaseLabel(phase, tool). Branch order: disabled -> not running -> executing -> pending asks
  -> blocked -> skipped -> never ran -> idle -> standby -> between cycles.
- src/stats/presence-tracker.ts: PresenceTracker { attach(stream), handle(event), get(botId),
  clear() } -> LivePresence { executing, phase, currentTool, since }. Attached to
  BotManager.getActivityStream() in src/web/server.ts.
- src/stats/agent-home-aggregator.ts: buildAgentHome(ctx, bot, deps) -> AgentHomeResponse,
  buildPresence(ctx, bot, deps) -> AgentPresence, mergeTimeline(items, limit),
  HOME_CACHE_TTL_MS = 15_000, TIMELINE_LIMIT = 60. Types exported from the same file
  (AgentHomeResponse, AgentPresence, AgentIdentity, TimelineItem, TimelineKind, HomeKarmaSource).
- src/web/routes/agent-home.ts: agentHomeRoutes(deps) mounted at /api/agents ->
  GET /:id/home (cached 15 s per bot), GET /:id/presence (uncached). 404 for unknown or
  out-of-tenant bots, 500 with a log line if an aggregation throws (never observed in tests).
- web/pages/agent-home-helpers.js: POSTURE_TONE, postureTone, formatNext, presenceMeta,
  presenceHeader(home, { actions, nowMs, backHref }), isPresenceEvent(event, botId),
  applyPresence(root, presence, identity, nowMs).
- web/pages/agents.js: renderAgentDetail fetches /home, renders presenceHeader with the action
  buttons inside it (legacy header when /home fails), startPresenceLive() opens /ws/activity and
  refetches /presence debounced 800 ms on agent:*, tool:*, llm:start for the bot + 30 s poll;
  exported destroyAgentDetail() is called from app.js navigate().
- web/style.css: .presence-header / .presence-now-<tone> block at the end (pulsing dot on info).
- Tests: tests/stats/now-line.test.ts (12), tests/stats/presence-tracker.test.ts (7),
  tests/web/routes/agent-home.test.ts (11, on the shared stats fixture), tests/web/
  agent-home-helpers.test.ts (9). tsc clean, biome clean.
- Docs: CHANGELOG, docs/architecture-docs/web-dashboard.html (API rows + Agents page note),
  CLAUDE.md stats table (now-line, presence-tracker, agent-home-aggregator).
Left out / deviations:
- The plan asked for a `cycle_step` event. The executor hands the whole plan to one agentic LLM
  call, so "step 2 of 5" is not observable. The live signal is phase (agent:phase) + tool
  (tool:start/end); the presence line reflects those. No new activity event types were added.
- `posture_changed` event: not emitted. Posture is recomputed from cached bot stats (60 s TTL)
  on each /presence call; the page polls every 30 s so a posture change shows within a minute.
  If S3's fleet grid needs a push signal, add it in the aggregator where posture is computed.
- Karma history is reconstructed backwards from the last 30 events and the current score
  (clamped 0..100) — a sparkline, not the decayed score over time. Good enough for S2.
- The /home payload uses the 7d bot stats window and a 7d timeline window, capped at 60 items.
Config keys: none.
Response shape (frozen, add-only):
  home: { generatedAt, identity { id, name, description, avatarSeed, enabled, running, backend,
          model, channel { kind, state } },
          presence { posture, nowLine, tone, enabled, running, isExecuting, phase, currentTool,
          lastRunAt, nextRunAt, skippedReason, lastError, pendingAsks, generatedAt },
          goals { active[], blocked[], completedRecently[] } (GoalDetail from stats/types),
          traits { current, baseline, drift, adjustments },
          karma { score, trend, delta7d, history[{ts,score}], recentEvents[{ts,delta,reason,source}] },
          timeline[{ ts, kind: llm|tool|production|ask|cycle|karma, title, detail, ok }],
          needsYou { asks, permissions, productionsPending } }
  presence: the `presence` object above.
Notes for S2:
- Build the Agent Home page on `/home`; reuse presenceHeader() and startPresenceLive() (move
  the latter into agent-home.js when the page moves). The chat panel can reuse renderThread from
  shared.js against the existing chat route used by Conversations/Inbox.
- Timeline items are already newest-first; group by hour client-side.
- `traits.current` is a Record<string, number> in 0.1..0.9 — feed radar() directly.
- Rebuild the container after backend changes (`docker compose up -d --build`); the web bind
  mount picks up page/CSS edits on refresh.
```

---

### S2 — Agent Home page

**Depends on:** S0, S1.
**Kickoff prompt:**
> Execute session S2 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and the Handoffs of S0 and S1. Build `#/agents/:id` as the Agent Home; move the old detail to `#/agents/:id/config`.

**Goal.** The agent as a person on one screen: who they are, what they are doing right now, what happened today, what they want, and a place to talk to them.

**Reads first.** `web/pages/agents.js` (`renderAgentDetail` around line 1092–1400 builds the evolution, LLM stats and soul banner cards), `web/pages/inbox.js` and `web/pages/shared.js` `renderThread` for the chat panel, `web/pages/conversations.js`, `web/ui/`.

**Steps.**
1. New `web/pages/agent-home.js` exporting `renderAgentHome(el, botId)`. Layout: presence header (avatar, name, posture dot with color, `nowLine`, channel state, Start/Stop/Run now), then a two-column body: left = chat panel (reuse `renderThread` against the existing chat route used by Conversations/Inbox), right = today timeline. Below: goals board (Active / Blocked / Done, drag disabled for now), traits radar, karma sparkline, "Needs you" strip linking into the queue.
2. Subscribe to `/ws/activity`, filter by `botId`, update `nowLine`, posture dot and prepend timeline items live. Fall back to polling the home endpoint every 30 s.
3. Route table in `web/app.js`: `#/agents/:id` → Agent Home; `#/agents/:id/config` → old `renderAgentDetail`; `#/agents/:id/edit` unchanged. Add a "Config" tab in the header.
4. Extract any logic (timeline grouping by hour, karma trend label, goal bucketing) into `web/pages/agent-home-helpers.js` for tests.
5. Empty states for a brand-new agent (no goals, no timeline) that explain what will appear.

**Tests.** `tests/web/agent-home-helpers.test.ts`. Manual: open Home for an enabled bot, a disabled bot and a headless bot; trigger "Run now" and watch the now-line move.

**Exit criteria.** Home loads under one second from cache, updates live during a cycle, works at 400px, old config page still reachable. `docs/architecture-docs/web-dashboard.html` updated.

**Demo.** Open `#/agents/:id`: the whole Agent Home. Chat with the agent on the left while its timeline fills on the right; goals, traits and karma below. The old form is one click away under Config.

**Handoff (S2, done 2026-09-13).**
```
Shipped:
- web/pages/agent-home.js: renderAgentHome(el, id), destroyAgentHome(). Layout: presenceHeader
  (actions: Run now / Stop or Start / Config) -> homeTabs -> needs-you strip (#home-needs) ->
  .home-grid [chat card | timeline card (#home-timeline)] -> .home-grid-3 [goals | traits | karma].
  Chat = newest `general` dashboard conversation (GET /api/conversations/:botId?type=general&limit=1),
  created on first send (POST /api/conversations/:botId { type:'general', title }), then the same
  messages / status / retry / approve flow as web/pages/conversations.js (duplicated on purpose —
  see Left out). Live: watchAgent() refreshes the header on every event and refetches /home
  (3 s debounce) to redraw timeline + needs strip.
- web/pages/agent-home-helpers.js (added): TIMELINE_KIND_TONE/LABEL, hourLabel, groupTimelineByHour,
  timelineRow, timelineBody, goalsColumns, traitAxes, karmaTone, needsYouStrip, homeTabs, ago,
  traitsBody, karmaBody. All pure; tests in tests/web/agent-home-page-helpers.test.ts (26).
- web/pages/live-presence.js: watchAgent(botId, { onPresence, onEvent, debounceMs, pollMs }) ->
  { stop, refresh }; stopAllWatches(). agents.js (Config page) now uses it too.
- Routes: #/agents/:id -> Home, #/agents/:id/config -> old detail (with the presence header, back
  link to Home, and the tab strip), #/agents/:id/edit unchanged. app.js navigate() calls
  destroyAgentHome(), destroyAgentDetail(), stopAllWatches().
- web/style.css: "Agent Home page" block (.home-grid, .home-grid-3, .home-needs, .home-chat,
  .home-timeline / .home-tl-*, .home-goal*, .home-karma*, .home-traits-radar).
- Docs: CHANGELOG, web-dashboard.html (Agents page section), README pages list.
Left out / deviations:
- Not verified in a browser: the dashboard needs a login and automation cannot enter credentials.
  Verified instead: module smoke-import under a DOM stub, 26 helper tests, lint, full suite green,
  and the container serving app.js / agent-home.js / agent-home-helpers.js / live-presence.js.
  FIRST THING in S3: log in, open #/agents/default, send a chat message, click Run now, and
  confirm the header + timeline move. Fix anything visual before touching the fleet grid.
- The chat controller duplicates ~120 lines of conversations.js logic. Follow-up (S5 or S6):
  extract `mountConversation(container, botId, conversationId, opts)` into shared.js and use it
  from Conversations, Inbox, Productions and Home.
- /home is cached 15 s server-side, so an event-triggered timeline refresh can lag up to 15 s.
- Goals are read-only here (no drag, no status change) — the plan said "drag disabled for now".
- The Agents list page (#/agents) still links rows to #/agents/:id, which is now Home. Good.
New files / exports: see above.
Notes for S3/S4/S6:
- Fleet grid cards: reuse avatar() + badge(toneFor(posture)) + the presence nowLine; a cheap
  GET /api/agents/presence (id -> presence) is still to be added (plan S3 step 1) — build it in
  src/web/routes/agent-home.ts next to the per-bot routes, composed from buildPresence().
- Avatar hook point (S4): presenceHeader() and avatar() already accept `identity.avatarUrl` /
  `src`; the backend just needs to populate identity.avatarUrl when an upload exists.
- Wizard (S6): after creation, redirect to #/agents/:id — the Home chat panel opens an empty
  conversation and the first send creates it, so "first greeting" just needs one POST.
```

---

### S3 — Fleet Home and navigation collapse

**Depends on:** S2.
**Kickoff prompt:**
> Execute session S3 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S2's Handoff. Replace the dashboard home with the fleet grid and collapse the sidebar to seven areas without breaking any old hash route.

**Goal.** The first screen after login shows the fleet as people, and the navigation stops listing 27 things.

**Reads first.** `web/pages/dashboard.js`, `web/index.html` sidebar, `web/app.js` routes, `src/web/routes/dashboard.ts` (`/badges`), `/api/status`.

**Steps.**
1. New `web/pages/fleet-home.js`: a card per agent (avatar, posture, nowLine, karma, last output, unread asks) fed by `/api/agents` plus a new lightweight `GET /api/agents/presence` (id → posture, nowLine, karma) added in `src/web/routes/agent-home.ts`. Live updates over `/ws/activity`. A global ticker at the top with the last ten fleet events. The old agent-loop results table moves under Insights → Activity.
2. Sidebar becomes: **Home**, **Agents**, **Needs You** (placeholder badge until S5), **Work** (Productions, Conversations, Sessions), **Automations** (Cron, Skills, Tools, Tool Runner), **Insights** (Stats, Behaviour, Infra, Hygiene, Karma, Activity, Feedback), **Settings** (Settings, Integrations, BaaS group when enabled). Sub-navigation renders as tabs at the top of each area.
3. Every old hash keeps resolving: add redirect entries in `web/app.js` (`#/karma` → `#/insights/karma`, etc.). Keep admin/tenant visibility rules from `navigate()`.
4. Remove the `nav-link-admin` sprinkled inline `style="display:none"` in favour of a class toggled from `navigate()`.

**Tests.** `tests/web/fleet-home-helpers.test.ts`, `tests/web/nav-routes.test.ts` asserting every old route maps to a handler (import the route table; make it exportable).

**Exit criteria.** Login lands on the fleet grid; every old bookmark still works; sidebar readable on a phone; `README.md` dashboard pages list updated.

**Demo.** Log in: the fleet grid with a live ticker is the first screen; the sidebar has seven areas; every old bookmark still lands somewhere.

**Handoff (S3, done 2026-09-14).**
```
Shipped:
- GET /api/agents/presence (src/web/routes/agent-home.ts; buildFleetPresence, FleetPresenceEntry,
  FleetPresenceResponse, FLEET_PRESENCE_TTL_MS = 3_000 in src/stats/agent-home-aggregator.ts):
  { generatedAt, agents: { [id]: { id, name, posture, nowLine, tone, enabled, running, isExecuting,
  phase, currentTool, karma, pendingAsks, unreviewed, lastRunAt, nextRunAt, lastOutputAt,
  channel { kind, state } } } }. Tenant-scoped (scopeBots), cached 3 s per tenant, a bot whose
  aggregation throws gets safe defaults. The agent-home mount moved ABOVE agentsRoutes in
  server.ts: their GET /:id answered /presence with "Agent not found" (route test covers it).
- web/nav-routes.js (pure, tested): AREAS (7 areas + tabs with admin/baas flags), ROUTES (49
  canonical patterns -> handler name + area + args), REDIRECTS (18 legacy prefixes),
  resolveRedirect, resolveHash, matchRoute, areaFor, visibleTabs, visibleAreas, areaHref,
  activeTab, needsBadgeCount, sidebarLinks, areaNav.
- web/app.js rewritten on top of it: `handlers` map (name -> page fn), renderChrome() renders the
  sidebar (#nav-areas) and the area tab strip (#area-nav) from nav-routes with the auth context;
  legacy hashes are rewritten with location.replace(); loadBadges re-renders the chrome when
  counts change. Pages render into #page (index.html: #content = #area-nav + #page); the one page
  that reached document.getElementById('content') (productions.js) now targets #page.
- web/pages/fleet-home.js: renderFleetHome(el), destroyFleetHome(). Header (summary line, Loop
  controls -> #/insights/loop, Agents), ticker (#fleet-ticker-body, last 10, seeded from
  GET /api/activity?limit=10 which is oldest->newest), grid (#fleet-grid-wrap). Live: watchFleet()
  -> onEvent prepends to the ticker, onPresence redraws cards in place; card order fixed at render.
- web/pages/fleet-home-helpers.js (pure, 12 tests): TICKER_LIMIT, POSTURE_ORDER, sortFleet,
  fleetSummary, fleetCard, fleetGrid, describeEvent (one sentence + tone per activity event type),
  pushTicker (dedup + cap), tickerRow, tickerBody.
- web/pages/live-presence.js: watchFleet({ onPresence, onEvent, debounceMs = 1500, pollMs }) next
  to watchAgent(); both share openLink(); stopAllWatches() covers both.
- web/style.css: "Navigation areas + area tab strip" and "Fleet Home" blocks (.nav-areas,
  .area-tabs, .fleet-*; staggered card reveal, pulsing dot on executing cards, reduced-motion
  guard, one column under 900px).
- The old dashboard page is Insights -> Agent loop (#/insights/loop, legacy #/dashboard); its
  title reads "Agent loop". agent-home-helpers.js / agent-home.js links point at canonical hashes.
- Tests: tests/web/nav-routes.test.ts (19, incl. the handler-name guard against app.js),
  tests/web/fleet-home-helpers.test.ts (12), tests/web/routes/agent-home.test.ts (+4, 15 total). tsc clean, biome
  clean. Docs: CHANGELOG, web-dashboard.html (API row, navigation section, Fleet Home + Agent loop
  cards), README (pages paragraph + list), CLAUDE.md stats row.
Left out:
- Not verified in a browser (login blocks automation). Verified instead: app.js + fleet-home.js +
  nav-routes.js smoke-booted under a DOM stub (fleet grid + ticker rendered, #/karma redirected to
  #/insights/karma, Insights strip marked Karma active), the container serves every new asset,
  GET /api/agents/presence on the live container returns the 8 real agents. FIRST THING in S4/S5:
  log in, confirm the grid, click a few old bookmarks, resize to phone width.
- "The old agent-loop results table moves under Insights -> Activity": it moved under Insights as
  its own tab "Agent loop" (the Activity page's internal Events/Logs/LLM tabs were left alone).
- No posture_changed push event (S1 left it out too); the fleet map is refetched 1.5 s after any
  activity event and every 30 s, and the server caches it 3 s, so a posture change shows within
  ~5 s of the next event or 30 s otherwise.
- The old in-page links across web/pages/*.js (href="#/inbox", "#/stats/bot/…", …) were NOT
  rewritten; they work through the redirects (one location.replace hop). Rewrite as pages are
  touched. `homeTabs`, `needsYouStrip` and the Home karma link already use canonical hashes.
- Sidebar badge counts other than Needs You: Feedback shows on the Insights tab strip only.
Route map (old -> new):
  #/inbox[/…]        -> #/needs/inbox[/…]        #/permissions      -> #/needs/permissions
  #/agent-proposals  -> #/needs/proposals        #/productions[…]   -> #/work/productions[…]
  #/conversations[…] -> #/work/conversations[…]  #/sessions[…]      -> #/work/sessions[…]
  #/cron[…]          -> #/automations/cron[…]    #/skills[…]        -> #/automations/skills[…]
  #/tools[…]         -> #/automations/tools[…]   #/tool-runner      -> #/automations/tool-runner
  #/stats[…]         -> #/insights/stats[…]      #/karma[…]         -> #/insights/karma[…]
  #/feedback[…]      -> #/insights/feedback[…]   #/activity[?tab=]  -> #/insights/activity[?tab=]
  #/logs             -> #/insights/activity?tab=logs   #/dashboard   -> #/insights/loop
  #/integrations     -> #/settings/integrations  #/baas/*           -> #/settings/baas/*
  Unchanged: #/, #/agents, #/agents/:id, #/agents/:id/config, #/agents/:id/edit, #/settings.
Notes for S5/S8/S9:
- S5 (Needs You queue): the area exists (#/needs, tabs Inbox / Permissions / Proposals, sidebar
  badge = needsBadgeCount(badges)). Build the unified queue as the `inbox` handler's replacement
  or as a new first tab; the Inbox/Permissions/Proposals pages keep working under their tabs.
- S8 (command palette): AREAS + ROUTES in web/nav-routes.js are the palette's route index —
  every canonical hash and label is already there; add `keywords` to tabs if needed.
- S9 (PWA): the fleet grid is one column under 900px; the ticker rows truncate with ellipsis.
  #topbar already shows the bot count; consider the Needs You badge there too.
- Adding a page: add a ROUTES entry (handler name) + a handler in app.js + a tab in AREAS if it
  has a sidebar home; tests/web/nav-routes.test.ts fails until the handler exists.
```

---

### S4 — Face and voice

**Depends on:** S2. Optional, can run any time after.
**Kickoff prompt:**
> Execute session S4 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S2's Handoff. Give each agent an avatar and a playable voice.

**Goal.** Each agent looks and sounds like someone specific.

**Steps.**
1. Avatar: `avatar.js` seed already renders a deterministic SVG. Add upload: `POST /api/agents/:id/avatar` (PNG/JPEG ≤ 512 KB) stored as `avatar.png` in the bot's soul dir, served by `GET /api/agents/:id/avatar`. Export/import (`bot-export-service.ts`) must include it.
2. Voice: `POST /api/agents/:id/speak { text }` runs `generateSpeech` (`src/tts.ts`) with the bot's `tts.voiceId` and streams audio back; a play button on the Home header reads the current nowLine. Voice picker in the config page lists ElevenLabs voices via a cached `GET /api/tts/voices`.
3. Fleet grid and Home use the uploaded avatar when present.

**Tests.** Route tests for size/type validation and export inclusion; `speak` returns 503 when TTS is not configured.

**Exit criteria.** Upload, play and export round-trip verified. CHANGELOG and web-dashboard doc updated.

**Demo.** Upload a face for an agent and press play on its header: it says its now-line in its own voice.

**Handoff (S4, done 2026-09-14).**
```
Shipped:
- src/bot/agent-avatar.ts: AVATAR_MAX_BYTES (512 KB), AVATAR_FILENAMES, AvatarType, AvatarFile,
  AvatarValidationError { code: 'empty' | 'bad-type' | 'too-large' }, sniffImageType(buf),
  validateAvatar(buf), findAvatar(soulDir), writeAvatar(soulDir, buf) (replaces the other
  variant), removeAvatar(soulDir), avatarUrl(botId, file) -> '/api/agents/:id/avatar?v=<mtime>'.
  The face lives in the soul dir on purpose: BotExportService already archives the whole soul
  dir, so export/import carries it with zero new code (tests prove both directions).
- src/web/routes/agent-face.ts: agentFaceRoutes({ config, logger, soulDirOf?, speak? }) mounted
  at /api/agents (after agentsRoutes; no path collides with /:id). GET /:id/avatar (bytes,
  Content-Type, Cache-Control: no-cache, ETag, 304 on If-None-Match, 404 { error: 'No avatar' }),
  POST /:id/avatar — request format: RAW BODY with Content-Type image/png or image/jpeg (also
  accepts multipart/form-data with a `file` field); 413 over 512 KB, 415 non PNG/JPEG (type is
  sniffed from the bytes, the declared MIME is ignored), 400 empty; returns { ok, avatarUrl,
  contentType, size }. DELETE /:id/avatar -> { ok, removed }. POST /:id/speak { text } ->
  generateSpeech(text, resolveTtsConfig(media.tts, bot)) streamed back with the content type
  from audioContentType(outputFormat, bytes) (sniffs OggS / ID3 / MP3 sync, then the format
  prefix: opus->audio/ogg, mp3->audio/mpeg, pcm->audio/L16, ulaw->audio/basic), Cache-Control:
  no-store, X-TTS-Latency-Ms, X-TTS-Voice-Id. 503 when media.tts.apiKey is unset, 400 empty or
  > SPEAK_MAX_CHARS (2000), 502 ElevenLabs error, 504 timeout. All tenant-scoped (404 outside).
- src/web/routes/tts.ts: ttsRoutes({ config, logger, fetch?, now? }) at /api/tts. GET /voices ->
  { voices: [{ voice_id, name, labels, preview_url }], defaultVoiceId, cachedAt }, cached
  VOICES_CACHE_TTL_MS = 10 min in-process, ?refresh=1 bypasses, failures never cached, 503
  unconfigured, 502 upstream. Types TtsVoice, TtsVoicesResponse.
- src/tenant/middleware.ts: createTenantAuthMiddleware(tm, logger, sessionStore, { allowQueryToken })
  + allowsQueryToken(method, path) = GET && /^\/api\/agents\/[^/]+\/avatar$/. Wired in server.ts.
  This is the whole reason <img src> works in multi-tenant mode; header still wins when present.
- src/stats/agent-home-aggregator.ts: AgentIdentity.avatarUrl (string | null) and
  AgentIdentity.voiceEnabled (Boolean(config.media?.tts?.apiKey)); FleetPresenceEntry.avatarUrl.
  Both resolve the soul dir with resolveBotPaths, the same as the route, so they cannot disagree.
- web/pages/agent-face-helpers.js (pure, 8 tests): AVATAR_MAX_BYTES, AVATAR_TYPES, CUSTOM_VOICE,
  SPEAK_STATES, avatarEndpoint, speakEndpoint, withToken(url, token), validateAvatarFile(file),
  faceControl(id, { hasAvatar }), speakButton({ state }), voiceLabel, isKnownVoice,
  voiceOptions(voices, { selected, defaultVoiceId }), resolveVoiceChoice(select, custom).
- web/pages/agent-face.js (DOM): authedAvatarSrc(url), uploadAvatar(id, file), deleteAvatar(id),
  wireFaceControl(root, id, { onChanged }), wireSpeakButton(root, id, getText) -> { stop }.
- presenceHeader(home, { avatarSrc, face, voice, ... }) grew three options; fleetCard/fleetGrid
  take a trailing { avatarSrc } option. Home + Config pages render face: true and
  voice: identity.voiceEnabled; Fleet Home passes { avatarSrc: authedAvatarSrc }.
- Config edit form: Voice select fed by /api/tts/voices on render (no more "Load Voices"), with
  "Custom voice id…" -> #tts-voice-custom text input, a Preview button playing preview_url (no
  credits), and resolveVoiceChoice() on save. Speed / Stability fields unchanged.
- web/style.css: "Face and voice — session S4" block (.presence-face*, .presence-now-row,
  .presence-speak[data-state], .tts-voice-*). No new tokens.
- Tests: tests/bot/agent-avatar.test.ts (8), tests/web/routes/agent-face.test.ts (18),
  tests/web/routes/tts.test.ts (5), tests/tenant-query-token.test.ts (6),
  tests/web/agent-face-helpers.test.ts (8), +2 export/import cases, +2 header/card cases,
  fleet key list updated. tsc clean; biome clean on every touched file.
- Docs: CHANGELOG, web-dashboard.html (5 API rows + "Face and voice (S4)" note), README
  (Agents line + dashboard paragraph), CLAUDE.md bot table (agent-avatar.ts).
Left out / deviations:
- Not verified in a browser (login blocks automation). Verified instead: route tests, module
  smoke-boot under a DOM stub (header + card render the tokenised face url, controls bind),
  container serves agent-face.js / agent-face-helpers.js / style.css with the new symbols,
  and the live API answers 401 on the new paths unauthenticated. FIRST THING in S5: log in,
  open #/agents/default, hover the avatar -> pencil -> upload a PNG, press play next to the
  now-line, then open #/agents/default/edit and check the voice select filled.
- /home is cached 15 s server-side, so after an upload the page swaps the <img> in place from
  the upload response instead of refetching; a removed face re-renders the page (seed avatar).
  The Fleet Home picks the new face up on its next presence refetch (<= 3 s cache + 30 s poll).
- "Play" says the now-line as rendered (the #presence-now text), not a fresh LLM line.
- No rate limit on /speak beyond the explicit button; every press costs ElevenLabs credits.
- The early Content-Length 413 in the upload route is not covered by a test: Request normalises
  the header to the real body size, so only the byte-length path is observable in-process.
Config keys: none. Request format for uploads is raw body (documented); multipart also works.
Notes for S5/S6:
- Wizard (S6): after creating an agent, POST its face with fetch(avatarEndpoint(id), { method:
  'POST', headers: { 'Content-Type': file.type, Authorization }, body: file }).
- Any page that renders avatar({ src }) for an uploaded face must pass the url through
  authedAvatarSrc(); a bare /api/agents/:id/avatar 401s in multi-tenant mode.
```

---

## Phase 2 — Simple

### S5 — Needs You queue

**Depends on:** S3.
**Kickoff prompt:**
> Execute session S5 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S3's Handoff. Merge Inbox, Permissions, Feedback replies, Agent Proposals and pending Productions into one queue with keyboard triage.

**Goal.** One place where a human answers everything the fleet is waiting on.

**Reads first.** `src/web/routes/ask-human.ts`, `ask-permission.ts`, `agent-feedback.ts`, `agent-proposals.ts`, `productions.ts` (`/all-entries`, `evaluate`), `web/pages/inbox.js`, `permissions.js`, `agent-proposals.js`, `src/bot/inline-approval.ts` (`describeToolCall`).

**Steps.**
1. `src/web/routes/needs-you.ts` → `GET /api/needs-you` returning a sorted list of items `{ id, kind: 'ask'|'permission'|'proposal'|'production'|'feedback', botId, title, body, options?, createdAt, urgency }` and `GET /api/needs-you/count`. Actions stay on their existing routes; the page calls them.
2. `web/pages/needs-you.js`: list on the left, detail on the right, keyboard: `j`/`k` move, `a` approve/answer, `d` deny/dismiss, `r` reply, `o` open the agent's Home. Quick-reply chips render `options` from `ask_human`.
3. Single badge in the sidebar replaces the four badges. Old pages remain reachable under Insights/Work for history views.
4. `config.operator.notifyOnAsk` (already in the schema, unconsumed) becomes real: when true, a new ask sends a Telegram message to the operator via the existing proactive path. S9 adds web push on the same hook.

**Tests.** `tests/web/routes/needs-you.test.ts` (merge order, counts, tenant scoping), `tests/web/needs-you-helpers.test.ts` (keyboard reducer), test for `notifyOnAsk`.

**Exit criteria.** Every pending item type shows and can be resolved from the queue; count matches the sum of the old counters.

**Demo.** Open Needs You: every pending ask, permission, proposal and unreviewed production in one list; answer three items using only the keyboard.

**Handoff (S5, done 2026-09-14).**
```
Shipped:
- src/web/routes/needs-you.ts: needsYouRoutes({ config, logger, sources, now? }) mounted at
  /api/needs-you in server.ts (after /api/dashboard). GET / -> NeedsYouResponse { generatedAt,
  count, byKind, items[] }, GET /count -> { count, byKind }. Exports: NEEDS_YOU_KINDS,
  NeedsYouItem / NeedsYouAction / NeedsYouKind / NeedsYouUrgency / NeedsYouActionId types,
  NeedsYouSources (asks?, conversations?, permissions?, proposals?, productions?, feedback?),
  buildNeedsYou(deps, allowedBotIds | undefined, nowMs) (the whole list without HTTP),
  sortNeedsYou, countByKind, pendingProductionFiles(entries), lastBotReply(feedback),
  needsYouSourcesFromBotManager(bm), PRODUCTIONS_SCAN_LIMIT = 5000. Tenant-scoped via
  scopeBots; every source read and every row map is try/caught and logged, never a 500.
- web/pages/needs-you-helpers.js (pure, 17 tests): KIND_LABEL, KIND_TONE, URGENCY_TONE,
  SHORTCUTS, initialState(items, prevSelectedId), selectedItem, moveSelection(state, delta),
  removeItem(state, id) (selection -> next, else previous, else null), actionByHotkey(item, 'a'|'d'),
  buildRequest(action, text) -> { path, method, body? } | { error }, reduceKey(state, key,
  { inInput, mod, replyText }) -> { state, effect: none|act|focusReply|blurReply|open|help },
  listRow, listBody, chipBar(options, chipIndex), detailPanel(item, state, nowMs), shortcutsHelp,
  queueSummary(byKind).
- web/pages/needs-you.js: renderNeedsYou(el), destroyNeedsYou(). Loads /api/needs-you, polls
  every 15 s (skipped while a reply is being typed), document-level keydown -> reduceKey ->
  effects; actions go through api(action.path, { method, body }) exactly as the item describes;
  success removes the item, toasts, dispatches window 'badges:refresh' (app.js re-polls) and
  re-reads the queue 1.5 s later. Chip click sends it; digits only focus it. '?' opens the
  shortcuts in a ui sheet.
- web/nav-routes.js: Needs You tabs are now Queue (#/needs, badge 'needs') / Inbox / Permissions
  / Proposals / Feedback (#/needs/feedback[/:botId] -> the existing feedback handlers; Insights
  keeps its Feedback tab too). ROUTE #/needs -> handler 'needsYou'. needsBadgeCount(badges)
  returns badges.needs when it is a number, else the legacy sum. areaNav resolves the 'needs'
  badge key through needsBadgeCount.
- web/app.js: handler needsYou, destroyNeedsYou() in navigate(), loadBadges() fetches
  /api/dashboard/badges and /api/needs-you/count in parallel and merges { needs: count };
  listens for 'badges:refresh'.
- web/style.css: "Needs You queue" block (.needs-*; kbd styling; one column under 900px).
- notifyOnAsk: src/tools/ask-human.ts exports OperatorNotifier, OperatorNotification,
  createFleetOperatorNotifier(getBot, getAnyBot); AskHumanDeps.notifyOperator is the injected
  sender (falls back to the asking bot's own instance when absent). bot-manager.ts wires the
  fleet notifier (own instance -> any live instance). +5 tests in ask-human-protocol, +1 schema
  guard in config-operator-askhuman (default stays off).
- Tests: tests/web/routes/needs-you.test.ts (14), tests/web/needs-you-helpers.test.ts (17),
  nav-routes (+3 legacy rows, badge + tab assertions). tsc clean, biome clean. Docs: CHANGELOG,
  web-dashboard.html (API rows, nav note, page card), README, CLAUDE.md bot-manager row.
Left out / deviations:
- Not verified in a browser (login blocks automation). Verified instead: route tests, helper
  tests, a DOM-stub smoke boot of needs-you.js that renders the real payload and triages three
  items with j/2/a/d/k/a (requests captured: conversation answer with the chip text, production
  reject, permission approve; empty state + badge refresh + shortcuts sheet), the container
  serving style.css / needs-you.js / needs-you-helpers.js / nav-routes.js / app.js with the new
  symbols, and /api/needs-you answering 401 unauthenticated. FIRST THING in S6: log in, open
  #/needs, answer three items with the keyboard, check the sidebar badge drops.
- "Single badge replaces the four badges": the sidebar has one badge (from /api/needs-you/count);
  the per-queue counts still show on the Needs You tab strip (Inbox / Permissions / Proposals /
  Feedback) because they are useful there. /api/dashboard/badges is still polled for them.
- The count is NOT the sum of the three legacy counters by design: it adds unreviewed outputs
  (one per active file, not per changelog line — so it can be lower than the fleet card's
  "N to review" pill, which counts entries) and feedback replies. The legacy sum remains the
  fallback in needsBadgeCount().
- A pending inbox conversation whose question expired with the process (restart) is listed with
  meta.live = false: answering it still goes through POST /api/conversations/:bot/:id/messages
  (which starts a normal chat reply), dismissing it deletes the conversation. Marking such a
  conversation 'answered' server-side is a follow-up for the conversations route.
- Feedback items are only threads where the bot spoke last; a fresh pending feedback with no bot
  reply is waiting on the bot and is not listed (the Feedback tab shows it).
- No live push on the queue page: 15 s poll + re-read after each action. S9 can subscribe to
  /ws/activity for ask / permission events and call refresh().
- The S2 follow-up (extract mountConversation() into shared.js) was not taken here.
Config keys: none added. operator.notifyOnAsk unchanged (optional, off by default).
Item shape (frozen, add-only):
  { id: '<kind>:<sourceId>' (production/feedback: '<kind>:<botId>:<id>'),
    kind: 'ask'|'permission'|'proposal'|'production'|'feedback', botId, botName, title, body,
    options: string[] | null, createdAt: ISO, urgency: 'high'|'normal'|'low',
    actions: [{ id: 'answer'|'approve'|'deny'|'reject'|'dismiss'|'reply', label,
                method: 'POST'|'DELETE', path, body?, input?: { field, required, placeholder },
                tone: 'ok'|'danger'|'muted', hotkey?: 'a'|'d' }],
    href, meta: Record<string, string|number|boolean|string[]|null> }
  Per kind: ask -> answer POST /api/conversations/:bot/:conv/messages { message } (or
  /api/ask-human/:id/answer { answer } without a conversation), dismiss DELETE /api/ask-human/:id
  (or DELETE /api/conversations/:bot/:conv when the question is gone); permission -> approve/deny
  POST /api/ask-permission/:id/(approve|deny) { note? }; proposal -> POST
  /api/agent-proposals/:id/(approve|reject) { note? }; production -> POST
  /api/productions/:bot/:id/evaluate { status, feedback? }; feedback -> reply POST
  /api/agent-feedback/:bot/:id/reply { message }, dismiss DELETE /api/agent-feedback/:bot/:id.
Notes for S9 (hook point for push):
- Telegram ping: notifyOperatorOfAsk() in src/tools/ask-human.ts calls deps.notifyOperator
  ({ chatId, botId, text }); add the web-push fan-out next to it (or wrap the notifier
  BotManager builds) so both fire from the same place with the same dedup rules.
- For a push payload reuse buildNeedsYou(deps, allowed, now) — it is the queue without HTTP —
  or the item shape above; the queue page URL is #/needs.
- Permissions have no notification at all today (only asks do); the ask_permission tool in
  src/tools/ask-permission.ts is the analogous hook point.
```

---

### S6 — Create-an-agent wizard

**Depends on:** S2.
**Kickoff prompt:**
> Execute session S6 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S2's Handoff. A new agent must go from "New" to first chat in under 60 seconds with no Telegram token.

**Goal.** Creating an agent is a conversation about who they are, not a JSON form.

**Reads first.** `web/pages/agents.js` `showNewAgentModal` (line ~2419) and `showGenerateSoulModal`, `src/web/routes/agents.ts` (`POST /`, `generate-soul`, `apply-soul`), `src/soul-generator.ts`, `src/web/routes/onboarding.ts` `first-bot`.

**Steps.**
1. `#/agents/new` page with three steps: (1) name and purpose in one sentence; (2) personality: four sliders mapped to the trait registers plus a free-text "quirks" box; (3) channels: web chat on by default, Telegram / WhatsApp / Discord optional with inline validation of the token via the existing channel-state classifier.
2. Backend: `POST /api/agents` accepts `{ purpose, personality, quirks }`; when present it runs the soul generator synchronously and applies the result, so the agent is born with IDENTITY, SOUL, MOTIVATIONS and initial GOALS. Headless when no token.
3. On finish, redirect to the new Agent Home with the chat focused and a first greeting requested through the chat route.
4. Rewrite `showNewAgentModal` to open the wizard; keep the advanced form as "Advanced" on step 3.

**Tests.** Route tests for the extended payload and validation; helper tests for slider → trait mapping. Manual timing of the 60-second path.

**Exit criteria.** Created agent chats immediately in the dashboard with a soul; no Telegram required; `README.md` quick start mentions the wizard.

**Demo.** Click New agent, fill three screens, and be chatting with a freshly-souled agent in under a minute with no Telegram token.

**Handoff (S6, done 2026-09-14).**
```
Shipped:
- web/pages/agent-wizard-helpers.js (pure, 27 tests): TRAIT_MIN/MAX, PERSONALITY_AXES (id, label,
  low, high, hint, drives[[trait, ±1] x2]), DEFAULT_PERSONALITY, STEPS, CHANNEL_KINDS, ID_PATTERN,
  GREETING_TEXT, FOCUS_CHAT_KEY, QUIRKS_MAX, PURPOSE_MIN, TELEGRAM_TOKEN_PATTERN,
  DISCORD_TOKEN_PATTERN, traitsFromPersonality, personalityFromTraits, personalityBlurb, deriveId,
  initialState, applyField(state, 'dotted.path', value) (immutable; name derives id until id is
  edited; clearing id hands derivation back), localTokenClass, validateStep(state, i) ->
  { ok, errors }, canCreate, buildCreatePayload, tokenStatusLabel, progressLabel, stepIndicator,
  stepWho, sliderRow, stepPersonality, channelCard, advancedBlock, stepChannels, wizardFooter,
  progressMarkup.
- web/pages/agent-wizard.js: renderAgentWizard(el), destroyAgentWizard(). Route #/agents/new
  (nav-routes ROUTES, handler 'agentWizard', registered before the :id patterns — an agent cannot
  be named "new"); app.js imports + destroys it. agents.js showNewAgentModal() now just navigates;
  the old modal is gone, its fields live in the Advanced block of step 3.
- Slider -> trait mapping (mirrored in src/bot/agent-wizard.ts, shared test vectors):
  warmth -> sociability up / independence down; boldness -> risk_tolerance up / caution down;
  rigor -> depth up / persistence up; playfulness -> creativity up / curiosity up.
  slider 0..1, register 0.1..0.9, up = 0.1 + 0.8x, down = 0.9 - 0.8x; all-0.5 = default traits.
- src/bot/agent-wizard.ts: Personality, PERSONALITY_AXES, isPersonality, normalizePersonality,
  personalityToTraits, describePersonality(p, quirks), WIZARD_SOUL_FILES, initialGoalsMarkdown,
  writeWizardSoul(soulDir, soul, goalsMd) (refuses to overwrite), traitsBaseDirFor(config),
  seedTraits(baseDir, id, traits, logger, policy?), ChannelKind/CHANNEL_KINDS/isChannelKind,
  TokenState, TokenValidation, TelegramTokenCheck, DISCORD_TOKEN_PATTERN,
  createTelegramTokenCheck(fetch?, timeoutMs?), validateChannelToken(kind, token, check?).
- src/bot/trait-registers.ts: TraitRegisters.seed(botId, traits) — unbounded first write, single
  'adaptive' snapshot (drift baseline), pins applied. +4 tests.
- src/web/routes/agents.ts: agentsRoutes({ ..., wizard?: { generateSoul?, telegramCheck? } }),
  exports AgentWizardDeps, CreateAgentWizardBody, BOT_ID_PATTERN, isSafeBotId. POST / (see
  contract), POST /validate-token. server.ts unchanged (defaults = real generator + live getMe).
- web/pages/agent-home.js: mountChat.load() checks /status and polls when a reply is in flight;
  focuses .thread-input once when sessionStorage[FOCUS_CHAT_KEY] === botId.
- web/style.css "Create-an-agent wizard" block (.wizard-*). No new tokens.
- Tests: tests/web/agent-wizard-helpers.test.ts (27), tests/bot/agent-wizard.test.ts (19),
  tests/web/routes/agents-wizard.test.ts (16), trait-registers (+4), nav-routes (+1 legacy row).
  tsc clean, biome clean on touched files. Docs: CHANGELOG, web-dashboard.html (2 API rows +
  page section), README (quick start step 4 + Agents line), CLAUDE.md (agent-wizard row, seed note).
Left out / deviations:
- Not verified in a browser (login blocks automation). Verified instead: helper + route tests, a
  DOM-stub smoke boot of agent-wizard.js (step 1 renders, /defaults fetched, payload assembled),
  the container rebuilt healthy and serving agent-wizard*.js / app.js / nav-routes.js / style.css
  with the new symbols, POST /api/agents/validate-token answering 401 unauthenticated.
  FIRST THING in S7: log in, Agents -> New Agent, fill three screens with no token, time it.
- The greeting is two POSTs from the page (create conversation, then message), not one: the
  conversations route has no "create + send" form. The Home chat picks the in-flight reply up.
- `greet` is accepted by POST /api/agents for forward compatibility but the server does not send
  the greeting itself (it would need a started bot + the conversations service); the page does.
- Start is done by the page (POST /:id/start?enable=true) after creation; with "Start the agent
  right away" unticked the agent is created enabled: false and no greeting is sent.
- No avatar upload in the wizard (S4's hook still applies: POST /api/agents/:id/avatar after
  creation). No preset row yet — that is S7.
- Discord / WhatsApp tokens are validated by shape only; no live check exists for them.
- The wizard writes TRAITS.json at <paths.data>/tenants/__admin__/bots/<id>/TRAITS.json (where
  BotManager's TraitRegisters reads it); for a bot with a custom soulDir or a tenant the soul and
  the traits can live in different trees — same as the runtime today, not a regression.
Config keys: none.
Payload contract (POST /api/agents, add-only):
  legacy: { id, name, token?, enabled?, skills?, ... } -> 201 flat BotConfig (token masked).
  wizard: { id, name, purpose, personality?: { warmth, boldness, rigor, playfulness } (0..1) |
           traits?: Partial<TraitSet>, quirks?, token: string | null, enabled?, language?,
           emoji?, generation?: { llmBackend: 'ollama'|'claude-cli', model? }, llmBackend?,
           model?, whatsapp?: { phoneNumberId, accessToken, verifyToken? }, discord?: { token },
           greet? }
        -> 201 { agent: BotConfig(masked, running), soul: { generated: true,
                 files: ['IDENTITY.md','SOUL.md','MOTIVATIONS.md','GOALS.md','TRAITS.json'], soulDir } }
        -> 400 bad id / empty purpose / bad personality, 409 duplicate id or soul_exists,
           502 soul_generation_failed (nothing written), 500 soul_write_failed (rolled back).
  POST /api/agents/validate-token { kind: 'telegram'|'whatsapp'|'discord', token } ->
        { kind, state: 'ok'|'shaped'|'placeholder'|'missing'|'revoked'|'error', live, detail, username? }
Notes for S7 (where presets plug into step 1):
- A preset is a partial wizard state: { name?, purpose, personality, quirks, advanced? }. Apply it
  with successive applyField() calls (or spread over initialState()) before render(); the id
  derives from the name unless the preset sets idTouched. Add a preset strip above stepWho()'s
  name field (stepWho is pure markup; the page owns the state) and keep the strip's data in a
  pure module so tests can assert each preset validates on every step (canCreate(applyPreset())).
- personalityBlurb(preset.personality) is the natural preset caption; traitsFromPersonality()
  gives the radar for a preview card (ui radar()).
- Server side needs nothing new: a preset is just a wizard payload.
```

---

### S7 — Presets

**Depends on:** S6.
**Kickoff prompt:**
> Execute session S7 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S6's Handoff. Ship five presets the wizard can start from.

**Steps.**
1. `config/presets/*.json`: `assistant` (personal Jarvis), `researcher`, `job-seeker`, `coder`, `social`. Each holds purpose, personality sliders, skills, tools to disable, agent-loop cadence, initial goals.
2. `src/bot/presets.ts` (`listPresets`, `loadPreset`, `applyPreset`) reused by the wizard step 1 as cards. In multi-tenant mode presets are also exposed through the existing `TemplateService` so tenants see them as templates.
3. `GET /api/agents/presets`.

**Tests.** Preset files validate against the bot config schema; `applyPreset` merges without clobbering user input.

**Exit criteria.** Picking a preset pre-fills the wizard; creating from each preset produces a working headless agent.

**Demo.** Pick "Researcher" in the wizard and see purpose, personality and goals pre-filled; create it and open its GOALS.md from the Config tab.

**Handoff (S7, done 2026-09-14).**
```
Shipped:
- src/bot/presets/{assistant,researcher,job-seeker,coder,social}.json — the catalogue. Under src/,
  NOT config/presets/: the Dockerfile copies src/ and treats config/ as a volume seeded only with the
  three example files, so a preset under config/ would never be in the image. Each holds id, name
  (suggested: Jarvis / Scout / Hunter / Forge / Echo), emoji, description (one line), purpose,
  personality { warmth, boldness, rigor, playfulness }, quirks, skills[], disabledTools[],
  agentLoop { every, mode }, goals[{ text, priority, notes? }].
- src/bot/presets.ts: PRESET_IDS, PresetId, PresetGoalSchema, AgentPresetSchema (Zod; every file is
  parsed at module load), AgentPreset, PresetGoal, listPresets(), getPreset(id) (copies; undefined
  for unknown), PresetFields, applyPreset(preset, input) (pure; fills only `undefined` fields —
  '' and [] from the user are kept; personality and agentLoop merge per key; stamps `preset`),
  presetGoalsMarkdown(preset, purpose) (purpose goal first, then preset goals with
  source: preset:<id>; parseable by tools/goals.ts), presetToBotConfig(preset, id),
  presetSummary(preset) / PresetSummary (the API shape), presetToTemplateConfig(preset),
  presetTemplateId(id) -> 'preset:<id>'.
- src/bot/agent-wizard.ts: purposeGoalEntry(purpose) extracted; initialGoalsMarkdown uses it.
- src/config.ts: BotConfigSchema.preset?: string (provenance stamp; nothing reads it at runtime).
- src/web/routes/agents.ts: GET /api/agents/presets (before /:id) -> PresetSummary[].
  POST /api/agents accepts `preset`: getPreset -> 400 "Unknown preset" if bad; applyPreset(preset,
  body) runs BEFORE the wizard/legacy split, so { id, preset } alone is a wizard creation.
  newBot now carries agentLoop and preset when present (add-only; legacy path unchanged otherwise).
  GOALS.md = presetGoalsMarkdown when a preset is set; reply soul.preset = id.
  CreateAgentWizardBody.preset?: string.
- src/tenant/template-service.ts: BotTemplate.builtin?: boolean, BuiltinTemplateInput,
  TemplateService.registerBuiltin(input) (in-memory only, stable id, list() puts built-ins first,
  get()/instantiate()/hasUpdate() resolve them, update()/delete() refuse them, never persisted).
  src/bot/bot-manager.ts initializeTenantManager registers the five presets as preset:<id>.
- web/pages/agent-wizard-helpers.js: LOOP_EVERY_PATTERN, CUSTOM_PRESET, parseList(v),
  applyPresetToState(state, preset) (immutable; tracks state.preset + state.presetFilled so a later
  pick replaces only what the previous preset put there; CUSTOM_PRESET/null blanks those),
  presetStrip(presets, selectedId) (null = "Loading presets…", [] = no strip, Custom card first,
  aria-pressed), stepWho(state, errors, { presets }) renders <div data-presets-slot> above the name
  field, advancedBlock(state, { defaults, errors }) gains skills / disabledTools (comma-separated
  text) / loopEvery (validated on step 3: "Use a duration like 30m, 2h or 1d.") / loopMode (select).
  initialState(): preset: '', presetFilled: {}, advanced.{skills,disabledTools,loopEvery,loopMode}.
  buildCreatePayload adds preset / skills / disabledTools / agentLoop only when set (S6's exact
  payload test still passes byte-for-byte).
- web/pages/agent-wizard.js: fetches /defaults and /presets in parallel on mount, paints the strip
  into the slot (paintPresets) so typing is not interrupted, delegated click on [data-preset] ->
  pickPreset -> applyPresetToState + re-render. destroyAgentWizard clears the catalogue.
- web/style.css: .wizard-presets (auto-fill grid), .wizard-preset (button card), -selected,
  -emoji, -name, -desc, .wizard-presets-loading. Tokens only (--accent, --accent-bg, --border).
- Tests (+60, bun test 5349 pass; log-tail rotation flake is pre-existing):
  tests/bot/presets.test.ts (35: catalogue order, copies, per-preset schema + skills exist under
  src/skills + tools known to TOOL_CATEGORIES + BotConfigSchema.parse of a full bot + GOALS.md
  round-trip + traits in band; applyPreset precedence/purity; summary/template shapes),
  tests/web/routes/agents-presets.test.ts (7: GET list, not shadowed by /:id, { id, preset }
  builds everything, caller wins field by field, unknown preset 400, S6 payload unchanged),
  tests/web/agent-wizard-presets.test.ts (13: prefill, name suggestion, second preset vs user
  edits, Custom reset, immutability + canCreate, parseList, payload, loop validation, strip
  markup + escaping, stepWho placement), tests/tenant/template-service.test.ts (+5 built-ins).
  DOM-stub smoke boot of agent-wizard.js: renders, fetches both endpoints, paints the strip,
  applies Researcher on click. tsc clean; biome clean on touched files.
- Docs: CHANGELOG (S7 entry), web-dashboard.html (GET /presets row incl. the POST `preset`
  contract, wizard "Presets (S7)" paragraph), configuration.html (BotConfigSchema.preset row),
  README (quick start step 4 + Agents line), CLAUDE.md (presets.ts row).
Left out / deviations:
- Not verified in a browser (login blocks automation). Verified instead as above plus the
  container rebuilt healthy and serving agent-wizard-helpers.js with applyPresetToState /
  presetStrip, style.css with .wizard-preset, and /api/agents/presets answering 401
  unauthenticated. FIRST THING in S8: log in, Agents -> New Agent, click Researcher, create.
- The plan named `loadPreset`; shipped as `getPreset` (same contract, returns a copy).
- Advanced skills / tools are comma-separated text inputs, not pickers: /defaults exposes only
  external skill names, not the built-in registry, and a picker was out of a one-sitting budget.
  Empty skills in the wizard = server default (all skills), or the preset's list when a preset is
  selected — clearing the field does not remove the preset's skills (the server re-applies the
  preset under an undefined `skills`). Type a different list to override.
- Presets carry no `directives`, `toolPermissions` or `topicGuard`; add to the JSON + schema if
  a later session wants them (applyPreset would need a new key each time — it is explicit).
- Multi-tenant exposure is list/get/instantiate only; the BaaS templates page shows built-ins
  with edit/delete buttons that answer 404 (read-only). Instantiate from a built-in does not
  write a soul (TemplateService never did) — the wizard/POST /api/agents path is the souled one.
- Skill ids in presets are validated against src/skills/<id>/skill.json, not against the live
  config's skills.enabled (a preset naming a skill that is installed but disabled fleet-wide just
  lists it on the bot; nothing breaks).
Config keys: BotConfigSchema.preset (optional string, informational). No global keys.
Notes for S8: nothing here blocks it. If the command palette wants "New <preset> agent" actions,
  GET /api/agents/presets gives id/name/emoji and #/agents/new could accept ?preset=<id> — the
  page does not read the query string today (would be a 5-line addition in renderAgentWizard:
  find the preset in the loaded catalogue and applyPresetToState before paintPresets).
```

---

### S8 — Natural-language automations and command palette

**Depends on:** S3.
**Kickoff prompt:**
> Execute session S8 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S3's Handoff. Let a human type what they want automated, and add a Ctrl+K palette.

**Steps.**
1. `POST /api/cron/parse { text, botId }`: the bot's LLM returns a structured cron proposal `{ schedule, instruction, chatId, confidence, explanation }` using the JSON parser in `src/bot/llm-json-parser.ts`. Never creates; the UI shows the preview and calls the existing `POST /api/cron`.
2. Automations area gets a one-line box at the top: "Tell an agent what to do and when".
3. Command palette (`web/ui/palette.js`): fuzzy search over agents, pages, and actions (start/stop/run now/open home/new agent). `Ctrl+K` / `Cmd+K`.

**Tests.** Parser test with fixed LLM output; palette ranking helper tests.

**Exit criteria.** "Check job boards every 3 hours and message me" produces a correct preview and a working cron job; palette opens on every page.

**Demo.** Type "check job boards every 3 hours and message me" into Automations and see the cron preview; press Ctrl+K anywhere and jump to an agent.

**Handoff (S8, done 2026-09-14).**
```
Shipped:
- src/cron/nl-parse.ts (pure, no HTTP, no LLM): CronConfidence, CronProposalSource, LlmCronProposal,
  CronProposal, DeterministicParse, CRON_FIELDS, DEFAULT_FALLBACK_SCHEDULE ('0 9 * * *'),
  isCronExpr (5 fields croner can schedule), cronToHuman(expr, tz), mentionsOperator,
  deterministicParse(text) -> { schedule, instruction, confidence, matched, phrase, warnings }
  (every N minutes/hours/days, every minute/hour/hourly, every day|morning|afternoon|evening|night,
  daily, at HH[:MM] [am|pm] / noon / midnight, every monday [and thursday] [at 10am], on fridays,
  weekdays, weekends, weekly, monthly, every N weeks -> Monday + warning, a literal cron -> high;
  strips "and message me" / "tell me" / "let me know" / "report back" from the instruction),
  buildParsePrompt({ text, botId, botName, tz, nowIso, operatorConfigured }), validateLlmProposal,
  parseLlmProposal(raw, logger) (llm-json-parser, extract pattern on "schedule"), jobNameFor,
  composeProposal({ text, botId, tz, nowMs, operator, llm, llmNote }) -> CronProposal.
- src/web/routes/cron-parse.ts: cronParseRoutes({ config, logger, llmFor?, now?, llmTimeoutMs? })
  -> POST /parse; CronParseLlm { client, model, backend }, CronParseLlmResolver, CronParseResponse
  (= CronProposal + llm: { backend, model } | null), CRON_PARSE_TEXT_MAX = 2000,
  CRON_PARSE_LLM_TIMEOUT_MS = 60_000, buildCronParseLlmResolver(botManager, config, logger) (bare
  planner client via resolvePlannerBackend / selectPlannerClient / resolvePlannerModel; null when
  getLLMClient throws = bot not started). Mounted in server.ts BEFORE cronRoutes. generate() runs
  with temperature 0, maxTokens 600; throw / timeout / garbage / bad cron -> fallback + warning.
  400 (no text/botId, > 2000 chars, bad JSON), 404 bot outside the tenant or unknown.
- Proposal shape (frozen, add-only): { schedule: '<5-field cron>', tz, scheduleHuman, nextRunAt:
  ISO|null, instruction, name, botId, chatId: 'operator' | number, operatorChatId: number|null,
  confidence: 'high'|'medium'|'low', explanation, warnings: string[], source: 'llm'|'fallback',
  llm: { backend, model } | null }. chatId is 'operator' unless the LLM proposes a number that the
  text itself contains (never an invented chat id). operatorChatId = config.operator.telegramChatId
  so the UI can post a numeric payload.chatId (cron payloads are numeric-only; the "operator"
  alias lives in tools/cron.ts, not in the scheduler).
- web/pages/automations-helpers.js (pure, 18 tests): PARSE_PATH, CREATE_PATH,
  AUTOMATION_PLACEHOLDER, CONFIDENCE_TONE, isCronExpr (shape only), cronToHuman (client mirror),
  buildParseRequest(text, botId), buildCreateRequest(proposal, { expr, instruction, name, chatId })
  -> the exact POST /api/cron payload of the New Job form ({ name, enabled: true, schedule: { kind:
  'cron', expr, tz }, payload: { kind: 'instruction', text, chatId, botId } }) or { error },
  pickDefaultAgent, agentOptions, automationBox({ agents, selectedId, text, busy }), relativeIn,
  targetLabel, describeSource, previewCard(proposal, { expr, instruction, name, chatId, agents,
  nowMs }).
- web/pages/automations.js (DOM): mountAutomationBox(container, { agents, onCreated, selectedId })
  -> { parse, destroy }. Parse -> POST /api/cron/parse -> preview card; cron field re-describes
  live; Create -> POST /api/cron -> toast + onCreated(job). Mounted by renderCron (web/pages/cron.js)
  in <div id="automation-box"> under the header; the Automations landing (#/automations) is the
  same handler, so the box is there too. cron.js's "+ New Job" link now points at the canonical
  #/automations/cron/new.
- web/ui/palette-helpers.js (pure, 18 tests): PALETTE_LIMIT = 12, RECENTS_MAX = 6, RECENTS_KEY
  ('aibot.palette.recents'), KIND_LABEL, matchScore(query, text) (exact 100 > prefix 90 > word
  start 80 > substring 65 > fuzzy 20-50 > 0; hints/keywords x 0.85), rankItems(items, query,
  { recents, limit }) (stable on item.index; empty query = recents then pages), buildAgentItems,
  buildPageItems(ctx, areas = AREAS) (one item per visible tab "Area › Tab", tab-less areas as
  themselves, deduped by href, imports visibleTabs/areaHref from nav-routes), buildActionItems
  (agents, { theme }) (stop + run now for running agents, start [?enable=true when disabled]
  otherwise, open config, new agent, open Needs You, switch theme), buildItems({ agents, ctx,
  theme }), moveIndex, pushRecent, isPaletteHotkey (Ctrl/Cmd+K, no Alt/Shift), isEditableTarget,
  paletteMarkup(items, active, { query }), paletteShell().
- web/ui/palette.js (DOM): initPalette({ loadAgents, ctx, api, navigate, canOpen }), openPalette,
  closePalette, togglePalette, isPaletteOpen, invalidateAgents. Capture-phase keydown on document;
  while open ArrowUp/Down, Enter, Escape are handled and stopped (Needs You shortcuts and the
  sheet's Esc do not fire). Actions POST through api(), toast, dispatch 'badges:refresh' and
  invalidate the agents cache; theme items call toggleTheme(). NOT exported from web/ui/index.js
  (palette-helpers imports nav-routes, which imports the barrel).
- web/app.js: initPalette() after the module-level state; `api` imported from shared.js.
  web/index.html: <button class="palette-hint" data-palette-open> ("Search / jump ⌘K") in
  .nav-foot above the theme toggle. web/style.css: "Automations box + preview card (session S8)"
  (.auto-box*, .auto-card*) and "Command palette (session S8)" (.palette-hint, #ui-palette-root,
  .ui-palette*) blocks; one column / top-anchored under 900px; reduced-motion guard.
- Tests (+75, bun test 5424 pass; the log-tail rotation flake is pre-existing):
  tests/cron/nl-parse.test.ts (29), tests/web/routes/cron-parse.test.ts (10: LLM happy path with
  fenced JSON, garbage -> fallback, 6-field cron -> fallback, no LLM -> fallback "not running",
  throwing + hanging LLM, tenant 404 + admin, 400s, length cap, resolver null / pinned backend),
  tests/web/automations-helpers.test.ts (18), tests/web/palette-helpers.test.ts (18, incl. nav
  integration: every visible tab of every area is a palette page item, tenant/admin visibility).
  tsc clean, biome clean on every touched file. DOM smoke boots under happy-dom (installed in the
  session scratchpad only, not in the repo): the box parses -> previews -> edits the cron ->
  creates with the exact payload; the palette ignores Ctrl+K in an input, opens, ranks "hun" ->
  agent first, arrows, Enter navigates, recents persist, "stop hun" POSTs the action, Esc closes;
  and app.js itself boots with the real index.html body, mounts the box on #/automations/cron,
  opens the palette from the sidebar button and navigates to #/insights/karma.
- Docs: CHANGELOG (S8 entry), web-dashboard.html (POST /api/cron/parse row, Cron page
  "Natural-language box" paragraph, "Command palette (session S8)" section), README (Automations
  line, dashboard paragraph, pages block), CLAUDE.md (new "Módulos Cron" table with nl-parse.ts).
Left out / deviations:
- Not verified in a browser (login blocks automation). Verified instead as above, plus the
  container rebuilt healthy, serving ui/palette*.js, pages/automations*.js, style.css (.auto-box,
  .ui-palette-row), index.html (data-palette-open), app.js (initPalette), and POST
  /api/cron/parse answering 401 unauthenticated. FIRST THING in S9: log in, open Automations,
  type "check job boards every 3 hours and message me", Parse, Create, see the job; press Ctrl+K
  on Fleet Home, type an agent name, Enter.
- The parse call is NOT written to the per-bot LLM query log (LlmQueryLog) — it goes straight to
  the bare client. Add an `llmQueryLog.append()` in cronParseRoutes if traceability matters.
- The plan's proposal shape was { schedule, instruction, chatId, confidence, explanation };
  shipped add-only with tz, scheduleHuman, nextRunAt, name, botId, operatorChatId, warnings,
  source, llm. `schedule` is the cron STRING (the UI wraps it as { kind: 'cron', expr, tz }).
- No client-side parser: with the server down the box only toasts the error. The server-side
  fallback covers "LLM down"; "server down" was out of scope.
- Only `instruction` jobs are proposed (never `message` or `skillJob`); the New Job form still
  covers those.
- The palette has no "New <preset> agent" actions (S7's note): #/agents/new does not read a
  ?preset= query yet. Cheap follow-up: add ?preset=<id> handling in renderAgentWizard and one
  action item per preset from GET /api/agents/presets.
- Palette agents are cached 30 s per open, so a Start/Stop from the palette shows the flipped
  action on the next open after the cache expires (invalidateAgents() is called after an action,
  so the very next open refetches).
- The Needs You page's own keydown handler still sees keys typed INTO the palette input other than
  arrows/Enter/Esc; it ignores them because the target is an input (reduceKey's inInput), so no
  conflict was observed in the smoke boot, but it was not exercised on the real page.
Config keys: none. No feature flag: the endpoint is read-only (never creates) and the palette is
  pure dashboard work.
Notes for S13 (webhook creation reuses the automation box):
- The box is `mountAutomationBox(container, { agents, onCreated })` from web/pages/automations.js;
  the parse -> preview -> create flow is three pure functions (buildParseRequest, previewCard,
  buildCreateRequest) around one DOM controller. For webhooks, add a second "kind" to the
  proposal (e.g. { trigger: 'cron' | 'webhook' }) rather than a second box: the server prompt in
  buildParsePrompt already asks for a single JSON object, so "when X happens, do Y" can return
  { trigger: 'webhook', event, instruction, ... } and previewCard can branch on it. Keep
  composeProposal's deterministic fallback for cron and add a webhook fallback that looks for
  "when / whenever / on <event>".
- The instruction text the box produces is what the cron delivers as a synthetic inbound message
  (BotManager.handleCronInstruction); a webhook payload can reuse exactly that path with the
  event JSON appended to the instruction.
- Palette actions are data ({ api: { path, method } } | { href } | { theme }); a webhook "fire
  test event" action is one more buildActionItems entry.
```

---

### S3.5 — Old pages onto the design system

**Depends on:** S3, S8.
**Kickoff prompt:**
> Execute session S3.5 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and the Handoffs of S0, S3 and S8. Bring the pages the plan never rewrote — Agents list, Cron list, the Work landing and the Home ticker — onto the component layer, without changing what they do.

**Goal.** After S0–S8 the app was two apps: the new Home / Agent Home / Needs You / wizard next to pre-plan tables with five to eight buttons per row. Make every first-level page feel like one product before S9 puts it on a phone.

**Why now.** The Agents rows were ~380 px tall because a 14-column table pushed an Actions cell holding up to eight buttons off-screen, where `flex-wrap` stacked them vertically. Cron showed fourteen near-identical rows with five buttons and a raw cron expression. Work opened on a file tree. Home led with ten "is running / finished" lines from one agent two hours ago, and its header count disagreed with the sidebar badge.

**Steps.**
1. `web/ui/data-table.js` (compact table inside `.table-scroll`) and `web/ui/menu.js` (native `<details>` row menu whose items keep `data-action` delegation working; `initMenus` for click-away).
2. Agents list: nine columns, one primary button + a row menu; handlers untouched.
3. Cron list: schedules in words, agent chip, one Run button + a row menu, agent filter with counts and a search box.
4. Work landing: `#/work` becomes "Outputs" — recent changelog entries newest first with Approve / Reject inline, status chips and an agent select; the file tree stays under the Productions tab.
5. Home: grid first, ticker under it condensed to one line per burst of tool runs, five lines with a "more" toggle; header count from `/api/needs-you/count`.

**Tests.** `tests/web/ui-menu-table.test.ts`, `tests/web/agents-list-helpers.test.ts`, `tests/web/cron-list-helpers.test.ts`, `tests/web/work-helpers.test.ts`, new cases in `tests/web/fleet-home-helpers.test.ts` and `tests/web/nav-routes.test.ts`.

**Demo.** Agents: rows as tall as their text, a "⋯" per row. Automations → Cron: "Every day at 03:30", agent chips, pick an agent in the filter. Work: a review list, click Approve. Home: cards first, then five "Recent" lines like "Econ Student ran file_read, read_production_log and manage_goals".

**Handoff (S3.5, done 2026-09-15).**
```
Shipped:
- web/ui/menu.js: rowMenu(items, { label }) -> <details class="ui-menu"> with <button data-action
  data-id> / <a href> items, { separator: true }, danger, title, disabled; '' when no real item.
  initMenus(root) -> cleanup fn (one open at a time, click-away, Escape, closes on item click).
- web/ui/data-table.js: dataTable({ columns, rows, className, id, empty }) -> .table-scroll > table.ui-table;
  columns string | { label, align: 'right'|'center', width }; rows string[][] | { cells, attrs }.
  Both exported from web/ui/index.js. CSS block "Session S3.5" at the end of web/style.css
  (.ui-menu*, .ui-table*, .agents-*, .bulk-bar, .cron-*, .work-*, .fleet-tick-toggle).
- web/pages/agents-list-helpers.js: formatTokenCount, primaryAction, primaryButton, agentMenuItems,
  loopButton, modelSelect, karmaCell, activityCell, agentRow, AGENTS_COLUMNS, agentsTable.
  agents.js: the list block now calls agentsTable(); a module-level closeAgentMenus holds the
  initMenus cleanup; tbody falls back to a detached element when there are no agents (empty state);
  selectAll is optional. karmaCompact / tokenBreakdownCompact removed (formatTokenCount stays: the
  loop-result modal uses it).
- web/pages/cron-list-helpers.js: FLEET_FILTER, jobAgentId, humanSchedule, inWords, payloadCell,
  nextRunCell, lastRunCell, displayName, filterJobs, sortJobs, jobMenuItems, jobRow, CRON_COLUMNS,
  cronTable, cronToolbar. cron.js: module-level cronFilter { botId, query } survives re-renders; the
  table renders into #cron-table-wrap and the old delegation (`tbody`) now sits on that wrapper;
  formatPayloadSummary removed (formatSchedule stays for the detail page).
- web/pages/work-helpers.js: WORK_STATUSES, entryStatus, filterEntries, sortEntries, workSummary,
  entryTitle, fileHref, entryRow, entriesList, workFilters. web/pages/work.js: renderWork(el),
  destroyWork() (listeners on the page root are bound to an AbortController). nav-routes: Work tabs
  are Outputs (#/work) / Productions / Conversations / Sessions; ROUTES '#/work' -> handler 'work'.
  app.js: `work` handler + destroyWork() in navigate().
- web/pages/fleet-home-helpers.js: TICKER_LIMIT = 30, TICKER_SHOW = 5, TICKER_GROUP_GAP_MS,
  NOISE_EVENTS, condenseEvents(events, names) -> [{ key, text, tone, timestamp, botId }] newest
  first, condensedTickerBody(events, names, nowMs, { expanded }), fleetSummary(agents, presence,
  { needsYou }). tickerBody/tickerRow (raw) are unchanged. fleet-home.js: grid before ticker,
  ticker-more / ticker-less toggle, /api/needs-you/count in the header (refreshed on presence).
- Tests: +66 (ui-menu-table 13, agents-list 16, cron-list 13, work 10, fleet-home +6, nav-routes
  +1 and one expectation updated: the Work sidebar link is now #/work). bun test tests/web: 840 pass.
  biome clean on every touched file (three pre-existing noForEach warnings in agents.js untouched).
- Verified: happy-dom smoke (scratchpad only, not in the repo) booting agents.js, cron.js, work.js
  and fleet-home.js against a mocked API — rows, one menu per row, Stop and toggle-productions
  requests, cron filter + search + Run, Work chips + Approve request + verdict, ticker condensed to
  5 lines and expanded to 7. curl confirmed the container serves style.css with the S3.5 block,
  pages/work.js and ui/menu.js (bind mount).
Left out:
- Not verified by eye in a browser (login blocks automation). First thing in S9: open Agents,
  Automations -> Cron, Work and Home, and resize to phone width; the row menu is position:absolute
  and .table-scroll:has(.ui-menu[open]) lifts the overflow clip — check it on Safari/older Chrome.
- /api/agents rows carry no avatarUrl, so the Agents list shows seed avatars even for agents with
  an uploaded face (the Home grid reads it from /api/agents/presence). Cheap follow-up: read
  presence in renderAgents too.
- Skills / Tools / Tool Runner, Insights tables and Settings still use the old table markup; wrap
  them in dataTable as they are touched.
- Work → Outputs shows the last 200 entries with no pagination and no rating/feedback input
  (Approve/Reject only; the Productions explorer keeps stars and threads).
Config keys: none.
```

---

### S9 — Mobile, PWA, web push

**Depends on:** S3, S5.
**Kickoff prompt:**
> Execute session S9 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and the Handoffs of S3 and S5. Make the dashboard installable on a phone and let asks reach it as push notifications.

**Steps.**
1. `web/manifest.json`, icons, `web/sw.js` that caches static assets respecting the cache-busting already in `src/web/static-cache` (see `tests/static-cache.test.ts`) and never caches `/api`.
2. Responsive pass over Fleet Home, Agent Home, Needs You and chat.
3. Web push: `config.push { enabled, vapidPublicKey, vapidPrivateKey: "${VAPID_PRIVATE_KEY}" }`; `POST /api/push/subscribe` stores subscriptions in `data/push/subscriptions.jsonl`; `src/web/push.ts` sends on the S5 `notifyOnAsk` hook and on `send_proactive_message` to the operator. Implement Web Push encryption without a heavy dependency if possible; otherwise pin `web-push` and record it.

**Tests.** Subscription store tests, push payload builder tests, service worker cache rules tested as pure functions.

**Exit criteria.** Installed on a phone, an `ask_human` arrives as a notification that opens the Needs You item.

**Demo.** Install the dashboard on your phone from the browser menu; trigger an `ask_human` and get a notification that opens the item.

**Handoff.**
```
Shipped:
Left out:
Config keys:
```

---

## Phase 3 — Outside world

### S10 — A2A v1.0 server upgrade

**Depends on:** nothing (backend). Read S1 only for event naming.
**Kickoff prompt:**
> Execute session S10 of `docs/plans/jarvis-fleet-plan.md`. Read the plan, `src/a2a/*`, and the A2A v1.0 specification at https://a2a-protocol.org/latest/specification/ (fetch it; do not rely on memory). Upgrade the server side and enable it behind config.

**Goal.** Any v1.0 client can discover a bot, send it work, stream progress, and be called back.

**Reads first.** `src/a2a/types.ts`, `server.ts`, `task-store.ts`, `executor.ts`, `agent-card-builder.ts`, `src/web/server.ts:418`, `src/tenant/middleware.ts` (API key auth), `tests/a2a/`.

**Steps.**
1. `types.ts`: add `rejected` and `auth-required` task states, `securitySchemes`, `signatures`, `extensions`, `provider`, `supportsAuthenticatedExtendedCard` on the card, `contextId`, `taskId`, `messageId` on messages, `kind` fields as v1.0 JSON binding requires. Keep a `LEGACY_KIND` shim only if the spec's migration notes require it.
2. Card: serve `/.well-known/agent-card.json` (keep `agent.json` as an alias for one release). Skills come from a new `bots[].a2a.skills[]` list (id, name, description, tags, examples) falling back to the bot's enabled skills, **never** the raw tool list. Add `securitySchemes` (`apiKey` header) and sign the card with an Ed25519 key stored at `data/a2a/card-key.json` (generated on first boot).
3. Methods: `message/stream` (SSE) with `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`, `tasks/list`, `tasks/resubscribe`, the four `tasks/pushNotificationConfig/*` methods with an outbound webhook sender (HMAC-signed), `agent/getAuthenticatedExtendedCard`.
4. `TaskStore` persists to `data/a2a/tasks/<botId>.jsonl` with the same TTL pruning; survives restart.
5. Auth: when `a2a.auth.required` is true, JSON-RPC calls need an API key accepted by the tenant middleware; the card stays public.
6. Executor: map an inbound A2A message onto the conversation pipeline with `channelKind: 'a2a'` (add to `ChannelKind`), sender = remote agent name, so memory and the human-inbound filter treat it as a peer agent, not a human.
7. Config: add the `a2a` block to `config/config.json` with `enabled: true`, `auth.required: true`.
8. Dashboard: an "A2A" panel in Integrations (`web/pages/integrations.js`) per bot showing the served card, the public URL to hand to other agents, and a "Try it" box that sends a message through `message/stream` and renders the streamed reply. Uses the dashboard session token as the API key.

**Tests.** Extend `tests/a2a/`: card shape against a v1.0 fixture, stream event ordering, persistence across a new `TaskStore` instance, auth rejection, `rejected` state on disabled bot, push config CRUD and delivery signature.

**Exit criteria.** A v1.0 client fixture completes discover → send → stream → get; `docs/architecture-docs/` gains an A2A section; `README.md` A2A bullet updated to v1.0.

**Demo.** `curl http://127.0.0.1:3000/a2a/<bot>/.well-known/agent-card.json` shows a signed v1.0 card; in Integrations, the A2A panel shows the card and the "Try it" box streams a reply from the bot over `message/stream`.

**Handoff.**
```
Shipped:
Left out:
New types / methods:
Config keys:
Notes for S11 (client changes needed, trust hooks):
```

---

### S11 — A2A outbound, discovery and a federated directory

**Depends on:** S10.
**Kickoff prompt:**
> Execute session S11 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S10's Handoff. Let a bot find and talk to any A2A agent on the web, with a human in the loop on first contact.

**Steps.**
1. `A2AClient` to v1.0: `agent-card.json`, streaming, auth header from `config.a2a.agents[].apiKey`, task persistence for outbound tasks.
2. Tools in `src/tools/a2a.ts`: `a2a_discover(url)` (fetches and summarises a card; caches it), `a2a_send(agent, text, wait?)`, `a2a_task_status(id)`. Trust policy in `config.a2a.trust { mode: 'allowlist'|'ask'|'open', allow[] }`: `ask` routes the first contact with a new agent through `ask_human` using the S5 queue; the answer is remembered in `data/a2a/trust.jsonl`.
3. `AgentDirectory` persists to `data/a2a/directory.jsonl` and federates: `config.a2a.peers[]` are other AIBot instances; every 10 min each instance pushes its cards to peers with a shared secret and pulls theirs. Directory search becomes a tool `a2a_search(skill)`.
4. Dashboard: Agents area gets a "Network" tab listing external agents, health, last contact, trust state.
5. Register the MCP server (already in `src/mcp/server.ts`) and each bot card in the MCP registry / NANDA-style indexes **only as documentation** in this session: write `docs/a2a-discovery.md` with the current options and what a submission needs. Do not submit anything.

**Tests.** Tool tests with a fake card server; trust policy branches; federation merge and stale pruning.

**Exit criteria.** A bot, told "ask the research agent at <url> for X", discovers it, asks the human once, sends, and reports back. `CLAUDE.md` module table updated.

**Demo.** Tell a bot in chat "ask the agent at <url> what it can do": it discovers the card, asks you once in Needs You, sends, and reports back. The Network tab lists the new agent.

**Handoff.**
```
Shipped:
Left out:
Trust config shape:
Notes for S15/S17:
```

---

### S12 — Email channel

**Depends on:** S0 only (nothing technical).
**Kickoff prompt:**
> Execute session S12 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and `src/channel/*`. Add email as a first-class inbound and outbound channel.

**Steps.**
1. `src/channel/email.ts`: IMAP IDLE (or polling fallback) reader → `InboundMessage` with `channelKind: 'email'` (extend `ChannelKind`), `chatId` = thread id from `References`/`In-Reply-To`, sender from `From`, attachments through the existing media pipeline for supported doc types. SMTP sender for `Channel.sendText` with proper `In-Reply-To` headers. Prefer a small dependency (`imapflow`, `nodemailer`) and record the choice.
2. Config per bot: `bots[].email { enabled, imap { host, port, user, pass: "${…}" }, smtp {…}, address, allowedSenders[] }`. Allowlist enforced in `ConversationGate`.
3. `outbound.ts` gains `email` so `send_proactive_message` can reach an email address; `UserDirectory` learns email addresses.
4. Dashboard: channel state for email in the Agent Home header.

**Tests.** `tests/channel/email.test.ts` with fixture messages: threading, allowlist, HTML-to-text, reply headers.

**Exit criteria.** Send a mail to the bot, get a reply in the same thread; `README.md` multi-channel bullet lists email.

**Demo.** Send an email to the bot's address and get a reply in the same thread; the Agent Home header shows the email channel as ok.

**Handoff.**
```
Shipped:
Left out:
Config keys:
```

---

### S13 — Inbound webhooks channel

**Depends on:** S8 (UI). Backend can start independently.
**Kickoff prompt:**
> Execute session S13 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and S8's Handoff. Let external systems wake an agent with a signed event.

**Steps.**
1. `POST /hooks/:botId/:hookId` in `src/web/routes/inbound-hooks.ts`: HMAC-SHA256 over the raw body with the hook's secret, replay window, JSON or form body. Hooks live in `data/hooks/<botId>.json` and are managed by `GET/POST/DELETE /api/hooks/:botId`.
2. Each hook has a `mode`: `message` (payload rendered by a template into an `InboundMessage` with `channelKind: 'webhook'`, `synthetic: true` so it never counts as human feedback) or `run` (calls `BotManager.requestImmediateAgentRun` with the payload as cycle context). Both are audited in the tool audit log.
3. Automations area: "Create a webhook" with a copyable URL and secret, and a "Test" button.

**Tests.** Signature/replay tests, both modes, engagement gate not credited.

**Exit criteria.** A GitHub push event triggers a run that the Agent Home timeline shows.

**Demo.** Create a webhook in Automations, press Test (or push to a GitHub repo), and watch the run appear in the agent's timeline.

**Handoff.**
```
Shipped:
Left out:
Config keys:
```

---

### S14 — Inbound voice (stretch)

**Depends on:** S12 not required; depends on the `phone-call` skill and Whisper/TTS config.
**Kickoff prompt:**
> Execute session S14 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and `src/skills/phone-call/`. Give an agent a phone number people can call.

**Steps.**
1. Twilio inbound webhook answers with `<Connect><Stream>`; `src/channel/voice.ts` handles the media stream WebSocket, buffers audio per utterance (silence detection), transcribes with the Whisper config, pushes an `InboundMessage` with `isVoice: true`, and plays the TTS reply back into the stream.
2. Conversation session keyed by caller number; allowlist reuse from S12.
3. Latency budget documented; if end-to-end is above ~4 s, mark the session as partial and record what to optimise.

**Tests.** Utterance segmentation and transcript assembly as pure functions; webhook TwiML shape.

**Exit criteria.** A phone call holds a two-turn conversation.

**Demo.** Call the number and hold a two-turn conversation.

**Handoff.**
```
Shipped:
Left out:
```

---

### S15 — Moltbook and social channels, hardened

**Depends on:** S11 (trust config).
**Kickoff prompt:**
> Execute session S15 of `docs/plans/jarvis-fleet-plan.md`. Read the plan, S11's Handoff, and `src/tools/moltbook.ts`. Make agent social networks a per-bot channel with injection guards.

**Steps.**
1. Generalise `moltbook.ts`: agent name from the bot, credentials in `data/<botId>/moltbook.json`, tools `moltbook_read(feed|submolt|thread)`, `moltbook_post`, `moltbook_reply`. Posting requires `ask_permission` (confirm level in `tool-permissions.ts`).
2. Injection guard: every fetched post is wrapped as untrusted data in the tool result with an explicit note; add a `social-content` lint in the topic guard that blocks instructions-in-content patterns from being echoed into `ask_human` or tool calls.
3. Same adapter shape for Reddit/Twitter posting so the "social media posting pipeline" idea in `docs/roadmap.md` becomes: draft → Needs You review → post.

**Tests.** Credential path per bot, permission gating, guard wrapping.

**Exit criteria.** A `social` preset bot can read a submolt and propose a post that a human approves in the queue.

**Demo.** A social-preset bot reads a submolt and proposes a post; it lands in Needs You for approval, and posting only happens after you approve.

**Handoff.**
```
Shipped:
Left out:
```

---

## Phase 4 — Power

### S16 — Native Anthropic API client

**Depends on:** nothing.
**Kickoff prompt:**
> Execute session S16 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and the Backends LLM section of `CLAUDE.md`. Add `llmBackend: 'anthropic'` as a first-class client next to Ollama and the Claude CLI.

**Steps.**
1. `src/core/anthropic-client.ts` implementing `LLMClient` (`generate`, `stream`, `getBackendClient`, tool use with the framework's tool definitions, images, prompt caching on the system prompt, usage into `TokenUsage` with `backend` set). Config `anthropic { apiKey: "${ANTHROPIC_API_KEY}", model, maxTokens }`. Default model to the latest Claude generation; keep it a config value.
2. `createLLMClient` and `orderCandidatesByBackend` learn the new backend; `resolvePlannerBackend` accepts it; the circuit breaker classifies its 429/401/5xx via `apiErrorStatus`.
3. Streaming path reuses what Ollama streaming already does for Telegram and the WebSocket widget.
4. Settings page: backend picker gains the option; bulk change from the agents list already exists.

**Tests.** Client tests with a mocked fetch (tool call round-trip, stream chunks, usage, error mapping), failover ordering, planner selection.

**Exit criteria.** A bot on `anthropic` chats with streaming and uses tools; `README.md` backends bullet updated.

**Demo.** Switch a bot to the Anthropic backend in Settings, chat, and watch tokens stream; a tool call round-trips.

**Handoff.**
```
Shipped:
Left out:
Config keys:
```

---

### S17 — Durable tasks

**Depends on:** S2 (UI slot), S10 (task model alignment).
**Kickoff prompt:**
> Execute session S17 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and the Handoffs of S2 and S10. Give agents work that survives restarts and cycles.

**Steps.**
1. `src/tasks/` module: `Task { id, botId, title, origin: 'human'|'goal'|'a2a'|'webhook', state, steps[], checkpoints[], artifacts[], createdAt, updatedAt }`, JSONL store per bot, `TaskService` (create, advance, checkpoint, complete, fail, resume).
2. Agent loop: the planner sees open tasks and may continue one instead of planning fresh; the executor writes checkpoints after each tool round; a cycle that times out leaves the task `working` and the next cycle resumes it.
3. A2A tasks from S10 are stored as `Task` with `origin: 'a2a'`; the A2A `TaskStore` becomes a view over `TaskService`.
4. Tool `manage_task` for the LLM; Agent Home gets a "Working on" card with progress; Needs You shows tasks in `input-required`.

**Tests.** Store, state machine (one test per transition), resume-after-timeout, A2A mapping.

**Exit criteria.** A task started in one cycle finishes in a later one after a container restart. `CLAUDE.md` module table gains `src/tasks/`.

**Demo.** Ask an agent to do a multi-step job, restart the container mid-way, and see the "Working on" card resume where it left off.

**Handoff.**
```
Shipped:
Left out:
Task shape:
Notes for S19:
```

---

### S18 — Sandboxed exec

**Depends on:** nothing.
**Kickoff prompt:**
> Execute session S18 of `docs/plans/jarvis-fleet-plan.md`. Read the plan and `src/tools/exec.ts`. Run agent shell commands in a disposable container when configured.

**Steps.**
1. `exec.sandbox { mode: 'none'|'docker', image, network: 'none'|'bridge', cpu, memory, timeout }`. In `docker` mode `exec` runs `docker run --rm` with the bot's work dir mounted, resource limits, no network by default. The container must have access to the Docker socket for this; document the trade-off in `docs/deployment-cloud.md` and keep `none` the default.
2. `process` tools (long-running sessions) get the same option or are disabled in sandbox mode; state which.
3. Tool audit records sandbox mode per call.

**Tests.** Command construction, limits, fallback when Docker is unavailable.

**Exit criteria.** A `coder` preset bot runs tests inside the sandbox; a `curl` from inside fails when network is `none`.

**Demo.** Run `curl https://example.com` from the Tool Runner with the sandbox on: it fails with no network; the audit shows the sandbox badge.

**Handoff.**
```
Shipped:
Left out:
Config keys:
```

---

### S19 — Sub-agents

**Depends on:** S17.
**Kickoff prompt:**
> Execute session S19 of `docs/plans/jarvis-fleet-plan.md`. Read the plan, S17's Handoff, and `docs/roadmap-inteligencia.md` item 4. Let an agent spawn a short-lived helper for a task.

**Steps.**
1. Tool `spawn_agent { purpose, tools?, backend?, maxRounds, timeout }`: creates an ephemeral bot config inheriting a trimmed soul (identity + relevant goals), runs it headless through the collaboration delegation path with its own session and work dir, returns the result into the parent task as a checkpoint. Depth limit 2, concurrency limit per bot.
2. Sub-agents appear in the parent's Agent Home timeline and in the fleet ticker but not in the fleet grid.
3. Cleanup of sessions and work dirs on completion; karma credits the parent.

**Tests.** Depth and concurrency limits, inheritance, cleanup, result checkpoint.

**Exit criteria.** "Research X while you keep drafting Y" spawns a helper whose result lands in the parent's task.

**Demo.** Ask "research X while you keep drafting Y": a helper appears in the timeline and its result lands in the parent's task.

**Handoff.**
```
Shipped:
Left out:
```

---

## Status table (update at the end of every session)

| Session | Title | Depends on | Status | Date | Handoff filled |
|---|---|---|---|---|---|
| S0 | Design tokens, component layer, responsive shell | — | done | 2026-09-13 | yes |
| S1 | Presence API and a live presence header | S0 | done | 2026-09-13 | yes |
| S2 | Agent Home page | S0, S1 | done | 2026-09-13 | yes |
| S3 | Fleet Home and navigation collapse | S2 | done | 2026-09-14 | yes |
| S4 | Face and voice | S2 | done | 2026-09-14 | yes |
| S5 | Needs You queue | S3 | done | 2026-09-14 | yes |
| S6 | Create-an-agent wizard | S2 | done | 2026-09-14 | yes |
| S7 | Presets | S6 | done | 2026-09-14 | yes |
| S8 | NL automations and command palette | S3 | done | 2026-09-14 | yes |
| S3.5 | Old pages onto the design system | S3, S8 | done | 2026-09-15 | yes |
| S9 | Mobile, PWA, web push | S3, S5 | planned | | no |
| S10 | A2A v1.0 server upgrade | — | planned | | no |
| S11 | A2A outbound, discovery, federated directory | S10 | planned | | no |
| S12 | Email channel | — | planned | | no |
| S13 | Inbound webhooks channel | S8 | planned | | no |
| S14 | Inbound voice (stretch) | — | planned | | no |
| S15 | Moltbook and social channels, hardened | S11 | planned | | no |
| S16 | Native Anthropic API client | — | planned | | no |
| S17 | Durable tasks | S2, S10 | planned | | no |
| S18 | Sandboxed exec | — | planned | | no |
| S19 | Sub-agents | S17 | planned | | no |

Status values: `planned` → `in progress` → `done` / `partial` (with a note) / `dropped` (with a reason).

## Suggested order for a solo operator

1. S0, S1, S2, S3 — the app looks and feels different after four sessions.
2. S5, S6 — daily use becomes pleasant; new agents are cheap.
3. S16 — better brains, unblocks streaming for everything.
4. S10, S11 — the fleet can meet the outside world.
5. S12, S13, S9 — the outside world can reach the fleet.
6. S7, S8, S4 — polish.
7. S17, S18, S19, S15, S14 — power and stretch.

## Follow-ups noted during planning (not in any session)

- `docs/roadmap.md` items still open (TTS outbound mode, Twitter skill, calendar providers) are unaffected by this plan and remain valid.
- `rewards.collaborateCompleted` and `getAgentLoopCircuitState()` gaps from Proyecto 9 could be closed inside S1 if cheap; otherwise leave them in the roadmap.
- The `FailoverLLMClient` ordering bug in the roadmap is already fixed per `CLAUDE.md` (`orderCandidatesByBackend`); the roadmap text is stale and should be corrected when Proyecto 9 is next touched.
