# Mind reset and mind-proposed roster

Status: implemented on `feat/mind-roster` (2026-10-27). Live steps (backup, reset) need the operator's go each time.

## Why

Review of 2026-10-27: six bots ran ~85 cycles in two days, almost all completed, and very little
reached the operator (~640 production rows, ~35 approvals; asks unanswered; bots spending cycles
checking whether he replied). The watcher's graph (3.5k neurons: 1.9k facts, 760 questions, 480
surprises, 43 insights) is mostly a record of that activity. The operator asked to clean the mind,
drop the bots, and let the mind define a new roster from (1) what he wants and (2) its own
objectives.

Decisions (agreed in the conversation):

- **Pause, don't delete.** Every bot is set `enabled: false`; its soul, memory and productions stay.
- **Reset the mind by archiving it**, never deleting: the watcher dir moves to `_trash`, restorable.
- **Ask, don't infer.** What the operator wants comes from a brief he writes, not from the graph.
- **Propose, don't create.** The mind proposes bots through the existing agent-proposal queue; the
  operator approves. Approval still creates the bot disabled, as today.
- **Grounded objectives.** Every proposal must serve at least one operator want; a mind objective
  is allowed only on top of that. At most 2 proposals per run, at most 2 pending.

## What changes

| Piece | Files | Proof |
|---|---|---|
| Birth and resync read only enabled bots' material (people, goals, knowledge, memory, history); the fleet stage still lists every bot | `src/watcher/birth.ts` | `tests/watcher/birth-disabled.test.ts` |
| Reset: plan / apply / restore, offline (container stopped) | `src/watcher/reset.ts`, `scripts/watcher/reset-mind.ts` | `tests/watcher/reset.test.ts` |
| Operator brief: ≤ 5 wants (`what`, `cadence`, `delivery`, `success`) + notes, `<watcherDir>/self/brief.json` | `src/watcher/roster/brief.ts` | `tests/watcher/roster/brief.test.ts` |
| Roster designer: prompt, parse, vet (cites a want, valid slug, unique, cadence, preset), submit as `AgentProposal` with `proposedBy: '__watcher__'` | `src/watcher/roster/designer.ts` | `tests/watcher/roster/designer.test.ts` |
| Runner: manual run, weekly tick, a brief edit makes it due 30 min later; state `<watcherDir>/self/roster.json` | `src/watcher/roster/runner.ts`, `src/watcher/watcher.ts` | `tests/watcher/roster/runner.test.ts` |
| Config `watcher.roster { enabled: true, everyHours: 168, maxProposals: 2, maxPending: 2 }` (not in `TUNABLES`, so locked) | `src/config.ts`, `src/watcher/types.ts` | schema test |
| Routes `GET/PUT /api/watcher/brief`, `GET/POST /api/watcher/roster` | `src/web/routes/watcher.ts` | `tests/web/watcher-roster-routes.test.ts` |
| Proposal fields `serves`, `goals`, `deliverable`, `delivery`, `killCriterion`, `preset`; approve writes GOALS.md (source `operator`), applies preset skills and cadence | `src/tools/agent-proposal-store.ts`, `src/web/routes/agent-proposals.ts` | `tests/web/agent-proposals-roster.test.ts` |
| Why for a mind proposal: "The watcher", wants served, kill criterion | `src/why/builders/agent-proposal.ts` | `tests/why/contract.test.ts` |
| Watcher page: Roster card (brief editor, Propose, last run, questions, retire suggestions, proposals with status) | `web/pages/watcher-roster-helpers.js`, `web/pages/watcher.js` | `tests/web/watcher-roster-helpers.test.ts` |

### Designer contract

Input (by code): the brief; every bot in the config (id, name, enabled, mind-proposed or not) and,
for mind-proposed bots, outcomes since approval (cycles completed, productions created / approved /
rejected, last cycle); the presets (id + one line); the mind's own state (graph counts by kind,
broadcasts delivered / served in 7 days); previous mind proposals and their status.

Output (JSON): `proposals[]` (`agentId`, `name`, `emoji?`, `role`, `personality`, `serves[]` want ids,
`mindObjective?`, `deliverable`, `cadence` as `agentLoop.every` (`30m`–`7d`), `delivery`,
`killCriterion`, `preset?`, `goals[]` ≤ 3, `language?`), `retire[]` (`botId`, `reason`),
`questions[]` ≤ 3, `note`.

Vetting drops (with a reason in the outcome and a log row): no known want cited, bad or taken id
(config or a pending proposal), cadence outside range, unknown preset, over `maxProposals`, or
pending mind proposals already at `maxPending`.

### Operating sequence (each live step needs the operator's go)

1. `bun scripts/docker/backup.ts backup` (host).
2. `docker compose build`, `docker compose stop aibot`.
3. `docker compose run --rm --no-deps --entrypoint bun aibot scripts/watcher/reset-mind.ts` (dry run), then `--apply`.
4. `docker compose up -d`.
5. Write the brief on the watcher page, press Propose (or wait ≤ 40 min), approve in Agent Proposals, set a token or leave headless, enable.

Restore: `reset-mind.ts --restore <archive dir>` with the container stopped.

## Out of scope (follow-ups)

- Tightening notice's keep policy (the main source of graph noise).
- A conversational intake (the brief form plus the designer's `questions` stand in for it).
- Acting on `retire` suggestions automatically (shown only; the operator turns a bot off).
