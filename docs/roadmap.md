# Roadmap

Documento vivo para trackear features futuras, ideas y estado de proyectos en progreso.
Última actualización: 2026-03-16.

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

## Ideas futuras

- **A2A Discovery Gateway** — Evolución del Agent Directory (Proyecto 8 Phase 3): el directorio rutea requests al mejor agente por capability match, con load balancing y auth centralizado
- **A2A Streaming** — Soporte `message/stream` SSE para tareas largas (scraping, razonamiento multi-step). A2A Phase 1+2 ya están implementados
- **Integración con APIs de calendario de terceros** — Más allá de Calendly/Google: Outlook Calendar, Cal.com
- **Social media posting pipeline** — Composición de contenido → revisión humana → publicación coordinada en Twitter + Reddit
- Ver Proyectos 4-7 arriba para las integraciones planificadas con estado y próximos pasos

---

*Este documento se actualiza a medida que avanzan los proyectos.*
