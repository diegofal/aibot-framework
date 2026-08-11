# Cloud Deployment Runbook

Operator guide for moving AIBot Framework off a local machine onto a small
always-on Linux host, using Docker Compose.

For non-containerised deployment (systemd, PM2) see
[deployment.md](./deployment.md). This document supersedes the Docker section
of that guide.

---

## 1. What you are deploying, and what constrains it

Read this section before sizing a server. The architecture rules out several
otherwise-obvious hosting choices.

| Constraint | Consequence |
|---|---|
| Telegram is consumed via a **long-polling `getUpdates` loop** (`src/bot/telegram-poller.ts`). There is no webhook mode. | Serverless and scale-to-zero platforms are unusable. You need a plain always-on VM or container host. |
| Telegram permits **one active `getUpdates` consumer per bot token**. | Never run two instances against the same token. The second one gets HTTP 409 Conflict and both flap, dropping messages. `deploy.replicas` is pinned to 1. |
| **All state is flat files.** No external database. | Persistence is entirely a matter of mounting the right volumes. Lose them and you lose every agent's identity and memory. |
| The primary model is an Ollama **`:cloud`** model, i.e. inference happens on Ollama's hosted GPUs. | **No GPU required**, and as of the direct-auth change a local daemon is optional too — see §1.1. |
| In single-tenant mode there is **no authentication** on the dashboard or on any `/api/*` route. | Never publish the web port on a public interface. See §7. |

### 1.1 Two topologies — pick one before sizing the host

`ollama.apiKey` lets the framework send `Authorization: Bearer <key>` on every
Ollama call, so `ollama.baseUrl` can address Ollama Cloud directly. The daemon
sidecar, whose only job was proxying to those same hosted models, becomes
optional.

| | **A — Direct to Ollama Cloud** | **B — With the daemon sidecar** |
|---|---|---|
| Start with | `docker compose up -d --build` | `docker compose --profile local-ollama up -d --build` |
| `OLLAMA_BASE_URL` | `https://ollama.com` | `http://ollama:11434` |
| `OLLAMA_API_KEY` | **required** ([ollama.com/settings/keys](https://ollama.com/settings/keys)) | leave blank — no auth header is sent |
| Containers | 1 | 2 |
| Extra image weight | none | **~6.3 GB on disk** (`ollama/ollama:latest`, measured 2026-08-11) |
| `soul.search` (RAG) | **must be `false`** — see below | supported |
| Local (non-`:cloud`) models | not possible | supported |

**The embeddings limitation is the whole decision.** Ollama Cloud serves no
embedding models — `ollama.com/search?c=cloud&c=embedding` returns nothing —
so with topology A there is no backend for `/api/embed`. Concretely:

- Set `soul.search.enabled: false`. You lose semantic memory search and the
  RAG prefetch; keyword-driven soul files and Core Memory still work.
- If you leave it enabled, the framework logs a single explicit `error` at
  startup naming the conflict, and each `/api/embed` call then fails with
  `Ollama embed API error: … this is NOT an authentication problem …`. It will
  not fail silently, but it will not work.

> **`/api/embed` on Ollama Cloud answers `{"error": "unauthorized"}` even with
> a perfectly good key.** Measured 2026-08-11 with a key whose `/api/chat`
> calls return 200. The word is a lie: there is no embedding model behind that
> endpoint under any credential, and re-minting the key cannot help. Both the
> startup error and the runtime `embed()` error say so explicitly, because the
> raw response reliably sends people to debug the wrong thing.
- If you want RAG, use topology B. The embedding model (`nomic-embed-text`,
  ~275 MB) is small and CPU-fine; that is the only reason to keep the sidecar.

There is no hybrid switch today: `ollama.baseUrl` is a single endpoint used for
both chat and embeddings. Splitting them would need a separate embedding
base URL, which is not implemented.

### Server sizing

Sizing follows directly from the topology above.

| Topology | RAM | Disk |
|---|---|---|
| **A** — direct to cloud, `soul.search` off | 1 GB is genuinely viable; Bun + pino sit around 200–300 MB at idle | app image ~110 MB + volumes; ~10 GB is plenty |
| **B** — sidecar | 2 GB comfortable; Bun + the daemon + pino sit around 500–700 MB at idle | app image ~110 MB, `ollama/ollama` **~6.3 GB unpacked** (the compressed download is far smaller — size the *disk* on the unpacked figure), plus `nomic-embed-text` ~275 MB; 40 GB SSD |

Reserve room for logs (see §10) and for `data/memory.db` if you enable RAG.

---

## 2. Provisioning

Any Debian/Ubuntu VPS works. On a fresh host:

```bash
# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in

# Lock the firewall down to SSH only. Nothing else should be reachable.
sudo ufw allow 22/tcp
sudo ufw enable
```

Then clone the repository and change into it:

```bash
git clone <your-repo> aibot-framework
cd aibot-framework
```

---

## 3. Secrets

Secrets are injected as environment variables through `.env`, which is read by
Compose (`env_file`) and never enters the image (`.dockerignore`).

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

`config/config.json` interpolates `${VAR}` anywhere a string appears, so the
config file itself can stay secret-free. Prefer that over pasting literal
values:

```json
{ "webTools": { "search": { "apiKey": "${BRAVE_SEARCH_API_KEY}" } } }
```

Telegram tokens belong in `config/bots.json` (gitignored), and should
themselves be `${TELEGRAM_BOT_TOKEN}`-style references rather than literals.
So does `ollama.apiKey` — `config.example.json` ships it as
`"${OLLAMA_API_KEY}"`. The framework never logs the key: no call site puts it
in a log object, and `src/logger.ts` redacts `authorization`/`apiKey` paths as
a backstop.

> **Check this before you deploy.** If your existing `config/config.json`
> contains a `bots` array with literal Telegram tokens, those tokens are in
> your git history. Rotate them with @BotFather, move the bots to
> `config/bots.json`, and keep only `${VAR}` references in the file.

Generate the admin key:

```bash
openssl rand -hex 32   # paste into ADMIN_API_KEY in .env
```

`ADMIN_API_KEY` is **fail-closed**: with it unset, every `/api/admin/*`
request is rejected with 503. It does *not* protect ordinary `/api/*` routes.

---

## 4. First run

```bash
docker compose up -d --build
docker compose logs -f aibot
```

On first boot the entrypoint seeds the empty `config` volume from the shipped
examples (`config.json`, `bots.json`, `sources.yml`) and creates
`data/logs/`. It never overwrites an existing file, so it is safe on every
subsequent restart. Wait for `All systems operational`.

### 4.1 `enabled` is the switch: a fresh deployment is inert, a live one heals itself

One flag decides both halves of this, and it is `enabled` in
`config/bots.json`:

| `enabled` | On every process start (boot, reboot, redeploy, OOM restart) | A direct `POST /api/agents/:id/start` |
|---|---|---|
| `false` | Not started. Nothing touches the token. | **Refused** with `409` and `code: agent_disabled` |
| `true` | **Started automatically** | Started |

`src/index.ts` calls `autoStartEnabledBots()` (`src/bot/auto-start.ts`) after
the web server is listening, and `BotManager.startBot()` refuses any bot whose
config says `enabled: false`. That refusal is the whole boundary: boot-time
start, the dashboard route, the multi-tenant path and the auto-restart timer all
funnel through that one method, so "disabled" is a promise the runtime keeps
rather than a filter in the dashboard's JavaScript.

**A fresh deployment is therefore still inert**, because
`config/bots.example.json` ships every bot with `"enabled": false` and that is
what a fresh config volume is seeded with. You can safely
`docker compose up -d --build` a new host while the old one is still serving
traffic: the container boots, probes the models, starts the dashboard, and sits
there. It will not touch Telegram. The entrypoint prints a banner saying so on
the boot that seeds `bots.json`, because the opposite confusion is just as
expensive — a healthy-looking container whose bot never answers.

**A deployment you have taken live comes back by itself.** After a host reboot,
an OOM kill, or `docker compose up -d --build`, `restart: unless-stopped`
restarts the container and the container restarts every enabled bot. No human,
no dashboard, no post-deploy script.

Two consequences to hold on to:

- **Stop is transient.** Stopping an agent from the dashboard does not change
  `enabled`, so the next restart brings it back. To keep an agent down across
  restarts, turn its **Enabled** toggle off. (The dashboard shows both columns
  precisely because they are different facts: `enabled` is intent, `running` is
  state.)
- **Going live is one deliberate click, and it persists.** For a disabled agent
  the dashboard shows **Enable & Start** rather than a plain Start, which calls
  `POST /api/agents/<id>/start?enable=true`: it sets `enabled: true`, writes
  `bots.json`, and starts the agent. That is what makes the click survive a
  reboot. Plain `Start` on a disabled agent is refused on purpose — silently
  starting something the config calls disabled is how a bot ends up running
  that nobody expects to be running.

#### Suppressing auto-start (the cutover lever)

Sometimes you want the container up and inspectable with **nothing** polling —
most importantly mid-cutover, while the old instance still owns the tokens.
Either of these does it, and both default to auto-start ON:

```bash
# .env — wins over the config file, and is the one you can reach without
# exec'ing into the container (config.json lives inside a Docker volume)
AIBOT_AUTOSTART_BOTS=false
```

```json
// config/config.json
{ "startup": { "autoStartBots": false } }
```

`AIBOT_AUTOSTART_BOTS` accepts `true/false`, `1/0`, `yes/no`, `on/off`
(case-insensitive). An unset or empty value defers to the config file; an
unparseable one logs a warning and defers to the config file rather than
guessing. When auto-start is off you get one `warn` at boot naming the source
of the decision, and the dashboard remains the way to go live.

Note that `enabled` also has two unrelated readers, unchanged by any of this:
startup model validation skips a disabled bot's `model` override, and
`SystemPromptBuilder` does not list disabled bots as collaboration peers.

Edit the live files inside the volume:

```bash
docker compose exec aibot sh -c 'vi /app/config/config.json'   # or edit and docker cp
docker compose restart aibot
```

At minimum you must set:

| Setting | Value |
|---|---|
| `web.enabled` | `true`. Not optional in practice for a *seeded* deployment: every seeded bot ships disabled, and the dashboard (or its API) is the only way to enable one. Once a bot is enabled it starts on every boot without the dashboard — but you still want the dashboard to see that it did. |
| `web.host` | `0.0.0.0` — this binds inside the container only; the host publish rule (`127.0.0.1:3000:3000`) is what keeps it private. |
| `logging.level` | `info` or `warn`. See §10. |

`ollama.baseUrl` and `ollama.apiKey` are no longer on that list, because
`config.example.json` now ships them as `"${OLLAMA_BASE_URL}"` and
`"${OLLAMA_API_KEY}"`. Substitution happens before schema validation, so `.env`
is genuinely what drives them.

> Two consequences worth knowing:
>
> 1. `OLLAMA_BASE_URL` is now **required**. Unset, it interpolates to an empty
>    string and startup fails with `ollama.baseUrl: Invalid url`. That is
>    deliberate — the previous seeded default (`http://127.0.0.1:11434`) was
>    silently wrong inside a container and every LLM call failed until someone
>    hand-edited the file.
> 2. Seeding only happens on a **fresh** config volume. An existing
>    `config/config.json` is never overwritten by the entrypoint, so an upgraded
>    deployment keeps whatever literal `baseUrl` it already had. Edit it by hand
>    if you want the env-driven form.

> **`OLLAMA_BASE_URL` must never be `127.0.0.1` in a container.** Inside the
> container, loopback is the container itself, so the sidecar is never reached
> and every LLM call fails while the daemon sits there healthy. The compose
> default (`${OLLAMA_BASE_URL:-http://ollama:11434}`) does **not** protect you:
> a value present in `.env` is not absent, `env_file` injects it, and a value
> in `.env` is what compose interpolates. `.env.example` therefore now ships
> `http://ollama:11434` — change it to `http://127.0.0.1:11434` only when
> running the framework directly on the host with `bun run src/index.ts`.
>
> Verify after any change:
>
> ```bash
> docker compose exec aibot sh -c 'echo $OLLAMA_BASE_URL'
> ```

---

## 5. Authenticating to Ollama Cloud

Which half of this section applies depends on the topology you chose in §1.1.

### Topology A — direct, with an API key (no sidecar)

Mint a key at <https://ollama.com/settings/keys>, then in `.env`:

```bash
OLLAMA_BASE_URL=https://ollama.com
OLLAMA_API_KEY=<the key>
```

`config.example.json` already references both. Every outbound Ollama call —
`/api/chat`, `/api/generate`, `/api/embed`, `/api/tags`, the streaming
variants, the tool-calling path and the startup probe — sends
`Authorization: Bearer <key>`. With the variable blank, no `Authorization`
header is emitted at all, so a local daemon behaves exactly as it did before
this option existed.

Remember: no embedding models. `soul.search.enabled` must be `false`.

### Topology B — daemon sidecar with a signed-in session

**The app's `ollama.apiKey` does nothing in this topology.** This was measured
directly (ollama 0.32.6, 2026-08-11) because the runbook previously implied it
either way:

| What was tried against a fresh `ollama/ollama` sidecar | `/api/generate` on a `:cloud` tag |
|---|---|
| App sends `Authorization: Bearer <valid cloud key>` | **401 Unauthorized** |
| No `Authorization` header at all | 401 Unauthorized (identical) |
| `OLLAMA_API_KEY=<valid key>` set on the **daemon container's** environment | **401 Unauthorized** |
| `~/.ollama/id_ed25519{,.pub}` copied in from a signed-in machine | **200 OK** |

The daemon does not accept, and does not forward, a bearer token. It
authenticates to Ollama Cloud with an **ed25519 keypair** in `~/.ollama` that
is registered to an ollama.com account by `ollama signin`. That is the only
mechanism.

So there are exactly two ways to provision the sidecar:

**1. Interactive sign-in (requires a browser).**

```bash
docker compose --profile local-ollama up -d
docker compose exec ollama ollama signin      # prints a URL; approve the device
docker compose exec ollama ollama ls
```

`ollama signin` has **no non-interactive flags** — `ollama signin --help`
lists only `-h`. There is no `--key`, no token argument, and no environment
variable that substitutes for it. On a headless VPS you must open the printed
URL from your own machine and approve the device there; the command blocks
until you do.

**2. Copy the keypair from an already-signed-in machine (fully non-interactive).**

This is the route for automated provisioning, and it is verified working:

```bash
docker compose --profile local-ollama up -d ollama
docker compose cp ~/.ollama/id_ed25519     ollama:/root/.ollama/id_ed25519
docker compose cp ~/.ollama/id_ed25519.pub ollama:/root/.ollama/id_ed25519.pub
docker compose restart ollama
```

Credentials live in the `ollama_data` volume (`/root/.ollama`), so they survive
restarts and rebuilds of the bot image. Treat `id_ed25519` as a secret: it is
your ollama.com identity, and copying it into a volume creates a second copy of
it. On Windows use `$USERPROFILE/.ollama/...` and remember
`export MSYS_NO_PATHCONV=1` in Git Bash, or the container-side path is rewritten
into a Windows path and the copy fails.

Leave `OLLAMA_API_KEY` blank in this topology. Setting it is harmless — the
daemon ignores it — but it makes the startup validator report
`apiKeyConfigured: true` on a failure that has nothing to do with the key.

> **The symptom of an unsigned daemon.** Every `:cloud` model returns
> `401 Unauthorized` from `http://ollama:11434`, and startup validation logs:
>
> ```
> ERROR  OLLAMA AUTHENTICATION FAILED — the local Ollama daemon refused the
>        request (HTTP 401/403). For ":cloud" model tags this means the DAEMON
>        is not signed in to Ollama Cloud …
> ```
>
> Embeddings are unaffected: `nomic-embed-text` is a genuinely local model, so
> `soul.search` works on a sidecar that was never signed in.

### Models must be cloud-capable

This is the failure mode that bites silently. `config.example.json` ships the
following trio, each of which was confirmed to answer a live inference call on
2026-08-11:

```json
"models": {
  "primary": "kimi-k2.6:cloud",
  "fallbacks": ["gpt-oss:120b-cloud", "nemotron-3-super:cloud"]
}
```

A fallback like `mistral` (7B) or `qwen2.5-coder:32b` (~20 GB VRAM) is a
genuine *local* model. On a CPU-only VM the primary will work and the failover
path will fail — and it only fails when the primary is already having a bad
day, which is exactly when you are not watching. Every entry in `fallbacks`
must be a cloud model.

#### Fallback order: fastest first, with compaction capped to the chain minimum

**This rule was inverted on 2026-08-11. Read the reasoning before changing it
back.**

The previous rule was "order fallbacks from the largest context window down",
which is why `nemotron-3-super:cloud` (256K) sat ahead of `gpt-oss:120b-cloud`
(128K). The logic was sound: a prompt sized for the roomier model overflows the
smaller one, and `classifyFailoverReason()` maps a context-length error to
`shouldAbortChain` (`src/bot/model-failover/failover-error.ts`), so an
undersized fallback does not merely fail — it *terminates the chain* and skips
every remaining candidate.

It optimised the wrong variable. Measured on the daemon, single-token response
via `/api/chat`, 2026-08-11:

| Model | Time to a single token |
|---|---|
| `nemotron-3-super:cloud` | **35,626 ms** — a reasoning model; it burns thinking tokens before emitting anything |
| `gpt-oss:120b-cloud` | 836 ms |
| `kimi-k2.6:cloud` (primary) | 3,794 ms |

With the reasoning model first, **every primary failure stalled the user for
about 35 seconds** before a reply appeared. That is a permanent latency tax
paid to avoid a context-overflow case that a prompt budget can rule out
outright.

So the prompt budget rules it out. `resolveContextWindow()`
(`src/bot/context-compaction.ts`) now clamps the compaction budget to the
**smallest context window across `ollama.models` (primary + every fallback)**,
using the per-model table in
`src/bot/model-failover/model-context-windows.ts`. With the shipped chain the
budget is bounded at 128K, `gpt-oss:120b-cloud` can accept anything the primary
was given, no candidate can overflow, and the chain is free to be ordered by
speed. Hence `["gpt-oss:120b-cloud", "nemotron-3-super:cloud"]`.

**What you must do when you add a model to the chain:**

- If it is in the built-in table, nothing — the budget tightens automatically.
- If it is *not* in the table, the framework will not guess. It contributes no
  clamp, and its tag is reported in the `chainUnknownModels` field of the
  `Context compaction triggered` log line. Add it to
  `conversation.compaction.modelContextWindows` so the clamp is real:

  ```json
  "conversation": {
    "compaction": {
      "modelContextWindows": { "some-new-model:cloud": 64000 }
    }
  }
  ```

- Order by latency, slowest last. Context size no longer constrains ordering.

The table is hand-maintained third-party data and will rot as Ollama moves
tags; `modelContextWindows` exists so you can correct it without a code change.

`conversation.compaction.contextWindows.ollamaTokens` remains an upper bound
you control (default 8192). The clamp only ever lowers it, never raises it.

#### Ollama retires cloud tags on a schedule you are not watching

Cloud tags are withdrawn periodically and the notice arrives by email. A
retired tag keeps appearing in `ollama ls` and in `/api/tags` after the hosted
backend stops serving it — the local daemon is only a proxy and does not know.
The only reliable test is a real inference call:

```bash
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"kimi-k2.6:cloud","prompt":"ping","stream":false,"options":{"num_predict":1}}'
```

A retired tag answers `410 Gone` with the retirement date. The framework now
performs exactly this probe for every configured model at startup — see
`ollama.startupValidation` below.

#### Startup model validation

At boot the framework probes each configured model concurrently (primary,
every fallback, `soul.healthCheck.model` when it runs on Ollama, and any
per-bot `model` override) and logs the result. It is enabled by default and
non-fatal by default.

```json
"ollama": {
  "startupValidation": { "enabled": true, "timeoutMs": 20000, "strict": false }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set to `false` to skip the probes entirely. |
| `timeoutMs` | `20000` | Per-model budget. Probes run concurrently, so this bounds the worst-case added startup time rather than summing across models. |
| `strict` | `false` | When `true`, a model that is *gone* aborts startup. Transient failures never do. |
| `modelTimeoutMs` | `{}` | Per-tag overrides of `timeoutMs`. See the note on `nemotron-3-super:cloud` below. |

Outcomes are graded, because "did not answer" and "no longer exists" are
different problems:

- **`410 Gone` / `404 Not Found` / a "retired" message** → logged at `error` as
  `Configured LLM model is GONE`. Trips `strict`.
- **`401` / `403`** → logged at `error` as `OLLAMA AUTHENTICATION FAILED`, with
  the wording chosen by topology (see below). Trips `strict`.
- **`503 overloaded`, `429`, a timeout, a network error** → logged at `warn` as
  `Could not verify LLM model`. The backend was busy; the configuration is
  probably fine.
- **Daemon entirely unreachable** → one `error` naming the `baseUrl`, and the
  per-model probes are skipped, so you get one clear fact rather than N copies
  of the same connection error.

##### Why the liveness check is not `/api/tags`

`https://ollama.com/api/tags` returns **`200` with the full cloud catalogue to
a request carrying no `Authorization` header at all** (measured 2026-08-11).
A validator that trusted that status would pronounce the backend healthy with
a missing, wrong or expired key, and the operator would find out on the first
real message. So `/api/tags` is used for **reachability only**; the per-model
`/api/generate` probe, which genuinely requires credentials, is the
authoritative signal. A `401`/`403` from it produces one loud, specific error
rather than three "could not verify, probably busy" warnings, and its wording
depends on where `baseUrl` points:

| `ollama.baseUrl` | `ollama.apiKey` | What the error tells you |
|---|---|---|
| `https://ollama.com` | unset | Set `OLLAMA_API_KEY`; note that `/api/tags` answering 200 proves nothing |
| `https://ollama.com` | set | The key was rejected — mint a new one |
| `http://ollama:11434` | either | The **daemon** is not signed in; run `ollama signin`. `ollama.apiKey` cannot help, because the daemon does not forward it (§5, topology B) |

##### The expected, benign `nemotron-3-super:cloud` warning

With the shipped chain you will see this on most boots:

```
WARN  Could not verify LLM model (busy, cold or slow) — treating as transient
      model="nemotron-3-super:cloud"
```

It is not a misconfiguration. `nemotron-3-super:cloud` is a reasoning model
and was measured at **35.6 s** to produce a single token — well past the 20 s
default budget. The model works; the probe just gives up first.

Do not simply ignore it. A warning that is always present is a warning nobody
reads, and this is the one channel that surfaces a silently retired primary.
Two acceptable responses:

1. **Give that one model more room** (leaves the global budget alone):

   ```json
   "ollama": {
     "startupValidation": {
       "timeoutMs": 20000,
       "modelTimeoutMs": { "nemotron-3-super:cloud": 60000 }
     }
   }
   ```

   Probes run concurrently, so the largest value here — not the sum — is the
   worst-case added boot time. 60 s means up to 60 s of boot delay when that
   model is cold. This is why the override is **not** shipped enabled by
   default: a permanent boot cost to silence an intermittent warning is a bad
   trade for most deployments.

2. **Accept the warning and remember what it tells you** — that a failover to
   this model is a ~36 s wait for the user. That is precisely why it sits last
   in the fallback chain.

Raising the global `timeoutMs` also works but slows every boot in the worst
case, not just this model's.

Confirm the exact tags against `docker compose exec ollama ollama ls` and
Ollama's cloud catalogue before trusting them; tag names move.

Enabling `soul.search` requires the local embedding model — and therefore
requires topology B, because Ollama Cloud hosts none (see §1.1):

```bash
docker compose --profile local-ollama exec ollama ollama pull nomic-embed-text
```

---

## 6. Cutover from your old machine

> ### The one rule
>
> **The old instance must be fully stopped, and confirmed stopped, before you
> start the bot on the new one.**
>
> Telegram allows exactly one active `getUpdates` consumer per bot token. With
> two, both get intermittent HTTP 409 Conflict, both keep running, and incoming
> messages are delivered to whichever one happened to be polling — so the
> failure looks like "the bot is flaky", not like a misconfiguration. There is
> no leader election, no lock, and nothing that detects the situation and
> stands down.

The two halves of a cutover are decoupled on purpose, and this is what makes it
safe: **booting the new container is not the same as going live.** A fresh
deployment comes up with every bot disabled and none running (§4.1), so the new
host can be built, imported into and inspected while the old one is still
serving traffic. **You** choose the moment of cutover, and it is a single
deliberate action: pressing **Enable & Start**.

```
1. Build and boot the NEW host                (docker compose up -d --build)
     → it is inert: bots seeded disabled, none started, nothing polling
2. Export agents from the OLD instance        (§8)
3. Import them into the NEW instance          (§8) — still nothing polling
4. Fully stop the OLD instance                (docker compose stop / down)
5. CONFIRM it is gone — see the check below. Do not skip this.
6. Only now: press "Enable & Start" on the NEW host's dashboard
7. Send a test message before decommissioning anything
```

**The one case where step 1 is not inert: an *existing* config volume.**
Auto-start reads `enabled` and does not care that the container is new, so
rebuilding or restarting a host whose volume already holds enabled agents starts
them immediately. If the old instance might still be alive at that moment, boot
with auto-start suppressed:

```bash
AIBOT_AUTOSTART_BOTS=false docker compose up -d --build   # or set it in .env
```

Then do steps 4 and 5, remove the variable, and `docker compose up -d` again.
Import (§8) is safe in this respect regardless: it forces `enabled: false` on the
imported config, so a freshly imported agent never auto-starts until you enable
it. Check `bots.json` before that first boot if you are unsure which case you are
in — this is the one way the change from "nothing starts at boot" can create a
double-poller that the old behaviour could not.

If you get it wrong, you will not be left guessing. The second consumer logs, at
`warn` from the third consecutive conflict onward and again at `error` when it
gives up:

```
WARN  getUpdates 409 — backing off. ANOTHER PROCESS IS ALREADY POLLING THIS BOT
      TOKEN (Telegram 409 Conflict). Telegram allows exactly one active
      getUpdates consumer per token, so this instance cannot win: find and stop
      the other one …
```

The first one or two 409s stay at `debug`: Telegram holds the previous
`getUpdates` session open for a moment after a normal restart, so escalating
those would make every clean restart look like an incident. Sustained conflict
then hits the auto-restart limiter (3 attempts in 5 minutes) and stops, rather
than flapping against the other instance forever.

Confirming step 5 properly matters more than it looks, because the old process
is often somewhere you are not looking — a detached container on the same host,
a `bun run src/index.ts` in a forgotten `tmux` session, or a laptop that went to
sleep rather than shutting down and will resume polling when it wakes.

```bash
# On the OLD host — both must come back empty
docker compose ps
pgrep -af 'bun run src/index.ts'
```

The authoritative check is from Telegram's side, and it needs no access to
either host. Ask the API who is polling; if a second consumer is alive, this
returns 409:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=0&offset=-1"
```

`{"ok":true,...}` means the token is yours alone. `409 Conflict` means someone
else is still on it — find them before starting the new bot. (Run this from a
shell where the token will not land in your history; it is a live credential.)

Keep the old machine's `config/`, `data/` and `productions/` directories
untouched until the new host has been running cleanly for a few days.

**After the cutover, a container restart brings the bot back on its own** (§4.1),
because `enabled: true` is now read at boot. If the new host reboots overnight,
the bot resumes polling by itself — which is the point, and also the reason the
old host must stay decommissioned rather than merely stopped: a host that boots
again will start its enabled bots too.

---

## 7. Reaching the dashboard safely

**Do not expose port 3000 publicly.** In single-tenant mode
(`multiTenant.enabled: false`) the auth middleware is never registered, so
every route is anonymous — including `GET /api/agents/:id/export`, which
streams a bot's entire soul, memory and configuration as a `.tar.gz`, and
`POST /api/agents/import`, which will happily write a new agent onto your
disk. A public bind is a data-exfiltration hole and a write primitive.

The compose file publishes the port to loopback only. Reach it through an SSH
tunnel from your laptop:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-host
```

Then open <http://127.0.0.1:3000> locally. Nothing is listening on the public
interface at any point.

If you later need genuine remote access, put a reverse proxy with
authentication in front of it, or enable `multiTenant` so the auth middleware
is actually mounted. Do not simply change the publish rule to `0.0.0.0`.

---

## 8. Migrating agents in

The framework has a first-class export/import path. Run both sides over the
SSH tunnel from §7.

Export from the old instance (tunnel to the old machine on port 3000):

```bash
curl -fL -o mybot.tar.gz \
  'http://127.0.0.1:3000/api/agents/mybot/export?productions=true&conversations=true&karma=true'
```

The archive contains the agent's soul directory, config entry, core memory and
whichever optional sections you requested. Omit the query flags for a smaller
archive containing only identity and configuration.

Import into the new instance (tunnel to the new host):

```bash
curl -f -X POST \
  -F 'file=@mybot.tar.gz' \
  'http://127.0.0.1:3000/api/agents/import'
```

Useful query parameters on import: `newBotId`, `newBotName`, and
`overwrite=true`. Overwriting is refused while the target agent is running —
stop it from the dashboard first.

**Import always writes `enabled: false`**, whatever the archive said, and clears
the token unless it is overwriting an agent that already had one. So an import
never puts a second consumer on a token by itself, and going live after an import
is still the deliberate **Enable & Start** click. The flip side: re-importing over
an enabled agent *disables* it, so re-enable it afterwards or it will not come
back on the next restart.

Both operations shell out to the `tar` binary, which is installed in the
image. (This is the path that is fragile on Windows and reliable on Linux.)

For a bulk move you can instead copy the volumes wholesale — see §9 in
reverse — but export/import is safer because it round-trips through
validation.

---

## 9. Backups

Everything worth keeping is in three named volumes. Nothing lives in the
image, and nothing lives in the database, because there is no database.

| Volume | Contents |
|---|---|
| `aibot_config` | `config.json`, `bots.json` (**tokens**), `config/soul/` — every agent's identity, motivations, goals and memory |
| `aibot_data` | sessions, cron jobs, karma, dynamic tools, agent proposals, conversations, tenants, logs, `memory.db` |
| `aibot_productions` | agent-authored artefacts |

`aibot_config` is the one you cannot rebuild. Back it up somewhere off-host.

```bash
#!/bin/bash
# /usr/local/bin/aibot-backup.sh
set -euo pipefail
DEST=/var/backups/aibot
DATE=$(date +%F)
mkdir -p "$DEST"

# Quiescing first keeps the JSONL stores and memory.db internally consistent.
docker compose -f /path/to/aibot-framework/docker-compose.yml stop aibot

for v in aibot_config aibot_data aibot_productions; do
  docker run --rm \
    -v "${v}:/src:ro" -v "${DEST}:/dst" \
    busybox tar -czf "/dst/${v}-${DATE}.tar.gz" -C /src .
done

docker compose -f /path/to/aibot-framework/docker-compose.yml start aibot
find "$DEST" -name '*.tar.gz' -mtime +30 -delete
```

```bash
sudo chmod +x /usr/local/bin/aibot-backup.sh
# 04:00 daily
echo '0 4 * * * root /usr/local/bin/aibot-backup.sh' | sudo tee /etc/cron.d/aibot-backup
```

Restore is the same operation inverted: stop the stack, extract the tarball
into the volume with a `busybox tar -xzf` run, start it again.

Test a restore at least once. An untested backup is a hypothesis.

---

## 10. Log rotation

**This will fill a small disk if you ignore it.** `logging.file` defaults to
`./data/logs/aibot.log` and pino appends to it with no rotation whatsoever.
The framework's default log level is verbose, and the agent loop logs on every
cycle.

Two independent streams, needing two independent fixes:

**Container stdout** — already handled. `docker-compose.yml` sets the
`json-file` driver to `max-size: 10m, max-file: 3`, capping it at 30 MB.

**`data/logs/aibot.log`** — not handled by Docker, because the app writes it
directly to the volume. Options, in order of preference:

1. **Set `logging.level` to `info` or `warn`** in `config/config.json`. The
   single highest-leverage change; `debug` is roughly an order of magnitude
   more output.

2. **Rotate it with host logrotate.** Find the volume's real path and point
   logrotate at it:

   ```bash
   docker volume inspect aibot_data --format '{{.Mountpoint}}'
   # e.g. /var/lib/docker/volumes/aibot_data/_data
   ```

   ```
   # /etc/logrotate.d/aibot
   /var/lib/docker/volumes/aibot_data/_data/logs/aibot.log {
       daily
       rotate 7
       maxsize 50M
       compress
       delaycompress
       missingok
       notifempty
       # copytruncate is REQUIRED, not a preference — see the note below.
       copytruncate
   }
   ```

   `copytruncate` is mandatory here. The dashboard tails this file with
   `fs.watch()` on the path plus a byte offset (`src/web/server.ts`). Renaming
   the file, which is logrotate's default `create` behaviour, leaves the
   watcher bound to the old inode and the live log view silently stops
   updating until the process restarts. `copytruncate` preserves the inode,
   and the tailer already handles `newSize <= offset` by resetting the offset
   to zero, so live streaming survives rotation cleanly.

3. **Not recommended: drop `logging.file` entirely** so pino only writes to
   stdout and Docker's rotation covers everything. This is the idiomatic
   container pattern, but it breaks the dashboard's Logs page, which reads
   that file. Only do it if you monitor via `docker compose logs`.

A pino-native rolling transport (`pino-roll`) would be the properly
self-contained fix and would remove the host dependency altogether. It needs a
new dependency and a change to the `transport.targets` array in
`src/logger.ts`. That is a code change rather than a deployment change, so it
is deliberately out of scope here — logrotate is the correct least-invasive
option today.

---

## 11. Optional components

| Component | Status in the default image | To enable |
|---|---|---|
| **Playwright / Chromium** (`browserTools`) | Not installed. The npm package is present; the ~400 MB browser binary is not. | Uncomment the marked block in the `Dockerfile`, rebuild, set `browserTools.enabled: true`. |
| **`claude` CLI** (`llmBackend: "claude-cli"`) | Not installed. | Soul quality review, memory consolidation and the improve tool degrade without it — mostly gracefully. Add an install step to the Dockerfile and mount its credentials if you need it. |
| **RAG / semantic search** (`soul.search`) | Available; `bun:sqlite` is built into Bun. **Requires the Ollama sidecar** — Ollama Cloud hosts no embedding models. | Start the sidecar (`--profile local-ollama`), point `ollama.baseUrl` at it, set `soul.search.enabled: true`, and pull `nomic-embed-text`. Adds `data/memory.db` to the data volume. |
| **Ollama daemon sidecar** | Behind the `local-ollama` compose profile; **not started by default**. | `docker compose --profile local-ollama up -d`. Needed only for embeddings or genuinely local models — see §1.1. |

---

## 12. Operating

```bash
docker compose ps                      # status
docker compose logs -f aibot           # follow
docker compose restart aibot           # restart after a config edit
docker compose down                    # stop (volumes are preserved)
docker compose up -d --build           # deploy a new version
```

**Every one of the commands that restarts the process restarts your enabled
bots.** Restart, rebuild and host reboot all come back up polling (§4.1), so a
config edit applied with `docker compose restart` completes on its own — and,
conversely, `docker compose restart` is not a way to take a bot offline. Turn
**Enabled** off for that, or set `AIBOT_AUTOSTART_BOTS=false` for the whole
instance.

`docker compose down -v` **deletes the volumes**. That is every agent's soul
and memory. There is no undo.

### Updating

```bash
git pull
docker compose up -d --build
```

The config volume is not touched by a rebuild, so your live settings survive.
The flip side: changes to `config.example.json` or `sources.yml` in a new
version will **not** propagate to an existing volume, since the entrypoint
only seeds files that are absent. Diff them by hand after an upgrade that
changes the config schema.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Bot silent, logs show 409 Conflict | Another instance is polling the same token, and the log line says so in as many words. Find and stop it — most often the old machine, or a new container that auto-started an enabled agent before the old one was stopped. See §6. |
| Bot silent after a fresh install, no errors in the log | Working as designed. A seeded deployment ships every bot disabled, and auto-start skips disabled agents (§4.1). Press **Enable & Start**. |
| Bot silent after a container restart, deploy or host reboot | Not expected any more. Check, in order: is the agent `enabled` in `bots.json`? Is `AIBOT_AUTOSTART_BOTS=false` left over in `.env` (the boot log warns when auto-start is off)? Did the start fail — look for `Auto-start failed for agent` with the reason attached. |
| `Auto-start started NO agents — every enabled agent failed` | Every enabled agent threw on start. The per-agent `Auto-start failed for agent "<id>"` lines above carry the cause; 409 means a second consumer, 401 means a bad token. |
| `POST /api/agents/:id/start` returns 409 `agent_disabled` | Deliberate: `enabled: false` is enforced at runtime, not just in the dashboard. Enable the agent first, or call it with `?enable=true` to enable and start in one step. |
| An agent you stopped came back after a restart | Stop is transient and does not write `enabled`. Turn the **Enabled** toggle off to keep an agent down across restarts (§4.1). |
| Dashboard shows an agent as disabled but it is running | Only possible if it was disabled *while* running — the toggle does not stop a running agent. It will not come back after the next restart. `running` is the current state; `enabled` is what happens at boot. |
| `Environment variable X is not defined, using empty string` | A `${X}` in `config.json` with no matching entry in `.env`. |
| `ollama.baseUrl: Invalid url` and the process exits | `OLLAMA_BASE_URL` is unset or blank in `.env`. It is required now that `config.example.json` reads `"${OLLAMA_BASE_URL}"`. See §4. |
| Every LLM call returns 401 / `Unauthorized`, `baseUrl` is `https://ollama.com` | `OLLAMA_API_KEY` is unset or wrong. See §5. |
| Every `:cloud` call returns 401 / `Unauthorized`, `baseUrl` is `http://ollama:11434` | The **sidecar daemon** is not signed in to Ollama Cloud. `OLLAMA_API_KEY` is irrelevant here — the daemon never forwards it. See §5 topology B. |
| `OLLAMA AUTHENTICATION FAILED` at startup | Startup validation proved the credentials are rejected. The message names which of the three causes applies. See §5. |
| Every LLM call fails but `docker compose exec ollama ollama ls` works | `OLLAMA_BASE_URL` is `127.0.0.1` inside the container, which is the container itself, not the sidecar. See §4. |
| `ENOENT … scandir './config/soul'` and the container restarts forever | Fixed: `discoverFiles` now treats a missing soul directory as empty and the entrypoint creates `config/soul/`. If you see it, your image predates that fix — rebuild. |
| LLM calls fail only under load or during an outage | A fallback model is a local model, or a chain member's context window is unknown to the compaction clamp. See §5. |
| First reply after a primary outage takes ~35 s | The chain fell through to `nemotron-3-super:cloud`, a reasoning model. Expected; it is deliberately last. See §5. |
| `Could not verify LLM model … nemotron-3-super:cloud` on every boot | Expected and benign. See §5. |
| `Configured LLM model is GONE` at startup | The tag was retired or renamed. Replace it in `ollama.models` and restart. See §5. |
| `Ollama embed API error … NOT an authentication problem` | `soul.search` is on while pointing at Ollama Cloud. The underlying `401 unauthorized` is not about your key. Disable search, or switch to the sidecar topology. See §1.1. |
| `Ollama daemon is unreachable` at startup | With the sidecar topology: it is not running (did you pass `--profile local-ollama`?), or `ollama.baseUrl` does not point at it (`http://ollama:11434` under Compose). |
| Dashboard unreachable through the tunnel | `web.enabled` is false, or `web.host` is `127.0.0.1` inside the container so the publish rule cannot reach it. Set it to `0.0.0.0`. |
| Disk full | `data/logs/aibot.log`. See §10. |
