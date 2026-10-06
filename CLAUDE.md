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

## Working agreements

**Canónico: [docs/working-agreements.md](docs/working-agreements.md). Leerlo antes de empezar a trabajar.**

Ahí viven el loop (entender, planear, TDD, verificar), el gate local, qué necesita aprobación
explícita (commit/push incluidos), qué registros mantener al día (CHANGELOG, `docs/architecture-docs/`,
README), los datos reales y el deploy. **No volver a copiar una regla en este archivo: enlazar.**
Lo que sigue es lo que es verdad sólo de este repo.

## Comandos
- `bun test` — suite completa. `bun run lint` (Biome), `bun run typecheck` (tsc). CI corre los tres.
- `bun run format` reescribe archivos: no es un check.
- `docker compose up -d --build` — rebuild + restart del contenedor en vivo (reinicia la flota).
- `bun scripts/docker/backup.ts backup` — backup de los volúmenes antes de tocar datos (`restore … --force` pisa los volúmenes vivos).

## Gotchas
- **Verificación de cambios en el frontend (`web/`)**: lo que corre en `127.0.0.1:3000` es el contenedor `aibot-framework-aibot-1`, y el `Dockerfile` hace `COPY web ./web` — los assets están horneados en la imagen. Editar `web/style.css` o `web/pages/*.js` en el host NO cambia nada en el contenedor por sí solo, y el fallo es silencioso: el navegador muestra la UI vieja y ningún log lo menciona. Antes de decir que un cambio de UI está listo, verificar que llegó:
  1. `docker-compose.override.yml` (versionado, se mergea solo) monta `./web` sobre `/app/web` en modo read-only, así que un refresh del navegador alcanza. Si el contenedor se levantó con `-f docker-compose.yml` solamente, el montaje no está.
  2. Cambios en `src/` siguen necesitando `docker compose up -d --build`.
  3. Comprobar el asset servido, no el archivo del repo: `curl -s http://127.0.0.1:3000/style.css | grep <lo-que-cambiaste>`.
- **El estado vivo está en los volúmenes Docker**, no en `data/` ni `config/bots.json` del host (están viejos).
- **`Dockerfile` y `docker-entrypoint.sh` deben quedar con finales de línea LF**; editarlos con herramientas de Windows rompe el contenedor en silencio.
- **Worktrees** (ver working agreements §3): cada worktree nuevo necesita su propio `bun install`. El contenedor sólo ve `D:aibot-framework` (build context y montaje de `web/`), así que un cambio hecho en un worktree no aparece en `127.0.0.1:3000` hasta mergearlo y tenerlo en la carpeta principal.
- **El login del dashboard bloquea la automatización del navegador**: verificar con tests, `curl` o smoke-imports.

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
| `bot-manager.ts` | Facade slim: constructor, `startBot` (rechaza bots con `enabled: false`), `stopBot`, `sendMessage`, API pública. `handleCronInstruction` ya **no** requiere la instancia grammy propia del bot (7 de 8 bots son headless y todo cron de instrucción tiraba `Bot not found for cron instruction`): resuelve entrega instancia propia → cualquier instancia viva de la flota → sesión web del bot, y estampa el `channelKind` real (el de **entrega**; el canal propio del bot sólo se loguea como `ownChannel`). Helper a nivel de módulo `buildCronDelivery(chatId, { telegram?, appendToSession })` → `{ kind: 'telegram' \| 'web', channel }`. Ojo operativo: una respuesta de cron de un bot headless entregada por la conexión Telegram de otro bot llega **desde la cuenta de ese otro bot**. Wirea también `crossBackendFallback` a `createLLMClient` y `getOperator`/`now` a `ask_human` y `send_proactive_message`. Para `operator.notifyOnAsk` inyecta `notifyOperator = createFleetOperatorNotifier(instancia propia, cualquier instancia viva)` (`src/tools/ask-human.ts`): antes el ping salía sólo por la instancia Telegram del bot que preguntaba, y 7 de 8 bots son headless |
| `auto-start.ts` | Semántica runtime de `enabled`: arranque de bots al boot (secuencial, per-bot failure aislado), escape hatch (`startup.autoStartBots` / `AIBOT_AUTOSTART_BOTS`), `BotDisabledError` |
| `telegram-errors.ts` | Clasificación compartida de errores Telegram: 409 (otro consumidor en el token), 401, resto — mensajes únicos para poller, auto-restart y auto-start. Estado de canal: `ChannelState = 'ok'\|'revoked'\|'placeholder'\|'missing'\|'error'`, `classifyTelegramToken` (missing/placeholder/shaped), `resolveChannelStart` (un token placeholder o ausente nunca llama a Telegram; arranca headless a nivel info), `channelStatusForUnstartedToken`. El resultado vive en `AgentRegistry.setChannel` y se lee con `BotManager.getChannelState(botId)` |
| `tenant-facade.ts` | Tenant/billing/metering — delegado desde BotManager |
| `user-directory.ts` | Persistent contact directory: auto-tracks users from all channels, supports manual registration, find by name/username/address |
| `tool-permissions.ts` | Permission matrix: per-tool access control (free/inform/confirm/blocked) across agent-loop, conv-owner, conv-external modes |
| `inline-approval.ts` | Two-turn inline approval for confirm-level tools in conversations: InlineApprovalStore, classifyApprovalResponse, describeToolCall |
| `llm-query-log.ts` | Persistent JSONL log per bot of every LLM call — traceability for conversation, agent-loop, memory, compaction, topic guard. Dentro de un ciclo del agent loop cada entrada lleva `cycleId` (y `goalId` si ya se resolvió) vía `AgentLoop.appendQueryLog`, curiosity incluido |
| `hooks.ts` | EventEmitter-based lifecycle hooks: message_received/sent, before/after_llm_call, before/after_tool_call, before_compaction, agent_loop_cycle |
| `tool-registry.ts` | Inicialización de tools, categorías (`TOOL_CATEGORIES`), pre-selección por categoría, filtro collaboration-safe. `ctx.tools` es `readonly` y compartido por referencia con `BotManager`: los filtros mutan **in place** (`removeToolsInPlace`), nunca reasignan la referencia |
| `tool-executor.ts` | Ejecución de tools con lifecycle events, retry y loop detection. Karma `toolError` por fallo de ejecución/validación, **salvo** cuando el tool devuelve `ToolResult.failureKind: 'blocked'` (un tercero rechazó el request: bot challenge, 403, 429 — hoy sólo lo setea `web_fetch`, que clasifica con `classifyHttpFailure` y recuerda el host bloqueado 1 h); `not-found` (URL inventada) y `error` se cobran igual. El `failureKind` viaja en el `ToolExecutionResult`. El `failureKind` también viaja en el evento `tool:end` y de ahí al tool-audit (`toolEndToAuditEntry` en `tool-audit-log.ts`); `exit-nonzero` (exec terminó con código ≠ 0) tampoco cobra karma, `policy` (guardrail propio: SSRF de `web_fetch`, throttle de `send_proactive_message`) sí. Si el `file_write` de una producción se renumera a `NN_<nombre>`, el resultado termina con `[Saved as <path> — use this path from now on]`; scratch (`_x`, `.x`) y `.sh` no se renumeran (`isUnnumbered` en `src/productions/files.ts`). `ToolExecutorOptions.attribution` (`{ cycleId, goalId }`, el mismo objeto que el ciclo; se lee en cada llamada): estampa `cycleId`/`goalId` en `tool:end` (→ `ToolAuditEntry`), en el `ProductionEntry` del changelog y en la metadata de karma `toolError`; el tool recibe `_cycleId` / `_goalId` (los usan `manage_goals` y `ask_human`) |
| `tool-loop-detector.ts` | 4-strategy tool loop detection: circuit breaker, poll no-progress, ping-pong, generic repeat |
| `system-prompt-builder.ts` | Composición unificada de system prompts (modo `conversation` y `collaboration`) |
| `memory-flush.ts` | Flush de sesión a daily memory log |
| `group-activation.ts` | Checks de relevancia en grupos: deference, LLM relevance, broadcast |
| `context-compaction.ts` | LLM-based context compaction: token estimation, truncation, summarization, overflow retry |
| `conversation-pipeline.ts` | Pipeline core: session expiry, RAG prefetch, compaction, LLM call, persist, reply. Channel-agnostic entry: `handleChannelMessage()`, que además emite `human_inbound` (`HUMAN_INBOUND_HOOK`, definido en `agent-loop-utils.ts` y emitido sobre el `EventEmitter` crudo, no sobre el mapa tipado de `hooks.ts`) filtrado por `isHumanInboundMessage(msg, { isPeerAgent })` — excluye peer agents, `channelKind: 'mcp'`, `synthetic: true`, ids `cron-*` y texto vacío. Telegram no pasa por acá, así que no hay doble conteo. `handleConversation` (Telegram) llama `ctx.recordOperatorMessage` cuando el chat privado es `operator.telegramChatId` — directiva de curiosity, ver Módulos Curiosity |
| `conversation-gate.ts` | Pre-condiciones de mensajes: auth, grupo, bot-to-bot, ask_human |
| `ask-permission-store.ts` | Cola de permisos: request → approve/deny → consume en agent loop |
| `collaboration.ts` | Bot-to-bot: visible, internal, delegation, multi-turn |
| `handler-registrar.ts` | Registro de handlers grammy: skills, commands, media, built-ins |
| `telegram-poller.ts` | Custom polling loop: getUpdates + 409/429 backoff + abort |
| `bot-reset.ts` | Reset de soul files, memoria, sessions, stores |
| `bot-export-service.ts` | Export/import de bots como .tar.gz (soul, config, core_memory, productions, etc.) |
| `agent-avatar.ts` | La cara del agente (S4 del plan Jarvis): un `avatar.png`/`avatar.jpg` en el soul dir (viaja con el export). `AVATAR_MAX_BYTES` (512 KB), `sniffImageType` (magic bytes, nunca el MIME declarado), `validateAvatar` → `AvatarValidationError { code: empty \| bad-type \| too-large }`, `findAvatar`, `writeAvatar` (borra la otra variante), `removeAvatar`, `avatarUrl(botId, file)` → `/api/agents/:id/avatar?v=<mtime>`. Lo consumen `src/web/routes/agent-face.ts` (GET/POST/DELETE avatar + POST speak) y `src/stats/agent-home-aggregator.ts` (`identity.avatarUrl`, `identity.voiceEnabled`, `FleetPresenceEntry.avatarUrl`), ambos resolviendo el soul dir con `resolveBotPaths` |
| `agent-loop.ts` | Orquestador del agent loop: ejecuta bots periódica/continuamente. `countDurableOutputs(botId, sinceTs)` alimenta el engagement gate desde el outcome ledger (fallback: changelog de productions; `null` si ninguno está wireado → se vuelve a la ventana in-memory), anclado en `lastFeedbackAt` o en el inicio de la ventana (`bots[].agentLoop.engagementGate.lookbackHours`, default 168 h). Memo por bot (`lastMemoryError`) para no repetir el mismo `[ERROR]` en la memoria diaria dentro de `ERROR_MEMO_WINDOW_MS`: el circuit breaker ya colapsa las cuotas, pero un fallo PERMANENT (credenciales vencidas) a propósito no abre el circuito y reaparece cada ciclo. **Atribución por ciclo**: `executeSingleBot` envuelve `executeSingleBotCycle` con un `cycleId` (`randomUUID`) por ciclo en `cycleAttribution` (por bot) y al terminar —cualquier status— escribe una fila en `<paths.data>/agent-cycles/<botId>/YYYY-MM-DD.jsonl` (`AgentCycleLog`, `src/bot/agent-cycle-log.ts`: `cycleId`, `startedAt`/`endedAt`, `status` completed/idle/skipped/error, `focus`, `plan`, `planSummary`, `priority`, `tools`, `goalId`/`goalTitle`/`goalSource`). El goal sale de `serves_goal` (planner → strategist → goal nombrado por un `manage_goals` del ciclo, `resolveCycleGoal`); sólo se registra, nunca reintenta ni rechaza un plan. El `cycleId`/`goalId` viaja a query log, tool audit, changelog de productions, outcome ledger, asks (`PendingQuestion` + metadata del hilo inbox) y karma (`novelAction`, repetición, `toolError`) |
| `agent-scheduler.ts` | Scheduling, concurrency, sleep, bot loops. `BotSchedule.feedbackEvents` (señales humanas, retención 7 días) vía `recordFeedbackEvent()` — `requestImmediateRun` registra cada mensaje humano entrante; el mismo evento acredita karma de engagement (`askAnswered` / `humanReply` vía `KarmaService.recordOutcome`; `agent_feedback` se registra pero no se acredita); `skippedReason` (p. ej. `circuit-open:ollama`). `subscribeHumanInbound()` / `unsubscribeHumanInbound()` en `start()`/`stop()`: cada `human_inbound` (REST, WebSocket, WhatsApp, Discord) se registra como `human_message`. Nota: `requestImmediateRun` sólo es alcanzable vía `BotManager.requestImmediateAgentRun`, que hoy no tiene call sites fuera de tests — Telegram todavía no acredita feedback |
| `agent-retry-engine.ts` | Retry con backoff exponencial, clasificación de errores. `BackendCircuitBreaker`: circuito fleet-wide por backend para errores CONTEXTUAL (429/quota) — `agentLoop.circuitBreaker { enabled, threshold: 3, cooldownMs: 30 min, weeklyQuotaCooldownMs: 6 h }`; abierto → ciclo omitido sin retries; half-open con un único probe. `isCircuitOpen` corta la escalera de retries. Si el error clasificado trae `resetsAt` (hint `resets 12:20pm (zona)` del Claude CLI), el cooldown termina en ese instante, clampeado a `[BackendCircuitBreaker.MIN_RESET_COOLDOWN_MS` (1 min), `weeklyQuotaCooldownMs]`. `classifyError()` lee **primero** señales estructuradas (`apiErrorStatus` 429 → CONTEXTUAL con `resetsAt`, 401/403 → PERMANENT, 5xx → TRANSIENT) y recién después matchea patrones anclados a palabra sobre el mensaje con las claves JSON removidas — el blob del CLI trae `"permission_denials":[]` y un 429 se leía como PERMANENT. Un `ClaudeCliError.timedOut` (nuestro timer mató el CLI) es TRANSIENT `code: 'timeout'` y un ciclo que vence por timeout se reintenta a lo sumo `MAX_TIMEOUT_RETRIES` (1) vez: cada retry re-ejecuta las tools del executor |
| `agent-planner.ts` | LLM planner con retry (periódico y continuo). Selección de backend del planner/strategist: `resolvePlannerBackend` (`agentLoop.plannerBackend` per-bot → global → `inherit` = `llmBackend` del bot), `resolvePlannerModel`, `selectPlannerClient` (desenvuelve el wrapper de fallback con `LLMClient.getBackendClient()` para que el planner nunca se re-emita silenciosamente a Ollama). `parsePlannerResult` conserva `serves_goal` (string no vacío) y el prompt lo pide como campo opcional |
| `agent-strategist.ts` | Strategist: reflexión, operaciones de goals, cadencia. `runStrategist` acepta `{ client, model }` opcional (el backend del planner). `StrategistResult.serves_goal` (opcional). `applyGoalOperations(..., { actor, cycleId })` escribe como `strategist` (o `curiosity` desde el navigator) a través de `writeGoalsFile` |
| `goal-events.ts` | Único escritor de GOALS.md: `writeGoalsFile(path, next, { actor, cycleId?, backup? })` hereda ids/`started`/`created` del archivo anterior (por título para escritores que reconstruyen goals sin ellos), asigna los ids que faltan (`ensureGoalIds`, `g-` + 8 hex), estampa `updated` en los goals que cambiaron y `started` la primera vez que pasan a `in_progress`, hace backup, escribe y agrega una fila por cambio a `<soulDir>/goal-events.jsonl` (`{ ts, goalId, title, op: add\|status\|notes\|priority\|complete\|reopen\|remove, from?, to?, actor, cycleId? }`; viaja con el export). Texto sin goals se escribe tal cual, sin eventos. `diffGoals`, `readGoalEvents`. Actores: `agent` (SoulLoader.writeGoals / `manage_goals`), `strategist`, `curiosity`, `reflection`, `lint` (goal-lint), `wizard` (wizard + presets), `operator` (rutas del dashboard) |
| `agent-loop-utils.ts` | Funciones puras: digest, dedup, file scan, memory log. Engagement gate: `countFeedbackSignals` (aprobaciones/rechazos de producciones, respuestas de ask_human, feedback del dashboard, mensajes humanos) → `FeedbackSignals.lastFeedbackAt`, `detectUnconsumedOutput(recentActions, threshold, externalFeedbackCount, durableOutputCount?)` → `UnconsumedOutputResult.outputSource` (`'durable' \| 'recent-actions'`) + `externalFeedbackCount`, `evaluateEngagementGate` (modo `hard`: plan CONTENT con gate activo → ciclo idle). Conteo **durable** de output: `countOutputsSince` (ledger, `CONTENT`/`OUTREACH`), `countProductionOutputsSince` (changelog, `create`/`edit`), `resolveDurableOutputCount`. Se eliminó el sniffer de keywords que dejaba a un bot des-gatearse escribiendo "feedback" en su propio plan summary; un ASSESSMENT propio tampoco cuenta. También viven acá `HUMAN_INBOUND_HOOK` / `isHumanInboundMessage` y el memo de errores (`shouldRecordErrorInMemory`, `ERROR_MEMO_WINDOW_MS` = 6 h) |
| `agent-loop-prompts.ts` | Prompt builders para planner, strategist, executor, feedback |
| `agent-wizard.ts` | Mitad servidor del wizard de creación (S6 del plan Jarvis; la página es `web/pages/agent-wizard.js`, helpers puros en `agent-wizard-helpers.js`). Cuatro sliders → ocho traits (`PERSONALITY_AXES`, `personalityToTraits`: warmth → sociability↑/independence↓, boldness → risk_tolerance↑/caution↓, rigor → depth↑/persistence↑, playfulness → creativity↑/curiosity↑; `up = 0.1 + 0.8x`, `down = 0.9 − 0.8x`, mismos vectores de test que el helper JS), `describePersonality` (sliders + quirks → prosa para el soul generator), `initialGoalsMarkdown` (GOALS.md parseable por `tools/goals.ts`), `writeWizardSoul` (IDENTITY/SOUL/MOTIVATIONS + `.baseline` + GOALS.md + `memory/`; nunca pisa un soul existente), `seedTraits` / `traitsBaseDirFor` (`<paths.data>/tenants/__admin__/bots`, donde `BotManager` construye su `TraitRegisters`), `validateChannelToken(kind, token, check?)` (shape-only para missing/placeholder vía `classifyTelegramToken`; `getMe` en vivo sólo para Telegram y sólo con `check` inyectado — `createTelegramTokenCheck(fetch)`; Discord/WhatsApp sólo forma). Lo compone `POST /api/agents` en `src/web/routes/agents.ts` (deps opcionales `wizard: { generateSoul, telegramCheck }`): genera y escribe todo **antes** de registrar el bot y hace rollback de lo que creó si algo falla |
| `trait-registers.ts` | `TraitRegisters`: ocho traits mecánicos (0.1–0.9) en `TRAITS.json` que derivan temperatura, rounds de tools, cadencia de ask_human. Política por bot (`bots[].traits { pinned, locked }`, resuelta en vivo vía `TraitPolicyResolver`): los `pinned` ganan al cargar y tras cada ajuste (se reescribe con source `'pinned'`), los `locked` descartan deltas; `getDrift()` (baseline = primer snapshot persistido), `getPolicy()/setPolicy()`. `seed(botId, traits)` (wizard S6): escribe el set inicial sin límite de delta como único snapshot `adaptive` — la baseline del drift — respetando pins. La guía de traits del strategist en `agent-loop-prompts.ts` está des-sesgada: "sin cambio" es la respuesta esperada, cada delta cita una observación concreta y respeta la identidad |
| `presets.ts` | Presets de agente (S7 del plan Jarvis): cinco puntos de partida (`assistant`, `researcher`, `job-seeker`, `coder`, `social`) como datos en `src/bot/presets/*.json` — bajo `src/` a propósito, porque `config/` es un volumen que la imagen nunca copia — validados con `AgentPresetSchema` (Zod) al cargar el módulo. `listPresets()` / `getPreset(id)` devuelven copias; `applyPreset(preset, input)` es puro y rellena **sólo** lo que el input dejó `undefined` (un `''` o `[]` del usuario nunca se pisa; `personality` y `agentLoop` se mergean por clave); `presetGoalsMarkdown(preset, purpose)` escribe el GOALS.md (goal de propósito + goals del preset con `source: preset:<id>`, parseable por `tools/goals.ts`); `presetToBotConfig`, `presetSummary` (forma de `GET /api/agents/presets`), `presetToTemplateConfig` + `presetTemplateId` (`preset:<id>`) para exponerlos como templates built-in read-only vía `TemplateService.registerBuiltin` cuando multi-tenant está activo. `POST /api/agents` acepta `preset` y lo aplica server-side antes del camino wizard; el bot queda estampado con `preset` (campo opcional nuevo en `BotConfigSchema`) |
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

### Módulos Curiosity (`src/bot/curiosity/`)

El ADN de todo bot (plan: `docs/plans/curiosity-navigator-plan.md`): seis genes (curious, compounding, self-directed, captivating, honest, bold), seis diales de límites por bot y un piso que ningún dial desbloquea. Encendido por defecto (`resolveCuriosity` → preset `explorer`); se apaga con `bots[].agentLoop.curiosity.enabled: false`. Estado en el soul dir del bot (viaja con el export): `KNOWLEDGE.json`, `NAVIGATOR.json`, `TASTE.json`, `DISPATCHES.jsonl`. El agent loop sólo llama al runner; ningún paso de curiosity puede fallar un ciclo.

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Tipos compartidos: `LimitDials` (`topic`, `purpose`, `instructions`, `method`, `capability`, `identity` × `closed\|ask\|open`), `ResolvedCuriosity`, `KnowledgeMap`/`KnowledgeTopic`/`FrontierItem`, `NavigatorState`/`Directive`/`Direction`/`CycleTopicEntry`, `Dispatch`/`TasteProfile` |
| `config.ts` | `CURIOSITY_PRESETS` (`focused`/`explorer`/`wild`), `CURIOSITY_DEFAULTS`, `resolveCuriosity(global, bot, curiosityTrait)` (defaults → preset → dials global → dials bot; el trait `curiosity` escala `exploreRatio` 0.6×–1.4×, tope 0.6), `evaluateFrontierItem` (distance ≥ 2 cruza `topic`, sin bridge cruza `purpose`; `closed` bloquea, `ask` requiere 👍 del operador). Schema: `CuriosityConfigSchema` en `src/config.ts` (`agentLoop.curiosity` global y por bot) |
| `knowledge-map.ts` | Gen compounding, puro: `mergeExtraction` (dedupe por `textSimilarity ≥ 0.8`, depth por cantidad de findings), `pruneKnowledgeMap` (`KNOWLEDGE_CAPS`), `markFrontier`, `setFrontierSignal`, `renderKnowledgeForPrompt` |
| `store.ts` | `CuriosityStore(soulDir)`: JSON atómico (tmp + rename), JSONL de dispatches; lecturas nunca lanzan |
| `cycle.ts` | `computeTopicConcentration`, `decideCycleMode` (explore por concentración de tópico > `maxTopicShare` o racha sin sorpresa — ambos sólo con `cyclesSinceExplore ≥ 1` —, budget cada 1/ratio ciclos, budget a la mitad con operador en silencio), `recordCycle` (un ciclo explore resetea la racha), `noteCycle` (ciclo idle o sin extracción igual mueve la cadencia), `selectFrontierItem` (`open` + `exploring`, que nunca queda varado; + proposals `ask`), `renderFrontierForPrompt` |
| `directives.ts` | Instrucciones del operador con decay: activas hasta `directiveHalfLifeOutputs` outputs o `directiveHalfLifeDays`, luego "served" = contexto; una instrucción repetida re-ancla |
| `taste.ts` | Modelo de gusto desde 👍/👎/more: `applySignal` (cadencia ×0.75 / ×1.25), `applyIgnored` (dispatch sin señal en 48 h → ×1.5), `likedTopicScores`, `renderTasteForPrompt` |
| `dna.ts` | `buildDnaSection(limits, exploration?)`: genes, diales con su significado por nivel (`DIAL_MEANINGS`), piso (`FLOOR_RULES`) y el mandato de EXPLORATION CYCLE |
| `extractor.ts` | LLM post-ciclo: tópico, findings con evidencia, sorpresas, preguntas abiertas, frontier, directivas servidas, candidato a dispatch. `MIN_DIRECTIVE_CHARS` (15). Las directivas salen **sólo** de superficies del operador: ask_human respondidas, feedback del dashboard, el chat Telegram privado `operator.telegramChatId` (`ConversationPipeline.handleConversation` → `ctx.recordOperatorMessage`) y los hilos del dashboard (`POST /api/conversations/:botId/:id/messages` → `BotManager.recordOperatorMessage`); los usuarios públicos (REST, widget, WhatsApp, Discord) nunca dirigen al bot |
| `navigator.ts` | Capa sobre el strategist (cada `navigatorEvery`, default 1 d): retrospectiva → dirección con 2–3 bets explore/exploit, frontier add/drop, directivas servidas, intereses según dial `identity`, goal ops. Temperatura 0.7 → 0.3. Un intento fallido hace backoff `min(navigatorEvery, NAVIGATOR_RETRY_MS = 2 h)` vía `lastNavigatorAttemptAt`. Corre **en background** (`CuriosityService.startNavigator`, uno por bot; `waitForNavigator` para tests): una retrospectiva en Claude CLI supera el presupuesto del ciclo, así que nunca lo bloquea ni se descarta; aplica sobre estado fresco cuando termina y el ciclo siguiente lo lee. Las propuestas de interés quedan en `NavigatorState.pendingInterests` hasta que el paso de dispatch las consume |
| `dispatch.ts` | Lo que recibe el operador: formato (hook → por qué te importa → evidencia → qué hacer), editor LLM duro (score = 0.5·insight + 0.3·novelty + 0.2·backed; backed < 0.5 ⇒ drop), `findHypeWords` (es/en) con penalidad, `decideDispatch`, digest, propuestas de cruce de diales |
| `runner.ts` | `beginCuriosityCycle` (directivas, decay, cadencia, navigator si toca, explore/exploit, bloque DNA ≤ `CURIOSITY_BLOCK_MAX_CHARS` = 6000) y `finishCuriosityCycle` (extractor → mapa → ciclo → a lo sumo un dispatch: insight → propuesta de interés → propuesta de frontier → digest; con cadencia cerrada el insight queda `held` sin llamar al editor). Ambos bajo `CuriosityService.runExclusive(botId)`, re-leen el estado después de cada await de LLM, begin es cancelable (`isCancelled`). Cada llamada LLM va al query log como `curiosity:navigator\|extractor\|editor` (`onLLMCall`). Nunca lanza |
| `loop-wiring.ts` | `createOperatorDispatchDeliverer` → `'telegram' \| 'inbox' \| false` (instancia Telegram propia → cualquiera de la flota → `operator.telegramChatId`; sin ruta Telegram, o bot de tenant en multi-tenant, el feed del dashboard es el canal y no cuenta como ignorado), `createFleetDispatchLimiter` (contador propio en memoria del mismo tamaño que `operator.proactiveDailyCap`, vía `ProactiveThrottle`; no se comparte con `send_proactive_message`). `createCuriosityCallRecorder` (cada llamada LLM → query log + `meter`; un sink que tira nunca escapa) y `createTenantCallMeter` (un `llm_request` contra el tenant del bot, resuelto al momento de la llamada, sólo en multi-tenant) |
| `service.ts` | `CuriosityService` (`BotManager.getCuriosityService()`): `snapshot`, `signalDispatch` (enseña al taste sólo si la señal cambia; en propuestas aprueba/descarta el frontier item; una propuesta de identidad aprobada agrega el `interest` al mapa), `signalFrontier`, `signalDirection`, `recordDirective`, `recordOperatorMessage`, `runExclusive`. Resuelve el soul dir del loader vivo o con la misma resolución de `startBot` |

Integración en `agent-loop.ts`: `beginCuriosityCycle` corre antes del strategist (acotado por `strategistMs`; al vencer se marca cancelado y no escribe más). Un ciclo explore **no** fuerza strategist (rompería su cadencia y `lastFocus`): si el strategist corre por su cadencia recibe el bloque DNA y `skipAlignmentRetry` (sin re-roll a temperatura 0); si no corre, el foco del planner es `EXPLORATION: <pregunta del frontier>`. `curiosityBlock` reemplaza en el planner la regla "if unsure, choose inaction" por PURPOSE ALIGNMENT y en el strategist el engagement check acepta EXPLORATION. `finishCuriosityCycle` corre tras todo ciclo (también idle, para mover la cadencia; tope 120 s). Cada llamada LLM de curiosity (fallidas incluidas) cuenta como un `llm_request` en el metering del tenant (bot de tenant en multi-tenant), vía `createCuriosityCallRecorder` + `createTenantCallMeter` de `loop-wiring.ts`.

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

Sección "Stats & Behaviour" del dashboard. Sólo lectura sobre la telemetría que ya existe en disco; nunca lanza por datos faltantes; cache de 60 s por agregación. Rutas en `src/web/routes/stats.ts`, montadas en `/api/stats` (`GET /fleet?window=24h|7d|30d`, `GET /bots/:botId`, `GET /behaviour`, `GET /curiosity?window=`, `GET /infra`), tenant-scoped como `/api/karma`.

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Contrato de API congelado (el frontend `web/pages/stats.js` depende de él): `FleetResponse`, `FleetBotStats`, `BotDetailResponse`, `BehaviourResponse`, `InfraResponse`, `Posture`, `StatsWindow`. Agregar campos sí; renombrar o quitar no |
| `util.ts` | `parseWindow`, `windowToMs`, helpers de fechas/números |
| `cache.ts` | `TtlCache` in-memory, `STATS_CACHE_TTL_MS = 60_000` |
| `posture.ts` | `computePosture()`: primera regla que matchea — `dormant` (disabled) → `unknown` (nunca corrió) → `blocked` (retryCount ≥ 3 con error, o todos los goals activos `blocked`) → `idle` (sin goals activos) → `standby` (≥ 5 ciclos idle, última corrida > 3 días, o sin outcome en 48 h con racha idle) → `active` |
| `paths.ts` | `resolveStatsDirs(config)`: dónde vive cada fuente (llm-query-log, tool-audit, outcome-ledger, karma, agent-scheduler, conversations, sessions, cron, mesh, log). `resolveBotPaths` replica la resolución de `BotManager.startBot`. `classifyToken` |
| `context.ts` | `StatsContext` compartido: config, dirs, `StatsBotManager` (subset estructural: `getAgentLoopState`, `isRunning`, `getChannelState`), karma, reloj, cache. `liveSchedule`, `liveChannelStatus`, `getLogSignals` |
| `readers/*.ts` | Un lector por fuente: `daily-files` (JSONL por día), `llm-query-log`, `tool-audit`, `outcomes`, `karma`, `schedules`, `sessions`, `conversations` (asks del inbox), `cron`, `mesh`, `logs` (tail de pino: 429/401, boots, ruido), `soul` (goals, traits, health), `productions` (`unreviewed` / `editedSinceReview` cuentan **archivos** en disco vía `pendingFiles` de `src/productions/changelog.ts` — la misma definición que Needs You; antes contaba filas del changelog, incluidas las de archivos archivados), `curiosity` (KNOWLEDGE/NAVIGATOR/TASTE/DISPATCHES), `goal-events` (`goal-events.jsonl` del soul dir + `readGoalExtras`: las líneas `id`/`started`/`updated` de GOALS.md que `parseGoals` no guarda; `GoalDetail.id`), `agent-cycles` (`<data>/agent-cycles/<bot>/<día>.jsonl`, `StatsDirs.agentCycles`). `tool-audit`: `isToolFailure` — `blocked` y `exit-nonzero` no cuentan como fallo (`ToolStats.blocked` / `exitNonzero` aparte, `notFound` / `policy` dentro de `failed`; entradas viejas sin `failureKind` siguen contando); `FleetTotals.toolBlocked` / `toolExitNonzero` |
| `fleet-aggregator.ts` | `buildFleet`, `buildBotDetail`, `resolveChannel` — composición pura sobre los readers |
| `behaviour-aggregator.ts` | `buildBehaviour`: producción sin feedback, ask economics por bucket de longitud, grafo de colaboración, mesh, varianza y drift de traits |
| `curiosity-aggregator.ts` | `buildCuriosityStats` (UI: Insights → Curiosity, `renderStatsCuriosity`): por bot, mapa de conocimiento, ciclos en la ventana (explore/exploit, sorpresas, tópicos distintos, share del dominante), `diversityTimeline` (tópicos distintos y share dominante sobre los `topicWindow` ciclos previos, incluidos los anteriores a la ventana), `dailyMix`, dirección del navigator, cadencia y `dispatchLanding` (`classifyDispatchLanding`: up/more/down; `ignored` = Telegram sin señal a las 48 h, igual que el taste model — un dispatch sólo-inbox nunca es ignored; `pending`; held/dropped; mediana del editor; landing rate = (up + more) / resueltos). Historia acotada por el cycle log (`CYCLE_LOG_CAP` = 30); la respuesta trae `cycleLogCap` y `historyStart`. Lector: `readers/curiosity.ts` (sólo lectura, nunca crea el dir) |
| `infra-aggregator.ts` | `buildInfra`: backends (429/401/fallos 24 h), security audit, cron, estados Telegram, ruido de logs, boots, tamaño de logs |
| `now-line.ts` | `describeNow(input)`: frase en primera persona, determinista y sin LLM, de "qué estoy haciendo ahora" (`{ text, tone }`); orden de ramas: disabled → not running → ejecutando (`phaseLabel` con la fase del loop y la tool en curso) → asks pendientes → blocked → skipped → nunca corrió → idle → standby → "between cycles". `relativeIn(nowMs, ts)` |
| `presence-tracker.ts` | `PresenceTracker`: se suscribe al `ActivityStream` y guarda por bot `{ executing, phase, currentTool, since }` a partir de `agent:phase`, `tool:start/end/error`, `agent:result/idle`. El executor recibe el plan entero en una sola llamada, así que no hay "paso N de M" observable: la fase y la tool son la señal viva |
| `goal-detail-aggregator.ts` | `buildGoalDetail(ctx, bot, { id?, title?, days? })` → `GoalDetailResponse` para el drawer de un goal (Agent Home → click en la card; `web/pages/goal-detail-helpers.js`). Header (origen parseado de `source` con `goalOrigin`, created/started/updated/done), timeline (`goal-events.jsonl`; antes del primer evento, llamadas `manage_goals` del tool-audit que nombran al goal, `inferred: true`), ciclos newest-first (tope `GOAL_DETAIL_MAX_CYCLES` = 30, lookback 1–30 días, default 14) con LLM calls, tool calls, files (estado de review por fila), asks y karma. Atribución por ciclo: `exact` (registro en agent-cycles o filas con el `goalId` del goal, unidas por `cycleId`), `inferred` (ventana reconstruida con `reconstructCycleWindows` desde el llm-query-log — un bot corre un ciclo a la vez — que llama `manage_goals` nombrando el goal o produce un archivo citado en sus notes), `weak` (≥ 3 palabras del título en el plan summary). Ruta `GET /api/agents/:id/goals/detail?id=&title=&days=` en `src/web/routes/agent-home.ts` (cache 15 s, tenant-scoped) |
| `agent-home-aggregator.ts` | `buildAgentHome` / `buildPresence`: payload del Agent Home (`identity`, `presence`, `goals` por bucket, `traits`, `karma` con historia reconstruida desde los eventos, `timeline` mergeada de llm-log + tool-audit + changelog de productions + asks + ciclos + karma, `needsYou`). `buildFleetPresence(ctx, bots, deps)` → `FleetPresenceResponse` (`agents[id]` = presencia + karma + `unreviewed` + `lastOutputAt` + `channel`, fallback seguro por bot). Rutas en `src/web/routes/agent-home.ts` (`GET /api/agents/presence` cache 3 s por tenant, `GET /api/agents/:id/home` cache 15 s, `GET /api/agents/:id/presence` sin cache, `POST /api/agents/:id/goals` — el operador agrega un goal: `parseGoalInput` valida, `appendGoal` de `tools/goals.ts` escribe en Active con `source: operator` + `created`, backup a `.versions/` e invalida el cache; `PATCH /api/agents/:id/goals { goal, status }` mueve un goal en el tablero To do / In progress / Blocked / Done vía `setGoalStatus` — `done` lo completa, otro status sobre uno completado lo reabre —; el home trae `goals.todo` / `goals.inProgress` según `goalBucket`), tenant-scoped. Los goals del operador llevan badge "you" en el board y el planner/strategist/executor los recibe en "## Set by your operator" (`buildOperatorGoalsSection` en `agent-loop-prompts.ts`: primero esos, `ask_human` si son ambiguos); `manage_goals add` escribe `source: agent`, y goal genealogy mapea sin source → `unknown` (antes `operator`). Montadas **antes** de `agentsRoutes` en `server.ts` porque su `GET /:id` respondería `/presence` con 404 |

### Módulos Hygiene (`src/hygiene/`)

Rutinas de mantenimiento deterministas (sin LLM) con `preview` (sin escrituras) y `apply`. **Apply nunca borra**: respalda cada archivo de soul en `<dir>/.versions/<archivo>.<ISO>.bak` y mueve lo que limpia a `<data>/_trash/<stamp>/…` con `manifest.json`. Rutas en `src/web/routes/hygiene.ts`, montadas en `/api/hygiene` (`GET /routines`, `POST /run { routine, botId?, apply?, options? }`, `POST /cleanup` = `all` aplicado con `CLEANUP_OPTIONS` (`pruneOrphans`, `archiveStale`) para todos los bots del caller, `GET /history?botId=&limit=`). Todo run con apply trae `remaining`: un preview fresco tomado después de los fixes, que es lo que la UI muestra como abierto (los `findings` son el estado previo); rutinas de bot tenant-scoped, rutinas de flota sólo admin. UI en `#/stats/hygiene` y en el panel de cada bot en `#/stats/bot/:botId`.

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `HygieneRoutine` (`preview`/`apply`), `HygieneFinding` (`kind`, `severity`, `fixable`, `fix`), `HygieneRun`, `HygieneContext` (`soulDir`, `workDir`, `allowedRoots`, `deps`), `HYGIENE_HISTORY_LIMIT = 500` |
| `fs-safe.ts` | **Único módulo que muta el filesystem**: `backupFile` (convención `.versions` de `src/soul.ts`, sin poda), `TrashBatch` (mueve a `_trash/<stamp>/`, rename o copy+rm cross-device, `manifest.json`), `isWithinRoot` / `assertWithinRoots` |
| `text-utils.ts` | `jaccard`, `textSimilarity`, `extractDates`, `daysBetween`, `localDate`, `titleTokens` |
| `registry.ts` | `CLEANUP_OPTIONS`, `HygieneRegistry` (lookup, `buildContext` con la misma resolución de paths que `BotManager.startBot`, `run`, rutina virtual `all`), `HygieneHistory` → `<data>/hygiene/runs.jsonl` (últimos 500). Lo construye `src/web/server.ts` (con `archiveProduction` = `ProductionsService.archiveFile`) y lo comparte con `/api/hygiene` y el auto-archive |
| `auto-archive.ts` | Auto-archive diario (`productions.autoArchive { enabled: true, staleDays: 7, intervalHours: 24 }`, `resolveAutoArchive`): `runAutoArchive` aplica `productions-triage` con `archiveStale` a cada bot con productions activas (un bot que falla se loguea y no frena al resto); `startAutoArchive` lo agenda 10 min después del boot y luego cada `intervalHours`, timers `unref`. Los runs quedan en el history como uno manual |
| `routines/goal-lint.ts` | GOALS.md vía el parser de `tools/goals.ts`: `archived-in-active` (→ Completed), `oversized-notes` (→ trim a 600 chars, texto completo al daily log), `duplicate-title`, `stale-block`, `dead-trigger` |
| `routines/soul-structure.ts` | Envuelve `lintSoulDirectory` + `soul-equals-motivations`, `missing-memory-md` (→ crea), `missing-traits`, `stale-current-focus`, `last-review-failed`. Sólo reporta salvo la creación de MEMORY.md |
| `routines/memory-hygiene.ts` | MEMORY.md y `memory/*.md` (archive intacto): `pii` (→ `[redacted:<kind>]`: email, phone, chat-id, money, custody), `stale-constraint` (→ marca `[stale as of …]` sólo si el tool-audit muestra la tool funcionando en 7 días), `daily-logs-pending` |
| `routines/productions-triage.ts` | `orphan-reference`, `unreviewed-stale`, `unnumbered`, `duplicate-number`, `cleanup-candidate`. `unreviewed-stale` sale de `pendingFiles`: la edad corre desde `pendingSince` (primera fila sin veredicto después del último), así que las ediciones del bot no reinician el reloj; un archivo aprobado nunca es candidato (sí uno nunca revisado o uno rechazado que el bot editó). Ignora paths de bookkeeping y `archived/**` (`isUntrackedProductionPath`). Apply archiva `unreviewed-stale` con `options.archiveStale === true` (vía `deps.archiveProduction` cuando está — reconstruye el index — o `archiveFile` de productions; nunca borra) y, con `options.pruneOrphans === true`, aplica el fix `prune-changelog` a los `orphan-reference` cuyo path cae dentro del dir de productions: respalda `changelog.jsonl` en `.versions/changelog.jsonl.<ISO>.bak` y lo reescribe sin las líneas huérfanas, dejando el resto byte a byte y en orden. Nunca toca entradas `archive`/`delete`/`trackOnly`, líneas malformadas, paths fuera del dir ni archivos que reaparecieron |
| `routines/data-cleanup.ts` | Scope flota: `orphan-karma-dir`, `orphan-soul-dir`, `legacy-config-soul`, `claude-tmp-transcripts` (→ `_trash`); `duplicate-skills` y `skills-are-tools` sólo reportan (`bots.json` no se reescribe). `skills-are-tools` ya no dispara para un nombre que es skill real **y** tool (`improve` es ambos y se reportaba en seis bots por corrida): resta `config.skills.enabled` + los subdirectorios de skill folders (`listSkillFolderIds`, privado del módulo), con `options.knownSkillIds` para tests |

### Módulos Cron (`src/cron/`)

Scheduler de jobs (`service.ts`, `timer.ts`, `jobs.ts`, `schedule.ts` sobre croner; payloads `message` / `instruction` / `skillJob`, `chatId` **numérico** — el alias `"operator"` lo resuelve el tool `tools/cron.ts` vía `resolveOperatorTarget`, no el scheduler). Rutas en `src/web/routes/cron.ts` (`/api/cron`).

| Archivo | Responsabilidad |
|---|---|
| `nl-parse.ts` | Propuestas de cron desde lenguaje natural (S8), sin HTTP ni LLM: `deterministicParse(text)` (every N minutes/hours/days, every day at HH:MM con am/pm/noon/midnight, every monday [and thursday] at 9, weekdays, weekends, weekly, monthly, cron literal; default `DEFAULT_FALLBACK_SCHEDULE` = `0 9 * * *` con `confidence: 'low'`), `isCronExpr` (5 campos que croner acepta), `cronToHuman(expr, tz)`, `mentionsOperator`, `buildParsePrompt` (incluye timezone y "now"), `validateLlmProposal` / `parseLlmProposal` (vía `llm-json-parser`), `jobNameFor`, `composeProposal({ text, botId, tz, nowMs, operator, llm, llmNote })` → `CronProposal` (`schedule`, `tz`, `scheduleHuman`, `nextRunAt`, `instruction`, `name`, `botId`, `chatId: 'operator' \| number`, `operatorChatId`, `confidence`, `explanation`, `warnings`, `source: 'llm' \| 'fallback'`). Un `chatId` numérico del LLM sólo se acepta si el texto lo cita; si el parser determinista leyó otro horario que el LLM, se agrega un warning. La ruta `src/web/routes/cron-parse.ts` (`POST /api/cron/parse`, montada **antes** de `cronRoutes`) inyecta el LLM con `CronParseLlmResolver`; `buildCronParseLlmResolver(botManager, config, logger)` usa `resolvePlannerBackend` / `selectPlannerClient` / `resolvePlannerModel` para que el parse corra en el backend del bot sin fallback silencioso. Nunca crea jobs: la UI (`web/pages/automations.js`) postea el `POST /api/cron` de siempre |

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
