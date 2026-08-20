# Plan: ship a configured `claude` CLI inside the Docker image

**Status:** implemented 2026-08-20 — see Findings at the bottom for what execution actually turned up
**Scope:** `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `.env.example`, `src/config.ts`,
new `src/bot/claude-cli-preflight.ts`, `src/index.ts` wiring, tests, `CHANGELOG.md`,
`docs/deployment-cloud.md`, `docs/architecture-docs/*.html`, `README.md`, `CLAUDE.md` module table
**Executed in-session** under the TDD gate in `CLAUDE.md`. Changes are left uncommitted for review.

---

## Goal

`claude` is present, on `PATH`, version-pinned and authenticated inside the running container, so every
call site that spawns it works in Docker exactly as it does on the operator's workstation today.

## Operator decisions already made (do not re-litigate)

1. **Auth**: the operator logs into Claude Code themselves and the container consumes *those*
   credentials. No `ANTHROPIC_API_KEY` path is being built. The plan's job is to make the credential
   store **persistent and reachable**, not to invent a token flow.
2. **Install mode**: always installed in the default image, at a **pinned** version. Justification:
   `resolveCandidatesFromConfig` already puts `claude-cli` in the failover chain by default, so today's
   image ships a backend that can never work.

---

## Current state (verified in the tree — cite these when you touch them)

| Fact | Where |
|---|---|
| Default binary name is the bare string `claude`, resolved off `PATH` | `src/claude-cli.ts:26` (`DEFAULT_CLAUDE_PATH`) |
| Spawned with `cwd: tmpdir()`, `CLAUDECODE` cleared, `TERM=dumb`, and a **copy of `process.env`** | `src/claude-cli.ts:63-88`, `:250-262` |
| `claudeGenerate` passes `--dangerouslySkipPermissions` | `src/claude-cli.ts:75` |
| Tool-calling path spawns the MCP bridge as `bun run src/mcp/tool-bridge-server.ts` | `src/claude-cli.ts:238-247` |
| Call sites: memory flush (x2), soul consolidator, soul quality reviewer, improve tool, skill generator, soul generator, `ClaudeCliLLMClient` | `src/bot/memory-flush.ts:40,123`, `src/bot/soul-memory-consolidator.ts:139`, `src/bot/soul-quality-reviewer.ts:175`, `src/bot/tool-registry.ts:391`, `src/skill-generator.ts:173`, `src/core/llm-client.ts:390` |
| `claude-cli` is a **default** failover candidate unless `claudeCli.enabled === false` | `src/bot/model-failover/model-fallback.ts:323` |
| …but `ClaudeCliConfigSchema` only declares `model`, so Zod **strips** `enabled` from `config.json` — the escape hatch silently does nothing | `src/config.ts:675-679` |
| Image is `oven/bun:1.3.11-slim`, ends `USER bun` (uid 1000); volumes are `/app/config`, `/app/data`, `/app/productions`; `HOME=/home/bun` is **not** a volume | `Dockerfile` |
| Docs currently state the CLI is absent | `docs/deployment-cloud.md` §11, the `claude CLI` row |

Because `claudeGenerate` copies `process.env` wholesale into the child, **any env var set on the
container reaches the CLI with zero code changes**. That is the lever for the optional token fallback.

---

## Design

### 1. Install the CLI in the runtime stage, pinned

In `Dockerfile`, runtime stage:

- add `curl` to the existing `apt-get install` line (the native installer needs it; keep the
  `rm -rf /var/lib/apt/lists/*` cleanup in the same layer),
- add `ARG CLAUDE_CLI_VERSION=<pin>` near the top of the runtime stage,
- run the installer **as `bun`, after `USER bun`**, so the binary and its metadata land under
  `/home/bun/.local` owned by uid 1000,
- `ENV PATH="/home/bun/.local/bin:${PATH}"`,
- `ENV DISABLE_AUTOUPDATER=1` so the pin stays a pin and the container never self-mutates,
- **build-time gate**: `RUN claude --version` as its own step, so a broken or relocated installer fails
  the build instead of failing silently at the first soul health check.

> **Verify, do not assume.** Before writing the `RUN` line, fetch the installer and read it
> (`curl -fsSL https://claude.ai/install.sh | head -60`) to confirm the current URL and the exact
> syntax for requesting a specific version. If it does not support pinning, pin by fetching the
> versioned artifact it points at. Record what you confirmed in **Findings** at the bottom of this file.

Keep the `USER root` / `USER bun` transitions readable in the same style as the commented Playwright
block, so the two optional-component patterns look alike.

### 2. Credentials: persistent, operator-supplied, never baked into the image

- `ENV CLAUDE_CONFIG_DIR=/app/data/claude` in the Dockerfile.
  `/app/data` is already a named volume (`aibot_data`), so a login survives
  `docker compose up -d --build`, container recreation and image upgrades. `/home/bun/.claude` would
  **not** — it lives in the container layer and dies on every rebuild. This is the whole point of the
  change.
- `docker-entrypoint.sh` creates it: `mkdir -p "$CLAUDE_CONFIG_DIR"` + `chmod 700`, defaulting to
  `/app/data/claude` when the var is unset so bare-metal runs are undisturbed.
- Login is an **operator action, run once**:
  `docker compose exec -it aibot claude` then `/login`, or the non-interactive token subcommand if the
  pinned version ships one. **Verify which subcommand exists** (`docker compose exec aibot claude --help`)
  and document the command that actually worked — do not copy an untested command out of this plan.
- **Never** `docker compose exec -u root`: credentials would land root-owned in the volume and the
  `bun` process could not read them afterwards.
- Optional fallback, documented only: a `CLAUDE_CODE_OAUTH_TOKEN` in `.env` reaches the child process
  for free (see the `process.env` note above). **Do not add it to compose's `environment:` block** — an
  env var that is present-but-empty typically shadows an on-disk credential profile, which would break
  the primary login flow for everyone who leaves the line blank. Ship it commented out in
  `.env.example` with that warning attached.

### 3. Do not run as root

`--dangerouslySkipPermissions` is refused when the CLI runs as uid 0. The image already ends with
`USER bun` — keep it that way, and say so in a Dockerfile comment beside the install block so nobody
"fixes" a future permission error by switching to root.

### 4. Make `claudeCli.enabled` real *(code change — TDD)*

`src/config.ts:675` — add `enabled: z.boolean().default(true)` to `ClaudeCliConfigSchema`.

Now that the binary genuinely ships, an operator who wants an Ollama-only deployment needs a switch
that survives config load; today theirs is eaten by Zod before `model-fallback.ts` ever sees it.

**Red first** (`tests/config-schemas.test.ts`):

- parsing a config with `claudeCli: { enabled: false }` keeps `enabled === false` (fails today),
- omitting it defaults to `true`,
- `resolveCandidatesFromConfig(parsedConfig)` yields no `claude-cli` candidate when the **parsed**
  config says `enabled: false` — the two halves wired together, which is the bug that actually bites.

### 5. Startup preflight *(new module — TDD)*

New `src/bot/claude-cli-preflight.ts`:

```ts
export interface ClaudeCliPreflight {
  available: boolean;
  version?: string;
  configDir: string;
  credentials: 'present' | 'missing' | 'unknown';
  reason?: string;
}

export async function checkClaudeCli(opts: {
  claudePath: string;
  which?: WhichFn;                  // injectable, mirrors resolveClaudeBin's WhichFn
  run?: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
  configDir?: string;
  exists?: (path: string) => Promise<boolean>;
}): Promise<ClaudeCliPreflight>;
```

Injectable `which` / `run` / `exists` so the tests stay hermetic — the same pattern as
`resolveClaudeBin(path, which)` at `src/claude-cli.ts:45`. Reuse `resolveClaudeBin` for the Windows
`.cmd` case rather than re-deriving it.

Behaviour:

- binary not on `PATH` → `available: false` with a reason,
- present → run `claude --version` with a short bounded timeout and parse the version,
- credentials → probe `CLAUDE_CONFIG_DIR`. **Confirm the real credential filename in the pinned version
  before asserting on it**; if you cannot confirm it, report `'unknown'` and probe only for a non-empty
  directory. A confidently-wrong "not authenticated" warning at every boot is worse than no warning.

Wire into `src/index.ts` after config load (near the existing startup logging around `:31`): one `info`
line when healthy; a `warn` **only when `claude-cli` is actually in the failover chain** and the binary
or credentials are missing — that is the single actionable case. Non-fatal, bounded, never blocks boot.

**Red first** (`tests/claude-cli-preflight.test.ts`), one test per branch: binary missing /
present + version parsed / `--version` non-zero exit / `--version` timeout / credentials present /
credentials missing / `enabled: false` short-circuit.

### 6. Entrypoint banner

In `docker-entrypoint.sh`, after the existing seeding block: when `CLAUDE_CONFIG_DIR` holds no
credentials, print a short banner in the established `[entrypoint]` style with the exact login command,
noting that the login persists in the `aibot_data` volume. Silent once logged in. Idempotent, and it
must never fail the boot (`|| true` around any probe that can error).

### 7. compose

No functional change is strictly required — `init: true` already reaps the `claude` subprocesses (the
existing comment even names them). Confirm that, refresh any comment the change makes stale, and do
**not** add `CLAUDE_CODE_OAUTH_TOKEN` to `environment:` (§2).

### 8. Docs, README, CHANGELOG (mandatory per `CLAUDE.md`)

- `docs/deployment-cloud.md` §11: flip the `claude CLI` row from "Not installed" to installed + pinned
  version, and add a subsection **"Authenticating the `claude` CLI"** covering the one-time login
  command you verified, where credentials live and why, how to re-login, how to verify
  (`docker compose exec aibot claude --version` plus the new preflight log line), and the
  don't-exec-as-root warning.
- `docs/architecture-docs/configuration.html`: add the `claudeCli.enabled` row.
- `docs/architecture-docs/bot-core.html` and the module table in `CLAUDE.md`: add
  `claude-cli-preflight.ts`.
- `README.md`: the Docker image now ships the `claude` CLI — update the stack / core-systems section.
- `CHANGELOG.md`: one entry covering the image change, the config fix and the preflight.

---

## Execution order

| # | Cycle | Gate |
|---|---|---|
| 1 | `claudeCli.enabled` — red tests → schema → green | `bun test tests/config-schemas.test.ts` |
| 2 | `claude-cli-preflight.ts` — red tests → module → green | `bun test tests/claude-cli-preflight.test.ts` |
| 3 | Wire preflight into `src/index.ts` | boot locally, see the line |
| 4 | Dockerfile + entrypoint + `.env.example` | real build + run, see Verification |
| 5 | Docs / README / CHANGELOG / `CLAUDE.md` | — |
| 6 | Full suite | `bun test` clean; no new failures vs. the pre-change baseline |

Take a `bun test` baseline **before** step 1 and diff against it at step 6. Pre-existing failures from
Playwright or missing API keys do not count as regressions (`CLAUDE.md`), but you must show the set did
not grow.

---

## Verification checklist — run these and paste the real output

1. `docker compose build` succeeds, and the build log shows the `claude --version` gate passing.
2. `docker compose run --rm aibot claude --version` (the entrypoint `exec "$@"`s, so this works).
3. Image size delta before/after (`docker image ls`) — report it.
4. Log in per §2, then `docker compose exec aibot claude -p 'reply with OK' --output-format json`
   returns parseable JSON carrying a `usage` field — that is the exact shape `parseClaudeUsage`
   (`src/claude-cli.ts:8`) consumes.
5. `docker compose restart aibot` → still authenticated.
6. `docker compose up -d --build` (fresh image, same volumes) → **still authenticated**. This is the
   test that justifies putting `CLAUDE_CONFIG_DIR` in the data volume; if it fails, the design is wrong.
7. Boot logs show the preflight line, and show the warning when you temporarily point
   `CLAUDE_CONFIG_DIR` at an empty directory.
8. `bun test` clean.

---

## Verify-don't-assume list

Anything here you cannot confirm at execution time: report it, do not guess.

- Installer URL and its version-pinning syntax (§1).
- The login subcommand available in the pinned version (§2).
- The credential filename inside `CLAUDE_CONFIG_DIR` (§5).
- **`--dangerouslySkipPermissions` at `src/claude-cli.ts:75`** — run `claude --help` in the container
  and confirm the pinned version accepts that camelCase spelling. If it only accepts
  `--dangerously-skip-permissions`, that is a live bug in `claudeGenerate`: fix it *with its own red
  test first* and give it a separate CHANGELOG line rather than folding it into the Docker entry.
- Whether the operator's Claude subscription terms permit a headless container using their personal
  login. Flag it to the operator; it is their call, not yours.

## Out of scope — record as follow-ups, do not implement

- `ClaudeCliLLMClient` takes its binary path from `improve.claudePath`
  (`src/bot/bot-manager.ts:637`) rather than from `claudeCli`, which is surprising once `claudeCli` is
  a first-class config block.
- Surfacing preflight state on `/api/status` and in the dashboard.
- Any change to the Playwright/Chromium optional block.

---

## Findings (execution, 2026-08-20)

**Status: implemented.** All six execution-order steps done. `bun test` 4257 pass / 43 fail vs. a
4236 / 43 baseline — +21 tests, zero new failures.

| Verify-don't-assume item | What was actually found |
|---|---|
| Installer URL + pinning syntax | `https://claude.ai/install.sh` takes the version as a **positional** arg: `install.sh [stable\|latest\|VERSION]`. It downloads the latest binary, sha256-verifies it against `manifest.json`, then runs `<binary> install <TARGET>`. Needs `curl` or `wget` (added `curl`); `jq` optional. Refuses to run under `sudo`, but plain root in a container is fine. Pinned to **2.1.237**. |
| Login subcommand | `claude auth login` / `auth logout` / `auth status` exist as a subcommand group; `claude setup-token` exists for long-lived tokens. Docs use `auth login`, not the `/login` slash command. |
| Credential filename | `.credentials.json`, directly in the config dir (confirmed against the logged-in host install). |
| `--dangerouslySkipPermissions` | **Rejected.** `claude -p hi --dangerouslySkipPermissions` → `error: unknown option`. The kebab-case `--dangerously-skip-permissions` works. Fixed at all **four** call sites via one exported constant. |
| Install layout | Binary: `~/.local/share/claude/versions/<version>` (334 MB), symlinked from `~/.local/bin/claude`. Config: `~/.claude/` — **separate trees**, which is why redirecting `CLAUDE_CONFIG_DIR` does not break binary resolution. Verified: `CLAUDE_CONFIG_DIR=/tmp/cfg claude --version` still works. |
| `HOME` under `USER bun` | Resolves to `/home/bun` from `/etc/passwd`; no explicit `ENV HOME` needed. |
| Image size delta | **538 MB → 993 MB.** The CLI is a single 334 MB bundled executable (nothing to prune — the installer already deletes its download); `curl` + apt metadata adds ~28 MB. This is ~5x the "~60 MB" first written into the docs; the doc now states the measured figure. |
| Subscription terms | Not verified — an operator/legal question about running a personal login headless in a container. Flagged, not decided. |

### Verification run

| Check | Result |
|---|---|
| `docker compose build` | Pass; `RUN claude --version` present as its own layer |
| `docker compose run --rm aibot claude --version` | `2.1.237 (Claude Code)` |
| Fresh-volume config dir | `drwx------ bun bun /app/data/claude` — entrypoint `chmod 700` works |
| Volume persistence | Marker file written in one container, read back in a new one; the named volume is by construction untouched by an image rebuild |
| Preflight inside the image | `{"available":true,"version":"2.1.237","configDir":"/app/data/claude","credentials":"missing"}` → `Claude CLI v2.1.237 installed but not logged in — run "claude auth login"` |
| Entrypoint banner | Fires on an unauthenticated volume, silent once `.credentials.json` exists |
| `sh -n docker-entrypoint.sh` (dash) | Pass |
| `bun run typecheck` | No errors in any changed file (pre-existing errors remain in `src/web/routes/`) |

**Not verified — needs a human:** the end-to-end `claude -p 'reply with OK'` round trip and
"login survives a rebuild" in the literal sense both require a real interactive login, which is the
operator's to perform. The volume-persistence *mechanism* was verified with a marker file instead, so
no real credentials were handled.

### Incident worth knowing about

`.gitattributes` pins `Dockerfile` and `docker-entrypoint.sh` to `eol=lf` precisely because a CRLF
shebang breaks the entrypoint. Python's `open(path, 'w')` on Windows writes CRLF, which silently
converted both files and made `dash` fail with `Syntax error: end of file unexpected`. Caught by
syntax-checking the entrypoint in a container before building. Any future scripted edit to those two
files must write bytes, not text.

## Follow-up found during execution (NOT implemented — out of the agreed plan)

**`claudeGenerate` treats an error response as a successful answer.** With the CLI installed but not
logged in, `claude -p ... --output-format json` exits **0** and returns
`{"is_error": true, ..., "result": "Not logged in · Please run /login"}`. `claude-cli.ts` reads
`parsed.result` without inspecting `is_error`, so that string is returned as the model's reply and
would reach a Telegram user verbatim. The boot preflight now makes the condition visible, but the
runtime path still mis-handles it. Fix would be a two-line `is_error` guard in `claudeGenerate` plus
a red test. Left out because it is outside the plan's agreed scope (CLAUDE.md TDD rule 5).
