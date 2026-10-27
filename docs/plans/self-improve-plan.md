# Plan: self-improvement loops — per bot, and in the watcher

**Status:** built 2026-10-27 on `feat/self-improve` (bot loop off by default, watcher loop on by default). Not deployed; no bot switched on yet.

**Ask (operator, 2026-10-27):** configure self-improvement per bot and for the watcher. The watcher's
loop on by default; every bot's loop off by default; pick the bot to start with.

**Principle:** an improvement is a change **plus the measurement that proves it**. Today the fleet
already changes itself (strategist trait deltas, weekly `reflection` rewriting MOTIVATIONS methods,
curiosity taste), but nothing checks afterwards whether a change helped, so it is drift, not
improvement. Every change in this plan names its metric before it applies, is measured by code, and
is retired by code when it does not move the metric.

---

## Where it stands (measured 2026-10-27, live container, tool audit 2026-10-20..27)

Charged tool failures (not `blocked`, not `exit-nonzero`), grouped by tool + error class; "repeated"
= a class with ≥ 3 failures:

| Bot | Tool calls | Charged failures | Repeated classes |
|---|---|---|---|
| ai-perfectionist | 706 | 49 | `file_read` file-not-found 30, `file_edit` "exploration cycle" refusal 10 |
| jarvis-factory | 540 | 36 | `file_read` file-not-found 16, `file_read` read-a-directory 5, `manage_goals` note-too-long 5, `web_fetch` 500 ×3 |
| default | 373 | 28 | `file_read` file-not-found 21, read-a-directory 6 |
| job-seeker | 367 | 28 | `web_fetch` guessed URL (404/410) 11, `file_read` file-not-found 11 |
| myfirstmillion | 251 | 9 | `web_fetch` guessed URL 4 |
| selfimprove | 238 | 5 | none |

Two kinds of repeat show up, and they need different loops:

- **Tool problems** (every bot hits them): `file_read` cannot resolve a bare production filename
  and errors on a directory. A lesson would teach five bots to work around a bug. These go to the
  operator as a finding, and the fix is code (follow-up F1).
- **Behaviour problems** (one bot's habit): guessing URLs, notes over the cap, writing a document in
  an exploration cycle, six cycles (2026-10-25 15:57 → 10-26 02:59) hunting another bot's
  `longlist.md` under the wrong root. These are what a per-bot lesson can fix.

Karma confirms it: the week's negative karma is almost all `toolError` (jarvis-factory −16,
job-seeker −14, myfirstmillion −7, default −5).

---

## Design

### Bot loop (off by default, per bot)

1. **Detect (code, no LLM).** After every cycle, read the bot's tool audit for the last 48 h and
   group charged failures by **failure class** = tool + a code-normalised error class
   (`classifyFailure`: file-not-found, read-a-directory, guessed-url, server-error, note-too-long,
   task-claimed, value-too-long, else `other:<error head with digits stripped>`). A site blocking
   bots (`blocked`) and a scope refusal (`scope`) never count as failures, so they never become lessons. A class with
   ≥ `minRepeats` (3) failures and no active lesson is a candidate. Never-charged kinds
   (`blocked`, `exit-nonzero`, `approval-pending`, `aborted`) never count, same rule as
   `isToolFailure` in `src/stats/readers/tool-audit.ts:34`.
2. **Write the lesson (one small LLM call).** The bot's planner backend (`selectPlannerClient`,
   `src/bot/agent-planner.ts`) gets a code-built digest: the class, the failing calls' args and
   result heads (≤ 5, redacted like the tool audit for `sensitive` tools), and the calls of the same
   tool that succeeded. It answers `{ lesson ≤ 300 chars, evidence: [auditRowIds] }`. Code rejects
   an answer that cites rows it was not shown. Fallback without a model answer: a fixed sentence per
   class.
3. **Use it.** Active lessons (≤ `maxActive`, 5) render as "## Lessons from your own mistakes" in the
   planner, the continuous planner and the executor prompt, next to
   `buildDirectivesSection` (`src/bot/agent-loop-prompts.ts:394`, called at `:551`, `:693`, `:855`).
4. **Measure (code).** At creation the lesson stores its **baseline**: that class's failure rate per
   call of that tool over the 7 days before. After `measureCalls` (20) further calls of the tool, or
   `measureDays` (5) days, whichever first:
   - rate dropped ≥ `minDrop` (50 %) → `proven`, stays in the prompt and is not measured again (v1);
   - did not → `retired`, removed from the prompt, reason recorded;
   - too few calls → measured once more, then `unproven` and retired.
5. **Record.** `<soulDir>/LESSONS.json` (travels with the bot export) and one row per change in
   `<soulDir>/soul-events.jsonl` (new op `lesson`, reusing `appendSoulEvent`,
   `src/bot/soul-events.ts`), so Memory history and Why show where a lesson came from.

Every step runs after `finishCuriosityCycle` (`src/bot/agent-loop.ts:1653`) under the same rule as
curiosity: it can never fail a cycle, and a throw is logged and skipped.

### Watcher loop (on by default when the watcher runs)

The watcher stays off by default as a whole (`watcher.enabled: false`); `watcher.selfImprove` is on
by default inside it.

1. **Fleet view.** Daily, read every bot's `LESSONS.json` and the audit classes (whether or not the
   bot's loop is on).
2. **Tool problem finding.** A class present in ≥ `toolProblemBots` (3) bots is not a lesson: one
   log row `self-improve:tool-problem` and a Needs You item (kind `watcher`, admin only, as today)
   naming the tool, the class, the counts per bot. Lessons are not written for that class in any bot
   until the operator dismisses the finding.
3. **Propagate what worked.** A `proven` lesson whose class shows up (≥ 2 failures in 7 d) in another
   bot whose loop is **on** is seeded into that bot's `LESSONS.json` as `borrowed` (source bot and
   lesson id kept), with its own baseline and measurement. Bots with the loop off get nothing.
4. **Report.** The weekly self-study digest (`src/watcher/autonomy/self-study.ts`) gains a lessons
   block: created, proven, retired, borrowed, tool problems, per bot.

`watcher.selfImprove.enabled` is an `enabled` flag, so it is locked from proposals by the existing
rule in `src/watcher/autonomy/locked.ts` (only `TUNABLES` and `BOT_CADENCE` are proposable). A bot's
`selfImprove` block is a bot field, locked the same way. Neither loop can switch itself on.

### Config

```jsonc
// global default, every bot inherits
"agentLoop": { "selfImprove": { "enabled": false } },
// per bot
"bots": [{ "id": "jarvis-factory", "agentLoop": { "selfImprove": { "enabled": true } } }],
// watcher
"watcher": { "selfImprove": { "enabled": true } }
```

`SelfImproveConfigSchema`: `enabled`, `minRepeats` 3, `maxActive` 5, `measureCalls` 20,
`measureDays` 5, `minDrop` 0.5. Added to `GlobalAgentLoopConfigSchema` (`src/config.ts:130`) and
`BotAgentLoopOverrideSchema` (`:193`, next to `curiosity`); bot over global, like curiosity.
`WatcherConfigSchema` (`:872`) gains `selfImprove { enabled: true, toolProblemBots: 3 }`.

---

## Which bot to start with

**Recommendation: jarvis-factory.**

- It has the most distinct behaviour classes (note-too-long, wrong-root hunting, read-a-directory),
  so the first week tests more than one kind of lesson.
- It is the most expensive bot (~$32 of ~$121 in 2026-10-24..26) and spent six cycles on one repeated
  mistake, so a working lesson shows up in cost as well as karma.
- Its karma fell the most from tool errors (−16).

Second, after one measured week: **job-seeker** (guessed URLs, a single clean behaviour class: the
simplest A/B for "does a lesson change behaviour"). Not first: ai-perfectionist and default, whose
repeats are mostly the `file_read` tool problem that F1 fixes in code.

Turning it on is a live config edit (one bot, reversible); it is confirmed separately at deploy time.

---

## Files that change

| File | Change |
|---|---|
| `src/config.ts` | `SelfImproveConfigSchema` in global and per-bot agent loop; `watcher.selfImprove` |
| `src/bot/self-improve/classes.ts` | `classifyFailure(entry)` → class key, pure |
| `src/bot/self-improve/detector.ts` | candidates from audit rows + active lessons, pure |
| `src/bot/self-improve/store.ts` | `LessonStore(soulDir)`: `LESSONS.json`, atomic, readers never throw |
| `src/bot/self-improve/writer.ts` | digest + one LLM call + evidence check + per-class fallback |
| `src/bot/self-improve/measure.ts` | baseline, window, proven / retired / unproven, pure |
| `src/bot/self-improve/runner.ts` | `runSelfImprove(bot)` after each cycle; never throws |
| `src/bot/agent-loop-prompts.ts` | `buildLessonsSection(lessons)` in the three prompts |
| `src/bot/agent-loop.ts` | call the runner after curiosity; pass active lessons to the prompts |
| `src/bot/soul-events.ts` | op `lesson` |
| `src/watcher/self-improve.ts` | fleet view, tool-problem finding, propagation; daily timer in `watcher.ts` |
| `src/watcher/autonomy/self-study.ts` | lessons block in the digest |
| `src/web/routes/agent-home.ts` | `GET /api/agents/:id/lessons` (tenant-scoped) |
| `web/pages/agent-home*.js` | "Lessons" card: text, class, baseline vs now, status |
| `src/why/builders/lesson.ts` | `lessonToWhy` (what failed, evidence, metric, outcome), registered in `WHY_BUILDERS` |
| CHANGELOG, CLAUDE.md tables, `docs/architecture-docs/agent-loop.html` | same change |

## Tests

- `classifyFailure`: each class from real result strings seen in the audit; unknown errors keep
  their head with digits stripped.
- Detector: 2 failures no candidate, 3 yes; blocked / exit-nonzero / aborted never count; a class
  with an active lesson is not a candidate; a class flagged as a tool problem is not a candidate.
- Writer: evidence citing an unshown row is rejected; model failure → fallback text; sensitive
  tool args never reach the digest.
- Measure: proven at ≥ 50 % drop, retired below, unproven after the extra window, baseline of 0
  failures is never a candidate.
- Runner: a throwing store or model never fails the cycle; loop off → nothing read or written.
- Prompts: lessons section only with active lessons; ≤ `maxActive`.
- Watcher: a class in 3 bots → tool-problem finding, not lessons; a proven lesson is borrowed only
  by bots with the loop on and the class present; the watcher's loop never edits a bot's config.
- Config: defaults (bot off, watcher on), bot over global, `selfImprove` paths refused by
  `checkTunableChange`.
- Why contract test picks up `lesson.ts`.

## Out of scope

- Code self-modification, budgets, limits, tools: no loop here touches them.
- Lessons about content quality: there is no quality signal without operator feedback (0 feedback on
  19 `default` outputs this week). Only tool and cycle behaviour is measured.
- Changing traits or MOTIVATIONS from lessons; reflection and the strategist keep their own loops.

## Follow-ups (not in this plan)

- **F1** `file_read`: resolve a bare production filename against the bot's productions dir, list a
  directory instead of erroring, and never charge karma for either. Fixes the largest class in four
  bots; the watcher's first tool-problem finding will point at it.
- **F2** a way to read another bot's production by name (the jarvis-factory hunt).
- **F3** measure the strategist's trait deltas and reflection's method edits the same way.

## Open decisions, with recommendations

1. **Lessons apply without a click when the bot's loop is on.** Recommendation: yes. Switching the
   loop on for a bot is the approval; each lesson is prompt-only, visible on the Agent Home, measured
   and retired by code. Routing each through the proposals queue would stall like the two cadence
   proposals pending since 2026-10-26.
2. **Propagation to other bots** only to bots whose loop is on. Recommendation: yes (above).
3. **First bot.** Recommendation: jarvis-factory, then job-seeker after a measured week.
