# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# AIBot Framework — production image
#
# Bun version is pinned to match .github/workflows/ci.yml (1.3.11) so the
# lockfile resolution in the image is identical to the one CI validates.
#
# Ollama is NOT installed here — it runs as a separate service. See the
# rationale block in docker-compose.yml and docs/deployment-cloud.md.
# ---------------------------------------------------------------------------

# --- Stage 1: dependencies -------------------------------------------------
FROM oven/bun:1.3.11-slim AS deps

WORKDIR /app

# Playwright is a package.json dependency but its browser binaries are a
# ~400 MB download we deliberately keep out of the default image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json bun.lock ./

# --production omits devDependencies (biome, typescript, @types/*) — Bun runs
# the TypeScript sources directly, so none of them are needed at runtime.
RUN bun install --frozen-lockfile --production


# --- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:1.3.11-slim AS runtime

# ca-certificates — outbound TLS to api.telegram.org and LLM/tool APIs.
# tzdata       — config.datetime.timezone is applied via process.env.TZ.
# curl         — used by the Claude CLI installer below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata curl \
  && rm -rf /var/lib/apt/lists/*

# --- Claude CLI ------------------------------------------------------------
# Installed by default rather than behind a flag: resolveCandidatesFromConfig()
# puts `claude-cli` in the failover chain unless claudeCli.enabled is false, so
# an image without it ships a backend that can never answer.
#
# Installed as `bun`, never as root, for two reasons: the installer puts
# everything under $HOME (/home/bun, resolved from /etc/passwd), and the CLI
# refuses --dangerously-skip-permissions when running as uid 0. Do NOT "fix" a
# future permission error by switching this to root.
#
# Placed before the source COPYs so editing src/ does not re-download it, and
# before CLAUDE_CONFIG_DIR is set so `claude install` cannot write into what
# becomes a volume mount point at runtime.
ARG CLAUDE_CLI_VERSION=2.1.237
USER bun
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CLI_VERSION}"
ENV PATH="/home/bun/.local/bin:${PATH}"
# Build-time gate: a moved installer or a bad pin fails the build here instead
# of surfacing later as a soul health check that quietly stopped working.
RUN claude --version
USER root
# ---------------------------------------------------------------------------

# --- OPTIONAL: browser tools (config.browserTools.enabled) -----------------
# Chromium plus its shared libraries adds roughly 500 MB. Uncomment this block
# ONLY if you enable browserTools; then rebuild the image.
#
# RUN apt-get update \
#   && apt-get install -y --no-install-recommends \
#        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
#        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
#        libgbm1 libpango-1.0-0 libcairo2 libasound2 \
#   && rm -rf /var/lib/apt/lists/*
# ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
# RUN mkdir -p /app/.playwright && chown bun:bun /app/.playwright
# USER bun
# RUN bunx playwright install chromium
# USER root
# ---------------------------------------------------------------------------

WORKDIR /app

# CLAUDE_CONFIG_DIR points into the data volume on purpose. The CLI default
# (~/.claude) lives in the container layer and is destroyed by every rebuild,
# so the operator would have to log in again after each deploy. Under /app/data
# the login survives `docker compose up -d --build`.
# DISABLE_AUTOUPDATER keeps the pinned version pinned: an image that silently
# upgrades itself at runtime is not a reproducible image.
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CLAUDE_CONFIG_DIR=/app/data/claude \
    DISABLE_AUTOUPDATER=1

COPY --from=deps /app/node_modules ./node_modules

# Explicit copies rather than `COPY . .` — the image can never pick up
# config/config.json, config/bots.json, .env, data/ or productions/ even if
# .dockerignore is edited incorrectly later.
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# Config templates are staged outside the volume mount point. The entrypoint
# seeds an empty /app/config from here on first boot without ever overwriting
# an operator's live files.
COPY config/config.example.json config/bots.example.json config/sources.yml ./config-defaults/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The oven/bun base image already provides an unprivileged `bun` user (uid 1000).
# These directories are created and chowned in the image so that fresh named
# volumes mounted over them inherit the correct ownership.
RUN mkdir -p /app/config /app/data/logs /app/data/claude /app/productions \
  && chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chown -R bun:bun /app

VOLUME ["/app/config", "/app/data", "/app/productions"]

# Only reachable when config.web.enabled is true. Publish it to 127.0.0.1 only —
# single-tenant mode has no authentication on /api/*.
EXPOSE 3000

USER bun

# Lightweight liveness probe — /api/status is public (no auth) and returns
# 200 + JSON while the web server is up. A hung process (e.g. every LLM call
# stuck in timeout) leaves PID 1 alive but this endpoint silent, so Docker
# marks the container unhealthy and `restart: unless-stopped` can take over.
# `bun -e` avoids needing curl/wget in the slim image.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so `bun` becomes PID 1 and receives SIGTERM directly, which fires
# the SIGTERM handler in src/index.ts (stopAll → cron stop → session dispose).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
