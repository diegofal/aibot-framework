# UX overhaul plan (2026-10-03)

Origin: the Needs You queue had 51 items (29 asks, 22 outputs, many days old) and no way to clear
them except pressing `d` 51 times. A read-only review of every dashboard screen followed; this is
the resulting plan. Builds on the Jarvis fleet plan (S3 nav, S5 Needs You, S8 palette, S3.5 polish).

## Phase 0 — shared primitives (`web/ui/`)
- `confirmInline` / async `confirmDialog` to replace `window.confirm`; `promptDialog` for `window.prompt`.
- `showToast` gains an action button (Undo) and a deferred-commit helper (`undoable`).

## Phase 1 — Needs You clearable
- `POST /api/needs-you/bulk { ids[], action }` → per-item results.
- `POST /api/needs-you/clear-stale { olderThanHours, kinds?, botId? }` (over `AskHumanStore.closeStale`
  + pending inbox conversations with no live question).
- Hourly sweep also covers pending inbox conversations without a live question (today only at startup).
- Neutral `archive` for outputs (no karma).
- Page: kind + agent filter chips, age groups (Today / This week / Older) with "Clear older",
  `x` select, `Shift+j/k` range, `*` select visible, bulk bar, deferred undo toast.
- Confirm before deleting a conversation from the queue.
- Pending dynamic-tool approvals appear in the queue.

## Phase 2 — bugs found by the review
- Queue production link uses `?path=`, productions page reads `?file=`.
- Agent edit save ignores API errors; agent delete ignores API errors.
- Tools reject: cancelling the note prompt still rejects.
- Agent loop auto-refresh writes the wrong column ("Executing" never updates).
- Inbox calls `showToast` without importing it.
- Cron and Sessions throw when their API returns an error.

## Phase 3 — one feedback language
- Replace ~80 `alert/confirm/prompt` with toasts + inline confirm; undo on deletes.
- 15 s polling never wipes in-progress input (Permissions note, Inbox).

## Phase 4 — information architecture
- Feedback only under Needs You; drop the Insights copy.
- Drop the inner Stats tab strip.
- Agent loop moves to Automations.
- Tools + Tool Runner merge (Run action per row).
- Queue is the review surface; Productions is the file browser.
- Rewrite the 37 legacy in-page hrefs to canonical; real 404 page.

## Phase 5 — shortcuts and power use
- Global: `g`+letter area jumps, `/` focus page filter, `n` new, `?` help on every page.
- Palette: Clear stale needs, New cron job, Run agent loop, Re-run failed crons, agent stats/karma/logs.
- Work › Outputs: make the advertised `a`/`r` keys real.
- Agents list: search, sortable columns, bulk Start/Stop/Enable/Delete.
- Home cards: hover Start/Stop/Run, filter chips, real error state.
- Agent Home: Edit button in header. Agent edit: section jump-nav, Ctrl+S, dirty guard.
- Settings: one sticky save bar with dirty tracking.
- Wizard: draft persistence, confirm on cancel, "start from existing agent".

## Execution
Done by subagents in waves, partitioned by file ownership:
0. ui primitives → 1. Needs You area / Agents area / Automations+Insights+Settings / Work area (parallel)
→ 2. global nav + shortcuts + legacy hrefs → 3. CHANGELOG + docs.

## Status
| Phase | State |
|---|---|
| 0 | done 2026-10-03 (`web/ui/toast.js` action + `undoable`, `web/ui/dialog.js`) |
| 1 | done 2026-10-03 (`POST /api/needs-you/bulk`, `/act`, `/clear-stale`; sweep covers pending inbox conversations; page bulk/groups/chips) |
| 2 | done 2026-10-03 (all six bugs plus the ones found on the way, see CHANGELOG) |
| 3 | done 2026-10-03 (no `alert`/`confirm`/`prompt` left; polling keeps in-progress input) |
| 4 | done 2026-10-03 (Feedback / Agent loop / Tool Runner moves with redirects, Stats strip gone, canonical hrefs + legacy-href test, 404 page). "Queue is the review surface" is the intent, not a separate change: Productions keeps its own verdict actions |
| 5 | done 2026-10-03 (global shortcuts, palette actions, Outputs keys, Agents list, Home cards, Agent Home/edit, Settings save bar, wizard) |
| Docs (wave 3) | done 2026-10-03 (CHANGELOG, `docs/architecture-docs/`, README, roadmap) |

Deploy: the wave 1 `src/` changes (Needs You write routes wired in `server.ts`, `closeStaleInboxConversations`,
feedback `botName`, archive empty body) need `docker compose up -d --build`; until then the queue's bulk,
clear-stale and orphan-ask dismiss calls 404 in the running container. `web/` is served from the read-only mount.

## Follow-ups (not done)
Collected from the wave notes; none is in the plan's scope.

**Backend / API**
- Outputs bulk runs sequential per-item `evaluate` / `archive` calls; a `POST /api/productions/bulk` would be
  faster for large queues. Outputs' Archive still moves the file to `archived/` (could switch to the Needs You
  neutral archive path if that ever diverges).
- Hygiene history "Load more" re-asks with `limit + 50` (the API pages only by `limit`, store cap 500).
- `GET /api/curiosity/dispatches?before=` skips dispatches that share the exact cursor timestamp. A compound
  `(createdAt, id)` cursor would close that gap if it ever matters.
- `POST /api/skills/toggle` only rewrites config: built-in skill changes take effect after a restart. A live
  load would also have to re-wire Telegram command handlers and per-bot skill cron jobs.

**Needs You**
- Bulk approve is offered only where it is safe and supported: asks, permissions and proposals have no bulk
  approve (asks need an answer, permissions/proposals only support deny/reject in bulk). Not offered on purpose,
  revisit if wanted.

**Frontend**
- `.tool-list-item.is-active`, `.tool-list-name` and `.tool-list-desc` in `web/style.css` are unused as well
  (same old Tool Runner layout); left in place because only `.tool-runner-*` was in scope.
- Pre-existing Biome `noForEach` warnings remain in the agent edit form code in `agents.js`.
- Not verified in a browser (the dashboard login blocks automation); verified with `bun test tests/web`,
  smoke imports and `curl` of the served assets.

**Code health**
- `bun run lint` passes with 283 warnings (183 `noNonNullAssertion`, 38 `noExplicitAny`, 38 `noForEach`, …).
  They are `warn` in `biome.json` and do not fail CI; clearing them is its own change.
- `tests/web/routes/{agent-feedback,conversations,productions,web-tool-helpers}.test.ts` also `mock.module`
  `src/claude-cli` (only `claudeGenerate`) and never restore the real module in `afterAll`. Not failing today,
  but the same leak as the one fixed in `conversation-backend-pinning.test.ts` if file order changes.

**Resolved 2026-10-04**
- Dispatches page past 200: `offset` / `before` on `GET /api/curiosity/dispatches` (`feat/dispatch-paging`).
- Skills bulk enable/disable: `POST /api/skills/toggle` and the Skills page bar (`feat/skills-toggle`).
- Dead `.tool-runner-*` and `#topbar .nav-status` CSS removed (`chore/dead-css`).
- Pages call `registerPageShortcuts`; the static `PAGE_SHORTCUTS` map is gone (`refactor/page-shortcuts`).
- The `log-tail` "detects rotation…" flake and the Hygiene "last 500 runs" timeout (`fix/flaky-tests`).
- Dropped as stale: "`clear-stale` never touches `tool` items" (tools have no neutral action, and `kinds`
  including `tool` is a 400), and both Housekeeping notes (`D:\tmp\ux-build-check` is gone; the branch merged).
