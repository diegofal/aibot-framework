# Infrastructure runbook

<!--
  Installed by /zero (stage 2: memory). Yours to edit; Zero updates never touch it.
-->

The log of record for every **manual** infrastructure command run against AIBot Framework: anything
that changes the running container, the Docker volumes (config, data, productions, ollama), or the
live config outside a normal `docker compose up -d --build` from a clean tree.

There is no CI deploy here, so this file is the only trace a hand-run command leaves.

## How to use it

Append at the moment the command runs, while the outcome is still in front of you. Zero's
log reminder prompts you when it notices one (`docker compose up/restart/stop/down`,
`scripts/docker/backup.ts`, `docker cp`/`docker exec` writes).

New entries go at the top, so the most recent state is the first thing you read during an incident.

## What counts

Rebuilds and restarts of the live container. Edits to `config/config.json` or `bots.json` inside the
`aibot_config` volume. Backups and restores (`bun scripts/docker/backup.ts`). Anything run inside
the container with `docker exec` that writes. Anything the deny list stopped that you then did
deliberately. If unsure, log it.

---

## Pending

<!--
  Planned but not yet run. Move an item to Executed the moment it runs, with its outcome.
-->

_Nothing pending._

---

## Executed

### 2026-10-05 — Rebuilt for PR #6 (reflection keeps the purpose) and re-enabled weekly reflection on the active bots

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`; `/app/data/cron/jobs.json` edited with the app stopped |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Deploy PR #6 (`65e2566`) and turn reflection back on, weekly, for ai-perfectionist, job-seeker, myfirstmillion |

```bash
git merge --ff-only origin/main
docker compose stop aibot
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -v "D:/tmp:/hosttmp" --entrypoint bun aibot /hosttmp/reflection-on.ts
docker compose up -d --build
```

**Outcome.** Container healthy; image has `src/skills/reflection/motivations.ts` and `productionsDir` wiring. Reflection jobs for the three active bots enabled with `30 3 * * 0` (America/Argentina/Buenos_Aires), next 2026-10-11T06:30Z; the paused bots' reflection stays off. Enabled jobs after boot: 3 weekly reflections, ai-perfectionist's daily intel gatherer, the three Monday deliverables. Only boot errors: the two known revoked Telegram tokens.

**Reversible?** Yes: `/app/data/cron/jobs.json.bak-reflection-weekly-2026-10-05T03-24-26-681Z` (restore with the app stopped); code via revert of `65e2566`.

### 2026-10-04 — Loop cadence to 24h, Monday deliverable crons, and nightly reflection / paused-bot crons disabled

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`: `/app/config/bots.json`, `/app/data/cron/jobs.json` (edited with the app stopped, from a one-off container on the same volumes) |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Loops ran every 6h/12h for weekly deliverables; delivery depended on the planner noticing it was Monday; nightly reflection rewrote MOTIVATIONS.md on every bot (paused ones included) from a 1000-char view, the likely engine of the drift |

```bash
docker compose stop aibot
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -v "D:/tmp:/hosttmp" --entrypoint bun aibot /hosttmp/cadence.ts
docker compose start aibot
# later, after ai-perfectionist's cycle completed:
docker compose stop aibot
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -v "D:/tmp:/hosttmp" --entrypoint bun aibot /hosttmp/crons-off.ts
docker compose start aibot
```

**Outcome.** `agentLoop.every: 24h` for ai-perfectionist, job-seeker, myfirstmillion. New cron jobs (America/Argentina/Buenos_Aires, chat 796164002): "Weekly AI Engineer / FDE Brief [ai-perfectionist]" `0 9 * * 1`, "Weekly roles shortlist [job-seeker]" `0 9 * * 1`, "Side-income idea, every other Monday [myfirstmillion]" every 14 d anchored 2026-10-05T12:00Z. Disabled: nightly reflection on all 8 bots (active ones for ~2 weeks), intel gatherer on default and econ-student, job-seeker's "weekly dormancy heartbeat" (it ordered no research). Still enabled: ai-perfectionist's daily intel gatherer plus the three new jobs. Verified after boot: 4 of 17 jobs enabled, nothing re-registered; loops on 24h.

**Reversible?** Yes: `/app/config/bots.json.bak-cadence-2026-10-05T01-38-50-003Z`, `/app/data/cron/jobs.json.bak-cadence-2026-10-05T01-38-50-003Z` and `/app/data/cron/jobs.json.bak-crons-off-2026-10-05T01-46-53-176Z` (restore with the app stopped).

### 2026-10-04 — job-seeker and myfirstmillion repurposed; five agent loops paused

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`: soul dirs of job-seeker and myfirstmillion, and `/app/config/bots.json` |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Fleet review: no bot had a consumer for its output. The operator kept two with a concrete deliverable and paused the autonomous loops of the rest |

```bash
MSYS_NO_PATHCONV=1 docker cp D:/tmp/repurpose.ts aibot-framework-aibot-1:/tmp/repurpose.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/repurpose.ts
MSYS_NO_PATHCONV=1 docker cp D:/tmp/pause.ts aibot-framework-aibot-1:/tmp/pause.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/pause.ts   # bots[].agentLoop.enabled=false for cryptik, econ-student, milei-rocca, selfimprove, default
docker compose restart aibot
```

**Outcome.** job-seeker: 4 new goals (Monday AI engineer / FDE role shortlist open from Argentina, applications.md tracker, monthly market signal, one calibration question), 4 old goals retired and kept; motivations rewritten; identity audience is Diego. myfirstmillion: 4 new goals (side-income idea with evidence every other Monday, ideas.md ledger, demand-source watchlist, one calibration question), 9 old goals retired and kept; motivations rewritten; identity audience is Diego. Navigator directions cleared on both. After the restart all 8 bots are running (chat works) and only job-seeker, myfirstmillion and ai-perfectionist are in the agent-loop schedule.

**Reversible?** Yes: soul backups in `soul/.versions/*.2026-10-04T20-45-46-786Z.bak`; `bots.json` backup at `/app/config/bots.json.bak-pause-2026-10-04T20-46-13-804Z` (copy back and restart, or set `agentLoop.enabled` back to true per bot).

### 2026-10-04 — AI Perfectionist repurposed as Diego's AI engineer / FDE research mentor (soul files in the live volume)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`, `/app/data/tenants/__admin__/bots/ai-perfectionist/soul/` |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Its goals had drifted to its own tooling and to chasing a reply about a deleted file; the operator wants it researching the latest AI engineering practice to make him a great AI engineer / FDE |

```bash
MSYS_NO_PATHCONV=1 docker cp D:/tmp/aiperf-apply.ts aibot-framework-aibot-1:/tmp/aiperf-apply.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/aiperf-apply.ts
# serializeGoals keeps only the last 10 completed goals and the retired ones had been placed first, so they were cut; rebuilt:
MSYS_NO_PATHCONV=1 docker cp D:/tmp/aiperf-goals-fix.ts aibot-framework-aibot-1:/tmp/aiperf-goals-fix.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/aiperf-goals-fix.ts
```

**Outcome.** GOALS.md: 5 new active goals (weekly AI Engineer / FDE Brief on Mondays, living FDE skills map, primary-source watchlist, monthly hands-on lab, one calibration question), the 5 old active goals kept in Completed as "retired 2026-10-04"; the 5 oldest completed goals now live only in the backup. MOTIVATIONS.md rewritten around Diego's growth (signal over hype, FDE lens, no goals about its own tooling). IDENTITY.md vibe names the FDE target. NAVIGATOR.json direction cleared so the navigator re-plans next cycle. Config, backend and knowledge map unchanged. Next scheduled run 2026-10-05T02:14Z.

**Reversible?** Yes: backups in `soul/.versions/{GOALS.md,MOTIVATIONS.md,IDENTITY.md,NAVIGATOR.json}.2026-10-04T20-32-11-616Z.bak`; copy them back.

### 2026-10-04 — Rebuilt the container for PR #4 (absolute paths) and PR #5 (message boxes)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Deploy PR #4 (`789fefd`: Needs You handles outputs logged with an absolute path) and PR #5 (`223d2a1`: full-width message boxes that grow as you type) |

```bash
git merge --ff-only origin/main   # main folder, clean and only behind
docker compose up -d --build      # at 223d2a1
MSYS_NO_PATHCONV=1 docker cp D:/tmp/orph3.ts aibot-framework-aibot-1:/tmp/orph3.ts
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 bun /tmp/orph3.ts   # read-only: pending outputs per bot with the new normalization
```

**Outcome.** Container healthy. Served `ui/composer.js`, `pages/shared.js` and `style.css` carry the change (`fitComposer`, `.thread-input-row`). Queue check over the live changelogs: milei-rocca's two absolute-path outputs resolve correctly (they had been approved at 19:01 UTC, so nothing is pending there); cryptik lists one output (`archived/44_terrapin…`, edited by the bot at 20:11 UTC after it was archived). Only errors at boot: the two known revoked Telegram tokens. `/tmp/orph3.ts` and `/tmp/dbg.ts` stay in the container's writable layer until the next rebuild.

**Reversible?** Yes: check out the previous commit and rebuild.

### 2026-10-04 — Rebuilt the container for the Needs You orphan-output fix (PR #3)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Deploy PR #3 (`c862d6f`): Needs You stops listing outputs whose file is gone, so "Clear" no longer fails on them |

```bash
docker compose up -d --build   # from D:/aibot-framework at 63b6354 (origin/main merged into local main, which carries other sessions' unpushed commits)
MSYS_NO_PATHCONV=1 docker cp D:/tmp/orph.ts aibot-framework-aibot-1:/tmp/orph.ts
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 sh -c 'bun /tmp/orph.ts'   # read-only: pendingProductionFiles over /app/productions/*/changelog.jsonl
```

**Outcome.** Container healthy; image has `productionFileStillThere`. Over the live changelogs: 10 unreviewed outputs are orphans (now hidden), 0 outputs left listed. The orphan entries themselves are untouched (pruning = `productions-triage` with `pruneOrphans`, not run). `/tmp/orph.ts` could not be removed (`Operation not permitted`); it lives in the container's writable layer and goes with the next rebuild.

**Reversible?** Yes: check out the previous commit and rebuild.

### 2026-10-04 — Rebuilt the container for the CI fix and the UX-overhaul follow-ups

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Claude (asked by Diego) |
| **Why** | `main` at `6bc89bf` changed `src/`: `POST /api/skills/toggle`, `offset` / `before` on `GET /api/curiosity/dispatches`, `assertWithinDir` rejecting Windows-absolute paths. `web/` is bind-mounted, so the new Skills and Dispatches pages were already live against the old server (toggle → 404, "Load older" hidden) |

```bash
docker compose up -d --build
```

**Outcome.** Built and recreated at 13:19; `healthy` within a minute; auto-start complete; no error-level log lines at boot. Checked inside the container: `app.post('/toggle'` in `src/web/routes/skills.ts`, `parseOffset` in `curiosity.ts`, `win32.isAbsolute` in `src/productions/paths.ts`. Both new routes answer 401 without a login (auth sits in front, as expected). Served `/pages/skills.js` calls `/api/skills/toggle`, and served `/style.css` has no `.tool-runner-*`. One unrelated Telegram `sendMessage` 400 ("can't parse entities") from a bot's own message.

**Reversible?** Yes: check out the previous commit and rebuild (no volume or config change).

### 2026-10-04 — Rebuilt the container for the curiosity Stats views (PR #2)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (agent session, approved in chat) |
| **Why** | Deploy PR #2 (`50d6262`): `GET /api/stats/curiosity`, Insights → Curiosity tab, curiosity LLM calls in tenant metering |

```bash
docker compose up -d --build   # from D:/aibot-framework at 7b79694 (PR #2 merged into local main, which also carries 63b441b + d0d77f7, not yet pushed)
```

**Outcome.** Container recreated and healthy. `/api/stats/curiosity` answers 401 without auth (route mounted, same as `/behaviour`); served `pages/stats.js`, `nav-routes.js` and `style.css` carry the new code; `/app/src` has `curiosity-aggregator.ts` and `createTenantCallMeter`. The only boot errors are the two known revoked Telegram tokens (401). Also built in: `63b441b` (CI repin, LF everywhere, Linux-only test fixes).

**Reversible?** Yes: check out the previous commit in the main folder and `docker compose up -d --build` again.

### 2026-10-04 — Rebuilt the container for the dashboard UX overhaul

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Claude (asked by Diego) |
| **Why** | The UX overhaul (`f96dc98`, merged in `5dc2fad`) changed `src/`: Needs You bulk / act / clear-stale routes, the ask_human sweep for orphan inbox questions, feedback `botName`, productions archive body. The image predated them |

```bash
docker compose up -d --build
```

**Outcome.** Image built and container recreated at 01:28; `healthy` after ~30 s. All enabled agents auto-started. Checked inside the container: `closeStaleInboxConversations` and the `clear-stale` route are present. Bots whose Telegram token Telegram rejects (401, `channelState: "revoked"`) started headless, as the existing fallback does; the UX work did not touch it.

**Reversible?** Yes: check out the previous commit and rebuild (no volume or config change).

### 2026-10-04 — Read-only curiosity live check inside the container

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` (volumes read, not written) |
| **Who** | Diego (agent session) |
| **Why** | Step 1 of the curiosity follow-up: per-bot knowledge map, cycle log, direction and dispatches |

```bash
MSYS_NO_PATHCONV=1 docker cp D:/tmp/cur-summary.js aibot-framework-aibot-1:/tmp/cur-summary.js
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 bun /tmp/cur-summary.js
# plus: docker exec … bun -e '…' reading DISPATCHES.jsonl bodies, and grep over /app/config/{config,bots}.json
```

**Outcome.** Summary printed; nothing in `/app/data` or `/app/config` changed. `/tmp/cur-summary.js` is left in the container's writable layer (not a volume); it goes away with the next rebuild.

**Reversible?** Yes: nothing to revert (`docker exec aibot-framework-aibot-1 rm /tmp/cur-summary.js` removes the script).

### 2026-10-03 — Fleet model switched to Sonnet 5.5 in the live config volume

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1`, volume `aibot-framework_aibot_config` |
| **Who** | Diego |
| **Why** | CLI bump to 2.1.289 (`fce6670`); make Sonnet 5.5 the fleet default |

```bash
# Verbatim command not recorded at the time. Effect, per CHANGELOG.md 2026-10-03:
# config/config.json: claudeCli.model and soul.healthCheck.model  claude-opus-5 -> claude-sonnet-5-5
```

**Outcome.** All eight bots run on Sonnet 5.5 (none had a per-bot model override).

**Reversible?** Yes: restore `config/config.json.bak-sonnet55-20261003` in the config volume and restart the container.

### 2026-10-04 — Rebuilt the container for the query-log model fix

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `af2a064`: the LLM query log records the Claude model that answered instead of `"claude"` |

```bash
docker compose up -d --build
```

**Outcome.** Image built and container recreated around 01:47 local; `healthy`. All enabled agents auto-started. Checked in `/app/data/llm-query-log/`: every entry after the rebuild shows `model: "claude-sonnet-5-5"` for all eight bots (planner, executor, curiosity steps); entries before it still say `"claude"`.

**Reversible?** Yes: check out the previous commit and rebuild (no volume or config change).

### 2026-10-04 — Rebuilt the container for the hygiene cleanup fix

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `fix(hygiene): apply really cleans; one-click fleet cleanup`: `POST /api/hygiene/cleanup`, `HygieneRun.remaining`, and the "Clean up everything" card |

```bash
docker compose up -d --build
```

**Outcome.** Image built and container recreated around 13:55 local; `healthy`. Verified in the container: `src/web/routes/hygiene.ts` has the `/cleanup` route, `/pages/hygiene.js` serves the "Clean up everything" card, and the route answers 401 without a session (behind auth, not 404). The boot log's only errors are the existing Telegram `getMe` 401s from revoked tokens. The cleanup itself was not run from here; the operator runs it from the page.

**Reversible?** Yes: check out the previous commit and rebuild (no volume or config change from the deploy itself; running the cleanup writes to volumes, with backups and `_trash`).

### 2026-10-04 — Rebuilt the container for the selection toolbar and bulk delete

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `feat(web): one selection toolbar on every list; bulk reject and delete`: Needs You bulk `delete` for tools (`DynamicToolRegistry.delete`) and `DELETE /api/tools/:id` unloading the tool from the running bots. The front end was already live through the `web/` mount |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-04T18-57-14`. Image built and container recreated around 14:58 local; `healthy`. Verified in the container: `src/web/routes/needs-you.ts` has `deleteTool`, and `POST /api/needs-you/bulk` answers 401 without a session (behind auth). The boot log's only errors are the existing Telegram `getMe` 401s from revoked tokens. Bulk delete itself not exercised from here (login).

**Reversible?** Yes: check out the previous commit and rebuild (no volume or config change).

### 2026-10-06 — Backup, rebuild for queue/tool-failure/operator-goal fixes, changelog repair

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` and its `aibot_productions` volume |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `80131ae`, `6c8611b`, `39103aa` (one definition of unreviewed + daily auto-archive; tool failure kinds and CLI timeouts; operator goals on Agent Home). Repair the three `changelog.jsonl` files that "Clear stale" archived on 2026-10-04 (myfirstmillion, econ-student, selfimprove) |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
docker cp D:/tmp/repair-changelogs.ts aibot-framework-aibot-1:/tmp/repair-changelogs.ts
docker exec -w /app aibot-framework-aibot-1 bun /tmp/repair-changelogs.ts          # dry run on /tmp copies
docker exec -w /app aibot-framework-aibot-1 bun /tmp/repair-changelogs.ts --apply
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-06T13-56-43`. Container recreated, `healthy`; the image has `isUntrackedProductionPath`, `src/hygiene/auto-archive.ts` and the "Set by your operator" prompt section. Boot errors: only the existing Telegram `getMe` 401. Live unreviewed (via `readProductionOutput` in the container) = 4 never reviewed + 2 edited since review, matching Needs You's 6 (was 33). Repair merged `archived/changelog.jsonl` back into the active changelog, dropping rows whose path is the changelog itself and the archive row of it: myfirstmillion 5 + 42 → 13 rows, econ-student 7 + 2 → 6, selfimprove 1 + 3 → 0 (its whole archived history was self-writes). Dry run showed no change to unreviewed/approved counts. Old files kept as `archived/changelog.jsonl.pre-repair-2026-10-06.bak`.

**Reversible?** Yes: restore the backup (`restore … --force`) or rename the `.bak` files back; check out `d05d1f9` and rebuild for the code.

### 2026-10-06 — Rebuilt for the goals board, exact goal attribution and the goal sidebar

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `e086c00` (goals board, `PATCH /api/agents/:id/goals`), `83547f1` (goal ids, `goal-events.jsonl`, cycle ids, `serves_goal`, `agent-cycles/`), `97f4fde` (goal detail sidebar, `GET /api/agents/:id/goals/detail`) |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-06T16-11-02`. Container recreated, `healthy`; the image has `src/bot/goal-events.ts`, `src/bot/agent-cycle-log.ts`, `src/stats/goal-detail-aggregator.ts`. `GET /goals/detail` and `PATCH /goals` answer 401 without a session (behind auth). Boot errors: only the existing Telegram `getMe` 401. `buildGoalDetail` run in the container on ai-perfectionist's "Monthly hands-on lab": in_progress, 1 inferred cycle (manage_goals named the goal), 6 LLM calls, 8 tool calls, 10.6k tokens, 2 files. Exact cycles start with the next agent-loop cycle.

**Reversible?** Yes: check out `263cb76` and rebuild. New files (`goal-events.jsonl`, `agent-cycles/`) are additive; GOALS.md gains `id`/`started`/`updated` lines that the old parser ignores.

### 2026-10-06 — Rebuilt for goal drag-and-drop and cycles starting their goal

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `17cd762`: draggable goal cards, a completed cycle moves its To do goal to In progress (`AgentLoop.startCycleGoal`), readable option lists |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-06T16-21-52`. Container recreated, `healthy`; image has `startCycleGoal`; served `style.css` has `drag-over` and `agent-home.js` has the `dragstart` handler. Boot errors: only the existing Telegram `getMe` 401. Drag and the auto-start not yet seen live.

**Reversible?** Yes: check out `c578c73` and rebuild.

### 2026-10-06 — Rebuilt for editing goals from the drawer

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `e9aed64`: click-to-edit goal title/notes in the drawer, `PATCH /api/agents/:id/goals` edits, `title` goal events |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-06T17-05-23`. Container recreated, `healthy`; image has `parseGoalEdits`; served `goal-detail-helpers.js` has `goalEditor`. No boot errors besides the existing Telegram `getMe` 401. Editing not yet exercised in the logged-in dashboard.

**Reversible?** Yes: check out `aee5ce1` and rebuild.

### 2026-10-06 — Probed Claude CLI vision inside the container (read-only)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Check that the container's Claude CLI accepts image blocks via `--input-format stream-json` before wiring images through `ClaudeCliLLMClient` |

```bash
docker cp D:/tmp/vision-probe.ts aibot-framework-aibot-1:/tmp/vision-probe.ts
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 sh -c 'cd /tmp && bun /tmp/vision-probe.ts'
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 mkdir -p /tmp/vprobe
docker cp D:/tmp/vision-probe2.ts aibot-framework-aibot-1:/tmp/vprobe/probe.ts
docker cp src/claude-cli.ts aibot-framework-aibot-1:/tmp/vprobe/claude-cli.ts
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 sh -c 'cd /tmp/vprobe && bun probe.ts'
```

**Outcome.** CLI 2.1.289 read a generated red PNG sent raw as stream-json ("Red"). The patched `claudeGenerate` read a blue PNG ("Blue.") and parsed usage. Two haiku calls, files left only in the container's `/tmp` (gone on next recreate). No bot state, volume or config touched.

**Reversible?** Nothing to reverse.

### 2026-10-06 — Rebuilt so Claude CLI bots see images

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Deploy `d11297e`: `ClaudeCliLLMClient` sends images as image blocks via stream-json instead of a "no vision" note |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-06T23-25-36`. Container recreated, `healthy`; image `/app/src/claude-cli.ts` has `buildClaudePromptInput` / `extractStreamJsonResult`, `/app/src/core/llm-client.ts` has `MAX_CLI_IMAGES`. 9 bots started. Only boot errors: the two known revoked Telegram tokens (cryptik, job-seeker → headless). A real Telegram photo not yet sent.

**Reversible?** Yes: check out `52ecb5a` and rebuild.

### 2026-10-06 — Memory audit of the fleet (read-only) and backup before a memory repair

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` (data and productions volumes, read-only) |
| **Who** | Diego (via Claude) |
| **Why** | Finny (`default`) did not know Pri and the kids and repeated stale claims; audit before repairing memory |

```bash
docker cp aibot-framework-aibot-1:/app/data/tenants/__admin__/bots/default/soul D:/tmp/aibot-default-soul
docker cp D:/tmp/custody-pairs.ts aibot-framework-aibot-1:/tmp/custody-pairs.ts   # + custody-ctx.ts; read-only line pairing
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 bun /tmp/custody-pairs.ts
# plus read-only greps/bun -e over hygiene/runs.jsonl, tool-audit, memory.db (readonly), sessions, logs
bun scripts/docker/backup.ts backup
```

**Outcome.** Backup `D:\aibot-backups\aibot-backup-2026-10-06T23-47-24` (container restarted by the backup). Findings: the 2026-10-04 16:05 hygiene run redacted `custody` lines in default (`legacy.md` kids list + 3 MEMORY.md lines), milei-rocca (its rule `REGLA_CUSTODIA_TEXTO`) and ai-perfectionist ("write-capable children"); originals in each `.versions/*.2026-10-04T16-05-*.bak`. `/app/productions/default` has been empty (0-byte changelog) since 2026-10-04 ~00:27Z, cryptik lost 30–43 in the same window; no tool call did it, not in any backup (oldest is 2026-10-04T18-57). No bot memory written: the repair was blocked by the permission guard and waits for the operator.

**Reversible?** Nothing changed besides the backup.

### 2026-10-06 — Deployed the memory fixes and repaired bot memory

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1`, data volume (soul files of default, milei-rocca, ai-perfectionist; `memory.db`) |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Deploy `b1565d7` (custody redaction opt-in, flush every N messages, dates, memory viewer) and undo/correct the memory damage found in the audit |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
docker cp D:/tmp/memory-repair.ts aibot-framework-aibot-1:/tmp/memory-repair.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/memory-repair.ts              # dry run
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/memory-repair.ts --apply      # files + goal; DB step failed (readonly:false misuse), nothing written to the DB
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/memory-repair.ts --core-only --apply
docker cp D:/tmp/verify-memory.ts aibot-framework-aibot-1:/tmp/verify-memory.ts
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun /tmp/verify-memory.ts
```

**Outcome.** Backup `D:\aibot-backups\aibot-backup-2026-10-07T00-39-16`. Container `healthy`; the image has `src/memory/viewer.ts` and `unflushedMessageCount`.

Repair:
- Restored 11 custody-redacted lines from the 2026-10-04 `.bak` files: default `legacy.md` ×6 and `MEMORY.md` ×3, milei-rocca ×1, ai-perfectionist ×1.
- Finny's MEMORY.md gained an operator-corrections block and a People section (days with the kids: Mar/Mié, confirmed by Diego). False lines about Telegram, replies and the productions inventory were fixed in place.
- The note on the Diego goal was rewritten through `writeGoalsFile`, actor `operator`.
- `core_memory` (default): deleted #272, #292, #324, #398 and #405 (wrong facts). Scoped 38 of Pri's "User…" facts to `user_id 1531050540`; none deleted.

Each file's backup is `.versions/*.2026-10-07T00-40-59.bak`; the DB snapshot is `/app/data/memory.db.2026-10-07T00-41-08.bak`.

Verified: 0 custody markers. Diego's core-memory block shows the family facts and none of Pri's private ones; Pri's block shows hers.

**Reversible?** Yes. Copy the `.bak` files back, or restore `memory.db` from the snapshot (stop the container first). For the code: check out `e5f2d3a` and rebuild.

### 2026-10-10 — ai-perfectionist engagement gate soft → hard

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1`, config volume (`bots.json`) |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | ai-perfectionist wrote 12 unreviewed files 10-05 → 10-09 (daily judge-validation sims) because its gate was `soft` and only annotated the prompt |

```bash
bun scripts/docker/backup.ts backup
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 sh -c 'cd /app/config && bun -e "…set bots[ai-perfectionist].agentLoop.engagementGate.mode = \"hard\", JSON.stringify(…, null, 2)…"'
```

**Outcome.** Backup `D:\aibot-backups\aibot-backup-2026-10-10T10-31-37` (the script paused and restarted the container). `bots.json` keeps its 247 lines; only `"mode": "soft"` → `"hard"` changed. `bots.json` is not hot-reloaded: the change applies at the next container restart.

**Reversible?** Yes. Set the field back to `"soft"`, or restore `aibot_config` from the backup.

### 2026-10-10 — Deployed `ea64498` (unread output teaches the bot; scratch files out of Needs You)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship `ea64498` and activate ai-perfectionist's `hard` engagement gate (config edited earlier today) |

```bash
docker compose up -d --build
```

**Outcome.** Container `healthy`. The image has `isScratchProductionPath` in `src/bot/tool-executor.ts`, `recordIgnored` wired in `src/web/server.ts`, and the SUPPORTING WORK rule in `src/bot/agent-loop-prompts.ts`. Boot logs show no errors except the known `default` Telegram `getMe` 401 (revoked token, already in older logs).

**Reversible?** Yes. Check out `61fcb80` and rebuild; set the gate back to `soft` in `bots.json`.

### 2026-10-10 — Deployed `9e15bda` (feed names the cause of tool failures; walled sites remembered 7 days)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship `9e15bda` |

```bash
docker compose up -d --build
```

**Outcome.** Container `healthy`. `http://127.0.0.1:3000/pages/fleet-home-helpers.js` serves `describeToolFailure`; the image has the 7-day `DEFAULT_BLOCKED_HOST_TTL_MS` and `toolTarget(e.args)` in the stream bridge. No error-level boot logs. `<data>/web-fetch/blocked-hosts.json` is created on the first blocked fetch.

**Reversible?** Yes. Check out `bcf0481` and rebuild; deleting `blocked-hosts.json` clears the list.

### 2026-10-10 — Deployed `9c18403` (Fleet Board prototype)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship the Fleet Board (`#/board`) and its goal API (subtasks, DELETE) |

```bash
docker compose up -d --build
```

**Outcome.** Container `healthy`. Served: `/pages/fleet-board.js` (`renderFleetBoard`), `/nav-routes.js` (`fleetBoard`), `/style.css` (`fb-lane`). The image has `DELETE /:id/goals` and `TASK_LINE`; an unauthenticated `DELETE /api/agents/x/goals` answers 401 (route present). No error-level boot logs.

**Reversible?** Yes. Check out `7addb27` and rebuild. GOALS.md files edited from the board keep `- task:` lines, which older code ignores.

### 2026-10-10 — Deployed `e046e2b` (readable Fleet Board)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship the redesigned Fleet Board (overview rows, agent board, goal drawer) and the `headline` / `brief` goal edits |

```bash
docker compose up -d --build
```

**Outcome.** Container `healthy`. Served: `/pages/fleet-board-helpers.js` (`goalHeadline`), `/nav-routes.js` (`#/board/:id`), `/style.css` (`fb-row`). The image has `GOAL_HEADLINE_MAX` in the goal route. No error-level boot logs.

**Reversible?** Yes. Check out `8aefe5b` and rebuild. GOALS.md files edited from the board keep `- headline:` lines, which older code ignores.

### 2026-10-11 — Deployed `10410d8` (conversations end, messages carry their time, old facts stay old)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Finny continued weeks-old conversations and called old facts "hoy": no chat ever ended, messages had no timestamps, core memory restamped re-extracted facts |

```bash
docker compose up -d --build
```

**Outcome.** Container recreated; dashboard answers 200. The image has `src/bot/session-continuity.ts`, `src/bot/message-envelope.ts`, and `/start` registered in `builtin-commands.ts`. AIBot (Finny) started on Telegram. Only boot error: the known revoked `job-seeker` Telegram token (headless). The live config does not set `session.resetPolicy`, so the new default (daily at 4 am) applies to every bot. Not yet exercised from Telegram.

**Reversible?** Yes. Check out `f9bcab1` and rebuild. Stored user messages keep their `[weekday date time]` prefix, which older code shows as text; `ended-sessions.json` is ignored by older code.

### 2026-10-12 00:33Z — Volume backup before the relay deploy

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Preflight for deploying `feat/relay` (`9c590a7`) |

```bash
MSYS_NO_PATHCONV=1 bun scripts/docker/backup.ts backup
docker compose build
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-12T00-33-52`; the script restarted `aibot`. Image `aibot-framework:latest` built with the relay code. The recreate (`docker compose up -d`) and moving the shared web session `bot:default:private:0` out of `sessions/` were refused by the session's permission classifier and are left for Diego to run.

**Reversible?** Yes: the backup restores with `bun scripts/docker/backup.ts restore … --force`.

### 2026-10-12 00:45Z — Deployed `9c590a7` (relays) and cleaned Finny's directory and web session

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship relays; Finny's text for the operator sat in the shared anonymous widget session, and an old web-only "operator" contact kept its own entry |

```bash
docker compose stop aibot
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps --entrypoint bun aibot -e "$(cat /d/tmp/clear-shared-web-session.js)"
docker compose up -d
# then, with the container stopped again: append two lines to /app/data/user-directory/default.jsonl
# (old web-only operator entry -> metadata.mergedInto = operator id; operator gets its name and email as aliases)
docker compose stop aibot
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps --entrypoint bun aibot -e '<append merge lines>'
docker compose up -d
```

**Outcome.** `bot:default:private:0` moved to `/app/data/_trash/2026-10-12T00-45-20-629Z-relay-shared-web-session/` (13 sessions left). The image has `src/relay/`. On boot, `startBot` seeded the operator: one `role: operator` contact with Telegram + the config email. After the merge, the operator's name, "operador", the old contact's name and its email all resolve to that contact. Container healthy, dashboard 200, no boot errors besides the known revoked `job-seeker` token. Backup of the directory file: `default.jsonl.bak-relay-merge`. Not yet exercised from Telegram.

**Reversible?** Yes. Restore the backup from 00:33Z, or copy `default.jsonl.bak-relay-merge` back and move the session out of `_trash`. Code: check out `5697e01` and rebuild.

### 2026-10-12 01:24Z — Deployed `60a10b8` (relay: who is speaking, force_reply)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Live: the operator answered a relayed question in free text and Finny answered him as if he were the person who asked |

```bash
docker compose up -d --build
```

**Outcome.** Container healthy, dashboard 200, AIBot (Finny) started. The image has the "Who you are talking with" section (`src/relay/prompt.ts`) and `force_reply` (`src/relay/service.ts`). Finny's live IDENTITY.md has `name: Finny`, which the relay header now uses. Not yet exercised from Telegram.

**Reversible?** Yes: check out `c612e92` and rebuild.

### 2026-10-12 03:38Z — Deployed `b10922d` ("Why this?" everywhere)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship the "Why this?" work (`docs/plans/why-everywhere-plan.md`, phases 0–3): every dashboard surface says where an item came from |

```bash
docker compose up -d --build
```

**Outcome.** Container recreated and healthy within a minute. Served `/pages/why-helpers.js` has `whyPanel`; the image has the 18 builders in `src/why/builders/`. New routes (`/api/agents/:id/cycles/:cycleId`, `/api/proactive`, `/api/agents/:id/memory-history`) answer 401 without a session, i.e. they are mounted behind auth; not exercised logged in. Startup logs: the only error is job-seeker's Telegram `getMe` 401 (revoked token), already present in older rotated logs; an "OLLAMA AUTHENTICATION FAILED" line in `aibot.log` is about 61 days old, not from this boot. New on-disk files appear as agents act: `<soul>/soul-events.jsonl`, `<soul>/DIRECTIONS.jsonl`, new optional fields in the cycle log, cron jobs, permissions, proposals, feedback and TRAITS.json.

**Reversible?** Yes for the code: check out `60a10b8` and rebuild. Files and fields written since are additive and ignored by the older code.

### 2026-10-12 12:37Z — Deployed `ebeb4af` (goal tasks with lanes)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship goal tasks: lanes, authors and ids in GOALS.md, `manage_goals add_task` / `update_task`, and the Agent Home board that opens a goal's tasks under its row |

```bash
docker compose up -d --build
```

**Outcome.** Container recreated and `healthy` within ~25 s; dashboard 200. Served `/pages/agent-home-helpers.js` has `goalTasksPanel` and `/style.css` has `home-task-lane`; the image's `src/tools/goals.ts` has `add_task`. Boot logs show a Telegram `getMe` 401 (the revoked token seen in earlier deploys) and "Ollama daemon is unreachable"; neither comes from this change. Task moves through `PATCH /api/agents/:id/goals` not exercised from here (the API needs a dashboard session).

**Reversible?** Yes for the code: check out `2533471` and rebuild. Tasks written since carry `[~]`/`[!]` marks and a `{id, by, cycle}` suffix; the older parser reads `[~]`/`[!]` lines as no task and keeps the suffix in the text, so roll back before many such tasks exist.

### 2026-10-12 12:09Z — Deployed `255f938` (goal activity on the Fleet Board)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship the Fleet Board goal activity: "worked Xh ago · N cycles / 7d" pulse on In progress cards, the drawer's Activity section, and `- parent:` spawned goals |

```bash
docker compose up -d --build
```

**Outcome.** Container recreated and `healthy` within ~30 s. Served `/style.css` has `fb-gpulse`; served `/pages/fleet-board-helpers.js` has `activityHtml` / `goalPulse`; the image's `src/stats/agent-home-aggregator.ts` calls `buildGoalActivity`. Boot errors: the known Telegram `getMe` 401 (revoked token) and "Ollama daemon is unreachable", both in earlier deploys, neither from this change. Not exercised logged in (the dashboard needs a session). No data written: live goals carry no `parent` until reflection, the strategist or `manage_goals add` writes one.

**Reversible?** Yes: check out `5efe173` and rebuild. `- parent:` lines written since are ignored by the older parser and dropped on its next GOALS.md write.

### 2026-10-12 12:14Z — Volume backup before linking a goal parent

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Before adding `- parent: g-7cb6a370` to AI Perfectionist's digest goal (`g-1001d015`) in the live GOALS.md |

```bash
bun scripts/docker/backup.ts backup
```

**Outcome.** Backup written to `D:\aibot-backups\aibot-backup-2026-10-12T12-14-04`; the script restarted aibot. The link itself was **not** written: the one-off script threw in `backupSoulFile` (wrong arguments) before calling `writeGoalsFile`, and the follow-up check inside the container was blocked by the session's permission policy, so it is left for Diego. GOALS.md is unchanged as far as the script got.

**Follow-up (12:2xZ).** Diego ran the corrected one-off script himself (`docker cp … link.ts` + `bun _link.ts` in `/app`, which backs GOALS.md up to `.versions/` and writes through `writeGoalsFile` as `operator`): output `linked g-1001d015 -> g-7cb6a370`. The digest goal now carries `- parent: g-7cb6a370`; the LLMs goal's drawer lists it under "Spawned from this goal".

### 2026-10-12 13:30Z — Backup, then deployed `591dff3` (goal tasks phase 0)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship goal tasks phase 0 (`docs/plans/goal-tasks-architecture-plan.md`): TASKS.json store + op API, goals view, real cancellation, Claude CLI semaphore, `blocked` enforced in the loop, tenant-scoped dashboard sockets. The task migration rewrites GOALS.md on first read, so the volumes were backed up first |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-12T13-29-58` (aibot_data 143.7 MB, productions, ollama identity; the script restarted the container). Before the rebuild, 0 of 24 live GOALS.md files had `- task:` lines, so the migration had nothing to move and no `TASKS.json` exists yet (one is created on the first task write). After the rebuild: `healthy` in ~35 s, dashboard 200, the image has `src/goals/{task-store,goals-view}.ts`, `src/core/cli-semaphore.ts`, `src/web/ws-tenant-filter.ts`, `src/bot/executor-turn.ts`; served `/pages/ws-reconnect.js` is the new one; `PATCH /api/agents/:id/tasks/:taskId` answers 401 without a session (route mounted behind auth). Agent cycles ran planner → tool pre-selection → executor on the new code. Boot errors seen: Telegram `getMe` 401 (revoked token, known), "Ollama daemon is unreachable" (known), a Telegram "can't parse entities" on an `ask_human` send (also in five older rotated logs), one `web_fetch` failure. Task moves from the boards not exercised from here (needs a dashboard session).

**Reversible?** Code: check out `2b8fde5` and rebuild. Data: `TASKS.json` files written after this deploy are ignored by the older code (tasks would disappear from the boards until redeployed); restore from the backup above only if GOALS.md itself needs to go back.

### 2026-10-12 19:21Z — Backup, then deployed `33ad720` (goal tasks phases 1–4: planner breakdown, task workers off, live view, upkeep)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Ship phases 1–4 of `docs/plans/goal-tasks-architecture-plan.md` after three review rounds. Workers stay off (no `workers` section in the live config) |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-12T19-21-44`. Before the rebuild: no `workers` key in `/app/config/config.json` (workers off), no `TASKS.json` yet. After: `healthy` in ~38 s, dashboard 200, the image has `src/workers/*` and `src/runtime-lifecycle.ts`, served `/pages/workers.js` is the new one, `/api/workers` answers 401 without a session. Cycles ran planner → executor on the new code with no new errors. One regression seen in the logs: myfirstmillion called `manage_goals` with a goal id (`g-5ba5ff60`, an active goal) and got "No active goal matching" — `findGoalIndex` matched text only and agents now see ids; fixed in `1809d60`, needs a rebuild.

**Reversible?** Code: check out `09b2261` and rebuild. Data: `TASKS.json` / `workers/` files written after this deploy are ignored by older code.

### 2026-10-12 19:31Z — Deployed `4aa9548` (manage_goals finds a goal by its id)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Fix the regression seen after the 19:21Z deploy: agents pass goal ids to `manage_goals` and got "No active goal matching" (charged as a tool error) |

```bash
docker compose up -d --build
```

**Outcome.** `healthy` in ~35 s, dashboard 200, the image's `src/tools/goals.ts` has the id match, no new errors in the boot logs. No backup: code-only change, taken 10 minutes after the 19:21Z backup.

**Reversible?** Check out `1278939` and rebuild.

### 2026-10-12 19:38Z — Workers enabled for all bots (live config)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1`, volume `aibot-framework_aibot_config` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Turn on task workers (phase 2) for every bot, with a conservative daily budget for the first day |

```bash
bun scripts/docker/backup.ts backup
# in the container: cp /app/config/config.json /app/config/config.json.pre-workers-20261012
# then added, via a bun one-off (JSON parse → add key → write, 2-space indent):
#   "workers": { "enabled": true, "bots": [], "maxConcurrent": 2, "maxPerBot": 1, "dailyStepsPerBot": 30 }
docker compose restart aibot
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-12T19-37-50`. The block validated with `WorkersConfigSchema` in the container; a parse-and-compare confirmed `workers` is the only key added. After the restart: `healthy` in ~40 s, boot errors only the known Telegram `getMe` 401. First cycle per bot after the restart: all `completed`, no tasks written and nothing dispatched yet — most were curiosity exploration cycles (which never write tasks by design); job-seeker served a goal and its planner did not break it down.

**Reversible?** Yes: restore `/app/config/config.json.pre-workers-20261012` (or set `workers.enabled` to false) and restart.

### 2026-10-12 21:07Z — Deployed `087d0ae` (goals with an end state must be broken down; standing goals)

| | |
| --- | --- |
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | No bot wrote a task after workers went live: breakdown was optional. Now required for goals with an end state; goals without one are marked standing and get no tasks |

```bash
docker compose up -d --build
```

**Outcome.** `healthy` in ~37 s, the image has `standing_goal` in `src/bot/agent-loop-tasks.ts`, the live config still has `workers`, served `/pages/agent-home-helpers.js` has `goalKindPayload`, no new errors in the boot logs. No backup: code only; GOALS.md gains a `- kind: standing` line when a goal is marked.

**Reversible?** Check out `8e4abd3` and rebuild; older code ignores the `kind` line.

### 2026-10-13 — Deploy goal-flow fixes (`d57f6ef`): standing marks land, fair stalled pulse

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | A day after goal tasks went live: no goal was ever marked standing (`standing_goal` dropped in `taskFieldsOf`), explore/gated cycles wrote no tasks, and the board showed most In progress goals "stalled" |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-13T21-07-32`. `healthy` in ~30 s; the image passes `standing_goal` through `taskFieldsOf`, has `goalTurnIntervalMs`, and the assistant preset has 3 standing goals; served `/style.css` has `.fb-tag.notasks` and `/pages/fleet-board-helpers.js` has `goalYardstickMs`; bots started. The "Ollama daemon is unreachable" boot error was already there on the previous boot (all bots run claude-cli).

**Reversible?** Check out `1538c33` and rebuild; data from the backup above with `restore … --force` if ever needed (this deploy writes only `- kind: standing` lines and tasks).

### 2026-10-13 — Deploy living documents (`fa554d2`) and archive all but one document per goal

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`; productions volumes |
| **Who** | Diego (via Claude), approved by Diego (deploy, and the keep/archive list with two swaps) |
| **Why** | Bots wrote a new file per cycle (jarvis-factory 12 files on one thread). The new rules keep one short document per goal; the backlog was cut to match |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
docker cp D:/tmp/aibot-scripts/plan-archive.js aibot-framework-aibot-1:/tmp/plan-archive.js
docker exec aibot-framework-aibot-1 bun /tmp/plan-archive.js            # read-only plan
docker cp D:/tmp/aibot-scripts/apply-archive.ts aibot-framework-aibot-1:/tmp/apply-archive.ts
docker exec -w /app aibot-framework-aibot-1 bun /tmp/apply-archive.ts   # dry run: 39, 0 problems
docker exec -w /app aibot-framework-aibot-1 bun /tmp/apply-archive.ts --apply
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-13T22-29-00`. Container healthy in ~30 s with `livingDocRefusalFor` and PROGRESS IMPERATIVE in the image. 39 documents archived with `ProductionsService.archiveFile` (moved to `archived/`, changelog `archive` entries, reason "Living documents cleanup 2026-10-13"), 12 kept: the newest document per active goal, except jarvis-factory purpose goal → `06_lights-off-gating-rules-v1.md` and job-seeker roles brief → `11_weekly_roles_brief_2026-10-12.md` (operator swaps). Documents with no goal or a closed goal were archived. Code files untouched. No karma charged (not the Needs You / auto-archive path).

**Reversible?** Files are in each bot's `archived/`; restore one from the Productions page or move it back. Whole state: `restore D:\aibot-backups\aibot-backup-2026-10-13T22-29-00 --force`. Code: rebuild from `d57f6ef`.

### 2026-10-15 — Deploy auto-dispatch + document cap 12,000 (`e97c8a3`); less exploration; fudi every 3 h

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`; live `config/config.json` and `config/bots.json` (volume) |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | 37 h after living documents: 0 of 41 dispatch offers taken, edits bouncing off the 6,000 cap, 55 % explore cycles on jarvis-factory, fudi idle 38 % at 1 h |

```bash
bun scripts/docker/backup.ts backup
docker cp D:/tmp/aibot-scripts/cfg.js aibot-framework-aibot-1:/tmp/cfg.js
docker exec -w /app aibot-framework-aibot-1 bun /tmp/cfg.js   # backs up both files as .bak-2026-10-15-explore
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-15T11-05-34`. `agentLoop.curiosity = { exploreRatio: 0.15, maxTopicShare: 0.85, noSurpriseStreak: 6 }` in `config.json`; fudi `agentLoop.every: "3h"` in `bots.json`. Healthy in ~35 s; image has `pickAutoDispatch` and `maxChars: 12000`; bots started. The "Ollama daemon is unreachable" boot error predates this (all bots run claude-cli).

**Reversible?** `cp config/config.json.bak-2026-10-15-explore config/config.json` (same for `bots.json`) inside the container and restart; code: rebuild from `6cd8d99`; auto-dispatch alone: `workers.autoDispatch: false`.

### 2026-10-15 — Deploy error detail + Claude accounts prototype + Usage (`274de34`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude); deployed while the fleet was stopped by the weekly Claude limit |
| **Why** | The new Integrations card and Insights → Usage were already served (web/ is mounted) but their API routes were not: both showed JSON parse errors |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-15T12-53-12`. Healthy in ~35 s; `/api/claude-accounts` and `/api/stats/usage` answer JSON (401 without a session). Inside the container `createClaudeAccounts(config).list()` returns `default` (`/app/data/claude`, logged in, diego.falciola@agilityio.com, active). `CLAUDE_CONFIG_DIR=/app/data/claude`. Add-account login not exercised with a real second account yet.

**Reversible?** Rebuild from `8cb8f70`. Accounts added later live in `/app/data/claude-accounts/`; deleting `accounts.json` there falls back to the original login.

### 2026-10-15 — Deploy accounts CRUD + test button + cost backfill script (`6813840`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | Accounts could not be renamed or removed and there was no way to check one works; Usage showed $0 cost |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
docker exec -w /app aibot-framework-aibot-1 bun /tmp/bf/scripts/usage/backfill-claude-costs.ts /app/data   # dry run only, before the deploy
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-15T13-06-51`. Healthy in ~35 s; the image has `ClaudeAccountService.test` and `scripts/usage/backfill-claude-costs.ts`; served `claude-accounts-helpers.js` has the Test button. Test from inside the container: `default` (agilityio) 429 weekly limit, resets 15:00 BA; `test-123` (bairesdev) OK in 5.8 s, $0.047. Backfill dry run: 1,875 sessions, 1,766 matched to 1,652 calls, $195.85 since 2026-09-26, $6.27 unattributed. **Not applied** (writes the data volume): `docker exec -w /app aibot-framework-aibot-1 bun scripts/usage/backfill-claude-costs.ts --apply`.

**Reversible?** Rebuild from `673a9f7`.

### 2026-10-15 — Applied the Claude cost backfill to the live query log

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1`, `/app/data/llm-query-log` (data volume) |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Insights → Usage showed $0: no entry before 2026-10-15 recorded cost or cache tokens |

```bash
docker exec -w /app aibot-framework-aibot-1 bun scripts/usage/backfill-claude-costs.ts /app/data --apply
docker exec -w /app aibot-framework-aibot-1 bun scripts/usage/backfill-claude-costs.ts /app/data   # re-run: 0 left
```

**Outcome.** 1,880 sessions; 1,771 matched to 1,657 calls ($189.58); 109 unattributed ($6.27) appended to `llm-query-log/_unattributed/`. 76 files rewritten; backup at `/app/data/llm-query-log.bak-backfill-2026-10-15T13-12-49-466Z`. A second run finds 0 sessions to backfill. Usage now: 7d $150.84 (1,883 calls), 30d $190.63; the $5.22 gap to the total is cryptik, econ-student and milei-rocca, no longer in the bot config.

**Reversible?** `rm -rf /app/data/llm-query-log && mv /app/data/llm-query-log.bak-backfill-2026-10-15T13-12-49-466Z /app/data/llm-query-log` inside the container (calls logged after 13:12 UTC would be lost from the log).

### 2026-10-15 — Deploy account availability (Available column)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude) |
| **Why** | The operator needs to see what each Claude account has left before switching |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
docker cp D:/tmp/aibot-scripts/acctest.ts aibot-framework-aibot-1:/tmp/acctest.ts
docker exec -w /app aibot-framework-aibot-1 bun /tmp/acctest.ts   # Test on every account
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-15T13-19-21`. Healthy in ~35 s. Test: `default` (agilityio) rejected, week 100 % used, resets 18:00 UTC; `test-123` (bairesdev, active, switched by the operator from the dashboard) allowed, 5 h 29 % used (resets 14:40 UTC), week 43 % (resets 2026-10-17 21:00 UTC). Saved in `/app/data/claude-accounts/limits.json`.

**Reversible?** Rebuild from `35acea2`.

### 2026-10-15 — Deploy standing-goal rotation + drop goals/tasks (`66cf3ef`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego |
| **Why** | Standing goals were never served (board "stalled"); nothing could say a goal or task no longer applies |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-15T13-51-14`. Healthy in ~35 s; the image has `src/goals/standing-rotation.ts` and `plannerStandingDue`; bots started; active Claude account `test-123` (applied at boot). In the first ~2.5 min: 15 LLM calls, all successful, all `account: test-123`, cost recorded; worker runs active.

**Reversible?** Rebuild from `163ad36`.

### 2026-10-16 — Rebuilt for goal titles and the Telegram borrow switch

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego in chat |
| **Why** | Deploy `1f3ffee`: goal titles no longer cut at 72 chars (headline up to 200); headless bots no longer write from @SpicyFinnyBot (`operator.borrowFleetTelegram`, default off) |

```bash
docker compose up -d --build
```

**Outcome.** No backup taken (no data touched; code only). Healthy in ~38 s; the image has `src/channel/fleet-telegram.ts` and `GOAL_HEADLINE_MAX = 200`; served `fleet-board-helpers.js` has `HEADLINE_MAX = 140` and `style.css` has `field-sizing: content`. All 7 bots started; `job-seeker` came up headless: Telegram rejects its token (401, `channelState: revoked`), unrelated to this change.

**Reversible?** Rebuild from `adba3ea`.

### 2026-10-16 — Deploy one speaker per chat (`62e2808`) and drop task `t-c92ad8`

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego (via Claude), approved by Diego in chat |
| **Why** | Finny answered each operator Telegram message twice (the agent loop re-answered chat lines); plan `docs/plans/personal-organizer-plan.md` P0 |

```bash
bun scripts/docker/backup.ts backup
docker compose up -d --build
MSYS_NO_PATHCONV=1 docker exec -w /app aibot-framework-aibot-1 bun -e "<TaskStore('/app/data/tenants/__admin__/bots/default/soul').apply([{ op: 'remove', id: 't-c92ad8', note: … }], { actor: 'operator' })>"
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-16T13-43-59`. Image has `recordHumanMessage` in `src/bot/agent-scheduler.ts`; `/api/status` 200; AIBot (Finny) started, `job-seeker` headless (401, known). Task `t-c92ad8` ("Cuando Diego conteste, responderle en el mismo día…") removed through `TaskStore` (rev 29, `task-remove` event with the reason); the dashboard DELETE route needs a login, so it was done in-container. Startup also logged "Ollama daemon is unreachable" (not touched by this change).

**Reversible?** Rebuild from `eef7432`; restore the backup to bring the task back.

### 2026-10-16 — Deploy of the personal organizer (`c763b8c`) and the finance API in Finny

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego ran the commands (the permission classifier refused the rebuild to the session) |
| **Why** | Ship personal accounts (off until configured), HTTP API tools, WhatsApp export summaries and the security hardening; connect Finny to the finance app's read-only API (diegofal/my-finance#73, in production since today) |

```bash
python -c "…secrets.token_urlsafe(32)…"   # key appended to .env as FINANZAS_AGENT_KEY; only the sha256 printed (it went to Vercel)
bun scripts/docker/backup.ts backup
MSYS_NO_PATHCONV=1 docker cp D:/tmp/finny-config/add-finanzas.ts aibot-framework-aibot-1:/tmp/add-finanzas.ts
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 bun /tmp/add-finanzas.ts   # integrations.httpApis = [finanzas]; previous config kept as config.json.bak-<ISO>
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-16T22-01-50`. `/api/status` 200; `FINANZAS_AGENT_KEY` present in the container; boot logged "HTTP API tools registered" with `api_finanzas_saldos`, `api_finanzas_vencimientos`, `api_finanzas_proyeccion`, `api_finanzas_conciliacion_pendientes`, and `whatsapp_export_summary`; all bots started. The finance API itself was checked with curl against production (401 without/with a wrong key, 405 on POST, 200 on the four routes with the key). Not yet exercised end to end through Finny on Telegram. Personal accounts stay off: no OAuth clients, `integrations.personalAccounts.bots` empty.

**Reversible?** Restore the config backup in the volume (`config.json.bak-*`) or remove `integrations.httpApis`, and rebuild from `7aa419b`; remove `FINANZAS_AGENT_KEY` from `.env`; on the finance side, `vercel env rm AGENTE_API_SHA256 production …` and redeploy.

### 2026-10-23 — Deploy the watcher (PR #12) and turn it on, both model tiers off

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, with Diego's go ("let's do it") |
| **Why** | Ship the fleet watcher (`d7471dc`) and run birth against the real fleet; tiers off so the first run spends no tokens |

```bash
"/c/Program Files/Docker/Docker/Docker Desktop.exe"   # Docker Desktop was not running; the old container auto-started
bun scripts/docker/backup.ts backup
MSYS_NO_PATHCONV=1 docker cp aibot-framework-aibot-1:/app/config/config.json D:/tmp/live-config.json
# python: config.watcher = { enabled: true, notice: { enabled: false }, integrate: { enabled: false } }
MSYS_NO_PATHCONV=1 docker cp D:/tmp/live-config.json aibot-framework-aibot-1:/app/config/config.json
docker compose up -d --build
```

**Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-23T20-36-42`. Container healthy. Birth ran on boot: 3,269 neurons (6 bots, 4 people, 66 goals, 200 topics, 1,832 facts, 401 surprises, 760 questions) in 1 min 1 s, no tokens. Link stage fell back to `no-embeddings`: the Ollama service (`http://ollama:11434`, compose profile `local-ollama`) has been down for 11 days, so `nomic-embed-text` is unreachable and neurons sit on shells by kind. Page, ball and vendored Three.js served 200; `/api/watcher` 401 without a token.

**Reversible?** Remove `watcher` from the live config (or set `enabled: false`) and restart; delete `/app/data/watcher/` to forget everything it learned; restore the backup for anything else.

### 2026-10-23 — Relink the watcher graph after Ollama came back

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | Diego started the `ollama` service; the session reopened the link stage |
| **Why** | Birth ran while Ollama was down, so no embeddings and no related links; resync never embeds, so the link stage had to be reopened by hand |

```bash
# inside the container, /app/data/watcher:
cp birth.json birth.json.bak-relink
# bun -e: drop "link" and "done" from birth.json done[], delete finishedAt, stage = "link"
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/stop
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/start
```

**Outcome.** `nomic-embed-text:latest` answers from `http://ollama:11434`. Link stage embedded all 3,269 neurons in about 2 min and added 1,388 `related` edges (3,271 → 4,659); layout recomputed; phase back to `sense`. The "Born … in 28 min 37 s" row measures from the first birth's `startedAt`. No fleet restart.

**Reversible?** Restore `birth.json.bak-relink`; embeddings live in `embeddings.jsonl` and can be deleted with the watcher stopped.

### 2026-10-23 — Turn on the watcher's notice tier (Haiku)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "restart" |
| **Why** | Let the watcher turn live events into neurons; integrate stays off |

```bash
MSYS_NO_PATHCONV=1 docker cp aibot-framework-aibot-1:/app/config/config.json D:/tmp/live-config.json   # copy kept as D:/tmp/live-config.before-notice.json
# python: config.watcher.notice = { enabled: true }
MSYS_NO_PATHCONV=1 docker cp D:/tmp/live-config.json aibot-framework-aibot-1:/app/config/config.json
docker compose restart aibot
```

**Outcome.** Healthy; wake + resync (nothing new), first notice pass 75 s later: 12 events, 5 kept, 1 recognised. Model `claude-haiku-5-5`, 1,968 prompt tokens but 22,122 cache-creation tokens (the Claude CLI's own system prompt), `costUsd` 0.2163 for one pass. At the default cap of 288 passes/day that is up to about $62/day of plan quota unless later calls read the cache.

**Reversible?** Set `watcher.notice.enabled` back to false (or restore the before-notice copy) and `docker compose restart aibot`.

### 2026-10-23 — Cap notice, turn on integrate (2 Opus passes/day), phase 0 baselines

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "let's do this" |
| **Why** | Bound the Haiku spend found above; let the watcher produce its first insights and broadcasts; record the metric baselines the plan is judged against |

```bash
MSYS_NO_PATHCONV=1 docker exec aibot-framework-aibot-1 sh -c 'cd /app && bun scripts/watcher/baseline.ts --config /app/config/config.json --data /app/data'
MSYS_NO_PATHCONV=1 docker cp aibot-framework-aibot-1:/app/config/config.json D:/tmp/live-config.json   # copy kept as live-config.before-integrate.json
# python: watcher.notice = { enabled: true, maxPerDay: 48 }; watcher.integrate = { enabled: true, maxPerDay: 2 }
MSYS_NO_PATHCONV=1 docker cp D:/tmp/live-config.json aibot-framework-aibot-1:/app/config/config.json
docker compose restart aibot
# in the container: bun scripts/watcher/introspect.ts --subject bot:ai-perfectionist --token "$ADMIN_API_KEY"; bun scripts/watcher/canary.ts plant --bot default --fact "… heliotrope." --question "…"
```

**Outcome.** Baseline (30 d): 774 cycles, 5 % idle, median cycle gap 1.4 h, 0 topics shared by name across bots, 719 chat/plan candidates; report `/app/data/watcher/baseline-2026-10-23.json`. Healthy after restart; integrate on at 2/day. Introspection of an idle bot scored 1.00 on a single trivially matching field (scorer flaw, noted for the cleanup PR). Canary planted with bot `default` (Finny); `check --bot <other>` is due tomorrow. Measured CLI overhead for the cost fix: default call 28k prefix tokens $0.081; `--tools "" --setting-sources ""` $0.046; plus own `--system-prompt` 565 tokens $0.0046.

**Reversible?** Restore `live-config.before-integrate.json` into the volume and restart.

### 2026-10-23 06:20 — Switch the fleet's Claude account to Agility and run the loop

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, with Diego's go ("let's restart the bots") |
| **Why** | Account Test 123 hit its weekly limit (429 since 2026-10-22, resets Oct 24 6pm ART); Agility tested with 82 % of the week left |

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" http://127.0.0.1:3000/api/claude-accounts/default/activate
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{}' http://127.0.0.1:3000/api/agent-loop/run
```

**Outcome.** `{"ok":true}`; the claude-cli breaker reset. Strategist and planner calls succeeded on account `default` for every bot, zero 429s in the following 3 minutes. No container restart.

### 2026-10-23 — Deploy the watcher follow-up (PR #14, `2197e01`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "yes please" |
| **Why** | Bring the Claude CLI lean flags (≈40× fewer prefix tokens per call), the embedding backfill, the live watcher config route and the ball fixes to the running fleet |

```bash
docker compose up -d --build
```

**Outcome.** Healthy; `Claude CLI v2.1.289 ready`. Watcher woke from saved state (no rebirth). Verification of the per-pass cost, the config route and the backfill row recorded below this entry once observed.

**Reversible?** `git checkout d7471dc -- .` is not needed: rebuild from `d7471dc` (`git worktree add ../rollback d7471dc && docker compose -f ... build`) or `docker compose up -d --build` after reverting the merge. Config file untouched by this deploy.

**Verified after the deploy.** Wake row, resync (1 new contact: the phase 0 REST sender), `maintain:link` embedded the 4 neurons noticing had created without vectors. `POST /api/watcher/config` no-op patch → 200 with `tiers` in the state. First notice pass after the deploy: `claude-haiku-5-5`, 1,492 cache-creation tokens, $0.029 (was 22,122 tokens, $0.216 on the first pass this afternoon, $0.06 with cache reads).

### 2026-10-24 — Raise the watcher's integrate cap 2 → 6 (live, no restart)

```bash
# in the container, admin token:
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"integrate":{"maxPerDay":6}}' localhost:3000/api/watcher/config
```

**Why.** A pass costs cents since `2197e01`; 4 Opus passes produced 0 broadcasts and the watcher needs more passes a day to act. **Outcome.** 200, `tiers.integrate.maxPerDay: 6`, written to `/app/config/config.json` atomically. **Reversible?** Same call with `2`.

### 2026-10-24 — Deploy the watcher day-2 gaps (PR #15, `dddffc7`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "yes" |
| **Why** | Fleet-memory prefetch in operator chats, a watcher that broadcasts (criteria, standing agenda), repeat window, introspection cause |

```bash
docker compose up -d --build
```

**Outcome.** Healthy; wake + resync (1 new goal), `maintain:link` embedded 3 neurons. Verification (canary recall, introspection cause, first broadcast) recorded below once observed.

**Reversible?** Rebuild from `2197e01`. Config untouched.

**Verified after the deploy (`dddffc7`).** Cross-bot recall works through the prefetch: `canary.ts check --bot job-seeker` got "It's heliotrope … the fleet watcher's notes say you asked Finny to remember…" (log: `Fleet memory prefetch injected`). The script still reported "not found (0.29)" because it compares the whole planted sentence to the reply; fix in progress. Through `ai-perfectionist` the prefetch never ran: that bot has `tenantId: "__admin__"` and every watcher path treats any tenantId as a tenant bot (prefetch, tool exclusion, broadcast targets); fix in progress (`fix/watcher-admin-tenant`). Diagnostics run: embedding ranking of the canary question over the graph (canary fact rank 1, 0.798); `POST /api/watcher/introspect` (answer correct in substance, scored 0.5: scorer too strict, same branch).

### 2026-10-24 — Deploy the admin-tenant fix (PR #16, `71a056c`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "yes" |
| **Why** | Bots with `tenantId: "__admin__"` were excluded from fleet memory and broadcasts (the only cause of 0 broadcasts); canary `--expect`; introspection scorer |

```bash
docker compose up -d --build
```

**Outcome.** Healthy; wake, resync, `maintain:link` embedded 4 neurons. Verification (canary via `ai-perfectionist`, introspection score, first broadcast) recorded below once observed.

**Reversible?** Rebuild from `dddffc7`. Config untouched.

**Verified after the deploy (`71a056c`).** `canary.ts check --bot ai-perfectionist --expect heliotrope` → found (prefetch injected for an admin-tenant bot, which failed before). `POST /api/watcher/introspect` → 0.75 (phase, tool, goal match; cause miss: the watcher again cited only the salience label and number). First broadcast pending: the next agenda pass is due at 19:45 UTC (6 h after the last) unless 5 salient items arrive first.

**Cap raised 6 → 8 (live, 12:3x AST).** All 6 Opus passes of the UTC day were spent before the fix landed; `POST /api/watcher/config {"integrate":{"maxPerDay":8}}` so the agenda pass due at 19:55 UTC can run today. Reversible with the same call.

### 2026-10-24 — Deploy the week-1 watcher optimizations (PR #17, `b6e7555`)

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, on Diego's "yes please" |
| **Why** | O1–O8 of `docs/plans/watcher-optimizations-plan.md` |

```bash
docker compose up -d --build
# preview only (no apply):
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"routine":"watcher-graph"}' localhost:3000/api/hygiene/run
```

**Outcome.** Healthy; wake, resync (1 new goal), `maintain:link` embedded 6. `stakes:integrateBudgetPressure` fired at boot (today's integrate budget already 100 % used). Infra embedding row: `nomic-embed-text:latest` ok, 51 ms. First broadcast before this deploy: 17:31Z, directive to Jarvis-Factory (from the integrate pass, after #16). Graph cleanup previewed, not applied.

**Reversible?** Rebuild from `71a056c`. Config untouched.

### 2026-10-25 — Deploy forgetting (PR #19, consolidation off) and the Mind panel (PR #20), `667b9d3`

```bash
docker compose up -d --build
```

**Who.** The session, on Diego's "yes please". **Outcome.** Healthy; wake, resync (6 new goals), `maintain:link` embedded 23 neurons (24 related edges); `stakes:integrateBudgetPressure` at boot (today's integrate budget used). `archived: 0` until the first daily maintenance runs forgetting. Consolidation is off (`watcher.consolidate.enabled` default false, `preview: true`). `watcher-mind-helpers.js` and `watcher-memory-helpers.js` served 200. The bot entity "** MyFirstMillion Bot" still shows the asterisks: the neuron was created at birth before the name fix (#14) and resync does not rename existing entities. **Reversible?** Rebuild from `b6e7555`; config untouched.

### 2026-10-25 — Read-only look at the live watcher (config + broadcasts)

```bash
docker exec aibot-framework-aibot-1 sh -c 'cat /app/config/config.json'
docker exec aibot-framework-aibot-1 sh -c 'cd /app/data/watcher && wc -l broadcasts.jsonl; tail -n 4 broadcasts.jsonl; ls passes | wc -l'
```

**Who.** The session, answering Diego's questions about the watcher. **Outcome.** `watcher.enabled`, notice (48/day) and integrate (8/day) on; 46 broadcast lines, 55 pass records. Nothing written. **Reversible?** n/a, read-only.

### 2026-10-25 — Read-only cost figures for the watcher autonomy plan

```bash
docker exec aibot-framework-aibot-1 sh -c 'cd /app/data/watcher && for f in budget-*.json; do cat $f; echo; done'
docker exec aibot-framework-aibot-1 bun -e '<sum costUsd of /app/data/watcher/passes/*.json by caller>'
docker exec aibot-framework-aibot-1 bun -e '<sum costUsd of /app/data/llm-query-log/**.jsonl, last 7 days, by bot|caller>'
docker exec aibot-framework-aibot-1 bun -e '<count /app/data/agent-cycles/**.jsonl rows, last 7 days, by status>'
```

**Who.** The session, for `docs/plans/watcher-autonomy-plan.md`. **Outcome.** Watcher ~$2.2/day (integrate cap hit 10-24 and 10-25); fleet $211 over 7 days; cycles 186 completed / 32 error / 22 skipped / 5 idle. Nothing written. **Reversible?** n/a, read-only.

### 2026-10-25 — Deploy the prediction judge and forgetting fix (PR #21, `ce41afb`), re-judge old predictions

| | |
|---|---|
| **Environment** | Local container `aibot-framework-aibot-1` |
| **Who** | The session, unattended under Diego's "continue all the way tonight without me" (2026-10-25 23:27 AST) |

```bash
docker compose up -d --build
# in the container:
bun scripts/watcher/rejudge.ts --dry-run --config /app/config/config.json
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/stop
bun scripts/watcher/rejudge.ts --apply --config /app/config/config.json --watcher-url http://localhost:3000 --token "$ADMIN_API_KEY"
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/start
```

**Outcome.** Healthy; wake, resync, `maintain:link` embedded 5. Re-judge: 9 judged, 6 changed (3 → happened, 3 → unknown, 3 stay did_not_happen), all with evidence from the tool audit and cycle log; written with the watcher stopped (URL check passed), watcher restarted. Calibration: Brier 0.42 (old judge) → **0.129** over 6 resolved (frequency baseline 0.25), 3 unknown excluded. Forgetting now runs below the size target from the next daily maintenance (≤ 200/run).

**Reversible?** Each re-judged neuron keeps `meta.previousHappened` and `meta.rejudgedAt`; rebuild from `667b9d3` for the code.

### 2026-10-26 — Turn on watcher consolidation in preview mode

```bash
MSYS_NO_PATHCONV=1 docker cp aibot-framework-aibot-1:/app/config/config.json D:/tmp/live-config.json   # copy kept as live-config.before-consolidate.json
# python: config.watcher.consolidate = { enabled: true, preview: true }
MSYS_NO_PATHCONV=1 docker cp D:/tmp/live-config.json aibot-framework-aibot-1:/app/config/config.json
docker compose restart aibot
```

**Who.** The session, on Diego's "proceed with what's pending". **Why.** First step toward enabling consolidation (PR #19 follow-up): nightly at 04:00 local while the fleet sleeps it calls the model and logs `consolidate:preview` rows (would-merge members, summary, coverage) without archiving or creating anything. **Outcome.** Healthy; config shows `consolidate: { enabled: true, preview: true }`. First preview expected 2026-10-27 04:00 local. Found while doing it: the daily maintenance (forgetting) is a 24 h timer from boot with nothing persisted, so restarts kept postponing it — it has never run; fix in `fix/watcher-ui-polish`. **Reversible?** Restore the before-consolidate copy and restart.

### 2026-10-26 — Deploy maintenance-across-restarts, entity rename and page polish (PR #24, `ff34fef`), with PR #22 (watcher autonomy rung 0, another session)

```bash
docker compose up -d --build
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/maintain   # in the container
```

**Who.** The session, on Diego's "proceed with what's pending". **Outcome.** Healthy. Overdue maintenance ran at start (`maintain.json` written: `lastMaintainAt` 10:42Z); resync renamed "** MyFirstMillion Bot" and "** SelfImproveBot" to their clean names. `POST /api/watcher/maintain` → `{ forgotten: 0, linking: false }`: nothing is past the 7-day grace yet (birth 2026-10-23), so the first archiving is expected around 2026-10-30. Also shipped (merged by another session as PR #22): hard kill switch, monthly ceiling `watcher.autonomy.monthlyCeilingUsd` default **$90** (at ~$6/day the watcher would stop mid-month), approval queue and change ledger. **Reversible?** Rebuild from `ce41afb`.

### 2026-10-26 — Deploy watcher autonomy rungs 0 + 2 (PRs #22, #25, #26), `2770dda`, and switch proposals + self-study on

```bash
bun scripts/docker/backup.ts backup
docker exec -i aibot-framework-aibot-1 bun run - < D:/tmp/autonomy-docs/enable-autonomy.ts   # raw config: watcher.autonomy.proposals.enabled + selfStudy.enabled = true
docker compose up -d --build
docker exec aibot-framework-aibot-1 sh -c 'curl -s -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/proposals'     # and /self-study, /api/watcher
docker exec aibot-framework-aibot-1 sh -c 'curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/watcher/self-study'
```

**Who.** The session, on Diego's "deploy" (09:31). **Outcome.** Backup at `D:\aibot-backups\aibot-backup-2026-10-26T12-31-59`. Config: `watcher.autonomy` was unset; now `{ proposals: { enabled: true }, selfStudy: { enabled: true } }` (defaults otherwise: ceiling $90, 3 pending, 72 h, weekly). Container healthy; the Telegram 401 at boot is the known revoked token (headless fallback). Routes live: proposals `enabled: true`, self-study scheduled 30 min after boot; watcher running, not killed, month $7.50 of $90; `watcher-autonomy-helpers.js` served 200 with the self-study card. First self-study run manually: 22 s, Haiku, $0.11, two pending proposals (`p-8478264f` jarvis-factory every 2h → 4h, ~$32/wk; `p-7bbffbba` default bot 6h → 12h, ~$16/wk; both guarded by `fleet.errorCycleShare` ≤ 0.2 over 168 h, expiring 2026-10-29). Nothing applied. **Reversible?** Turn the two switches off in the config file (or `AIBOT_WATCHER_KILL=1` / `<data>/watcher-kill` stops every watcher call); rebuild from `664b158`'s parent `a9dedc6` for the code.
