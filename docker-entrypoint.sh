#!/bin/sh
# ---------------------------------------------------------------------------
# Seeds the persistent volumes on first boot, then hands off to the app.
#
# Everything here is idempotent and never overwrites an existing file: the
# config volume holds live, runtime-mutable operator state (config.json,
# bots.json and config/soul/ are all rewritten by the dashboard at runtime).
# ---------------------------------------------------------------------------
set -eu

CONFIG_DIR="${AIBOT_CONFIG_DIR:-/app/config}"
DEFAULTS_DIR=/app/config-defaults

# config/soul/ holds every agent's identity and memory. It is created here
# rather than on demand because soul.search indexes it at startup, and a
# missing directory on a fresh volume used to be a fatal ENOENT.
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/soul" /app/data/logs /app/productions

# config.json / bots.json are seeded from the examples so a fresh container
# boots into a valid (idle) state instead of crashing on a missing file.
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$DEFAULTS_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "[entrypoint] seeded $CONFIG_DIR/config.json from config.example.json — edit it before enabling bots"
fi

seeded_bots=0
if [ ! -f "$CONFIG_DIR/bots.json" ]; then
  cp "$DEFAULTS_DIR/bots.example.json" "$CONFIG_DIR/bots.json"
  seeded_bots=1
fi

# sources.yml is read by the intel-gatherer skill.
if [ ! -f "$CONFIG_DIR/sources.yml" ]; then
  cp "$DEFAULTS_DIR/sources.yml" "$CONFIG_DIR/sources.yml"
fi

# An inert first boot is deliberate, but silence is the wrong way to deliver
# it: the operator sees a healthy container and a bot that never answers.
# Say it once, loudly, and only on the boot that actually created bots.json.
if [ "$seeded_bots" = 1 ]; then
  cat <<'BANNER'
[entrypoint] ============================================================
[entrypoint]  FRESH INSTALL — every seeded bot is DISABLED and STOPPED.
[entrypoint]
[entrypoint]  Nothing polls Telegram until you start a bot by hand, so it
[entrypoint]  is safe to boot this container while another instance is
[entrypoint]  still live on the token. Cut over deliberately: stop the old
[entrypoint]  instance first, confirm it is gone, then start the bot here.
[entrypoint]
[entrypoint]  To go live:
[entrypoint]    1. Put the real tokens in .env (config/bots.json reads
[entrypoint]       ${TELEGRAM_BOT_TOKEN} / ${TELEGRAM_BOT_TOKEN_AGENT}).
[entrypoint]    2. Set web.enabled=true and web.host=0.0.0.0 in
[entrypoint]       config/config.json, then restart the container.
[entrypoint]    3. Reach the dashboard over an SSH tunnel and press
[entrypoint]       "Enable & Start" on the agent (or POST
[entrypoint]       /api/agents/<id>/start?enable=true).
[entrypoint]
[entrypoint]  From then on, every ENABLED agent starts automatically on
[entrypoint]  each container start — a reboot or redeploy brings the bot
[entrypoint]  back by itself. To keep a container up with nothing
[entrypoint]  polling (e.g. mid-cutover), set AIBOT_AUTOSTART_BOTS=false.
[entrypoint]  See docs/deployment-cloud.md sections 4.1 and 6.
[entrypoint] ============================================================
BANNER
fi

# exec keeps the app as PID 1 so SIGTERM reaches the graceful shutdown handler.
exec "$@"
