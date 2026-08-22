# CLAUDE.md - AIBot Framework

## Referencia OpenClaw
El codigo fuente de OpenClaw esta en `/home/diego/openclaw/`.
Siempre consultar esa carpeta para entender como OpenClaw maneja skills, tools, plugins, etc.
NO buscar en internet la documentacion de OpenClaw - usar el codigo fuente local.

- Skills bundled: `/home/diego/openclaw/skills/`
- Codigo fuente: `/home/diego/openclaw/src/`
- Paquetes: `/home/diego/openclaw/packages/`
- Extensions: `/home/diego/openclaw/extensions/`
- Docs: `/home/diego/openclaw/docs/`

## Reglas de trabajo
- NUNCA hacer git commit o git push a menos que el usuario lo pida explicitamente.
- Al implementar features, solo escribir codigo. El commit/push es decision del usuario.
- Antes de refactorizar, agregar features, o corregir bugs en el bot core: SIEMPRE leer la sección "Arquitectura del Bot" más abajo para entender qué módulo modificar y cómo se relacionan entre sí.
- Cada cambio de código debe incluir o actualizar tests unitarios en `tests/`. Ejecutar `bun test` antes de considerar el trabajo terminado.
- **Flujo TDD obligatorio** para todo código nuevo o refactor de código existente:
  1. **Red**: escribir primero el test que describe el comportamiento deseado (o el contrato que se va a mantener durante un refactor). El test debe fallar de forma explícita antes de tocar la implementación.
  2. **Green**: escribir el mínimo de código de producción para que el test pase. No agregar funcionalidad extra.
  3. **Refactor**: limpiar el código de producción sin romper los tests. Re-correr `bun test`.
  4. **Cobertura por función**: toda función/método público nuevo debe tener al menos un test dedicado. Para ramas con comportamiento divergente (errores, edge cases, valores límite), agregar un test por rama.
  5. **Alineación con el plan**: antes de cada ciclo, confirmar que la función que se está implementando está en el plan acordado. Si surge trabajo fuera del plan, anotarlo como follow-up pero no implementarlo en el mismo ciclo.
  6. **Puerta de salida**: un cambio no se considera terminado hasta que `bun test` corre limpio para los archivos tocados y los tests pre-existentes no se rompen.
- **Verificación de cambios en el frontend (`web/`)**: lo que corre en `127.0.0.1:3000` es el contenedor `aibot-framework-aibot-1`, y el `Dockerfile` hace `COPY web ./web` — los assets están horneados en la imagen. Editar `web/style.css` o `web/pages/*.js` en el host NO cambia nada en el contenedor por sí solo, y el fallo es silencioso: el navegador muestra la UI vieja y ningún log lo menciona. Antes de decir que un cambio de UI está listo, verificar que llegó:
  1. `docker-compose.override.yml` (versionado, se mergea solo) monta `./web` sobre `/app/web` en modo read-only, así que un refresh del navegador alcanza. Si el contenedor se levantó con `-f docker-compose.yml` solamente, el montaje no está.
  2. Cambios en `src/` siguen necesitando `docker compose up -d --build`.
  3. Comprobar el asset servido, no el archivo del repo: `curl -s http://127.0.0.1:3000/style.css | grep <lo-que-cambiaste>`.
- Cualquier cambio relevante debe agregarse al archivo `CHANGELOG.md` en la raíz del proyecto.
- Cualquier cambio que afecte la arquitectura, módulos, tools, skills, rutas web, config schemas, o memoria debe reflejarse en la documentación en `docs/architecture-docs/`. Actualizar la página HTML correspondiente para mantener la documentación sincronizada con el código.
- Cambios que afecten la lista de skills, tools, sistemas core, páginas del dashboard, estructura del proyecto, o stack tecnológico deben reflejarse también en `README.md`.
- Todo código generado por AI (incluyendo este asistente) DEBE producir tests que pasen. Ejecutar `bun test` y verificar que no se introducen nuevos fallos antes de considerar el trabajo terminado. Los tests pre-existentes que fallan por dependencias externas (Playwright, API keys) no cuentan como fallos nuevos.
- Antes de proponer nuevos features o integraciones, consultar `docs/roadmap.md` para entender el estado actual de los proyectos planificados y evitar trabajo duplicado.

## Proyecto
- Runtime: Bun
- Lenguaje: TypeScript
- Bot framework: grammy
- Skills: `src/skills/<id>/` con skill.json + index.ts
- Tools del LLM: `src/tools/`
- Config: `config/config.json`

## Arquitectura del Bot

El core del bot vive en `src/bot/` como módulos enfocados compuestos por un facade (`BotManager`).
El API pública es `BotManager` — se importa desde `src/bot/index.ts`.

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `BotContext` interface compartido + `SeenUser` |
| `bot-manager.ts` | Facade slim: constructor, `startBot` (rechaza bots con `enabled: false`), `stopBot`, `sendMessage`, API pública. `handleCronInstruction` ya **no** requiere la instancia grammy propia del bot (7 de 8 bots son headless y todo cron de instrucción tiraba `Bot not found for cron instruction`): resuelve entrega instancia propia → cualquier instancia viva de la flota → sesión web del bot, y estampa el `channelKind` real (el de **entrega**; el canal propio del bot sólo se loguea como `ownChannel`). Helper a nivel de módulo `buildCronDelivery(chatId, { telegram?, appendToSession })` → `{ kind: 'telegram' \| 'web', channel }`. Ojo operativo: una respuesta de cron de un bot headless entregada por la conexión Telegram de otro bot llega **desde la cuenta de ese otro bot**. Wirea también `crossBackendFallback` a `createLLMClient` y `getOperator`/`now` a `ask_human` y `send_proactive_message` |
| `auto-start.ts` | Semántica runtime de `enabled`: arranque de bots al boot (secuencial, per-bot failure aislado), escape hatch (`startup.autoStartBots` / `AIBOT_AUTOSTART_BOTS`), `BotDisabledError` |
| `telegram-errors.ts` | Clasificación compartida de errores Telegram: 409 (otro consumidor en el token), 401, resto — mensajes únicos para poller, auto-restart y auto-start. Estado de canal: `ChannelState = 'ok'\|'revoked'\|'placeholder'\|'missing'\|'error'`, `classifyTelegramToken` (missing/placeholder/shaped), `resolveChannelStart` (un token placeholder o ausente nunca llama a Telegram; arranca headless a nivel info), `channelStatusForUnstartedToken`. El resultado vive en `AgentRegistry.setChannel` y se lee con `BotManager.getChannelState(botId)` |
| `tenant-facade.ts` | Tenant/billing/metering — delegado desde BotManager |
| `user-directory.ts` | Persistent contact directory: auto-tracks users from all channels, supports manual registration, find by name/username/address |
| `tool-permissions.ts` | Permission matrix: per-tool access control (free/inform/confirm/blocked) across agent-loop, conv-owner, conv-external modes |
| `inline-approval.ts` | Two-turn inline approval for confirm-level tools in conversations: InlineApprovalStore, classifyApprovalResponse, describeToolCall |
| `llm-query-log.ts` | Persistent JSONL log per bot of every LLM call — traceability for conversation, agent-loop, memory, compaction, topic guard |
| `hooks.ts` | EventEmitter-based lifecycle hooks: message_received/sent, before/after_llm_call, before/after_tool_call, before_compaction, agent_loop_cycle |
| `tool-registry.ts` | Inicialización de tools, categorías (`TOOL_CATEGORIES`), pre-selección por categoría, filtro collaboration-safe. `ctx.tools` es `readonly` y compartido por referencia con `BotManager`: los filtros mutan **in place** (`removeToolsInPlace`), nunca reasignan la referencia |
| `tool-executor.ts` | Ejecución de tools con lifecycle events, retry y loop detection |
| `tool-loop-detector.ts` | 4-strategy tool loop detection: circuit breaker, poll no-progress, ping-pong, generic repeat |
| `system-prompt-builder.ts` | Composición unificada de system prompts (modo `conversation` y `collaboration`) |
| `memory-flush.ts` | Flush de sesión a daily memory log |
| `group-activation.ts` | Checks de relevancia en grupos: deference, LLM relevance, broadcast |
| `context-compaction.ts` | LLM-based context compaction: token estimation, truncation, summarization, overflow retry |
| `conversation-pipeline.ts` | Pipeline core: session expiry, RAG prefetch, compaction, LLM call, persist, reply. Channel-agnostic entry: `handleChannelMessage()`, que además emite `human_inbound` (`HUMAN_INBOUND_HOOK`, definido en `agent-loop-utils.ts` y emitido sobre el `EventEmitter` crudo, no sobre el mapa tipado de `hooks.ts`) filtrado por `isHumanInboundMessage(msg, { isPeerAgent })` — excluye peer agents, `channelKind: 'mcp'`, `synthetic: true`, ids `cron-*` y texto vacío. Telegram no pasa por acá, así que no hay doble conteo |
| `conversation-gate.ts` | Pre-condiciones de mensajes: auth, grupo, bot-to-bot, ask_human |
| `ask-permission-store.ts` | Cola de permisos: request → approve/deny → consume en agent loop |
| `collaboration.ts` | Bot-to-bot: visible, internal, delegation, multi-turn |
| `handler-registrar.ts` | Registro de handlers grammy: skills, commands, media, built-ins |
| `telegram-poller.ts` | Custom polling loop: getUpdates + 409/429 backoff + abort |
| `bot-reset.ts` | Reset de soul files, memoria, sessions, stores |
| `bot-export-service.ts` | Export/import de bots como .tar.gz (soul, config, core_memory, productions, etc.) |
| `agent-loop.ts` | Orquestador del agent loop: ejecuta bots periódica/continuamente. `countDurableOutputs(botId, sinceTs)` alimenta el engagement gate desde el outcome ledger (fallback: changelog de productions; `null` si ninguno está wireado → se vuelve a la ventana in-memory), anclado en `lastFeedbackAt` o en el inicio de la ventana (`bots[].agentLoop.engagementGate.lookbackHours`, default 168 h). Memo por bot (`lastMemoryError`) para no repetir el mismo `[ERROR]` en la memoria diaria dentro de `ERROR_MEMO_WINDOW_MS`: el circuit breaker ya colapsa las cuotas, pero un fallo PERMANENT (credenciales vencidas) a propósito no abre el circuito y reaparece cada ciclo |
| `agent-scheduler.ts` | Scheduling, concurrency, sleep, bot loops. `BotSchedule.feedbackEvents` (señales humanas, retención 7 días) vía `recordFeedbackEvent()` — `requestImmediateRun` registra cada mensaje humano entrante; el mismo evento acredita karma de engagement (`askAnswered` / `humanReply` vía `KarmaService.recordOutcome`; `agent_feedback` se registra pero no se acredita); `skippedReason` (p. ej. `circuit-open:ollama`). `subscribeHumanInbound()` / `unsubscribeHumanInbound()` en `start()`/`stop()`: cada `human_inbound` (REST, WebSocket, WhatsApp, Discord) se registra como `human_message`. Nota: `requestImmediateRun` sólo es alcanzable vía `BotManager.requestImmediateAgentRun`, que hoy no tiene call sites fuera de tests — Telegram todavía no acredita feedback |
| `agent-retry-engine.ts` | Retry con backoff exponencial, clasificación de errores. `BackendCircuitBreaker`: circuito fleet-wide por backend para errores CONTEXTUAL (429/quota) — `agentLoop.circuitBreaker { enabled, threshold: 3, cooldownMs: 30 min, weeklyQuotaCooldownMs: 6 h }`; abierto → ciclo omitido sin retries; half-open con un único probe. `isCircuitOpen` corta la escalera de retries. Si el error clasificado trae `resetsAt` (hint `resets 12:20pm (zona)` del Claude CLI), el cooldown termina en ese instante, clampeado a `[BackendCircuitBreaker.MIN_RESET_COOLDOWN_MS` (1 min), `weeklyQuotaCooldownMs]`. `classifyError()` lee **primero** señales estructuradas (`apiErrorStatus` 429 → CONTEXTUAL con `resetsAt`, 401/403 → PERMANENT, 5xx → TRANSIENT) y recién después matchea patrones anclados a palabra sobre el mensaje con las claves JSON removidas — el blob del CLI trae `"permission_denials":[]` y un 429 se leía como PERMANENT |
| `agent-planner.ts` | LLM planner con retry (periódico y continuo). Selección de backend del planner/strategist: `resolvePlannerBackend` (`agentLoop.plannerBackend` per-bot → global → `inherit` = `llmBackend` del bot), `resolvePlannerModel`, `selectPlannerClient` (desenvuelve el wrapper de fallback con `LLMClient.getBackendClient()` para que el planner nunca se re-emita silenciosamente a Ollama) |
| `agent-strategist.ts` | Strategist: reflexión, operaciones de goals, cadencia. `runStrategist` acepta `{ client, model }` opcional (el backend del planner) |
| `agent-loop-utils.ts` | Funciones puras: digest, dedup, file scan, memory log. Engagement gate: `countFeedbackSignals` (aprobaciones/rechazos de producciones, respuestas de ask_human, feedback del dashboard, mensajes humanos) → `FeedbackSignals.lastFeedbackAt`, `detectUnconsumedOutput(recentActions, threshold, externalFeedbackCount, durableOutputCount?)` → `UnconsumedOutputResult.outputSource` (`'durable' \| 'recent-actions'`) + `externalFeedbackCount`, `evaluateEngagementGate` (modo `hard`: plan CONTENT con gate activo → ciclo idle). Conteo **durable** de output: `countOutputsSince` (ledger, `CONTENT`/`OUTREACH`), `countProductionOutputsSince` (changelog, `create`/`edit`), `resolveDurableOutputCount`. Se eliminó el sniffer de keywords que dejaba a un bot des-gatearse escribiendo "feedback" en su propio plan summary; un ASSESSMENT propio tampoco cuenta. También viven acá `HUMAN_INBOUND_HOOK` / `isHumanInboundMessage` y el memo de errores (`shouldRecordErrorInMemory`, `ERROR_MEMO_WINDOW_MS` = 6 h) |
| `agent-loop-prompts.ts` | Prompt builders para planner, strategist, executor, feedback |
| `trait-registers.ts` | `TraitRegisters`: ocho traits mecánicos (0.1–0.9) en `TRAITS.json` que derivan temperatura, rounds de tools, cadencia de ask_human. Política por bot (`bots[].traits { pinned, locked }`, resuelta en vivo vía `TraitPolicyResolver`): los `pinned` ganan al cargar y tras cada ajuste (se reescribe con source `'pinned'`), los `locked` descartan deltas; `getDrift()` (baseline = primer snapshot persistido), `getPolicy()/setPolicy()`. La guía de traits del strategist en `agent-loop-prompts.ts` está des-sesgada: "sin cambio" es la respuesta esperada, cada delta cita una observación concreta y respeta la identidad |
| `agent-loop-user-context.ts` | Active users summary for planner injection (coach/student awareness) |
| `topic-guard.ts` | LLM-based topic pre-filter: blocks off-topic messages before full pipeline |
| `claude-cli-preflight.ts` | Boot probe for the Claude CLI: binary on PATH, version, credentials in `CLAUDE_CONFIG_DIR`. Injectable deps, never throws |
| `llm-json-parser.ts` | Parser genérico de JSON desde output LLM |
| `soul-health-check.ts` | Orquestador: lint + consolidación + quality review |
| `soul-lint.ts` | Lint estructural de soul directory (sin LLM) |
| `soul-memory-consolidator.ts` | Consolidación de daily logs → MEMORY.md |
| `soul-quality-reviewer.ts` | Quality review de soul files (Claude CLI) |
| `hooks.ts` | Lifecycle hook system: `HookEmitter` con 8 eventos (message_received/sent, before/after_llm_call, before/after_tool_call, before_compaction, agent_loop_cycle) |
| `index.ts` | Barrel re-export de `BotManager` |

### Backends LLM (`src/core/llm-client.ts`)

`createLLMClient(opts)` decide qué cliente recibe cada bot. **El fallback cross-backend es opt-in**: `CreateLLMClientOptions.crossBackendFallback` + `claudeCli.crossBackendFallback` (ambos default `false`, wireados en `bot-manager.ts`). Antes, sin cadena `failover` configurada, todo bot con `llmBackend: 'claude-cli'` recibía `LLMClientWithFallback(claude, ollama)` y **cualquier** llamada Claude fallida se re-emitía a Ollama en silencio — no sólo el planner: skill de reflexión, soul health check, quality reviewer, memory consolidator y el camino de conversación. Hoy un bot `claude-cli` recibe el `ClaudeCliLLMClient` pelado salvo que se prenda el flag.

Con `failover.enabled`, `orderCandidatesByBackend(candidates, backend)` pone primero el backend propio del bot y `resolveOllamaModels(ollamaClient, opts)` toma los modelos configurados del cliente (antes el primario era `ollamaClient.toString()`, o sea `[object Object]`). `LLMClient.getBackendClient(backend)` es parte de la interfaz y lo implementan los dos clientes concretos y los dos wrappers. `TokenUsage.backend` existe como campo opcional pero **hoy ningún productor lo setea** (`ollamaUsage()` / `parseClaudeUsage()` no lo escriben), así que el query log cae al `?? llmBackend`.

Los errores del Claude CLI llegan como `ClaudeCliError` (`src/claude-cli.ts`) con `exitCode`, `apiErrorStatus`, `isError`, `terminalReason`, `resultText` y `resetsAt`; `parseResetsAt()` convierte el hint `resets 12:20pm (zona)` en un instante absoluto.

### Módulos System (`src/system/`)

Export/import de la instancia completa. Guía de operador: `docs/system-backup-restore.md`.

| Archivo | Responsabilidad |
|---|---|
| `tar-archive.ts` | tar + gzip puro JS (ustar + PAX para paths largos). Sin binario `tar`, sin staging en `/tmp`. Normaliza separadores Windows y rechaza paths con traversal |
| `archive-fs.ts` | Walk de directorios → entradas de archivo, selección de subárboles, escritura a disco, sha256 |
| `config-sanitizer.ts` | **Frontera de seguridad**: secretos → `${VAR}`, drop de settings machine-specific, scrub de credenciales embebidas en contenido, `REQUIRED_ENV.txt`. Debe recibir el JSON **crudo**, nunca el `Config` cargado (`loadConfig` ya expandió los `${VAR}`) |
| `effective-config.ts` | `Config` mínimo construido desde JSON crudo sin Zod — para máquinas cuyo config no valida o cuyas env vars no están seteadas |
| `system-export-service.ts` | Arma el bundle: config saneado, roster, un bundle per-bot anidado por agente (vía `BotExportService.collectBotEntries`), directorios de data, tenants, manifest con checksums |
| `system-import-service.ts` | Valida kind/versión/checksums, rechaza si hay bots corriendo, planifica todas las colisiones antes de escribir, restaura las secciones pedidas |
| `types.ts` | `SYSTEM_EXPORT_VERSION`, `SYSTEM_EXPORT_KIND`, secciones, forma del manifest |

### Módulos Stats (`src/stats/`)

Sección "Stats & Behaviour" del dashboard. Sólo lectura sobre la telemetría que ya existe en disco; nunca lanza por datos faltantes; cache de 60 s por agregación. Rutas en `src/web/routes/stats.ts`, montadas en `/api/stats` (`GET /fleet?window=24h|7d|30d`, `GET /bots/:botId`, `GET /behaviour`, `GET /infra`), tenant-scoped como `/api/karma`.

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Contrato de API congelado (el frontend `web/pages/stats.js` depende de él): `FleetResponse`, `FleetBotStats`, `BotDetailResponse`, `BehaviourResponse`, `InfraResponse`, `Posture`, `StatsWindow`. Agregar campos sí; renombrar o quitar no |
| `util.ts` | `parseWindow`, `windowToMs`, helpers de fechas/números |
| `cache.ts` | `TtlCache` in-memory, `STATS_CACHE_TTL_MS = 60_000` |
| `posture.ts` | `computePosture()`: primera regla que matchea — `dormant` (disabled) → `unknown` (nunca corrió) → `blocked` (retryCount ≥ 3 con error, o todos los goals activos `blocked`) → `idle` (sin goals activos) → `standby` (≥ 5 ciclos idle, última corrida > 3 días, o sin outcome en 48 h con racha idle) → `active` |
| `paths.ts` | `resolveStatsDirs(config)`: dónde vive cada fuente (llm-query-log, tool-audit, outcome-ledger, karma, agent-scheduler, conversations, sessions, cron, mesh, log). `resolveBotPaths` replica la resolución de `BotManager.startBot`. `classifyToken` |
| `context.ts` | `StatsContext` compartido: config, dirs, `StatsBotManager` (subset estructural: `getAgentLoopState`, `isRunning`, `getChannelState`), karma, reloj, cache. `liveSchedule`, `liveChannelStatus`, `getLogSignals` |
| `readers/*.ts` | Un lector por fuente: `daily-files` (JSONL por día), `llm-query-log`, `tool-audit`, `outcomes`, `karma`, `schedules`, `sessions`, `conversations` (asks del inbox), `cron`, `mesh`, `logs` (tail de pino: 429/401, boots, ruido), `soul` (goals, traits, health), `productions` |
| `fleet-aggregator.ts` | `buildFleet`, `buildBotDetail`, `resolveChannel` — composición pura sobre los readers |
| `behaviour-aggregator.ts` | `buildBehaviour`: producción sin feedback, ask economics por bucket de longitud, grafo de colaboración, mesh, varianza y drift de traits |
| `infra-aggregator.ts` | `buildInfra`: backends (429/401/fallos 24 h), security audit, cron, estados Telegram, ruido de logs, boots, tamaño de logs |

### Módulos Hygiene (`src/hygiene/`)

Rutinas de mantenimiento deterministas (sin LLM) con `preview` (sin escrituras) y `apply`. **Apply nunca borra**: respalda cada archivo de soul en `<dir>/.versions/<archivo>.<ISO>.bak` y mueve lo que limpia a `<data>/_trash/<stamp>/…` con `manifest.json`. Rutas en `src/web/routes/hygiene.ts`, montadas en `/api/hygiene` (`GET /routines`, `POST /run { routine, botId?, apply?, options? }`, `GET /history?botId=&limit=`); rutinas de bot tenant-scoped, rutinas de flota sólo admin. UI en `#/stats/hygiene` y en el panel de cada bot en `#/stats/bot/:botId`.

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `HygieneRoutine` (`preview`/`apply`), `HygieneFinding` (`kind`, `severity`, `fixable`, `fix`), `HygieneRun`, `HygieneContext` (`soulDir`, `workDir`, `allowedRoots`, `deps`), `HYGIENE_HISTORY_LIMIT = 500` |
| `fs-safe.ts` | **Único módulo que muta el filesystem**: `backupFile` (convención `.versions` de `src/soul.ts`, sin poda), `TrashBatch` (mueve a `_trash/<stamp>/`, rename o copy+rm cross-device, `manifest.json`), `isWithinRoot` / `assertWithinRoots` |
| `text-utils.ts` | `jaccard`, `textSimilarity`, `extractDates`, `daysBetween`, `localDate`, `titleTokens` |
| `registry.ts` | `HygieneRegistry` (lookup, `buildContext` con la misma resolución de paths que `BotManager.startBot`, `run`, rutina virtual `all`), `HygieneHistory` → `<data>/hygiene/runs.jsonl` (últimos 500) |
| `routines/goal-lint.ts` | GOALS.md vía el parser de `tools/goals.ts`: `archived-in-active` (→ Completed), `oversized-notes` (→ trim a 600 chars, texto completo al daily log), `duplicate-title`, `stale-block`, `dead-trigger` |
| `routines/soul-structure.ts` | Envuelve `lintSoulDirectory` + `soul-equals-motivations`, `missing-memory-md` (→ crea), `missing-traits`, `stale-current-focus`, `last-review-failed`. Sólo reporta salvo la creación de MEMORY.md |
| `routines/memory-hygiene.ts` | MEMORY.md y `memory/*.md` (archive intacto): `pii` (→ `[redacted:<kind>]`: email, phone, chat-id, money, custody), `stale-constraint` (→ marca `[stale as of …]` sólo si el tool-audit muestra la tool funcionando en 7 días), `daily-logs-pending` |
| `routines/productions-triage.ts` | `orphan-reference`, `unreviewed-stale`, `unnumbered`, `duplicate-number`, `cleanup-candidate`. Apply archiva `unreviewed-stale` con `options.archiveStale === true` (usa `archiveFile` de productions, nunca borra) y, con `options.pruneOrphans === true`, aplica el fix `prune-changelog` a los `orphan-reference` cuyo path cae dentro del dir de productions: respalda `changelog.jsonl` en `.versions/changelog.jsonl.<ISO>.bak` y lo reescribe sin las líneas huérfanas, dejando el resto byte a byte y en orden. Nunca toca entradas `archive`/`delete`/`trackOnly`, líneas malformadas, paths fuera del dir ni archivos que reaparecieron |
| `routines/data-cleanup.ts` | Scope flota: `orphan-karma-dir`, `orphan-soul-dir`, `legacy-config-soul`, `claude-tmp-transcripts` (→ `_trash`); `duplicate-skills` y `skills-are-tools` sólo reportan (`bots.json` no se reescribe). `skills-are-tools` ya no dispara para un nombre que es skill real **y** tool (`improve` es ambos y se reportaba en seis bots por corrida): resta `config.skills.enabled` + los subdirectorios de skill folders (`listSkillFolderIds`, privado del módulo), con `options.knownSkillIds` para tests |

### Módulos Karma (`src/karma/`)

Score de calidad por bot (0–100, con decay temporal) **basado en outcomes**. Rutas en `src/web/routes/karma.ts` (`/api/karma`, `/api/karma/:botId` con `breakdown`, `/api/karma/:botId/history`, `/api/karma/:botId/adjust`).

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `KarmaSource` (`production`, `agent-loop`, `feedback`, `goal`, `manual`, `tool`, `engagement`), `KarmaRewards` / `KarmaOutcomeKind` con `DEFAULT_KARMA_REWARDS` (`novelAction: 0`, `productionApproved: 3`, `productionRejected: -1`, `askAnswered: 2`, `humanReply: 3`, `collaborateCompleted: 0`, `toolError: -1`), `KARMA_KIND_SOURCE` (kind → source), `KarmaEvent.kind`, `KarmaBreakdown`, `KarmaScore.breakdown` |
| `service.ts` | `KarmaService`: `recordOutcome(botId, kind, reason, metadata?)` — delta desde `config.karma.rewards`, un reward 0 no escribe nada, cooldown por kind (`humanReply` una vez por bot cada `humanReplyCooldownHours`, 6 h por defecto); `addEvent` (dedup de negativos automáticos por `dedupCooldownMinutes`); `getBreakdown(botId, 30)` sumas crudas `bySource` / `byKind`; `getKarmaScore`, `getAllScores`, `renderForPrompt` (dice explícitamente que la actividad sola no suma). Call sites: `AgentScheduler.recordFeedbackEvent` (engagement — incluye el `human_inbound` de canales no-Telegram), `ProductionsService.evaluate` (production), `ToolExecutor` (toolError), `AgentLoop` (novelAction), `CollaborationManager.initiateCollaboration` (`collaborateCompleted`, sólo al terminar la sesión; los timeouts tiran antes; reward default 0 ⇒ no escribe nada) |

### Módulos Channel (`src/channel/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `InboundMessage`, `Channel`, `ChannelKind` — interfaces canal-agnósticas |
| `telegram.ts` | Adapter grammy Context → InboundMessage + Channel |
| `rest.ts` | Adapter REST API request → InboundMessage + Channel (collect-reply pattern) |
| `websocket.ts` | Adapter WebSocket connection → InboundMessage + Channel (widget chat), `streamToWebSocket()` |
| `whatsapp.ts` | Adapter WhatsApp Cloud API → InboundMessage + Channel (webhook signature, message extraction, image sending, interactive buttons, status tracking) |
| `discord.ts` | Adapter Discord REST API → InboundMessage + Channel (2000-char splitting) |
| `discord-gateway.ts` | Discord Gateway WebSocket: heartbeat, identify, MESSAGE_CREATE dispatch, auto-reconnect |
| `outbound.ts` | Factory de canales de salida para mensajes proactivos: Telegram (bot.api, con dep opcional `getAnyTelegramBot` como fallback de flota — hoy sólo la ejercitan los tests, `ToolRegistry` hace el mismo fallback inline), WhatsApp (Cloud API), web (`appendWebSessionMessage(sessionManager, botId, address, text)`, único camino de append a la sesión web), Discord (stub). `null` ahora significa realmente no entregable |
| `index.ts` | Barrel re-export |

### Módulos A2A (`src/a2a/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | A2A v0.3.0 tipos: `AgentCard`, `A2AMessage`, `Task`, `TaskState`, JSON-RPC, error codes |
| `task-store.ts` | `TaskStore` — CRUD de tasks in-memory con TTL pruning, session grouping |
| `agent-card-builder.ts` | `buildAgentCard()` — genera AgentCard desde BotConfig + ToolDefinitions |
| `executor.ts` | Headless LLM executor: A2AMessage → ChatMessage → LLM → A2AMessage |
| `server.ts` | `A2AServer` — HTTP JSON-RPC handler: `message/send`, `tasks/get`, `tasks/cancel`, agent card discovery, directory endpoints |
| `client.ts` | `A2AClient` — HTTP client para agentes A2A externos con agent card caching |
| `client-pool.ts` | `A2AClientPool` — pool de clientes con `discoverAll()` |
| `tool-adapter.ts` | Convierte skills de agentes A2A externos en framework Tools (`a2a_<agent>_<skill>`) |
| `directory.ts` | `AgentDirectory` — registry de agentes con heartbeat, stale pruning, skill search |
| `index.ts` | Barrel re-export |

### Módulos MCP (`src/mcp/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Tipos compartidos: `JsonRpcMessage`, `McpToolDef`, `McpToolCallResult`, `MCP_PROTOCOL_VERSION` |
| `protocol.ts` | Transports: `McpStdioTransport` (spawn + NDJSON stdin/stdout), `McpSseTransport` (HTTP SSE) |
| `client.ts` | `McpClient` — conecta a un MCP server, handshake, `callTool()`, reconnect |
| `client-pool.ts` | `McpClientPool` — lifecycle de múltiples clients |
| `tool-adapter.ts` | Conversión MCP tools ↔ framework `Tool` objects. Prefijo: `mcp_<server>_<tool>` |
| `server.ts` | `McpServer` — HTTP/SSE server que expone tools a clientes externos (Claude Desktop, Cursor, etc.) |
| `agent-bridge.ts` | `McpAgentBridge` — agent-to-agent via MCP, integra con `AgentRegistry` y `CollaborationTracker` |
| `tool-bridge-server.ts` | Standalone stdio server para Claude CLI (usa tipos compartidos de `types.ts`) |

### Módulos Tenant (`src/tenant/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `Tenant`, `TenantQuota`, `TenantFeatures`, `UsageEventType`, `PLAN_DEFINITIONS` |
| `manager.ts` | `TenantManager` — CRUD tenants, usage recording, quota checking, usage rotation |
| `middleware.ts` | Hono middleware: API key auth, tenant context injection |
| `rate-limit-middleware.ts` | Per-tenant rate limiting middleware |
| `billing.ts` | `BillingProvider` interface, `NoOpBillingProvider`, Stripe integration |
| `tenant-paths.ts` | `resolveTenantPaths()`, `isPathWithinTenant()` — filesystem isolation |
| `tenant-scoping.ts` | `getTenantId()`, `scopeBots()`, `isBotAccessible()`, `isAdminOrSingleTenant()` — route-level tenant filtering |
| `usage-tracker.ts` | `UsageTracker` — batched usage metering with periodic flush |
| `template-service.ts` | `TemplateService` — bot template CRUD, instantiation, version tracking |
| `customization.ts` | `CustomizationService` — per-tenant bot overlays (identity, knowledge, goals, rules) |
| `webhook-service.ts` | `WebhookService` — outbound webhook registration, HMAC delivery, retry, auto-disable |
| `analytics-service.ts` | `AnalyticsService` — conversation metrics, tenant-scoped JSONL event store, aggregation |

### Patrón de composición

Todos los módulos reciben un `BotContext` compartido (estado mutable por referencia).
Las dependencias circulares (delegation/collaborate tools → CollaborationManager) se resuelven con lazy callbacks `() => collaborationManager`.

### Grafo de dependencias

```
BotManager (facade)
  ├── TenantFacade            (tenant/billing/metering)
  ├── UserDirectory            (persistent contact directory, JSONL per bot)
  ├── HookEmitter             (lifecycle hooks: message/llm/tool/compaction/agent-loop events)
  ├── McpClientPool           (MCP server connections, shared pool)
  ├── LlmQueryLog             (persistent JSONL traceability log for all LLM calls)
  ├── SecurityAudit           (startup audit with 24h cooldown, non-blocking)
  ├── ToolRegistry            (sin deps de módulo, registra MCP + A2A + SKILL.md tools, wires send_message)
  ├── SystemPromptBuilder     (lee ToolRegistry.getDefinitions())
  ├── MemoryFlusher           (sin deps de módulo)
  ├── GroupActivation         (sin deps de módulo)
  ├── ContextCompactor        (usa MemoryFlusher, LLMClient, SessionManager)
  ├── ConversationPipeline    (usa SystemPromptBuilder, MemoryFlusher, ToolRegistry, ContextCompactor, Channel, streaming)
  ├── CollaborationManager    (usa SystemPromptBuilder, ToolRegistry)
  ├── TelegramPoller          (polling loop, inyectado en startTelegramBot)
  ├── BotResetService         (reset soul/memory/sessions/stores)
  ├── BotExportService        (export/import bots as .tar.gz archives)
  ├── HandlerRegistrar        (usa ConversationPipeline, GroupActivation, ConversationGate)
  │   └── ConversationGate    (auth, grupo, bot-to-bot gates)
  ├── A2AServer               (A2A JSON-RPC server + AgentDirectory)
  ├── DiscordGateway          (Discord WebSocket gateway, per-bot)
  └── AgentLoop               (orquestador)
      ├── AgentScheduler      (scheduling, concurrency, sleep)
      ├── AgentRetryEngine    (retry con backoff, unified error classification via FailoverLLMClient,
      │                        BackendCircuitBreaker fleet-wide por backend)
      ├── AgentPlanner        (LLM planner; resolvePlannerBackend/selectPlannerClient fijan el backend
      │                        del planner+strategist sobre el cliente bare)
      ├── AgentStrategist     (strategist, goals)
      └── AgentLoopUtils      (funciones puras, countFeedbackSignals, evaluateEngagementGate)
```

Fuera del facade, dos paquetes de sólo lectura/mantenimiento montados en `src/web/server.ts`: `src/stats/` (`/api/stats`) lee `BotManager.getAgentLoopState()` / `getChannelState()` y los directorios de datos; `src/hygiene/` (`/api/hygiene`) recibe `toolSucceededRecently` (desde el tool-audit vía `stats/readers/tool-audit`) y `channelStateOf` (desde `BotManager.getChannelState`). Ninguno escribe estado del bot en runtime.
