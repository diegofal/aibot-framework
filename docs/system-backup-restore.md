# System Backup & Restore

Export a whole AIBot instance as a portable `.tar.gz` and stand up an equivalent instance
somewhere else — a new VPS, a fresh laptop, a container, a rollback target.

This is the instance-level counterpart to the per-agent export
(`GET /api/agents/:id/export`). Use the per-agent archive to move one agent between instances;
use a system bundle to reproduce the instance itself.

> **The bundle contains no secrets, but it is still sensitive.** Every soul file, every session
> transcript and every setting is in there. Treat it like a database dump.

---

## Quick start

```bash
# Back up everything to a file outside the repo
bun run export:system -- --out ../aibot-backup.tar.gz

# On the new machine: see what would happen
bun run import:system -- --in ../aibot-backup.tar.gz

# Then actually do it
bun run import:system -- --in ../aibot-backup.tar.gz --yes
```

The `--` before the flags is required: it stops `bun run` from eating them.

After importing, every agent is **disabled with an empty Telegram token**. Add tokens and enable
agents only once you are certain the old instance has stopped polling them (see
[Telegram 409](#the-409-problem) below).

---

## What is in a bundle

```
manifest.json          schema/framework version, source host, inventory, checksums
REQUIRED_ENV.txt       every environment variable you must define on the target
config/config.json     global settings, sanitized
config/bots.json       the agent roster: token "", enabled false
agents/<id>/           one nested per-agent bundle per agent
  manifest.json
  config.json
  soul/                soul directory, minus .versions/
  core_memory.jsonl    core memory entries
  productions/         included by default; omit with --no-productions
  conversations/       included by default; omit with --no-conversations
  karma/               included by default; omit with --no-karma
  sessions/            this agent's Telegram sessions (included by default; --no-sessions)
data/cron/             cron job definitions and run history
data/sessions/         conversation sessions and transcripts
data/tools/            dynamic tools
data/agent-proposals/  agent proposals
data/karma/            karma scores
data/contacts.json     phone-call contacts (credential fields blanked)
tenants/               tenant/billing state, minus per-agent soul dirs
```

### What is deliberately left out, and why

| Left out | Why |
|---|---|
| **All secret values** | Replaced with `${VAR}` placeholders. See [Secrets](#secrets). |
| **`data/memory.db`** (+ `-wal`, `-shm`) | The vector index is derived from soul files and is rebuilt on first run. Embeddings are model-specific, so restoring a stale index onto a target running a different embedding model silently degrades RAG — and the symptom looks like "the agent forgot things", not like a bad restore. |
| **`data/logs`, `data/screenshots`, `data/intel`** | Runtime output and caches. Large, regenerable, and a common place for a stray credential to land. |
| **Soul `.versions/`** | Soul file history. Large; the current files are what matter. |
| **`.env`** | By definition the file you recreate by hand on the target. |
| **`ollama.baseUrl`** | Becomes `${OLLAMA_BASE_URL}`. Pointing a restored instance at the old host's Ollama daemon is a silent misconfiguration. |
| **`improve.claudePath`, `browserTools.executablePath`** | Binary paths on the old machine. |
| **`web.host`, `web.port`, `mcp.expose.host`/`port`** | Bind addresses belong to the deployment, not to the backup. |
| **`soul.search.dbPath`, `logging.file`** | Point at artifacts that are not carried. |
| **Absolute paths anywhere** (`paths.*`, `soul.dir`, `productions.baseDir`, per-agent `soulDir`/`workDir`, …) | Dropped so the target's own values or defaults apply. Relative paths are kept and normalized to forward slashes. |
| **Per-agent `apiKey` and `billing`** | Tenant API keys and Stripe subscription state are not portable; re-issue them on the target. |

Everything dropped is listed by name (never by value) in `manifest.json` under
`security.dropped` and at the bottom of `REQUIRED_ENV.txt`.

---

## Secrets

This is the property the whole design is built around: **no credential value is ever written into
a bundle.**

How it is enforced, in layers:

1. **The raw file is read, not the loaded config.** `loadConfig()` expands `${VAR}` before
   validating, so the in-memory `Config` holds *resolved* secrets. The exporter reads
   `config/config.json` and `config/bots.json` straight off disk.
2. **Key-name sweep.** Any string under a key that reads as a credential (`token`, `apiKey`,
   `authToken`, `clientSecret`, `passwordHash`, …) is replaced with a `${VAR}` placeholder.
   Well-known fields get their conventional names (`OLLAMA_API_KEY`, `BRAVE_SEARCH_API_KEY`,
   `STRIPE_SECRET_KEY`, …); anything else gets a derived one (`AIBOT_<PATH>`).
3. **Value-shape sweep.** A credential sitting under an innocuous key is caught by its shape —
   Telegram tokens, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, `whsec_…`, Stripe keys, PEM private key
   blocks, long hex strings.
4. **Content scrub.** Every text file in the bundle — soul memories, session transcripts, cron
   payloads — is swept for embedded credentials and the matches are replaced with
   `[REDACTED:<kind>]`. This uses a deliberately narrow pattern set so it cannot mangle real
   content (a 40-character hex string in a memory file is far more likely to be a git SHA).
   Files that were scrubbed are listed in `manifest.json` under `security.scrubbedFiles`, and the
   CLI prints them: **if that list is non-empty, those credentials are live on the source
   instance and you should rotate them.**
5. **Telegram tokens are blanked outright**, not placeheld. An empty token plus `enabled: false`
   is the framework's own "not startable" state, and it keeps the bundle useless to anyone who
   gets hold of it.

`REQUIRED_ENV.txt` inside the bundle lists every variable the target needs, split into secrets
and host settings, with a copy-pasteable `.env` skeleton at the bottom. The importer also checks
the target's environment and reports which of them are still unset.

---

## CLI

The CLI is the disaster-recovery path. It never starts the framework and never validates the
config through Zod, so it still works when the app itself will not boot.

### Export

```bash
bun run export:system -- --out <file.tar.gz> [options]
```

| Option | Meaning |
|---|---|
| `--out <file>` | Destination archive (required) |
| `--sections <list>` | `config`, `agents`, `data`, `tenants`, or `all` (default: `all`) |
| `--agents <ids>` | Comma-separated agent ids (default: every agent) |
| `--productions` | No-op (productions are included by default) |
| `--conversations` | No-op (conversation logs are included by default) |
| `--karma` | No-op (karma data is included by default) |
| `--no-productions` | Omit each agent's productions directory |
| `--no-conversations` | Omit each agent's conversation logs |
| `--no-karma` | Omit each agent's karma data |
| `--no-sessions` | Omit per-agent Telegram sessions from `agents/<id>/` (the `data` section still carries the shared session store) |
| `--config <path>` | Path to `config.json` (default: `<root>/config/config.json`) |
| `--root <dir>` | Instance root (default: current directory) |
| `--force` | Overwrite `--out` if it exists |
| `--json` | Print the manifest as JSON instead of a summary |

```bash
# Everything (productions, conversations, karma, and per-agent sessions included)
bun run export:system -- --out ../full-backup.tar.gz

# Just the agents, to seed a fresh install (still includes per-agent sessions)
bun run export:system -- --out ../agents.tar.gz --sections agents

# Two specific agents, without productions
bun run export:system -- --out ../coach.tar.gz --sections agents --agents coach,soporte --no-productions

# Export an instance that lives somewhere else
bun run export:system -- --out ../b.tar.gz --root /srv/aibot
```

### Import

```bash
bun run import:system -- --in <file.tar.gz> [options]
```

| Option | Meaning |
|---|---|
| `--in <file>` | Bundle to restore (required) |
| `--sections <list>` | Subset to restore (default: whatever the bundle contains) |
| `--agents <ids>` | Restore only these agents |
| `--overwrite` | Replace items that already exist on this instance |
| `--dry-run` | Show the plan and exit |
| `--yes` | Actually write. **Without it the import stops after printing the plan.** |
| `--config`, `--root` | As above |
| `--force` | Skip the "instance appears to be running" check |
| `--json` | Print the result as JSON |

```bash
# Full restore onto a fresh machine
bun run import:system -- --in ../full-backup.tar.gz --yes

# Move agents into an existing install without touching its settings
bun run import:system -- --in ../agents.tar.gz --sections agents --yes

# Replace one agent from a backup
bun run import:system -- --in ../full-backup.tar.gz --sections agents --agents coach --overwrite --yes
```

---

## HTTP API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/system/export` | Downloads the bundle. Query: `sections`, `agents`, `productions`, `conversations`, `karma`, `sessions`. Extras default on; pass `false` to omit. |
| `GET` | `/api/system/export/manifest` | Returns the manifest as JSON without the payload. |
| `POST` | `/api/system/import` | `multipart/form-data` (field `file`) or a raw `application/gzip` body. Query: `sections`, `agents`, `overwrite`, `dryRun`. |

```bash
curl -o backup.tar.gz 'http://127.0.0.1:3000/api/system/export?sections=all'

curl 'http://127.0.0.1:3000/api/system/export/manifest' | jq '.inventory'

curl -X POST 'http://127.0.0.1:3000/api/system/import?dryRun=true' \
  -F file=@backup.tar.gz

curl -X POST 'http://127.0.0.1:3000/api/system/import?sections=agents&overwrite=true' \
  -F file=@backup.tar.gz
```

Status codes: `409` when the restore would replace something and `overwrite` was not set, `422`
when the bundle's schema version or kind is not readable by this build, `500` for everything else
(including "stop all running agents first").

There is also a **System Backup & Restore** card at the bottom of the dashboard's Settings page
with the same options, a dry-run preview, and a download button.

### Security

**These routes must not be reachable from a public network.** In single-tenant mode the dashboard
and `/api/*` have no authentication at all, and `/api/system/*` mounts unconditionally alongside
everything else. `GET /api/system/export` returns every soul, session transcript and setting in a
single unauthenticated request — a far more valuable target than one agent's archive.

- Keep `web.host` at its default `127.0.0.1`, or put an authenticating reverse proxy in front.
- Optionally set `AIBOT_SYSTEM_EXPORT_REQUIRE_ADMIN_KEY=true`. When enabled, `/api/system/export`
  and `/api/system/import` require `ADMIN_API_KEY` as a `Bearer` token or an `X-Admin-Key`
  header (an authenticated admin session also passes). It fails closed with `503` if
  `ADMIN_API_KEY` is not configured. This is **opt-in on purpose**: making it automatic whenever
  `ADMIN_API_KEY` is set would silently break the local no-auth dashboard workflow for anyone who
  configured that key for `/api/admin/*`. The dashboard prompts for the key once and sends it as
  a header; it is never stored.

---

## Import safety

The importer is non-destructive by default and checks, in this order:

1. **Kind and version.** A per-agent archive fed to the system importer is rejected by name
   (`422`), not by a confusing downstream parse error, and vice versa.
2. **Checksums.** Every file is verified against `manifest.checksums` before anything is written.
   A mismatch or a missing file aborts the import.
3. **Nothing may be running.** The per-agent route refuses to overwrite a *running* agent; a
   system import touches the whole roster, so it refuses if *any* agent is running. The CLI
   additionally probes the configured web port and refuses if something answers.
4. **Collisions are planned before the first write.** If anything would be replaced and
   `overwrite` is not set, the import fails with the full list and the target is untouched — a
   half-merged data directory is much harder to diagnose than a refusal. A dry run reports the
   same list instead of failing.
5. **Agents land inert.** Every restored agent gets `token: ""` and `enabled: false`.

When the `config` section is restored over an existing `config/config.json`, the previous file is
copied to `config/config.json.bak-<timestamp>` first — it is the only remaining copy of the
machine-specific settings the bundle deliberately dropped.

---

## Restoring onto a new machine, end to end

1. Clone the repo and `bun install`.
2. Copy the bundle across and run the plan:
   ```bash
   bun run import:system -- --in ./aibot-backup.tar.gz
   ```
3. Read the "required environment variables" list it prints, then extract `REQUIRED_ENV.txt` for
   the details:
   ```bash
   tar -xzOf aibot-backup.tar.gz REQUIRED_ENV.txt
   ```
   (or open the bundle with any archive tool — it is a plain `.tar.gz`).
4. Create `.env` with those variables. `OLLAMA_BASE_URL` is a host setting, not a secret: point it
   at this machine's Ollama daemon or at `https://ollama.com` with `OLLAMA_API_KEY`.
5. Apply:
   ```bash
   bun run import:system -- --in ./aibot-backup.tar.gz --yes
   ```
6. Start the framework. The soul search index rebuilds itself from the restored soul files on
   first run.
7. Add Telegram tokens and enable agents one at a time — see below.

### The 409 problem

Telegram allows exactly one `getUpdates` consumer per bot token. If the old instance is still
polling and the new one starts, both get `409 Conflict` and neither works reliably. Because
boot-time auto-start (`startup.autoStartBots`) is on by default, an imported roster with
`enabled: true` and real tokens would do exactly that on the first restart. That is why every
imported agent lands disabled with a blank token, and why you should stop the old instance before
enabling the new one.

---

## Portability notes

- **Windows to Linux and back.** Archive paths are always POSIX: backslashes are converted, drive
  letters stripped, and directory names containing spaces (`config/soul/Improve my life`)
  survive verbatim.
- **No `tar` binary required.** Archiving is pure JavaScript (`src/system/tar-archive.ts`) and
  runs entirely in memory, so there is no temp-directory staging and nothing to install. Output is
  POSIX ustar with PAX headers for long paths, so GNU tar and bsdtar both read it, and archives
  produced by system `tar` can be imported.
- **Traversal is rejected** on both pack and extract: an entry containing `..`, a leading `/` or a
  drive letter aborts the operation.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Target already has N item(s) that this import would replace` | Expected on a populated instance. Re-run with `--overwrite` (CLI) or `overwrite=true` (HTTP). |
| `Stop all running agents before a system import` | Stop the agents from the dashboard, or stop the process. |
| `An AIBot instance appears to be running` | The CLI got a response on the configured web port. Stop it, or pass `--force`. |
| `Corrupt bundle: checksum mismatch for "..."` | The archive was modified or truncated in transit. Re-copy it. |
| `Bundle schema version N is not supported by this build` | The bundle came from a newer framework. Upgrade this instance, or re-export from the source with a matching build. |
| Agent has no memories after restore | Expected until first run: the vector index is not shipped and is rebuilt from soul files. Check that `agents/<id>/soul/` was in the bundle. |
| A feature errors at runtime with an empty credential | A `${VAR}` from `REQUIRED_ENV.txt` is not set. Undefined variables expand to an empty string rather than failing at boot. |
