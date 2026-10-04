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
