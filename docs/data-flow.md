# Data Flow — Flujo de Datos

Cómo fluye un mensaje desde su recepción hasta la respuesta del bot, pasando por cada módulo del sistema.

---

## Resumen Visual

```
Telegram Message
  → Grammy Bot
  → HandlerRegistrar
    → /command → Skill handler → reply
    → callback_query → Skill callback → reply
    → Built-in commands → reply
    → message:text →
        trackUser()
        skip if consumed by skill
        bot-to-bot collaboration gate
        authorization check
        group activation gate
        strip @mentions
        messageBuffer.enqueue()
          → dedup
          → Layer 1: inbound debounce (merge rapid messages)
          → Layer 2: followup queue (if bot busy)
          → dispatch() → ConversationPipeline.handleConversation()
              → start RAG prefetch (parallel)
              → session expiry check → memory flush if needed
              → proactive memory flush (fire-and-forget)
              → load history from JSONL
              → await RAG results
              → SystemPromptBuilder.build()
              → assemble messages [system, ...history, user]
              → typing indicator
              → LLM chat (tool loop: up to maxToolRounds)
              → sendLongMessage() → Telegram reply
              → persist to session JSONL
              → refresh reply window (groups)
    → message:photo/document/voice →
        (mismo flujo con MediaHandler pre-processing)
```

---

## 1. Inicialización (Startup)

Cuando se construye `BotManager` (`src/bot/bot-manager.ts`):

1. **Infraestructura compartida**: `AgentRegistry`, `CollaborationTracker`, `CollaborationSessionManager`, `MediaHandler`
2. **Módulos en orden de dependencia**:
   ```
   ToolRegistry → SystemPromptBuilder → MemoryFlusher → GroupActivation
     → ConversationPipeline → CollaborationManager → HandlerRegistrar → AgentLoop
   ```
3. **ToolRegistry.initializeAll()**: Crea todas las tools. Delegation/collaboration reciben lazy callbacks `() => collaborationManager`
4. **MessageBuffer**: Se crea con callback a `ConversationPipeline.handleConversation`

### Per-Bot Startup (`startBot()`)

1. Grammy `Bot` instance creada
2. `LLMClient` per-bot (Ollama, Claude CLI, o fallback composite)
3. `SoulLoader` per-bot inicializado (lee IDENTITY, SOUL, etc.)
4. `HandlerRegistrar.registerAll(bot, config)` registra handlers Grammy
5. Polling inicia; bot registrado en `AgentRegistry`

---

## 2. Llegada del Mensaje y Routing

### Orden de Registro de Handlers (`src/bot/handler-registrar.ts`)

| Prioridad | Handler | Descripción |
|-----------|---------|-------------|
| 1 | Skill commands | `/command` de cada skill |
| 2 | Callback queries | Botones inline, routing por `skillId:data` |
| 3 | Built-in commands | `/start`, `/help`, `/clear`, `/model`, `/who`, `/memory` |
| 4 | Conversation handler | Catch-all para texto (debe ser último) |

### Intercepción por Skills

Los skills pueden registrar handlers `onMessage` que corren como middleware Grammy (antes del conversation handler). Si un skill retorna `true` (consumido), el messageId se guarda en `handledMessageIds`. El conversation handler verifica este set y salta mensajes consumidos.

### User Tracking

Cada mensaje entrante dispara `trackUser(ctx)`, que registra `{ id, firstName, username, lastSeen }` por chat. Alimenta el comando `/who`.

---

## 3. Gates de Seguridad

### Autorización

```
if config.allowedUsers is empty → allow all
else → userId must be in allowedUsers list
```

### Bot-to-Bot Collaboration Gate

Si el sender es un bot registrado (via `agentRegistry.getByTelegramUserId()`):

1. Collaboration deshabilitada globalmente → skip
2. Mensaje NO @menciona a este bot → skip (bots solo responden si son mencionados)
3. `CollaborationTracker.checkAndRecord()` enforcea rate limits:
   - Tracks exchange depth por par de bots por chat
   - Bloquea si `maxRounds` excedido y cooldown no ha pasado
4. Si permitido → procesa como `isPeerBotMessage = true`

**CollaborationTracker** (`src/collaboration-tracker.ts`): Key sorted por par de bots por chat, max rounds con cooldown, sweep de records stale cada 60s.

---

## 4. Group Activation Gate

Para chats grupo/supergrupo cuando `isPeerBotMessage` es false:

### Paso 1: shouldRespondInGroup() (`src/session.ts`)

Checks en orden, retorna el primer resultado truthy:

| Razón | Condición |
|-------|-----------|
| `'always'` | Config `groupActivation = 'always'` |
| `'replyToBot'` | Mensaje es reply a un mensaje de este bot |
| `'mention'` | Mensaje contiene `@botusername` entity |
| `'mentionPattern'` | Mensaje matchea un `mentionPatterns` (case-insensitive, whole-word) |
| `'replyWindow'` | Usuario tiene conversación activa (dentro de `replyWindow` minutos) |
| `false` | Ninguna condición met |

### Paso 2: Deference Check

Si la razón NO es `'mention'` o `'replyToBot'`: verifica si el mensaje @menciona a otro bot registrado. `GroupActivation.messageTargetsAnotherBot()` escanea entities del mensaje. Si encuentra otro agente → este bot cede.

### Paso 3: LLM Relevance Check

Cuando la razón es `'replyWindow'` y `llmRelevanceCheck` está habilitado: `GroupActivation.checkLlmRelevance()` envía contexto reciente + nuevo mensaje al LLM. Multi-bot aware: incluye descripciones de otros bots. **Fail-open**: en error/timeout, default = responder.

### Paso 4: Broadcast Relevance Check

Cuando ninguna condición de activación se cumplió pero `broadcastCheck` está habilitado: `GroupActivation.checkBroadcastRelevance()` pregunta al LLM si el mensaje va dirigido a todos (ej: "presentense", "bots"). **Fail-closed**: en error/timeout, default = NO responder.

---

## 5. Pre-Procesamiento del Mensaje

### Stripping de Mentions

En grupos, `@botusername` y los `mentionPatterns` se stripean del texto para un prompt LLM más limpio.

### Procesamiento de Media (`src/media.ts`)

| Tipo | Procesamiento |
|------|---------------|
| **Fotos** | Variante de mayor resolución descargada, convertida a base64 |
| **Documentos** | PDF, text, markdown, CSV, JSON, HTML — contenido extraído (max 50K chars) |
| **Voz** | Audio descargado y transcrito via Whisper STT |

Cada handler produce un `MediaResult` con `text` (para LLM), `images` (base64, opcional), y `sessionText` (texto limpio para transcript).

---

## 6. Message Buffer (Cola de 2 Capas)

Todos los mensajes pasan por `MessageBuffer` (`src/message-buffer.ts`) antes del pipeline.

### Entry Point: `enqueue(entry)`

1. Dedup check (por messageId, cap de 250 mensajes vistos)
2. Si el bot está busy con esta sesión → enqueue como followup (Capa 2)
3. Si es media o debounce deshabilitado → dispatch inmediato
4. Else → buffer con debounce timer (Capa 1)

### Capa 1: Inbound Debounce

Cuando un usuario envía múltiples mensajes rápido (dentro de `inboundDebounceMs`):
- Mensajes se acumulan en buffer per-session
- Timer se resetea con cada nuevo mensaje
- Cuando el timer dispara: textos concatenados con `\n`, imágenes combinadas

### Capa 2: Followup Queue

Cuando llega un mensaje mientras el LLM ya está procesando:
- Mensajes encolados (hasta `queueCap`; el más viejo se descarta si lleno)
- Cuando la tarea LLM activa completa, la cola se drena
- Mensajes múltiples se mergean con separadores numerados:
  ```
  [Mensajes adicionales enviados mientras respondias]
  ---
  #1: primer mensaje
  ---
  #2: segundo mensaje
  ```

### Dispatch

Entry mergeado se envía a `ConversationPipeline.handleConversation()`. Una sola llamada LLM activa por session key. Tras completar, `tryDrainQueue()` verifica followups pendientes.

---

## 7. Conversation Pipeline (Core)

`ConversationPipeline.handleConversation()` (`src/bot/conversation-pipeline.ts`) es el corazón del sistema.

### 7.1 Resolución de Config

`resolveAgentConfig(globalConfig, botConfig)` mergea defaults globales con overrides per-bot para model, temperature, maxHistory, systemPrompt, soulDir, llmBackend.

### 7.2 RAG Pre-Fetch (en paralelo)

Inicia `prefetchMemoryContext()` inmediatamente (corre en paralelo con checks de sesión):

1. Guards: RAG habilitado, search disponible, memoryManager existe, query >= 8 chars
2. Strip group prefix: Remueve `[Name]: ` prefix
3. **Búsqueda híbrida** via `MemoryManager.search()`:
   - **Vector search**: Cosine similarity contra embeddings en SQLite
   - **Keyword search (FTS5)**: BM25 ranking, stop words (ES + EN), prefix matching
   - **Score merging**: `vectorWeight * vectorScore + keywordWeight * keywordScore`
4. Filtrado: Excluye daily logs de hoy/ayer (ya en prompt) y resultados de sesión
5. Cap de contenido: Límite a `maxContentChars` (default 2000)
6. Output: String formateado con paths y scores, o null

### 7.3 Session Expiry Check

Si las sesiones están habilitadas:
1. `sessionManager.isExpired()` verifica:
   - **Daily reset**: Última actividad antes de la hora de reset configurada
   - **Idle reset**: Tiempo idle excede minutos configurados
2. Si expirada Y soul habilitado: obtiene historial completo, flushea a memoria, limpia sesión

### 7.4 Proactive Memory Flush

Si `memoryFlush` habilitado y `messageThreshold` excedido desde último flush:
- Obtiene historial completo
- Marca sesión como flushed
- Llama `memoryFlusher.flushToDaily()` fire-and-forget
- Solo se dispara una vez por ciclo de compactación

### 7.5 Carga de Historial

Carga últimos `maxHistory` mensajes del archivo JSONL de transcript.

### 7.6 Await RAG

Se espera el resultado del `ragPromise` del paso 7.2.

### 7.7 Composición del System Prompt

`SystemPromptBuilder.build()` (`src/bot/system-prompt-builder.ts`) ensambla el prompt en capas:

```
┌─────────────────────────────────┐
│  1. Soul base prompt             │
│     IDENTITY → SOUL →            │
│     MOTIVATIONS → GOALS →        │
│     legacy.md → daily logs       │
├─────────────────────────────────┤
│  2. Humanizer prompt (si on)     │
├─────────────────────────────────┤
│  3. Tool instruction blocks      │
│     (uno por grupo de tools)     │
├─────────────────────────────────┤
│  4. Group chat awareness         │
├─────────────────────────────────┤
│  5. RAG context injection        │
│     (cerca del final = recency)  │
├─────────────────────────────────┤
│  6. Memory search reminder       │
└─────────────────────────────────┘
```

**Fallback**: Si no hay archivos soul, usa `config.conversation.systemPrompt`.

**Tres modos**: `conversation` (tools completas), `collaboration` (solo memory_search + save_memory), `autonomous` (tools + preámbulo autónomo).

### 7.8 Ensamblado de Mensajes

```typescript
[
  { role: 'system', content: systemPrompt },
  ...history,
  { role: 'user', content: prefixedText, images? }
]
```

En grupos, texto prefijado: `[SenderName]: message text`.

### 7.9 Typing Indicator

Acción `typing` enviada inmediatamente y refrescada cada 4 segundos.

### 7.10 LLM Call con Tool Loop

```typescript
response = await llmClient.chat(messages, {
  model, temperature, tools, toolExecutor, maxToolRounds
});
```

**Jerarquía de LLM Clients** (`src/core/llm-client.ts`):

| Client | Características |
|--------|----------------|
| `OllamaLLMClient` | API directa Ollama, soporta tools |
| `ClaudeCliLLMClient` | Subprocess Claude CLI, NO soporta tools |
| `LLMClientWithFallback` | Primary + fallback; smart routing: tool requests con Claude CLI → Ollama |

**Tool Loop** (`src/ollama.ts`):

```
for round = 0 to maxToolRounds:
  if lastRound: omit tools (forzar texto)
  send to Ollama /api/chat
  if tool_calls:
    append assistant message
    execute each tool via toolExecutor
    append tool results
    continue
  else:
    return text response
```

**Tool Executor** (`src/bot/tool-registry.ts`): Verifica disabled tools, encuentra tool por nombre, inyecta `_chatId` y `_botId`, llama `tool.execute()`.

**Fallback de modelo**: Si el modelo primario falla, Ollama intenta cada modelo en el array `fallbacks`.

### 7.11 Manejo de Respuesta

- Respuesta no vacía: Split en chunks ≤ 4096 chars (límite Telegram) via `sendLongMessage()`, cortando en newlines
- Respuesta vacía: Envía checkmark de acknowledgment

### 7.12 Persistencia de Sesión

User message y assistant response se appendan al transcript JSONL. Tras appendar, check de compactación: si el transcript excede `2 × maxHistory` líneas, mantiene solo las últimas `maxHistory`.

### 7.13 Refresh de Reply Window

En grupos, tras reply exitoso: `sessionManager.markActive(botId, chatId, userId)`. Esto abre una ventana de reply para mensajes subsiguientes sin mención explícita.

---

## 8. Gestión de Sesiones

### Session Key

`{ botId, chatType, chatId, userId, threadId? }` → serializado como `bot:{botId}:{chatType}:{chatId}` o `bot:{botId}:private:{userId}`.

### Almacenamiento de Transcripts

Archivos `.jsonl` en `{dataDir}/transcripts/`, un `ChatMessage` JSON por línea. Basado en archivos (sin database).

### Reset Policies

| Policy | Trigger |
|--------|---------|
| Daily | Última actividad antes de la hora de reset configurada |
| Idle | Tiempo idle excede N minutos |

En expiración: flush a memoria, luego clear.

### Active Conversations

`Map<"botId:chatId:userId", timestamp>` in-memory. Persistido a `active-conversations.json` con writes debounceados a 2s. Entries expiran tras `replyWindow` minutos (0 = nunca).

---

## 9. Persistencia de Memoria

### Pipeline de Memory Flush (`src/bot/memory-flush.ts`)

1. Formatea historial como transcript: `user: ...\nassistant: ...`
2. Envía al LLM: "Summarize into key facts, preferences, context worth remembering"
3. Prefiere Claude CLI si configurado, fallback a Ollama
4. Escribe a `{soulDir}/memory/{YYYY-MM-DD}.md` via `SoulLoader.appendDailyMemory()`
5. Cada entry con timestamp: `- [HH:MM] summary text`
6. Patrones sensibles (API keys, tokens, teléfonos) auto-redactados

### Triggers de Flush

| Trigger | Timing | Blocking? |
|---------|--------|-----------|
| Session expiry | Antes de limpiar sesión | Sí |
| Proactive flush | Durante handleConversation | No (fire-and-forget) |
| `/clear` command | Antes de limpiar todas las sesiones | Sí |
| Agent loop completion | Tras finalizar executor | No (sync append) |

---

## 10. Flujos de Colaboración

### Visible (`src/bot/collaboration.ts`)

Bot source envía `@targetBot message` en grupo. `processVisibleResponse()` maneja multi-turn alternando hasta `visibleMaxTurns`. Cada turno: genera respuesta con prompt collaboration-mode, envía al grupo, persiste en sesión del bot respondedor.

### Internal

`collaborationStep()`: rate limit check, crear/obtener sesión (UUID), invocar target LLM con system prompt + session history + collaboration-safe tools (sin collaborate/delegate). Respuesta retornada al tool call del source bot. Multi-turn via `sessionId`.

### Delegation

`handleDelegation()`: Resuelve target bot, invoca target LLM SIN tools (previene loops), system prompt incluye contexto de delegación, respuesta enviada al chat Telegram.

### Programmatic Multi-Turn

`initiateCollaboration()`: Source maneja loop multi-turn. Source evalúa respuesta del target cada turno. Detección de `[DONE]` para terminar temprano. Transcript completo construido y retornado.

---

## 11. Agent Loop (Ejecución Autónoma)

Ver [docs/autonomy-roadmap.md](autonomy-roadmap.md) para detalles completos.

### Resumen del Flujo

```
Timer dispara → para cada bot activo:
  1. Planner: LLM decide si actuar (JSON: should_act, reasoning, plan)
  2. Si should_act=true:
     Executor: LLM agéntico con tools ejecuta plan
  3. Post-ejecución: summary → daily memory, report → reportChatId
```
