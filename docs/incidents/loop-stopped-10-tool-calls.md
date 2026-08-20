# Incident: Web-Conversation Replies Truncated with `[Loop stopped: Exceeded 10 total tool calls]`

**Status:** Fixed — see [`loop-stopped-10-tool-calls-fix-plan.md`](./loop-stopped-10-tool-calls-fix-plan.md) (all four pending decisions resolved in §1 of that plan; four TDD cycles merged; `bun test` clean vs. baseline).
**Severity:** Medium (user-visible degradation; not a crash, but blocks multi-step research tasks)
**Affected surface:** Web dashboard `/api/conversations/:botId/:id/messages` (and any future caller of `webGenerate`)
**First reported:** 2026-08-19 — dashboard session, bot `ai-perfectionist`, conversation `4e90c708-d074-45ef-96f3-0bdc2b1e7768`

---

## User-visible symptom

The bot starts a complex task (e.g. *"archiving all the old files first, then research LLM-based development workflows and token cost optimization"*) and produces an assistant reply that begins with what looks like a coherent plan, but is suffixed with:

```
\n\n[Loop stopped: Exceeded 10 total tool calls]
```

The reply is then persisted into the conversation JSONL as-is, so the marker becomes part of the bot's permanent message. From the operator's perspective, the bot "ran out of budget" mid-task and shipped a half-done plan as a final answer.

The number `10` is deterministic and reproducible. It is not a model-side issue.

---

## How to reproduce (local)

1. Start the dashboard with `webTools.enabled: true` and any Ollama-backed bot.
2. In the dashboard, open a new conversation for that bot.
3. Send a task that requires more than ~10 tool invocations end-to-end (e.g. "search X, fetch Y, read file Z, search X again, fetch W, summarize"). Concrete example: the user's "archive old files + research LLM workflows + token cost" prompt.
4. Observe the bot's reply ends with `[Loop stopped: Exceeded 10 total tool calls]`.

---

## Root cause

The web-dashboard conversation path uses a different code path than the Telegram `ConversationPipeline`, and that path does not honor `maxToolRounds`.

### Call chain (dashboard)

1. `POST /api/conversations/:botId/:id/messages`
   → `src/web/routes/conversations.ts:343` (`app.post('/:botId/:id/messages', …)`)
2. `generateBotReply(...)`
   → `src/web/routes/conversations.ts:96`
3. `webGenerate({ …, messages, permissionMode: 'conversation', … })`
   → `src/web/routes/conversations.ts:163`
4. Inside `webGenerate` (`src/web/routes/web-tool-helpers.ts:135`), the LLM call is:
   ```ts
   const result = await llmClient.chat(chatMessages, {
     model,
     tools: filteredDefs,
     toolExecutor,
   });
   ```
   **No `maxToolRounds` is passed.**
5. `OllamaClient.chat` (`src/ollama.ts:181`) then falls back to:
   ```ts
   const maxRounds = resolvedOptions.maxToolRounds ?? 5;
   ```
6. `runToolLoop` (`src/core/tool-runner.ts`) creates `createLoopDetector(maxRounds)` and runs the loop.
7. `createLoopDetector(5)` (`src/core/loop-detector.ts:23`) sets:
   ```ts
   const globalLimit = maxToolRounds * 2;  // = 10
   ```
8. On the 10th call, `check()` returns `{ action: 'break', message: 'Exceeded 10 total tool calls' }`. `tool-runner.ts:101-104` then prepends the marker to whatever the last assistant content was and returns it. That returned string is what gets stored as the bot's reply via `conversationsService.addMessage(...)` in `conversations.ts:197`.

### Why Telegram doesn't hit this

The Telegram `ConversationPipeline` resolves `maxToolRounds` from config and passes it down explicitly:

```ts
// src/bot/conversation-pipeline.ts:161-162
const webToolsConfig = this.ctx.config.webTools;
const maxToolRounds = config.maxToolRounds ?? webToolsConfig?.maxToolRounds;
```

…and the resolved value flows into `llmClient.chat(..., { maxToolRounds, ... })` at `conversation-pipeline.ts:414` (and again at lines 478, 1130, 1178).

The web dashboard path simply forgot to do the same.

---

## Contributing factors

These amplify the bug but are not the cause:

1. **Default `maxToolRounds = 5` is low for research tasks.**
   `src/config.ts:526` — `maxToolRounds: z.number().int().min(1).max(50).default(5)`. With the 2× multiplier in `loop-detector.ts:23`, the global ceiling becomes 10.
2. **Global limit is hardcoded to `maxRounds * 2`.** Doubling is the only knob; there is no flat `globalLimit` override.
3. **Loop-break message is leaked into user-visible replies.** `tool-runner.ts:102` returns the half-done response with the loop marker concatenated. The dashboard then persists it verbatim. The marker reads like internal debug output but ships to the user.
4. **No per-call-site override.** `webGenerate` cannot accept a `maxToolRounds` override from its callers. The Telegram pipeline reads `config.maxToolRounds ?? webToolsConfig?.maxToolRounds` (config.ts has `BotConfig.maxToolRounds` at line 289 — per-bot override that the dashboard does not consult either).
5. **No telemetry.** There is no log line at the loop-break site that records the conversation id, bot id, or the call pattern that triggered the break, so debugging is by hand.

---

## Impact assessment

- **Users affected:** Any operator running a bot via the web dashboard (not Telegram) on tasks that exceed ~10 tool calls.
- **Tasks affected (in practice):** Anything that combines web search + fetch, or any read-search-fetch-summarize chain, plus the user's `archive + research + cost` workflow.
- **Tasks not affected:** Casual chat, single-tool tasks (e.g. `save_memory`), and any flow that hits the Telegram pipeline.
- **Data loss:** None. The half-done plan is saved as a message; nothing is corrupted. But the bot "consumes" the request — the operator has to manually send a follow-up because the loop breaker returned a string instead of raising.
- **Reproducibility:** 100% deterministic, given a model that calls ≥10 tools. Confirmed in the reported session.

---

## Proposed fix

Implemented in TDD cycles per `CLAUDE.md`. Each cycle is independently mergeable.

### Cycle 1 — make `webGenerate` honor `maxToolRounds` (the actual bug)

- **Red:** `tests/web-tool-helpers.test.ts`
  - `webGenerate` forwards `config.webTools.maxToolRounds` to `llmClient.chat`.
  - Per-bot `config.bots[i].maxToolRounds` overrides the global.
  - Unset config → falls back to current behavior (no test regression).
- **Green:** thread the resolved value into the chat options in `web-tool-helpers.ts:135`.
- **Refactor:** extract the resolution helper (`config.maxToolRounds ?? webToolsConfig?.maxToolRounds`) into something both `conversation-pipeline.ts` and `web-tool-helpers.ts` import.

### Cycle 2 — stop leaking the loop marker into user replies (UX)

- **Red:** `tests/core/tool-runner.test.ts` (or extend existing) — assert that when `loopDetector.check()` returns `break`, the returned text does **not** contain `[Loop stopped:` for callers that opt into "clean break" mode.
- **Green:** add an option `cleanBreak: boolean` to `ToolRunnerOptions`. When true, the runner returns an explicit structured error / a clean message rather than concatenating the marker into `text`. The dashboard sets `cleanBreak: true`.
- **Refactor:** update `webGenerate` to use `cleanBreak: true` and have `generateBotReply` translate a clean-break signal into a user-friendly "task interrupted at round N, please continue" message before persisting.

### Cycle 3 — raise the default and let operators tune it (config)

- **Red:** schema-level test that `webTools.maxToolRounds` accepts a higher default; existing test that asserts default stays at 5 is updated.
- **Green:** bump default in `src/config.ts:526` from `5` to a value appropriate for research workflows (proposal: `15` — keeps 2× = 30 ceiling, roomy but not unbounded). Document the change in `docs/tools.md:34` and `docs/architecture-docs/configuration.html` (search anchors at lines 1098, 1504, 2140).
- **Refactor:** introduce an optional `webTools.globalLimit` flat override so operators can set the ceiling directly without the 2× multiplier, when they need to.

### Cycle 4 — observability

- **Red:** assert that on a loop break, the logger emits a `warn` with `botId`, `conversationId`, `round`, `totalCalls`, and `detector` (or equivalent fields).
- **Green:** `tool-runner.ts:99` already logs at warn — extend it with the structured fields, plus pass them through from `webGenerate` / `generateBotReply`.
- **Refactor:** add a `loop_break` event to the `HookEmitter` (`src/bot/hooks.ts`) so analytics can track frequency per bot.

---

## Decisions pending senior input

Resolved — see §1 of [`loop-stopped-10-tool-calls-fix-plan.md`](./loop-stopped-10-tool-calls-fix-plan.md#1-decisions-resolved--do-not-re-open). Summary: new default `15` (30-call ceiling), clean-break opt-in (`cleanBreak: true`) returns a summary instead of the marker, per-bot override reuses the existing `BotConfig.maxToolRounds`, and no flat `globalLimit` knob is added.

1. **Cycle 3 — what should the new default be?** Options: `10`, `15`, `20`. Recommendation: `15` (30-call ceiling; matches the agent-loop `agentLoop.maxToolRounds` default of 30 at `src/config.ts:73` — the asymmetry between chat and agent loop is currently arbitrary and worth aligning).
2. **Cycle 2 — what should the user see when the loop breaks?** Options:
   - **(a) Bot says "I hit the tool-call limit, here's what I have so far, want me to continue?"** — keeps the partial plan visible.
   - **(b) Bot says nothing and the dashboard renders a banner** — hides the broken reply, surfaces a system message instead.
   - **(c) Status quo, but strip the `[Loop stopped: …]` marker and replace with a humanized sentence** — minimal change.
   - Recommendation: **(c)** for backward compatibility, **(a)** as a follow-up if the team is OK changing the dashboard UX.
3. **Should the per-bot override apply at `BotConfig.maxToolRounds` (already exists, line 289) or be re-exposed at the dashboard level?** The schema field exists; the dashboard simply doesn't render it. Low-effort follow-up: surface it in `src/web/routes/agents.ts` GET.
4. **Do we want a separate `globalLimit` knob, or is `maxToolRounds * 2` fine?** If the team is comfortable with the doubling, skip Cycle 3's "flat override" sub-step.

---

## Related files (for review)

- `src/web/routes/conversations.ts` — entry point, `generateBotReply`
- `src/web/routes/web-tool-helpers.ts` — `webGenerate`, the bug site
- `src/ollama.ts` — default fallback `maxRounds ?? 5` at line 181
- `src/core/tool-runner.ts` — loop runner, marker concatenation at line 102
- `src/core/loop-detector.ts` — `globalLimit = maxRounds * 2` at line 23
- `src/bot/conversation-pipeline.ts` — reference implementation, lines 161-162 / 414 / 478 / 782 / 1130 / 1178
- `src/config.ts` — schemas: `WebToolsConfigSchema` (522), `BotConfig.maxToolRounds` (289), `GlobalAgentLoopConfigSchema.maxToolRounds` (73)
- `tests/loop-detector.test.ts` — existing loop-detector tests
- `docs/tools.md:34`, `docs/architecture-docs/configuration.html` (anchors 1098, 1504, 2140) — config docs to update

---

## Notes for the review

- The Telegram path is **not** affected. This is purely a dashboard-side regression.
- The 4-strategy `ToolLoopDetector` in `src/bot/tool-loop-detector.ts` (used by `ToolExecutor`) is a separate system from the outer-loop `createLoopDetector`. That 4-strategy detector has its own `criticalThreshold` and `globalCircuitBreakerThreshold` and is not the source of this bug. Don't conflate them in the review.
- Per `CLAUDE.md`, no commit/push without explicit sign-off. TDD red-green-refactor cycles are pre-baked into the proposal; each cycle has its own test target and is independently testable.
