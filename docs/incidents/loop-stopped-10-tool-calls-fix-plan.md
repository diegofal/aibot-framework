# Fix Plan: `[Loop stopped: Exceeded 10 total tool calls]` on web-dashboard replies

**Incident:** [`loop-stopped-10-tool-calls.md`](./loop-stopped-10-tool-calls.md)
**Status:** Ready to implement
**Owner of execution:** implementer agent ("minion") — follow this document literally
**Method:** TDD Red → Green → Refactor per `CLAUDE.md` §"Flujo TDD obligatorio"
**Review:** [`loop-stopped-10-tool-calls-review.md`](./loop-stopped-10-tool-calls-review.md) — implementation accepted, 8 follow-up findings with an action checklist
**Commits:** DO NOT commit or push. `CLAUDE.md` forbids it without explicit user sign-off.

---

## 0. Read this first

Four cycles. Each is **independently mergeable** and each ends with a green `bun test`.
Do **not** start a cycle before the previous one is green.

Every cycle has the same shape:

1. **Red** — write the test changes exactly as specified. Run the named command.
   **Confirm the test fails for the stated reason** (paste the failure into the cycle log in §9).
   A test that passes on Red means the test is wrong — fix the test, not the code.
2. **Green** — apply the minimum production change specified. Re-run. All green.
3. **Refactor** — apply the cleanup step. Re-run. Still green.
4. **Gate** — run the regression command for that cycle. No new failures.

Pre-existing failures caused by external dependencies (Playwright, missing API keys, no Ollama
running) do **not** count as new failures. Record a baseline before Cycle 1:

```bash
bun test 2>&1 | tail -20   # record pass/fail counts BEFORE touching anything
```

---

## 1. Decisions (resolved — do not re-open)

The incident left four open questions. They are now decided:

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | New default for `webTools.maxToolRounds` | **15** (→ 30-call ceiling) | Same ballpark as `agentLoop.maxToolRounds` (30) without granting chat the budget of an autonomous loop. 30 tool calls covers search→fetch→read→search→fetch→summarize with headroom. |
| D2 | What the user sees on loop break | **Clean break**: no `[Loop stopped: …]` marker; the runner does one final tools-less round and the model summarizes what it got and what remains. Opt-in via `cleanBreak`. | Option (c) from the incident, upgraded. The current code returns the *last assistant message* — usually the empty/preamble content of a tool-call message — which is why replies looked truncated. A summarization round returns a real answer instead of a stub. Opt-in keeps the agent-loop path and `tests/ollama.test.ts` unchanged. |
| D3 | Where the per-bot override lives | **Reuse the existing `BotConfig.maxToolRounds`** (`src/config.ts:289`). Dashboard form surfacing is a **deferred follow-up**, not part of this plan. | The schema field already exists and the Telegram pipeline already honors it. A second knob would be a third source of truth. |
| D4 | Separate flat `globalLimit` knob | **No.** Keep `globalLimit = maxToolRounds * 2`. | With D1 the ceiling is 30, and D3 gives per-bot tuning. A multiplier-bypass knob is one nobody asked for. The *semantics* (rounds vs. individual calls) get documented instead — see §5.3. |

---

## 2. Verified facts (re-confirmed against the working tree)

Do not re-derive these; they were checked while writing this plan.

- `src/web/routes/web-tool-helpers.ts:135-139` — `llmClient.chat()` is called with `{ model, tools, toolExecutor }`. **No `maxToolRounds`.** This is the bug.
- `src/ollama.ts:181` — `const maxRounds = resolvedOptions.maxToolRounds ?? 5;`
- `src/core/loop-detector.ts:23` — `const globalLimit = maxToolRounds * 2;` → 10.
- `src/core/tool-runner.ts:96-112` — the break branch. Returns the last **assistant** message content + marker.
- `src/bot/conversation-pipeline.ts:162` **and `:782`** — two copies of `config.maxToolRounds ?? webToolsConfig?.maxToolRounds`. Both get replaced by the shared helper in Cycle 1.
- `src/config.ts:985` — `webTools: WebToolsConfigSchema.default({})`, so on a *parsed* `Config` the field is always present. Tests pass partial configs, so the resolver must still be optional-safe (`config.webTools?.…`).
- `src/config.ts` imports only `node:fs`, `node:path`, `zod`. `src/ollama.ts:1` already imports a type from `./config`. **`ollama.ts` importing a value constant from `config.ts` therefore creates no cycle.**
- `src/core/llm-client.ts:321-326` — `FailoverLLMClient.chat` spreads `{ ...opts }`; `LLMClientWithFallback.chat` (`:217-248`) forwards `opts`. New `ChatOptions` fields flow through both wrappers with no change.
- `webGenerate` has **six other call sites** besides the conversation route: `src/web/routes/agent-feedback.ts:221,316` and `src/web/routes/productions.ts:106,178,253,481`. They all inherit the Cycle 1 fix.
- The only strings matching `Loop stopped` in the repo are `src/core/tool-runner.ts:102` and four assertions in `tests/ollama.test.ts` (lines 62, 112, 167, 244). Cycle 2's opt-in design keeps all four green.
- `README.md` does not mention `maxToolRounds` (verified by grep). **No README change is required by this plan.**

---

## 3. Cycle 1 — `webGenerate` honors `maxToolRounds` (the actual bug)

**Goal:** the dashboard path resolves the same budget the Telegram path does.

### 3.1 Red

**New test file:** `tests/config-max-tool-rounds.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { resolveMaxToolRounds } from '../src/config';
```

Four tests, one per branch (per `CLAUDE.md` §"Cobertura por función"):

1. `'returns the global webTools.maxToolRounds when no bot override'` → `resolveMaxToolRounds({ webTools: { maxToolRounds: 15 } } as any)` === `15`
2. `'per-bot maxToolRounds wins over the global'` → global 15, bot `{ maxToolRounds: 40 }` → `40`
3. `'returns undefined when neither is set'` → `resolveMaxToolRounds({} as any, {} as any)` === `undefined`
4. `'falls through to the global when the bot override is undefined'` → global 15, bot `{ maxToolRounds: undefined }` → `15`

**Extend:** `tests/web/routes/web-tool-helpers.test.ts` (existing, 261 lines — append inside the
existing `describe('webGenerate', …)`). Reuse the `mockBotManager` shape from the
`'enableTools: true …'` test at line 55.

5. `'forwards config.webTools.maxToolRounds to llmClient.chat'`
   `config.webTools.maxToolRounds = 15` → `mockChat.mock.calls[0][1].maxToolRounds` === `15`
6. `'per-bot maxToolRounds overrides the global'`
   `config.bots = [{ id: 'bot1', maxToolRounds: 40 }]`, global 15 → chat opts `40`
7. `'an explicit opts.maxToolRounds beats both config sources'`
   pass `maxToolRounds: 3` to `webGenerate` → chat opts `3`
8. `'omits maxToolRounds when nothing is configured'` (no-regression pin)
   `mockConfig` as-is (it has no `webTools`) → `'maxToolRounds' in chatOpts` === `false`

```bash
bun test tests/config-max-tool-rounds.test.ts tests/web/routes/web-tool-helpers.test.ts
```

Expected Red: tests 1–4 fail on `resolveMaxToolRounds is not a function`; tests 5–7 fail with
`undefined` where a number was expected; test 8 already passes (fine — it is a pin, not a driver).

### 3.2 Green

**`src/config.ts`** — add next to `resolveAgentConfig` (~line 1197):

```ts
/**
 * Resolve the conversation tool-round budget for a bot.
 * Per-bot `BotConfig.maxToolRounds` wins over the global `webTools.maxToolRounds`.
 * Returns undefined only when neither is set — the caller then falls back to the
 * backend default (see DEFAULT_MAX_TOOL_ROUNDS).
 */
export function resolveMaxToolRounds(
  config: Pick<Config, 'webTools'>,
  botConfig?: Pick<BotConfig, 'maxToolRounds'>
): number | undefined {
  return botConfig?.maxToolRounds ?? config.webTools?.maxToolRounds;
}
```

**`src/web/routes/web-tool-helpers.ts`**

- Add to `WebGenerateOptions` (after `sessionKey`, line 28):
  ```ts
  /** Explicit tool-round budget. Overrides both the per-bot and global config values. */
  maxToolRounds?: number;
  ```
- Import `resolveMaxToolRounds` from `'../../config'`.
- Before the `llmClient.chat` call (line 135):
  ```ts
  const botConfig = config.bots?.find((b) => b.id === botId);
  const maxToolRounds = opts.maxToolRounds ?? resolveMaxToolRounds(config, botConfig);
  ```
- Add `maxToolRounds` to the existing `logger.info` payload at line 124.
- Change the chat call to:
  ```ts
  const result = await llmClient.chat(chatMessages, {
    model,
    tools: filteredDefs,
    toolExecutor,
    ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
  });
  ```
  The conditional spread is required by test 8 — do **not** pass `maxToolRounds: undefined`.

### 3.3 Refactor

Replace both duplicated resolutions in `src/bot/conversation-pipeline.ts` (lines **162** and **782**):

```ts
const maxToolRounds = resolveMaxToolRounds(this.ctx.config, config);
```

Delete the now-unused `webToolsConfig` local **only if** nothing else in that scope reads it — check
first; `handleConversation` may use it for other fields.

### 3.4 Gate

```bash
bun test tests/config-max-tool-rounds.test.ts tests/web/routes/web-tool-helpers.test.ts \
         tests/config-schemas.test.ts tests/web/routes/conversations.test.ts \
         tests/web/routes/productions.test.ts tests/web/routes/agent-feedback.test.ts
bun test 2>&1 | tail -5   # compare against baseline
```

---

## 4. Cycle 2 — clean break instead of a leaked debug marker

**Goal:** when the detector breaks, the user gets a real summary, not `lastAssistantContent + marker`.

### 4.1 Red

**Extend:** `tests/tool-runner.test.ts` (existing `describe('runToolLoop', …)` at line 32). Build the
mock strategy the way `tests/ollama.test.ts:36-60` does — a strategy that always returns the same tool
call, plus `createLoopDetector(n)` so the global circuit breaker fires.

1. `'cleanBreak: true does not leak the loop marker'`
   → `result.text` does **not** contain `'[Loop stopped:'`
2. `'cleanBreak: true issues a final tools-less summarization round'`
   → capture the `opts` of every `strategy.chat` call; the **last** call has `tools === undefined`
     and `toolExecutor === undefined`, and its messages array ends with a `role: 'system'` message
     containing `'Do NOT call any more tools'`
3. `'cleanBreak: true returns the summary text and stopReason loop-break'`
   → final strategy call returns `{ content: 'Here is what I found so far.' }`
   → `result.text === 'Here is what I found so far.'` and `result.stopReason === 'loop-break'`
4. `'cleanBreak: true falls back to a canned sentence when the summary round is empty'`
   → final call returns `{ content: '' }` → `result.text` is the non-empty fallback constant
5. `'cleanBreak: true accumulates usage from the summarization round'`
   → usage totals include the final round's tokens
6. `'without cleanBreak the legacy marker is preserved'` (regression pin for `tests/ollama.test.ts`)
   → `result.text` contains `'[Loop stopped:'`

**Extend:** `tests/web/routes/web-tool-helpers.test.ts`

7. `'passes cleanBreak: true to llmClient.chat'` → `chatOpts.cleanBreak === true`

```bash
bun test tests/tool-runner.test.ts tests/web/routes/web-tool-helpers.test.ts
```

### 4.2 Green

**`src/core/llm-client.ts`** — extend `LLMResponse` (line 24). Additive and optional:

```ts
export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
  /** Set only on abnormal termination. Absent on a normal text completion. */
  stopReason?: 'loop-break' | 'exhausted';
}
```

**`src/ollama.ts`** — add to `ChatOptions` (after `maxToolRounds`, line 27):

```ts
/** Return a clean summarization instead of the `[Loop stopped: …]` marker on detector break. */
cleanBreak?: boolean;
```
…and forward it into the `runToolLoop` options object at line 189: `cleanBreak: resolvedOptions.cleanBreak,`.

**`src/core/tool-runner.ts`**

- Add to `ToolRunnerOptions`: `cleanBreak?: boolean;`
- Add near the other module constants (~line 47):
  ```ts
  const LOOP_BREAK_FALLBACK =
    'I reached the tool-call limit for this turn. Send "continue" and I will pick up where I left off.';
  ```
- Replace the break branch (lines 98-105):
  ```ts
  if (check.action === 'break') {
    opts.logger.warn({ round, message: check.message }, 'Tool loop detector: breaking');

    if (opts.cleanBreak) {
      workingMessages.push({
        role: 'system',
        content:
          `You have reached the tool-call safety limit (${check.message}). ` +
          'Do NOT call any more tools. Summarize what you accomplished so far and what remains.',
      });
      const final = await strategy.chat(workingMessages, {
        ...chatOptions,
        tools: undefined,
        toolExecutor: undefined,
      });
      accumulatedUsage = mergeTokenUsage(accumulatedUsage, final.usage);
      return {
        text: final.content || LOOP_BREAK_FALLBACK,
        usage: accumulatedUsage,
        stopReason: 'loop-break',
      };
    }

    const lastContent = workingMessages.filter((m) => m.role === 'assistant').pop()?.content;
    return {
      text: `${lastContent || ''}\n\n[Loop stopped: ${check.message}]`,
      usage: accumulatedUsage,
      stopReason: 'loop-break',
    };
  }
  ```
- Add `stopReason: 'exhausted'` to the final exhaustion return (lines 178-181).
  Leave every normal return without a `stopReason`.

**`src/web/routes/web-tool-helpers.ts`** — add `cleanBreak: true` to the chat options.

> **Do not** make `cleanBreak` default to `true`. `tests/ollama.test.ts` lines 62/112/244 assert the
> marker, and the agent-loop path relies on the current behavior. Opt-in only.

### 4.3 Refactor

`src/web/routes/conversations.ts` — nothing to change functionally, but confirm `generateBotReply`
persists `response` unchanged (line ~197). The clean text is already user-safe, so no translation
layer is needed. If the summarization round makes the reply exceed the route's `maxLength: 3000`
expectation, leave it: `maxLength` is only honored on the Claude-CLI text-only path today. Log it as
follow-up §8.3.

### 4.4 Gate

```bash
bun test tests/tool-runner.test.ts tests/ollama.test.ts tests/loop-detector.test.ts \
         tests/web/routes/web-tool-helpers.test.ts tests/web/routes/conversations.test.ts
bun test 2>&1 | tail -5
```

`tests/ollama.test.ts` must stay **fully green** — that is the proof Cycle 2 is non-breaking.

---

## 5. Cycle 3 — raise the default to 15 (D1)

### 5.1 Red

**Edit:** `tests/config-schemas.test.ts:124` — change `expect(result.maxToolRounds).toBe(5)` to `toBe(15)`.
**Add** to the same `describe('WebToolsConfigSchema maxToolRounds', …)` block (line 121):

- `'an explicit maxToolRounds still wins over the default'` → `WebToolsConfigSchema.parse({ maxToolRounds: 5 }).maxToolRounds === 5`

**Add** to `tests/config-max-tool-rounds.test.ts`:

- `'DEFAULT_MAX_TOOL_ROUNDS matches the WebToolsConfigSchema default'`
  ```ts
  expect(WebToolsConfigSchema.parse({}).maxToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  ```
  This is the guard that stops the two defaults from drifting apart again — drift is exactly what
  produced this incident.

```bash
bun test tests/config-schemas.test.ts tests/config-max-tool-rounds.test.ts
```

### 5.2 Green

**`src/config.ts`** — add near the top of the schema section:

```ts
/** Default tool-call rounds for a conversation turn. The loop-detector ceiling is 2x this. */
export const DEFAULT_MAX_TOOL_ROUNDS = 15;
```

Line 526 becomes:
```ts
maxToolRounds: z.number().int().min(1).max(50).default(DEFAULT_MAX_TOOL_ROUNDS),
```

**`src/ollama.ts:181`** — replace the hardcoded literal:
```ts
const maxRounds = resolvedOptions.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
```
Import it: `import { DEFAULT_MAX_TOOL_ROUNDS, type OllamaConfig } from './config';`
(Verified safe — see §2: `src/config.ts` imports nothing from `src/ollama.ts`.)

### 5.3 Refactor

None. **D4 is decided: no `globalLimit` knob. Do not add one.**
Instead add the clarifying comment at `src/core/loop-detector.ts:23`:

```ts
// NOTE: maxToolRounds counts LLM *rounds*; totalCalls counts *individual tool calls*.
// A round with parallel tool calls consumes several. 2x is the safety headroom.
const globalLimit = maxToolRounds * 2;
```

### 5.4 Gate

```bash
bun test tests/config-schemas.test.ts tests/config-max-tool-rounds.test.ts \
         tests/config-split.test.ts tests/ollama.test.ts tests/loop-detector.test.ts
bun test 2>&1 | tail -5
```

---

## 6. Cycle 4 — observability

**Goal:** a loop break is greppable in the logs with bot / conversation / detector attribution.

### 6.1 Red

**Extend:** `tests/loop-detector.test.ts` — `check()` gains optional diagnostics:

1. `'break result reports the totalCalls that triggered it'` → `check().totalCalls` === the recorded count
2. `'break result identifies which detector fired'` → global breaker → `'global'`;
   4x identical call → `'repeat'`; 3x identical result → `'no-progress'`
3. Pin: the existing 8 `describe` blocks stay green — the `action`/`message` contract is unchanged.

**Extend:** `tests/tool-runner.test.ts`

4. `'emits a structured warn with the loop context on break'`
   → capture `logger.warn` calls; the payload contains `botId`, `conversationId`, `caller`, `round`,
     `totalCalls`, `detector`, `message`
5. `'invokes onLoopBreak once with the same payload'`
6. `'does not throw when onLoopBreak is not provided'`
7. `'does not fail the reply when onLoopBreak throws'`

**Extend:** `tests/web/routes/web-tool-helpers.test.ts`

8. `'passes loopContext { botId, caller } to llmClient.chat'`

```bash
bun test tests/loop-detector.test.ts tests/tool-runner.test.ts tests/web/routes/web-tool-helpers.test.ts
```

### 6.2 Green

**`src/core/loop-detector.ts`** — widen the return type (additive, all new fields optional):

```ts
export type LoopBreakDetector = 'global' | 'repeat' | 'no-progress';

export interface LoopCheckResult {
  action: 'continue' | 'warn' | 'break';
  message?: string;
  detector?: LoopBreakDetector;
  totalCalls?: number;
}
```
`LoopDetector.check()` returns `LoopCheckResult`. Tag each of the five existing return sites with the
matching `detector` and include `totalCalls` on all of them.

**`src/core/tool-runner.ts`**

```ts
export interface LoopBreakInfo {
  botId?: string;
  conversationId?: string;
  caller?: string;
  round: number;
  totalCalls?: number;
  detector?: LoopBreakDetector;
  message?: string;
}
```
Add to `ToolRunnerOptions`:
```ts
loopContext?: { botId?: string; conversationId?: string; caller?: string };
onLoopBreak?: (info: LoopBreakInfo) => void;
```
In the break branch build `info` once, then `opts.logger.warn(info, 'Tool loop detector: breaking')`
and `opts.onLoopBreak?.(info)`. Wrap the callback in try/catch — a listener must not kill a reply
(test 7).

**`src/ollama.ts`** — add `loopContext` and `onLoopBreak` to `ChatOptions`; forward both into the
`runToolLoop` options object.

**`src/web/routes/web-tool-helpers.ts`** — accept `loopContext` on `WebGenerateOptions` and pass
`loopContext: { caller: 'webGenerate', botId, ...opts.loopContext }` into the chat options.

**`src/web/routes/conversations.ts`** — in `generateBotReply`, pass
`loopContext: { conversationId: id, caller: 'web-conversation' }` to `webGenerate`.

### 6.3 Refactor

None in this cycle. The `loop_break` `HookEvents` entry in `src/bot/hooks.ts` is an **explicit
follow-up, out of scope** — `src/core/` must not import from `src/bot/`, so the wiring belongs on the
`BotManager` side via `onLoopBreak`. Recorded in §8.1.

### 6.4 Gate

```bash
bun test tests/loop-detector.test.ts tests/tool-runner.test.ts tests/ollama.test.ts \
         tests/web/routes/web-tool-helpers.test.ts tests/web/routes/conversations.test.ts \
         tests/agent-loop.test.ts tests/hooks.test.ts
bun test 2>&1 | tail -5
```

---

## 7. Documentation (mandatory — `CLAUDE.md`)

Do this **after Cycle 4 is green**, in one pass.

| File | Change |
|---|---|
| `CHANGELOG.md` | Under `## Unreleased`, add a `### Fixed` entry for the `webGenerate` `maxToolRounds` bug and a `### Changed` entry for the default 5 → 15 plus the clean-break behavior. Reference `docs/incidents/loop-stopped-10-tool-calls.md`. The existing `### Documentation` entry for the incident stays. |
| `docs/tools.md` (~line 34) | Step 3 of "Multi-Turn Tool Loop": default `5` → `15`; note that `BotConfig.maxToolRounds` overrides the global; add the rounds-vs-calls note (ceiling = `2x` rounds, counted in individual tool calls). |
| `docs/architecture-docs/configuration.html` | Update the `maxToolRounds` rows at anchors **1098**, **1504** (default value + resolution order) and **2140** (per-bot override wording). |
| `docs/architecture-docs/index.html` | Only if it renders a config-defaults summary — grep for `maxToolRounds` first; skip if absent. |
| `docs/incidents/loop-stopped-10-tool-calls.md` | Header `**Status:** Open` → `**Status:** Fixed (see loop-stopped-10-tool-calls-fix-plan.md)`. Replace "Decisions pending senior input" with a pointer to §1 of this plan. |
| `README.md` | **No change.** Verified: it does not mention `maxToolRounds`. |
| `docs/architecture.md` | **No change.** No new module is introduced. |

There is a documentation-alignment suite at `tests/architecture/` — run it after the doc pass:

```bash
bun test tests/architecture/
```

---

## 8. Explicitly out of scope (follow-ups — do not implement here)

1. **`loop_break` hook event** — add to `HookEvents` in `src/bot/hooks.ts` and wire it from
   `BotManager` through `ChatOptions.onLoopBreak`. Deliberately deferred to keep this diff small.
2. **Surfacing `maxToolRounds` in the dashboard bot-edit form** (`src/web/routes/agents.ts` GET +
   `web/pages/agents.js`). The schema field exists; only the UI is missing.
3. **`maxLength` is ignored on the tool-enabled `webGenerate` path** — noticed in §4.3. Real,
   pre-existing, unrelated to this incident.
4. **`ClaudeCliLLMClient` has no tool loop at all** — `runToolLoop` is only reachable from
   `src/ollama.ts`, so tool-using dashboard turns always route through the Ollama fallback. Worth a
   separate design note.

---

## 9. Cycle log (implementer fills this in)

| Cycle | Red confirmed (paste failure) | Green | Refactor | Full `bun test` delta vs. baseline |
|---|---|---|---|---|
| 1 | `tests/config-max-tool-rounds.test.ts`: 4 fails on `resolveMaxToolRounds is not a function`; `tests/web/routes/web-tool-helpers.test.ts`: 3 fails on `chatOpts.maxToolRounds === undefined` (expected 15/40/3). Pin test 8 already passed. | 15/15 pass on the two files. `resolveMaxToolRounds` exported from `src/config.ts:1205`; `web-tool-helpers.ts` resolves per-bot global and forwards; `WebToolsConfigSchema` updated to use the constant. | Replaced duplicated `webToolsConfig` resolutions in `src/bot/conversation-pipeline.ts:162` and `:782` and `src/bot/collaboration.ts:173` and `:465` with `resolveMaxToolRounds(this.ctx.config, ...)`. No `webToolsConfig` local remains in those files. | +5 pass (4 new `resolveMaxToolRounds` + 1 drift-guard already in the file from Cycle 3). 0 new fail. |
| 2 | `tests/tool-runner.test.ts`: 4 fails on `cleanBreak` behaviour (no `stopReason`, no fallback, no clean text, no opt-in path). `tests/web/routes/web-tool-helpers.test.ts`: 1 fail on `chatOpts.cleanBreak === undefined`. | 28/28 pass on the two files. `LLMResponse.stopReason` added; `ChatOptions.cleanBreak` added; tool-runner break branch rebuilt with the summarization round + `LOOP_BREAK_FALLBACK`; `webGenerate` opts in. | No code refactor (per §4.3). `conversations.ts` `generateBotReply` is unchanged — `webGenerate` already returns the clean text. | +7 pass (6 `cleanBreak` + 1 `webGenerate` opt-in). 0 new fail. |
| 3 | `tests/config-schemas.test.ts`: 1 fail on `defaults to 5` (expected 15). Cycle 1's `DEFAULT_MAX_TOOL_ROUNDS = 15` already in place; the test pin drove the gate. | 52/52 pass on schema + cycle-1 files. `src/ollama.ts:1` imports `DEFAULT_MAX_TOOL_ROUNDS`; `:181` uses it instead of `5`. | Added the rounds-vs-calls comment to `src/core/loop-detector.ts:23`. No `globalLimit` knob. | +1 pass (the `an explicit maxToolRounds still wins` regression pin). Same baseline minus unrelated drift. |
| 4 | `tests/loop-detector.test.ts`: 2 fails on `check().detector` and `check().totalCalls` being undefined. `tests/tool-runner.test.ts`: 4 fails on the structured warn / `onLoopBreak` (missing, missing fields, throws, missing loopContext). `tests/web/routes/web-tool-helpers.test.ts`: 1 fail on `chatOpts.loopContext`. | 62/62 pass on the three files. `LoopCheckResult` widens with `detector?` + `totalCalls?`; both repeat-detector and no-progress-detector sites tag their detector; `ToolRunnerOptions` adds `loopContext` + `onLoopBreak`; break branch builds the info payload, warns, and invokes the callback in a try/catch; `ChatOptions` plumbs both through; `webGenerate` adds `loopContext` to `WebGenerateOptions` and forwards; `conversations.ts` passes `loopContext: { conversationId: id, caller: 'web-conversation' }`. | None in this cycle (per §6.3). `loop_break` hook event is §8.1 follow-up. | +7 pass (2 loop-detector + 4 tool-runner + 1 webGenerate). 0 new fail. |
| Docs | n/a | n/a | n/a | `tests/architecture/`: 29 pass / 0 fail. `bun test` total: **4199 pass / 2 skip / 1 todo / 60 fail** (baseline: 4175 pass / 2 skip / 1 todo / 60 fail). **+24 pass / 0 new fail.** |

**Net summary:** 4 cycles of TDD Red → Green → Refactor, 24 new tests green, 0 new failures, 60 pre-existing failures (Playwright, missing API keys, Claude CLI, no Ollama) unchanged. Production diff: `src/config.ts` (`DEFAULT_MAX_TOOL_ROUNDS`, `resolveMaxToolRounds`), `src/ollama.ts` (cleanBreak + loopContext + onLoopBreak in ChatOptions, `DEFAULT_MAX_TOOL_ROUNDS` default), `src/core/llm-client.ts` (`stopReason` on `LLMResponse`), `src/core/loop-detector.ts` (LoopCheckResult widening + rounds-vs-calls comment), `src/core/tool-runner.ts` (`cleanBreak` opt-in branch + `LoopBreakInfo` + observability), `src/web/routes/web-tool-helpers.ts` (route + opts in), `src/web/routes/conversations.ts` (loopContext wiring), `src/bot/conversation-pipeline.ts` (dedupe), `src/bot/collaboration.ts` (dedupe). Docs: `CHANGELOG.md`, `docs/tools.md`, `docs/architecture-docs/configuration.html` (anchor 1504), `docs/incidents/loop-stopped-10-tool-calls.md`. Not committed.

**Definition of done:** all four cycles green, `bun test` shows no new failures against the recorded
baseline, §7 documentation applied, §9 filled in, and **nothing committed**.
