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
