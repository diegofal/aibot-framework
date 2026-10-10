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
