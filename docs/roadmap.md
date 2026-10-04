# Roadmap

Documento vivo para trackear features futuras, ideas y estado de proyectos en progreso.
Última actualización: 2026-10-03.

---

## Proyecto 1 — Audio Input (Voice-to-Text)

**Estado: Auth implementado, tests completos — pendiente testing manual**

### Lo que ya existe

- `processVoice()` en `src/media.ts` — descarga el archivo OGG de Telegram, lo envía a un endpoint Whisper con auth condicional, devuelve la transcripción.
- Handler `message:voice` registrado en `src/bot/media-handlers.ts` — captura voice messages, extrae file URL, invoca `processVoice`, inyecta la transcripción en la sesión de conversación.
- `WhisperConfigSchema` en `src/config.ts` — esquema Zod con `endpoint`, `model`, `language`, `timeout`, `apiKey` (todos opcionales excepto endpoint).
- `config/config.json` — configurado con endpoint OpenAI (`https://api.openai.com/v1/audio/transcriptions`), model `whisper-1`, language `es`, apiKey via `${OPENAI_API_KEY}`.
- `Authorization: Bearer` header — se envía condicionalmente solo cuando `apiKey` está presente. Endpoints sin auth (whisper.cpp local) siguen funcionando.
- `tests/media.test.ts` — 13 test cases unitarios cubriendo: transcripción exitosa, formatos de sessionText, language hint, API key auth, errores HTTP, timeout, archivo demasiado grande.

### Lo que falta

- **Testing manual** con notas de voz reales en Telegram (requiere `OPENAI_API_KEY` en env).
- **Feedback al usuario** — considerar enviar un mensaje "Transcribiendo..." mientras se procesa el audio.
- **Soporte para audio files** — actualmente solo maneja `message:voice` (notas de voz). Telegram también tiene `message:audio` para archivos de audio regulares.

### Próximos pasos

1. Setear `OPENAI_API_KEY` en environment
2. Testing manual con notas de voz reales
3. Agregar feedback "Transcribiendo..." al usuario
4. Soporte para `message:audio` (archivos de audio regulares)

---

## Proyecto 2 — Audio Output (TTS)

**Estado: Implementado (inbound mode) — pendiente testing manual**

### Lo que ya existe

- `generateSpeech()` en `src/tts.ts` — llama a ElevenLabs API, devuelve audio Buffer en formato OGG/Opus nativo de Telegram.
- Modo **inbound**: TTS solo se activa cuando el mensaje del usuario fue una nota de voz. Flag `isVoice` propagado desde `BufferEntry` → `ConversationProcessor` → `handleConversation`.
- Integrado en `src/bot/conversation-pipeline.ts` — después de obtener la respuesta del LLM, si `isVoice=true` y TTS está configurado, genera audio y envía con `replyWithVoice`. Fallback a texto si TTS falla.
- `TtsConfigSchema` en `src/config.ts` — schema Zod con `provider`, `apiKey`, `voiceId`, `modelId`, `outputFormat`, `languageCode`, `timeout`, `maxTextLength`, `voiceSettings` (stability, similarityBoost, style, useSpeakerBoost, speed).
- `config/config.json` — configurado con ElevenLabs, voice `pMsXgVXv3BLzUgSXRplE`, model `eleven_multilingual_v2`, language `es`, apiKey via `${ELEVENLABS_API_KEY}`.
- Strip de markdown antes de enviar a TTS (headers, bold, code, links).
- Truncado a `maxTextLength` chars con "..." si excede.
- Typing indicator `record_voice` mientras se genera el audio.
- `tests/tts.test.ts` — 22 test cases (stripMarkdown, truncateText, generateSpeech: success, headers, body, language, markdown stripping, truncation, HTTP errors, timeout, empty text).
- 4 tests de integración en `src/bot/__tests__/conversation-pipeline.test.ts` (voice reply, text-only, fallback, unconfigured).

### Lo que falta

- **Testing manual** con notas de voz reales en Telegram (requiere `ELEVENLABS_API_KEY` en env).
- **Soporte multi-provider** — actualmente solo ElevenLabs. Podría agregarse OpenAI TTS como alternativa más barata.
- **Caching** de respuestas frecuentes para reducir costos.
- **Tool `send_voice_message`** — modo alternativo donde el LLM decide cuándo hablar (outbound mode).
- **Audio `message:audio`** — actualmente solo `message:voice` setea `isVoice`. Los archivos de audio regulares no activan TTS.

### Próximos pasos

1. Setear `ELEVENLABS_API_KEY` en environment
2. Testing manual con notas de voz reales
3. Evaluar si agregar mode outbound (tool que el LLM decide usar)
4. Soporte para OpenAI TTS como provider alternativo

---

## Proyecto 3 — WhatsApp

**Estado: IMPLEMENTADO** (commit `6434c46`, 2026-03-15)

### Lo que se implementó

- **`src/channel/whatsapp.ts`** — Adapter completo para WhatsApp Business Cloud API (Meta)
  - Webhook signature verification (HMAC-SHA256)
  - Message extraction (text, image, interactive responses)
  - Image sending via media upload
  - Interactive buttons support
  - Message status tracking (sent, delivered, read)
- **Abstracción multi-canal** — Se eligió Opción A (Cloud API directo). La abstracción de plataforma se implementó como `Channel` interface en `src/channel/types.ts` con `InboundMessage`, `ChannelKind`, y pipeline channel-agnostic via `handleChannelMessage()`
- **`src/channel/outbound.ts`** — Factory de canales de salida para mensajes proactivos incluyendo WhatsApp

### Lo que falta

- Testing manual con número WhatsApp Business verificado
- Templates para mensajes fuera de ventana 24h

---

## Proyecto 4 — Twitter/X Integration

**Estado: Tools implementados — pendiente skill Telegram y testing manual**

### Lo que ya existe

- `src/tools/twitter.ts` — 3 tools: `twitter_search` (Bearer Token), `twitter_read` (Bearer Token), `twitter_post` (OAuth 1.0a con firma HMAC-SHA1 built-in, sin deps externas)
- `TwitterConfigSchema` en `src/config.ts` — apiKey, apiSecret, bearerToken, accessToken (optional), accessSecret (optional)
- `twitter_post` requiere `ask_permission` antes de publicar; solo se registra cuando hay credenciales de escritura
- Rate limiting: 300/15min (search), 200/15min (tweets)
- Cache via `TtlCache` (120s default)
- Tests: `tests/tools/twitter.test.ts` (19 tests: definitions, params, auth headers, OAuth signature, caching, error handling)

### Lo que falta

- **`src/skills/twitter/` skill** — No existe. Los tools están disponibles vía LLM pero no hay Telegram skill con comandos `/twitter search`, `/twitter trending`, `/twitter post`.
- Configurar app en developer.twitter.com y obtener API keys
- Testing manual con API keys reales

---

## Proyecto 5 — Reddit Integration

**Estado: Implementado — pendiente testing manual con API keys reales**

### Lo que ya existe

- `src/tools/reddit.ts` — 3 tools: `reddit_search`, `reddit_hot`, `reddit_read`. OAuth2 script-app auth con promise-based mutex para token refresh concurrente.
- `src/skills/reddit/` — Telegram skill con comandos `/reddit hot <subreddit>`, `/reddit search <query>`
- `RedditConfigSchema` en `src/config.ts` — clientId, clientSecret, username, password, userAgent, cacheTtlMs, timeout
- Rate limiting: 100 req/min (shared across all 3 tools)
- Cache via `TtlCache` (300s default)
- Tests: `tests/tools/reddit.test.ts` (16 tests: definitions, params, formatting, caching, API errors, auth credentials)

### Lo que falta

- Registrar app en reddit.com/prefs/apps (tipo "script")
- Testing manual con API keys reales

---

## Proyecto 6 — Calendly/Calendarios Integration

**Estado: Implementado — pendiente testing manual con API keys reales**

### Lo que ya existe

- `src/tools/calendar.ts` — 3 tools: `calendar_list`, `calendar_availability`, `calendar_schedule`. Provider abstraction (`CalendarProvider` interface) con implementaciones `CalendlyProvider` y `GoogleCalendarProvider`.
- `src/skills/calendar/` — Telegram skill con comandos `/cal today`, `/cal availability <YYYY-MM-DD>`, `/cal schedule`
- `CalendarConfigSchema` en `src/config.ts` — provider (calendly|google), apiKey, calendarId, defaultTimezone, cacheTtlMs, timeout
- `calendar_schedule` requiere `ask_permission` antes de crear eventos
- Calendly reporta gracefully que no soporta creación directa (usa scheduling links)
- Cache via `TtlCache` (60s default)
- Tests: `tests/tools/calendar.test.ts` (20 tests: both providers, definitions, params, formatting, caching, error handling, Calendly limitation)

### Lo que falta

- Obtener API key de Calendly o Google Calendar
- Testing manual con API keys reales

---

## Proyecto 7 — Discord (canal bidireccional)

**Estado: IMPLEMENTADO** (commit `6434c46`, 2026-03-15)

### Lo que se implementó

- **`src/channel/discord.ts`** — Adapter Discord REST API con splitting de mensajes a 2000 chars
- **`src/channel/discord-gateway.ts`** — Discord Gateway WebSocket completo:
  - Heartbeat keep-alive
  - Identify handshake
  - MESSAGE_CREATE dispatch
  - Auto-reconnect con backoff
- **`src/channel/outbound.ts`** — Soporte de Discord en factory de mensajes proactivos
- No usa `discord.js` — implementación nativa sobre Discord REST + Gateway API (zero deps)

### Lo que falta

- Testing manual con bot token real en un server Discord
- Soporte para embeds, reactions, threads

---

## Proyecto 8 — A2A Protocol (Agent-to-Agent)

**Estado: IMPLEMENTADO — Phase 1 + Phase 2 complete** (commit `6434c46`, 2026-03-15)

### Lo que se implementó

10 archivos en `src/a2a/`:

| Módulo | Responsabilidad |
|---|---|
| `types.ts` | Tipos A2A v0.3.0: `AgentCard`, `A2AMessage`, `Task`, `TaskState`, JSON-RPC, error codes |
| `agent-card-builder.ts` | `buildAgentCard()` — genera AgentCard desde BotConfig + ToolDefinitions |
| `task-store.ts` | `TaskStore` — CRUD de tasks in-memory con TTL pruning, session grouping |
| `executor.ts` | Headless LLM executor: A2AMessage → ChatMessage → LLM → A2AMessage |
| `server.ts` | `A2AServer` — HTTP JSON-RPC: `message/send`, `tasks/get`, `tasks/cancel`, agent card discovery, directory endpoints |
| `client.ts` | `A2AClient` — HTTP client con agent card caching |
| `client-pool.ts` | `A2AClientPool` — pool de clientes con `discoverAll()` |
| `tool-adapter.ts` | Convierte skills de agentes A2A externos en framework Tools (`a2a_<agent>_<skill>`) |
| `directory.ts` | `AgentDirectory` — registry con heartbeat, stale pruning, skill search |
| `index.ts` | Barrel re-export |

**Integración:**
- Rutas montadas en `src/web/server.ts`
- `A2AServer` creado y gestionado por `BotManager`
- `registerA2aTools()` en `ToolRegistry`
- A2A como transport en `CollaborationManager`
- Config schema con bloques `server`, `clients[]`, `directory`

### Lo que queda (Phase 3 — futuro)

- **Discovery Gateway** — El directory evoluciona para rutear requests por capability match, con load balancing y auth centralizado
- **A2A Streaming** — `message/stream` SSE para tareas largas

---

## Proyecto 9 — Observabilidad operativa y resiliencia del agent loop

**Estado: IMPLEMENTADO (sin commit todavía, 2026-08-21) — karma/traits en progreso**

### Lo que se implementó

- **Stats & Behaviour** (`src/stats/`, `src/web/routes/stats.ts`, `web/pages/stats.js`) — agregaciones de sólo lectura sobre la telemetría en disco, cache de 60 s, tenant-scoped. `GET /api/stats/fleet|bots/:botId|behaviour|infra`. Postura por bot (`computePosture`). UI en `#/stats`, `#/stats/bot/:botId`, `#/stats/behaviour`, `#/stats/infra`, `#/stats/hygiene`.
- **Hygiene** (`src/hygiene/`, `src/web/routes/hygiene.ts`, `web/pages/hygiene.js`) — cinco rutinas deterministas (`goal-lint`, `soul-structure`, `memory-hygiene`, `productions-triage`, `data-cleanup`) + `all`, con preview sin efectos y apply que respalda en `.versions/` y mueve a `_trash/` en lugar de borrar. Historial en `data/hygiene/runs.jsonl`.
- **Agent loop** — `agentLoop.plannerBackend` (el planner/strategist corre sobre el cliente bare del backend elegido; corrige el fallback silencioso de `LLMClientWithFallback.generate()` a Ollama), `BackendCircuitBreaker` fleet-wide por backend (`agentLoop.circuitBreaker`), engagement gate en modo `hard` por defecto alimentado por señales humanas reales (`countFeedbackSignals`, `AgentScheduler.recordFeedbackEvent`).
- **Canal y operador** — `ChannelState` (`ok|revoked|placeholder|missing|error`) expuesto en `/api/agents` y `/api/status`; `bots[].token: null`; `config.operator` con alias `chatId: "operator"` en `send_proactive_message` y `cron`; protocolo `ask_human` (`config.askHuman { maxChars: 600, autoCloseHours: 72 }`, `options` como quick replies, auto-cierre con nota en memoria).
- **Karma por outcomes + política de traits** — `config.karma.rewards` (`novelAction: 0`, `productionApproved: 3`, `productionRejected: -1`, `askAnswered: 2`, `humanReply: 3` con cooldown `humanReplyCooldownHours: 6`, `toolError: -1`), `KarmaService.recordOutcome`, source `engagement`, `getBreakdown` → `breakdown` en `GET /api/karma/:botId` y tabla "Score composition" en el dashboard; `bots[].traits { pinned, locked }` aplicados por `TraitRegisters` (source `'pinned'`, `getDrift`, `traitDrift`/`traitPolicy` en `getEvolutionState`) y guía de traits del strategist des-sesgada.

### Lo que falta

- `rewards.collaborateCompleted` está definido (default 0) pero ningún call site llama a `recordOutcome(…, 'collaborateCompleted')` todavía; subirlo en config no tiene efecto hasta que `CollaborationManager` lo registre.
- **Bug de orden en `FailoverLLMClient` con `failover.enabled`** — el modelo primario de Ollama se pasa como `ollamaClient.toString()` y la cadena de candidatos arranca siempre con Ollama, independientemente del `llmBackend` del bot. El pinning del planner lo esquiva (usa el cliente bare), pero el executor y las conversaciones siguen pasando por la cadena. Corregir la construcción de candidatos para respetar el backend del bot.
- **Feedback de canales no-Telegram** — `requestImmediateRun` registra `human_message` sólo desde el buffer de Telegram; los mensajes entrantes por REST, WebSocket, WhatsApp y Discord todavía no cuentan como feedback para el engagement gate (sí cuentan los mensajes humanos de conversaciones del dashboard). Registrar el evento desde `handleChannelMessage()` para todos los canales.
- `config.operator.notifyOnAsk` está en el schema pero ningún código lo consume todavía.
- `BotManager.getAgentLoopCircuitState()` existe pero ninguna ruta lo expone; la pestaña Infra deriva el estado de los backends del log y del llm-query-log, no del circuito.
- El sweep de `ask_human` (`sweepStaleAskHumanQuestions`) corre en cada llamada a la tool para el bot que llama; no hay un timer periódico que cierre asks de bots que dejaron de preguntar.

---

## Proyecto 10 — Jarvis fleet: UI viva, uso simple, mundo exterior, A2A v1.0

**Estado: PLANIFICADO (2026-09-13) — sin ejecutar**

Plan completo, sesión por sesión, en [`docs/plans/jarvis-fleet-plan.md`](plans/jarvis-fleet-plan.md). Veinte sesiones encadenadas (S0–S19) en cuatro fases: **Life** (Agent Home, presencia, cara y voz), **Simple** (cola "Needs You", wizard de creación, presets, automatizaciones en lenguaje natural, PWA + push), **Outside world** (A2A v1.0 servidor y cliente, directorio federado, canal email, webhooks entrantes, voz entrante, Moltbook endurecido) y **Power** (cliente Anthropic nativo, tareas durables, exec en sandbox, sub-agentes). Cada sesión tiene prompt de arranque, dependencias, pasos, tests, criterio de salida y bloque de handoff; la tabla de estado al final del plan es la fuente de verdad.

Absorbe las ideas "A2A Discovery Gateway" y "A2A Streaming" de abajo (sesiones S10/S11) y el item 4 (subagentes) de `roadmap-inteligencia.md` (sesión S19).

---

## Proyecto 11 — Curiosity Navigator: el ADN curioso de cada bot

**Estado: IMPLEMENTADO (2026-10-03, sin commit todavía) — pendiente deploy (`docker compose up -d --build`)**

Plan y tabla de estado en [`docs/plans/curiosity-navigator-plan.md`](plans/curiosity-navigator-plan.md) (pasos C0–C8). Motivación: ai-perfectionist hizo 18 producciones, 10 sobre su propio harness/tooling, siguiendo como única ruta un mensaje del operador de 15 días; el strategist sólo veía 7 días de logs crudos, la novedad se medía por tipo de acción y nunca por tópico, y los prompts premiaban la inacción.

### Lo que se implementó

- **C0 — plumbing de `ask_human`**: las respuestas del operador sobreviven reinicios y llegan al bot (nota durable en la memoria diaria).
- **ADN** (`src/bot/curiosity/`, encendido por defecto; `agentLoop.curiosity.enabled: false` lo apaga): seis genes (curious, compounding, self-directed, captivating, honest, bold), seis diales de límites por bot (`topic`, `purpose`, `instructions`, `method`, `capability`, `identity` × `closed|ask|open`), presets `focused` / `explorer` (default) / `wild` y un piso que ningún dial desbloquea. Schema `CuriosityConfigSchema` en `agentLoop.curiosity` global y por bot.
- **Knowledge map** (`KNOWLEDGE.json`) llenado por un extractor post-ciclo; **frontier** de preguntas abiertas rankeadas por sorpresa esperada; **explore/exploit** por concentración de tópico, racha sin sorpresa o budget (`exploreRatio`, escalado por el trait `curiosity`, doble con el operador en silencio).
- **Navigator** diario sobre el strategist (`NAVIGATOR.json`): retrospectiva, dirección con 2–3 bets, frontier, limpieza de goals; tras un intento fallido reintenta a los min(`navigatorEvery`, 2 h) (`NAVIGATOR_RETRY_MS`). Directivas del operador con decay (`directiveHalfLifeOutputs` / `directiveHalfLifeDays`), sólo desde superficies del operador: ask_human respondido, feedback del dashboard, el chat privado de Telegram del operador (`operator.telegramChatId`, vía `ConversationPipeline.handleConversation` → `recordOperatorMessage`) y los mensajes que el operador escribe en un hilo de conversación del dashboard (`POST /api/conversations/:botId/:id/messages`). Mensajes < 15 caracteres se ignoran; usuarios públicos (REST/widget/WhatsApp/Discord) nunca dirigen.
- **Dispatches** (`DISPATCHES.jsonl`, `TASTE.json`): formato claim → por qué te importa → evidencia → qué hacer, editor LLM duro + detector de hype, cadencia ganada con 👍/👎 (clicks repetidos no se acumulan), cadena insight → propuesta de interés → propuesta de frontier → digest (digest a lo sumo una vez por `maxIntervalHours`; con la cadencia cerrada el insight se guarda `held` con score heurístico, sin llamar al editor), cap diario de flota del mismo tamaño que `operator.proactiveDailyCap` pero con contador propio en memoria (no compartido con `send_proactive_message`, se resetea al reiniciar), entrega por Telegram vía cualquier instancia viva o el inbox del dashboard (`deliveredVia`; los bots de tenant sólo al inbox; lo entregado sólo al inbox no cuenta como ignorado). `DISPATCHES.jsonl` conserva los 500 más nuevos.
- **Prompts**: PURPOSE ALIGNMENT en lugar de "if unsure, choose inaction"; el engagement check acepta EXPLORATION. La exploración ya no fuerza un pase del strategist: si el strategist corre por su cadencia en un ciclo de exploración recibe el bloque ADN y `skipAlignmentRetry`; si no corre, el focus del planner pasa a `EXPLORATION: <pregunta del frontier>`. Bloque ADN ≤ 6000 chars, directivas ≤ 1500 dentro de él (2500 sueltas), cada una recortada a 300. Begin/finish del runner bajo lock por bot, re-leyendo estado tras cada await; el begin es cancelable por timeout. Las llamadas LLM de curiosidad se registran en el LLM query log (`curiosity:navigator` / `curiosity:extractor` / `curiosity:editor`).
- **Dashboard**: `/api/curiosity` (snapshot por bot, feed de dispatches, señales), sección **Mind** en Agent Home, tab **Dispatches** en Work (`#/work/dispatches`), sección **Curiosity** en el form de edición (validada por `validateCuriosityPatch`).

### Lo que falta

- **Deploy** y observación en vivo: costo real (extractor por ciclo no-idle, editor por candidato con cadencia abierta, navigator diario, todo en el backend del planner) y calidad de los primeros dispatches.
- **Stats de curiosidad** (plan C7, no implementado): diversidad de tópicos en el tiempo, mezcla explore/exploit y tasa de aterrizaje de dispatches en `/api/stats` / `#/insights/stats`.
- **👍/👎 desde Telegram**: no hay forma de calificar un dispatch desde Telegram — sólo desde el dashboard.
- **Metering de tenant**: las llamadas LLM de curiosidad (navigator, extractor, editor) quedan en el LLM query log pero el usage metering por tenant todavía no las cuenta.

---

## Proyecto 12 — UX overhaul del dashboard

**Estado: IMPLEMENTADO (2026-10-03, branch `feat/ux-overhaul`, sin commit todavía) — pendiente deploy (`docker compose up -d --build` por los cambios en `src/`)**

Plan, tabla de estado y follow-ups en [`docs/plans/ux-overhaul-plan.md`](plans/ux-overhaul-plan.md) (fases 0–5): Needs You vaciable (bulk, clear-stale, Undo; `POST /api/needs-you/bulk|act|clear-stale`), bugs de la revisión, un solo lenguaje de feedback (toasts + diálogos en vez de `alert/confirm/prompt`), IA (Feedback sólo en Needs You, Agent loop en Automations, Tools + Tool Runner fusionados, 404 real) y atajos globales (`g`+letra, `/`, `n`, `?`).

---

## Ideas futuras

- **A2A Discovery Gateway** — Evolución del Agent Directory (Proyecto 8 Phase 3): el directorio rutea requests al mejor agente por capability match, con load balancing y auth centralizado
- **A2A Streaming** — Soporte `message/stream` SSE para tareas largas (scraping, razonamiento multi-step). A2A Phase 1+2 ya están implementados
- **Integración con APIs de calendario de terceros** — Más allá de Calendly/Google: Outlook Calendar, Cal.com
- **Social media posting pipeline** — Composición de contenido → revisión humana → publicación coordinada en Twitter + Reddit
- **Productions — refresh `Created` timestamp on `file_edit`** — currently `tool-executor.ts` calls `injectFrontmatter` only on `file_write`, not on `file_edit`. After a heavy edit the dashboard displays a misleadingly old "Created" date. Out of scope for the `productions/service.ts` split (Cycle 0–9 plan) but worth a separate fix later. References: `src/bot/tool-executor.ts:662–729`, `src/productions/service.ts:555–606` (`Frontmatter.injectFrontmatter`).
- Ver Proyectos 4-7 arriba para las integraciones planificadas con estado y próximos pasos

---

*Este documento se actualiza a medida que avanzan los proyectos.*
