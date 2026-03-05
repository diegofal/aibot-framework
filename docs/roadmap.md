# Roadmap

Documento vivo para trackear features futuras, ideas y estado de proyectos en progreso.
Última actualización: 2026-03-05.

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

**Estado: Investigación temprana**

### Contexto

El bot está actualmente acoplado a grammy/Telegram. La abstracción existente es mínima:
- `TelegramClient` interface en `src/core/types.ts` (línea 41) — define `sendMessage`, `sendDocument`, `answerCallbackQuery`, `editMessageText`.
- Todos los handlers usan directamente el contexto de grammy (`telegramCtx`).

### Opciones de integración

**Opción A: WhatsApp Business API (Cloud API via Meta)**
- API oficial de Meta, gratis para mensajes iniciados por el usuario (24h window)
- Requiere Facebook Business account y número verificado
- Webhook-based, similar a Telegram en concepto
- Limitaciones: templates obligatorios para mensajes fuera de la ventana de 24h, approval process

**Opción B: WhatsApp Business API via proveedor (Twilio, MessageBird, etc.)**
- Twilio ya está parcialmente integrado (phone calls) — podría reutilizar credenciales
- API más amigable que la de Meta directamente
- Costo adicional por mensaje sobre el costo de Meta

**Opción C: Librería open-source (whatsapp-web.js, Baileys)**
- Sin costo de API, usa WhatsApp Web como bridge
- Riesgo de ban por Terms of Service de WhatsApp
- Inestable — depende de reverse engineering del protocolo
- No recomendado para producción

### Nivel de refactoring necesario

1. **Abstracción de plataforma** — Generalizar `TelegramClient` a una interface `MessagingPlatform` que soporte Telegram y WhatsApp
2. **Handler abstraction** — Los handlers de grammy (`bot.on('message:text')`, etc.) necesitan un adapter layer
3. **Media handling** — WhatsApp tiene su propio sistema de media IDs, download URLs, y formatos soportados
4. **Session management** — Adaptar session keys para manejar chat IDs de WhatsApp
5. **Skills** — Algunas skills usan features específicas de Telegram (inline keyboards, callback queries) que no tienen equivalente directo en WhatsApp

### Próximos pasos

1. Definir si vale la pena el refactoring o si es mejor un bot WhatsApp separado que comparta el core (LLM, tools, memoria)
2. Si se refactoriza: diseñar la interface `MessagingPlatform` y el adapter pattern
3. Elegir proveedor de WhatsApp API
4. POC con un echo bot mínimo

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

**Estado: Investigación futura — Diferido**

### Nota

Requiere refactor multi-canal: una interface `Channel` abstracta que soporte Telegram, WhatsApp (Proyecto 3) y Discord bajo un adapter pattern unificado. No tiene sentido implementar Discord antes de tener esa abstracción.

### Referencia

- OpenClaw usa `ChannelPlugin` con `api.registerChannel()` para soportar múltiples plataformas
- Librería probable: `discord.js`
- Ver Proyecto 3 (WhatsApp) para el diseño de la abstracción multi-canal

### Próximos pasos

1. Completar la abstracción `MessagingPlatform` del Proyecto 3
2. Evaluar discord.js como ChannelPlugin
3. POC con un bot echo mínimo en Discord

---

## Ideas futuras

- **Multi-canal unificado** — Interface `Channel` abstracta que permita conectar Telegram, WhatsApp, Discord y futuros canales sin duplicar lógica (prerequisito para Proyectos 3 y 7)
- **Integración con APIs de calendario de terceros** — Más allá de Calendly/Google: Outlook Calendar, Cal.com
- **Social media posting pipeline** — Composición de contenido → revisión humana → publicación coordinada en Twitter + Reddit
- Ver Proyectos 4-7 arriba para las integraciones planificadas con estado y próximos pasos

---

*Este documento se actualiza a medida que avanzan los proyectos.*
