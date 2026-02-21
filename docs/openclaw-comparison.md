# OpenClaw vs AIBot — Análisis Comparativo

> Qué agregar, qué simplificar, y qué ya tenemos que OpenClaw no tiene.

---

## Contexto

OpenClaw es un gateway multi-canal (~80K+ LOC) orientado a un asistente personal single-user.
AIBot es un framework multi-bot para Telegram con personalidad persistente, autonomía y colaboración.

**Filosofía distinta**: OpenClaw es un *gateway genérico* (muchos canales, muchos providers, plugins para todo). AIBot es un *sistema de agentes con personalidad* (soul, goals, reflexión, colaboración). Son complementarios, no competidores directos.

---

## 1. QUÉ AGREGAR (de OpenClaw)

### 1.1 Multi-Provider LLM (Prioridad: CRÍTICA)

**OpenClaw tiene**: 20+ providers (Anthropic, OpenAI, Google, Bedrock, Together, Ollama, GitHub Copilot, etc.) con auth profile rotation, failover automático, y model catalog con descubrimiento dinámico.

**AIBot tiene**: Ollama + Claude CLI (subprocess) + `LLMClientWithFallback`. Sin API nativa de cloud.

**Qué implementar**:
- Interface `LLMProvider` unificada con `chat()`, `generate()`, `embed()`, `stream()`
- Adaptadores: Anthropic SDK, OpenAI SDK, Google Gemini, Ollama (ya existe)
- Auth profile con rotation y cooldown ante rate limits
- Transformación de tool schemas por provider (cada API tiene quirks)
- Model catalog con capabilities (vision, tools, context window, streaming)

**Impacto**: Acceso a los mejores modelos del mercado. Es el cuello de botella #1 de inteligencia.

---

### 1.2 Context Compaction (Prioridad: CRÍTICA)

**OpenClaw tiene**: `compaction.ts` (~500 LOC) — cuando se acerca al límite de la ventana de contexto, divide el historial en chunks por token share, resume los chunks viejos con el propio LLM, y los fusiona. Retry con backoff. Context window guard con min/warn/block thresholds.

**AIBot tiene**: Sliding window fijo de `maxHistory` (default 20) mensajes. Memory flush a daily logs. Sin estimación de tokens.

**Qué implementar**:
- Token estimation (tiktoken o heurística)
- Context window awareness: saber cuántos tokens quedan disponibles
- Compactación automática: resumir mensajes viejos cuando se acerca al límite
- Inyección del resumen como "Previously:" al inicio
- Config: umbral de activación, tokens reservados, modelo para resumir

**Impacto**: Conversaciones de horas sin perder el hilo. Hoy después de ~20 mensajes se pierde contexto.

---

### 1.3 Tool Loop Detection (Prioridad: ALTA)

**OpenClaw tiene**: `tool-loop-detection.ts` (~600 LOC) — sistema sofisticado con 4 detectores:
- `generic_repeat`: tool + args idénticos repetidos
- `known_poll_no_progress`: poll sin cambio de resultado
- `ping_pong`: alternancia A→B→A→B sin progreso
- `global_circuit_breaker`: límite absoluto

Cada uno con thresholds warning/critical configurables, hashing de tool calls y outcomes.

**AIBot tiene**: Solo `maxToolRounds` (hard limit de 5-10 rounds). Sin detección de patrones.

**Qué implementar**:
- Hash de tool calls (name + args digest)
- Hash de outcomes (resultado para detectar no-progress)
- Detección de loops repetitivos y ping-pong
- Warning injection al LLM antes de critical block
- Circuit breaker global configurable

**Impacto**: El agent loop y las conversaciones con tools desperdician tokens en loops infinitos. Esto lo corta temprano.

---

### 1.4 Streaming de Respuestas (Prioridad: ALTA)

**OpenClaw tiene**: Streaming a nivel de token con `pi-embedded-subscribe.ts` — block streaming, soft chunks con paragraph preference, fenced code block awareness, tool execution interleaving.

**AIBot tiene**: Espera respuesta completa. El usuario ve "typing..." por 30-60 segundos.

**Qué implementar**:
- `stream: true` en Ollama API (ya lo soporta)
- Buffer con flush periódico (~500ms o N tokens)
- `editMessageText` en Telegram para actualizar progresivamente
- Pausar stream durante tool calls, mostrar indicador de "ejecutando tool"

**Impacto**: UX dramáticamente mejor. Se siente más rápido y responsivo.

---

### 1.5 Plugin/Hook System (Prioridad: ALTA)

**OpenClaw tiene**: Plugin API completa (`OpenClawPluginApi`) con 18 hook points en el lifecycle:
- `before_model_resolve`, `before_prompt_build`, `before_agent_start`
- `llm_input`, `llm_output`, `agent_end`
- `before_compaction`, `after_compaction`, `before_reset`
- `message_received`, `message_sending`, `message_sent`
- `before_tool_call`, `after_tool_call`, `tool_result_persist`
- `before_message_write`, `session_start`, `session_end`
- `gateway_start`, `gateway_stop`

Plugins pueden registrar: tools, hooks, HTTP handlers, CLI commands, services, channels, providers, commands.

**AIBot tiene**: Skills con commands/handlers/jobs, pero sin hooks en el pipeline. El pipeline es monolítico.

**Qué implementar** (versión pragmática):
- Hook system con eventos clave: `before_llm_call`, `after_llm_call`, `before_tool_call`, `after_tool_call`, `session_start`, `session_end`, `message_received`, `message_sent`
- Los skills existentes migran a registrar hooks además de commands
- No necesitamos la complejidad completa de OpenClaw (HTTP handlers, CLI, providers) — somos Telegram-only

**Impacto**: Extensibilidad sin tocar el core. Los skills podrían interceptar y modificar el pipeline.

---

### 1.6 Subagents / Dynamic Agent Spawning (Prioridad: MEDIA)

**OpenClaw tiene**: `subagent-spawn.ts` — spawn de sub-agentes con su propia sesión, modelo, thinking level, timeout, y auto-announce al completar. Depth limits para prevenir recursión infinita. Registry de subagents activos con lifecycle management.

**AIBot tiene**: Colaboración bot-to-bot (visible/internal/delegation) entre bots pre-configurados. No hay spawn dinámico.

**Qué implementar**:
- Spawn de sub-agentes efímeros para tareas específicas
- Depth limits y timeout
- El agent loop podría spawnar sub-tareas
- Registry de agentes activos con cleanup

**Impacto**: Divide-and-conquer para tareas complejas. El agent loop hoy es single-threaded.

---

### 1.7 Memory: MMR + Temporal Decay (Prioridad: MEDIA)

**OpenClaw tiene**:
- **MMR (Maximal Marginal Relevance)**: Re-ranking que balancea relevancia con diversidad. Evita que los resultados de búsqueda sean todos sobre lo mismo.
- **Temporal Decay**: Exponential decay con half-life configurable. Memorias recientes tienen más peso que las viejas.
- **Query Expansion**: Extrae keywords de queries conversacionales para mejorar FTS.
- **Batch embeddings**: Genera embeddings en lotes para eficiencia.

**AIBot tiene**: Hybrid search (vector + FTS5) con weights fijos. Sin diversity ni recency bias. Sin batch.

**Qué implementar**:
- Temporal decay con half-life configurable (exponential decay por fecha del archivo)
- MMR para diversidad en resultados
- Batch embedding para reindexar eficientemente
- Query expansion para mejorar búsquedas conversacionales

**Impacto**: Memoria más inteligente. Hoy puede devolver 3 resultados del mismo día y perder info diversa.

---

### 1.8 Sandbox / Tool Safety (Prioridad: MEDIA)

**OpenClaw tiene**: Docker-based sandboxing completo — containers por sesión, tool policies por agente, path restrictions, browser sandbox separado. `dangerous-tools.ts` con audit trail.

**AIBot tiene**: Deny lists builtin en `exec`, path validation en file tools, SSRF protection en web fetch. Sin sandboxing real.

**Qué implementar** (pragmático):
- Tool policies configurables por bot (más granulares que `disabledTools`)
- Audit log de tool executions (ya tenemos log parcial en agent loop)
- Opcional: ejecución de `exec` tool en container Docker

**Impacto**: Seguridad mejorada sin perder funcionalidad.

---

### 1.9 Token Usage Tracking (Prioridad: BAJA)

**OpenClaw tiene**: `usage.ts` con tracking de input/output/cache tokens por request, per-profile cost aggregation.

**AIBot tiene**: Nada. No sabemos cuántos tokens consume cada bot/conversación.

**Qué implementar**:
- Capturar usage de Ollama API responses (ya incluyen token counts)
- Persistir per-bot/per-day aggregates
- Dashboard widget con consumo

**Impacto**: Visibilidad operacional. Importante cuando se agreguen providers de pago.

---

## 2. QUÉ YA TENEMOS QUE OPENCLAW NO TIENE

Estas son ventajas competitivas de AIBot que NO existen en OpenClaw:

| Feature | AIBot | OpenClaw |
|---------|-------|----------|
| **Soul system** (IDENTITY, SOUL, MOTIVATIONS, GOALS) | ✅ Layered, per-bot, versionado | ❌ Solo un "workspace" con bootstrap files |
| **Self-reflection** (nightly, multi-phase) | ✅ Mirror→Explorer→Architect pipeline | ❌ No tiene |
| **Agent loop** (autonomous planner-executor) | ✅ Planner→Executor con goals awareness | ❌ No tiene autonomía proactiva |
| **Bot-to-bot collaboration** (visible + internal + delegation) | ✅ Multi-mode con session mgmt | ❌ Solo subagents (parent→child) |
| **Dynamic tool creation** (bots crean tools, human approval) | ✅ TypeScript/command, hot-load, web UI review | ❌ No tiene |
| **Goal tracking** (persistent, priority, CRUD) | ✅ manage_goals + GOALS.md | ❌ No tiene sistema de goals |
| **Memory flush summarization** | ✅ LLM summariza sesión → daily logs | ❌ Memory solo indexa archivos |
| **AI soul generation** | ✅ Claude CLI genera personality para nuevos bots | ❌ No tiene |
| **Self-improvement** (`improve` tool) | ✅ Spawn Claude Code para mejorar soul | ❌ No tiene |
| **Group intelligence** (deference, LLM relevance, broadcast) | ✅ 5 activation triggers + multi-bot deference | Parcial (mention gating, reply tags) |

**Conclusión**: No tirar estas ventajas. Son lo que hace a AIBot único.

---

## 3. QUÉ SIMPLIFICAR / ORDENAR EN AIBOT

### 3.1 Módulos del Bot Core: ¿Demasiados Archivos?

**Estado actual**: 10 archivos en `src/bot/` + barrel index.

**Diagnóstico**: La modularización actual es **correcta en diseño** pero tiene overhead innecesario:

- `handler-registrar.ts` (650+ LOC) es el módulo más grande y hace demasiado: auth, routing, media, skills, commands, bot-to-bot gate. Debería separarse en sub-responsabilidades.
- `group-activation.ts` y `memory-flush.ts` son módulos small pero bien enfocados — OK.
- `BotManager` (facade) es slim como debe ser — OK.

**Recomendación**: No reducir módulos; **dividir `handler-registrar.ts`** en:
- `auth-gate.ts`: Authorization y bot-to-bot gate
- `media-handler.ts`: Photo/document/voice processing (ya está en `src/media.ts`, pero el handler wrapping está en handler-registrar)
- `command-handlers.ts`: Built-in commands (/start, /help, /clear, etc.)
- `message-router.ts`: Slim router que orquesta los gates y delega

---

### 3.2 LLM Client: Simplificar la Cadena de Fallback

**Estado actual**: `OllamaClient` (raw) → `OllamaLLMClient` (wraps) → `ClaudeCliLLMClient` → `LLMClientWithFallback` (composite). Además, `ollama.ts` tiene el tool loop hardcodeado dentro de `chat()`.

**Problemas**:
- El tool loop está en `OllamaClient.chat()` — debería estar una capa arriba (pipeline level)
- `ClaudeCliLLMClient` no soporta tools, entonces `LLMClientWithFallback` tiene smart routing hardcodeado
- Cuando se agreguen más providers, esta estructura no escala

**Recomendación**: Refactor a:
```
LLMProvider (interface: chat, stream, embed)
  ├── OllamaProvider
  ├── AnthropicProvider
  ├── OpenAIProvider
  └── FallbackProvider (wraps N providers con failover)

ToolRunner (standalone, provider-agnostic)
  - Recibe provider + tools + messages
  - Ejecuta el tool loop
  - Retorna final response
```

El tool loop sale de `ollama.ts` y va a un `ToolRunner` genérico que funciona con cualquier provider.

---

### 3.3 Session: Datos Dispersos

**Estado actual**: Session data está repartido en:
- `data/sessions/transcripts/` (JSONL)
- `data/sessions/sessions.json` (metadata)
- `data/sessions/active-conversations.json` (reply windows)
- `data/memory.db` (SQLite para search index)
- `config/soul/{botId}/memory/` (daily logs)

**Problema**: 5 ubicaciones distintas para datos relacionados. No hay un solo source of truth.

**Recomendación**: Consolidar a SQLite:
- Transcripts → tabla `messages` (ya indexamos en SQLite para RAG)
- Metadata → tabla `sessions`
- Active conversations → tabla `active_conversations`
- Mantener daily logs como archivos (son parte del soul, no de la sesión)
- Eliminar JSONL y JSON files; usar SQLite como single store

**Impacto**: Una sola base de datos, queries más eficientes, sin file-based state management.

---

### 3.4 Config: Zod Schema Gigante

**Estado actual**: `src/config.ts` tiene un Zod schema monolítico que valida TODO el config, incluyendo `resolveAgentConfig()` que mezcla bot overrides. El config es un JSON plano con muchos niveles de nesting.

**Problema**: Difícil de extender. Cada feature nueva agrega más nesting al schema.

**Recomendación** (no urgente, pero preparar para plugins):
- Modularizar el schema: cada módulo declara su propio sub-schema
- Agregar `plugins` section al config para futuro hook system
- Mantener el Zod validation pero compositional

---

### 3.5 Tools Duplicados: Soul Tools

**Estado actual**: `src/tools/soul.ts` tiene 3 tools (`save_memory`, `update_soul`, `update_identity`) que son wrappers thin sobre `SoulLoader`. `src/tools/goals.ts` también wraps `SoulLoader`.

**Problema**: No es grave, pero los tools son tan thin que podrían consolidarse:
- `save_memory` → 10 LOC útiles
- `update_soul` → 5 LOC útiles
- `update_identity` → 15 LOC útiles

**Recomendación**: Mantener separados (son tools distintos para el LLM) pero podrían vivir en un solo archivo `soul-tools.ts` en vez de `soul.ts` + `goals.ts`.

---

### 3.6 Agent Loop Prompts: Acoplamiento Rígido

**Estado actual**: `agent-loop-prompts.ts` genera prompts con string concatenation y tiene la lógica de decisión del planner hardcodeada.

**Problema**: No es modular. Si se quiere cambiar la estrategia del planner (ej: usar un modelo diferente, agregar criterios), hay que tocar el template string.

**Recomendación**: Extraer a templates configurables o al menos separar:
- `planner-prompt-template.ts`: Template con slots
- `executor-prompt-template.ts`: Template con slots
- Los slots se llenan desde config/soul/context sin tocar el template

---

## 4. PLAN DE EJECUCIÓN SUGERIDO

### Fase 1: Foundations (las críticas)
1. **Multi-Provider LLM** + refactor LLM client chain
2. **Context Compaction** (requiere token estimation)
3. **Tool Loop Detection** (relativamente standalone)

### Fase 2: UX + Extensibilidad
4. **Streaming** (depende de multi-provider refactor)
5. **Hook System** (lightweight, prepara para plugins)
6. **Session consolidation a SQLite**

### Fase 3: Intelligence
7. **Memory: MMR + Temporal Decay + Query Expansion**
8. **Subagents / Dynamic Spawning**
9. **Token Usage Tracking**

### Fase 4: Safety
10. **Sandbox / Tool Policies** (puede hacerse gradualmente)

---

## 5. LO QUE NO COPIAR DE OPENCLAW

Algunas cosas de OpenClaw son overhead para AIBot:

| Feature OpenClaw | Por qué NO copiar |
|---|---|
| Multi-canal (WhatsApp, Slack, Discord, etc.) | AIBot es Telegram-first. Agregar canales agrega complejidad enorme sin valor claro. |
| Gateway WS control plane | Over-engineering para nuestro caso. El web server HTTP actual es suficiente. |
| Companion apps (macOS, iOS, Android) | Fuera de scope. |
| MCP via mcporter | Innecesario. Nuestro tool system es directo. Si se necesita, es una extensión. |
| Plugin npm distribution | Overkill. Nuestros skills locales funcionan bien. |
| Onboarding wizard CLI | Nice-to-have pero no crítico. El config JSON + dashboard web es suficiente. |
| Auth profile rotation (OAuth flows) | Solo necesario cuando tengamos multi-provider, y aún así es más simple (API keys). |
| Canvas / A2UI | Completamente fuera de scope. |
