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
| 0 | in progress |
| 1–5 | pending |
