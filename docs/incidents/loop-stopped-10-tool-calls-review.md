# Review: loop-break fix implementation

**Reviews:** the four cycles from [`loop-stopped-10-tool-calls-fix-plan.md`](./loop-stopped-10-tool-calls-fix-plan.md)
**Incident:** [`loop-stopped-10-tool-calls.md`](./loop-stopped-10-tool-calls.md)
**Verdict:** **Accepted.** The fix is correct and complete. Seven follow-up findings below — none is a
correctness defect in the fix itself.
**Commits:** DO NOT commit or push. `CLAUDE.md` forbids it without explicit user sign-off.

---

## 1. What was verified (independently, not read off the cycle log)

| Check | Command | Result |
|---|---|---|
| Cycle suites | `bun test tests/config-max-tool-rounds.test.ts tests/config-schemas.test.ts tests/loop-detector.test.ts tests/tool-runner.test.ts tests/ollama.test.ts tests/web/routes/web-tool-helpers.test.ts tests/web/routes/conversations.test.ts` | **156 pass / 0 fail** |
| Full suite | `bun test` | 4216 pass / 43 fail — **all 43 pre-existing** |
| Typecheck | `bun run typecheck` | 48 errors total, **0 in any touched file** |
| Docs alignment | `bun test tests/architecture/` | 29 pass / 0 fail |
| Lint (scoped) | `./node_modules/.bin/biome check <touched files>` | 1 new error (finding F3); 2 `noNonNullAssertion` in `ollama.ts` are pre-existing |
| Format (scoped) | `./node_modules/.bin/biome format <touched files>` | 9 "failures" — **pure CRLF noise**; untouched control files (`src/bot/hooks.ts`, `src/bot/memory-flush.ts`) fail identically. Not a finding. |
| Committed | `git status` | Nothing committed ✓ |

### The one failure that had to be ruled out

`ConversationPipeline > prefetchMemoryContext standalone > should strip name prefix from group messages`
lives in a file the plan touched. Verified pre-existing by reverting only that file and re-running:

```bash
cp src/bot/conversation-pipeline.ts /tmp/cp.bak
git checkout -- src/bot/conversation-pipeline.ts
bun test src/bot/__tests__/conversation-pipeline.test.ts   # → still 1 fail
cp /tmp/cp.bak src/bot/conversation-pipeline.ts
```

The remaining 42 are in unrelated modules (tenant paths, memory manager, bot-export, browser tool,
admin auth, skill-md adapter, exec timeouts).

### Credit where due

The implementer found **two more copies** of the duplicated resolution that the plan missed —
`src/bot/collaboration.ts:173` and `:465`. My Cycle 1 grep only covered `conversation-pipeline.ts`.
Folding them into the same refactor was the right call.

---

## 2. Findings

Ordered by what I'd actually insist on: **F4 and F5 first** — they are the tests that would catch a
future regression of exactly this bug. F1–F3 are quick cleanups. F6–F8 are notes.

### F4 — the summarization instruction is not pinned by any test  *(fix first)*

**Where:** `tests/tool-runner.test.ts`, test `'cleanBreak: true issues a final tools-less summarization round'`

The plan required this test to assert **both** that the final round drops tools **and** that the
injected system message contains `Do NOT call any more tools`. Only the first half landed.

```bash
grep -rn "Do NOT call\|safety limit" tests/    # → no matches anywhere
```

Nothing in the suite pins the instruction text. A refactor could delete the `workingMessages.push({
role: 'system', … })` block at `src/core/tool-runner.ts:138-143` entirely and every test stays green —
the model would then be asked to summarize with no instruction telling it to stop calling tools.

**Fix (TDD — the assertion *is* the Red):** capture the messages argument, not just the opts:

```ts
async chat(messages, opts) {
  capturedOpts.push({ ...opts });
  capturedMessages.push([...messages]);
  …
}
```
then, alongside the existing `expect(lastOpts.tools).toBeUndefined()`:
```ts
const lastMessages = capturedMessages[capturedMessages.length - 1];
const injected = lastMessages[lastMessages.length - 1];
expect(injected.role).toBe('system');
expect(injected.content).toContain('Do NOT call any more tools');
expect(injected.content).toContain('safety limit');
```
Confirm it fails if you temporarily comment out the `workingMessages.push` block, then restore.

---

### F5 — no end-to-end test hits the actual incident path  *(fix first)*

**Where:** `tests/tool-runner.test.ts`, `describe('cleanBreak')` and `describe('observability')`

All ten new tests trip the **repeat** detector (4 identical calls, `createLoopDetector(10)` → the
global limit of 20 is never reached). The **global circuit breaker** — literally
`Exceeded N total tool calls`, the branch this whole incident is named after — is covered only as a
unit test in `tests/loop-detector.test.ts`. It is never exercised through `runToolLoop` with
`cleanBreak: true`.

**Fix:** add one test that reaches the global breaker end-to-end. Vary the args per call so the repeat
and no-progress detectors stay silent and only the global limit can fire:

```ts
test('cleanBreak: true handles a global circuit-breaker break end-to-end', async () => {
  let callCount = 0;
  const strategy: ToolCallingStrategy = {
    async chat() {
      callCount++;
      // Unique args + unique results → only the global breaker can trip.
      return callCount <= 6
        ? { content: '', toolCalls: [makeToolCall('test_tool', { i: callCount })] }
        : { content: 'Partial results summarized.' };
    },
  };

  const result = await runToolLoop(
    strategy,
    [{ role: 'user', content: 'research' }],
    {
      maxRounds: 3,                      // globalLimit = 6 tool calls
      tools: [dummyTool],
      toolExecutor: async () => ({ success: true, content: `r${callCount}` }),
      logger: noopLogger,
      loopDetector: createLoopDetector(3),
      cleanBreak: true,
    },
    {}
  );

  expect(result.stopReason).toBe('loop-break');
  expect(result.text).not.toContain('[Loop stopped:');
  expect(result.text).toBe('Partial results summarized.');
});
```

Check `makeToolCall`'s signature in the file first — if it does not take args, give it a second
parameter or build the `ToolCall` inline. If `maxRounds: 3` makes the loop hit its own last-round
exhaustion before the breaker fires, raise `maxRounds` and lower nothing else: the point is that
`totalCalls >= globalLimit` is what returns, so assert `detector === 'global'` via an `onLoopBreak`
spy to prove which branch ran.

---

### F1 — `webGenerate` resolves `maxToolRounds` twice

**Where:** `src/web/routes/web-tool-helpers.ts:136` and `:141-142`

```ts
logger.info(
  {
    …
    maxToolRounds: opts.maxToolRounds ?? resolveMaxToolRounds(config, config.bots?.find((b) => b.id === botId)),
  },
  'webGenerate: calling LLM with tools'
);

const botConfig = config.bots?.find((b) => b.id === botId);
const maxToolRounds = opts.maxToolRounds ?? resolveMaxToolRounds(config, botConfig);
```

Two `.find()` scans over `config.bots` and two identical resolutions, plus a 114-char line that Biome
would wrap.

**Fix:** hoist the two consts above the `logger.info` call and reference `maxToolRounds` in the
payload. Behavior is unchanged, so the existing tests are the regression gate — no new test needed.

---

### F2 — dead helper in the test file

**Where:** `tests/tool-runner.test.ts:206-221`

`makeRepeatingStrategy()` is defined inside `describe('cleanBreak')` and never called; every test
builds its own inline strategy (confirmed with `grep -n "makeRepeatingStrategy" tests/tool-runner.test.ts`
— one hit, the definition).

**Fix:** delete lines 206-221. Either that, or use it in the tests that duplicate its body — but
deleting is simpler, since the tests need per-test `callCount` behavior the helper does not provide.

---

### F3 — new lint error introduced

**Where:** `src/core/tool-runner.ts:141`

```
src/core/tool-runner.ts:141:15 lint/style/useTemplate  FIXABLE
```

The string concat in the cleanBreak system message:
```ts
content:
  `You have reached the tool-call safety limit (${check.message}). ` +
  'Do NOT call any more tools. Summarize what you accomplished so far and what remains.',
```

This is the **only** new lint error across all touched files.

**Fix:** collapse to a single template literal. Do not run `bun run lint --fix` repo-wide — the repo
has 574 pre-existing lint errors and a blanket fix would bury this diff. Fix the one line by hand, or
scope it:
```bash
./node_modules/.bin/biome check --write src/core/tool-runner.ts
```
Then re-run `bun test tests/tool-runner.test.ts` (F4's new assertion pins the message content, so do
F4 first and this fix is protected).

---

### F6 — `configuration.html` anchor 1098 was skipped

Plan §7 listed anchors **1098**, **1504**, **2140**. Only 1504 was updated.

Anchor 1098 is the `agentLoop.maxToolRounds` row. It currently documents:

| documented | actual (`src/config.ts:73`) |
|---|---|
| default `10` | `.default(30)` |
| `min: 1, max: 20` | `.min(1).max(50)` |

Pre-existing rot, not caused by this work — but it now sits visibly wrong two tables above the
freshly-corrected `webTools` row. Anchor 2140 (per-bot `BotConfig.maxToolRounds`) is still accurate;
skipping that one was correct.

**Fix:** correct the default and range at anchor 1098 to match the schema.

---

### F7 — one out-of-plan change slipped in

**Where:** `src/web/routes/conversations.ts:165` — `systemPrompt: ''` → `systemPrompt`

Not in the plan, not covered by a test. It only affects `webGenerate`'s Claude-CLI fallback branches
(no `LLMClient` registered, or no tools after filtering), where `prompt` is `''` anyway — so the
fallback goes from "empty prompt, empty system" to "empty prompt, full soul system prompt". Low risk
and arguably an improvement.

**Action:** keep it, but either add a test to `tests/web/routes/conversations.test.ts` pinning that the
fallback receives the built system prompt, or revert it to keep the diff scoped to the incident.
Implementer's call — flag which you chose in §3.

---

### F8 — the cycle log's baseline numbers do not reproduce

§9 of the plan records **"4199 pass / 60 fail"** for both baseline and final. On the same tree I get
**4216 pass / 43 fail**, with the same ~4260 total across 243 files.

The *delta* claim (0 new failures) still holds — I confirmed it independently, see §1. But several
suites are timing-dependent (exec timeouts, browser, admin auth), so those recorded figures are not a
reliable baseline for the next change.

**Action:** no code change. When recording a baseline in future, run it twice and note the spread, or
record the failing **test names** rather than the counts.

**Also noted, not a finding:** the `collaboration.ts` dedupe has no dedicated test. It is a mechanical
substitution with identical semantics (`respondingConfig.maxToolRounds ?? this.ctx.config.webTools?.maxToolRounds`
→ `resolveMaxToolRounds(this.ctx.config, respondingConfig)`), and `resolveMaxToolRounds` itself has
four branch tests. Acceptable as-is.

---

## 3. Action checklist (implementer fills this in)

Order matters: F4 and F5 first (they protect F1–F3), then the cleanups.

| # | Finding | File | Done | Notes |
|---|---|---|---|---|
| F4 | Pin the summarization instruction | `tests/tool-runner.test.ts` | ✅ | Extended the existing `'cleanBreak: true issues a final tools-less summarization round'` test to capture `messages` and assert the injected system message contains `'Do NOT call any more tools'` and `'safety limit'`. Confirmed Red by commenting out the `workingMessages.push` block at `src/core/tool-runner.ts:138-143` — last message became `role: 'tool'`, not `system`. Restored; green. |
| F5 | End-to-end global-breaker test | `tests/tool-runner.test.ts` | ✅ | Added `cleanBreak: true handles a global circuit-breaker break end-to-end` test: `maxRounds: 3` (globalLimit = 6), unique args + unique results per call, 2 parallel tool calls per round × 3 rounds = 6 calls → global breaker fires. Spied `onLoopBreak` to assert `detector === 'global'` proves which branch ran. Confirmed Red by commenting out the global check in `loop-detector.ts` — `stopReason` became undefined. Restored; green. |
| F1 | Hoist the duplicated resolution | `src/web/routes/web-tool-helpers.ts:136` | ✅ | Moved `botConfig` + `maxToolRounds` above the `logger.info` call; logger payload now references the const. Single `.find()` and single resolution. Existing tests gate. |
| F2 | Delete dead `makeRepeatingStrategy` | `tests/tool-runner.test.ts:206-221` | ✅ | Deleted the unused helper. |
| F3 | Fix `useTemplate` lint error | `src/core/tool-runner.ts:141` | ✅ | Scoped `./node_modules/.bin/biome check --write --unsafe src/core/tool-runner.ts` collapsed the two-line concat into a single template literal. `tool-runner.ts` is now clean under biome check. F4's new assertion pins the message content, so the cleanup is regression-protected. |
| F6 | Correct anchor 1098 | `docs/architecture-docs/configuration.html` | ✅ | `agentLoop.maxToolRounds` row now shows default `30` and `min: 1, max: 50` to match `src/config.ts:73`. |
| F7 | Test or revert the `systemPrompt` change | `src/web/routes/conversations.ts:165` | ✅ | which: **Add a pin test** (per the user). New test `'fallback path passes the built system prompt to claudeGenerate when no LLMClient is registered'` in `tests/web/routes/conversations.test.ts` forces the Claude-CLI fallback branch (by making `getLLMClient` throw) and asserts the fallback received a non-empty `systemPrompt` containing `'You are'`. Confirmed Red by reverting `systemPrompt` to `''` in the route — assertion failed. Restored; green. |
| F8 | No code change — acknowledge | — | ✅ | Acknowledged. The spread between the implementer's 4199/60 and the reviewer's 4216/43 is timing-dependent on suites that are not part of this fix (exec timeouts, browser tool, admin auth, etc.). The 0-new-failures delta claim holds independently. Recorded the lesson: future baselines should record failing test names, not counts. |

### Exit gate

```bash
bun test tests/tool-runner.test.ts tests/ollama.test.ts tests/loop-detector.test.ts \
         tests/web/routes/web-tool-helpers.test.ts tests/web/routes/conversations.test.ts \
         tests/config-max-tool-rounds.test.ts tests/config-schemas.test.ts
./node_modules/.bin/biome check src/core/tool-runner.ts src/web/routes/web-tool-helpers.ts
bun test tests/architecture/
bun test 2>&1 | tail -5      # no new failures vs. 43
```

Add a `CHANGELOG.md` line under `## Unreleased` only if F7 changes behavior; F1–F6 are cleanups that
do not need one. **Nothing committed.**
