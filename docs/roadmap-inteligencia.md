# Roadmap de Inteligencia: AIBot vs OpenClaw

> Comparativa de capacidades y lista priorizada de mejoras para hacer a AIBot
> mas inteligente, usando OpenClaw como referencia.

---

## Resumen Ejecutivo

AIBot es un framework modular y funcional con un buen sistema de skills, tools,
memoria semantica y gestion de sesiones. Sin embargo, comparado con OpenClaw,
tiene limitaciones significativas en areas clave que impactan directamente la
"inteligencia" percibida y real del bot.

OpenClaw es un gateway multi-canal con ~80K lineas de codigo, soporte para 20+
proveedores de LLM, sistema de plugins con hooks en cada etapa del ciclo de
vida, memoria vectorial avanzada, compactacion inteligente de contexto,
multi-agente, y streaming en tiempo real.

A continuacion, las 10 mejoras priorizadas.

---

## 1. Soporte Multi-Proveedor de LLM (Prioridad: CRITICA) — IMPLEMENTADO

**Estado actual:** ~~AIBot esta atado exclusivamente a Ollama (modelos locales).~~ **IMPLEMENTADO.** Multi-provider LLM con model failover en `src/bot/model-failover/` (4 archivos: failover-error, failover-orchestrator, model-fallback, cooldown-tracker). Soporta Anthropic, OpenAI, Google, Ollama con failover automático, error classification (9 FailoverReasons), y cooldown por modelo. `FailoverLLMClient` es drop-in replacement.

**Lo que tiene OpenClaw:** Soporte para 20+ proveedores (Anthropic, OpenAI,
Google, Bedrock, Together, Ollama, etc.) con rotacion de perfiles de
autenticacion, failover automatico entre proveedores, y seleccion de modelo por
agente/sesion/request.

**Por que es critico:** La inteligencia del bot esta limitada por la calidad del
modelo. Los modelos locales via Ollama (Llama, Mistral, etc.) son buenos, pero
modelos como Claude Opus/Sonnet o GPT-4o son significativamente mas capaces en
razonamiento, seguimiento de instrucciones, y uso de herramientas. Sin acceso a
estos modelos, AIBot tiene un techo de inteligencia artificial.

**Que implementar:**
- Abstraccion `LLMProvider` con interfaz comun (chat, generate, embed)
- Adaptadores para: Anthropic (Claude), OpenAI, Google (Gemini), Ollama
- Configuracion de modelo primario + fallbacks por bot/chat
- Rotacion de API keys y cooldown por perfil ante rate limits
- Transformacion de schemas de tools por proveedor (cada API tiene sus quirks)

**Impacto:** Acceso inmediato a los modelos mas inteligentes del mercado.

---

## 2. Compactacion Inteligente de Contexto (Prioridad: CRITICA) — IMPLEMENTADO

**Estado actual:** ~~AIBot carga los ultimos N mensajes (`maxHistory`, default 20)
y resetea sesiones por tiempo/dia. No hay manejo de ventana de contexto.~~ **IMPLEMENTADO.** `src/bot/context-compaction.ts` con token estimation, truncation, LLM-based summarization, overflow retry. Integrado con `MemoryFlusher` y `SessionManager`.

**Lo que tiene OpenClaw:** Compactacion automatica cuando se acerca al limite de
la ventana de contexto. Estima tokens por mensaje, divide el historial en chunks,
resume los chunks mas viejos usando el propio modelo, y los fusiona. Tiene un
margen de seguridad configurable (`reserveTokensFloor`).

**Por que es critico:** Con solo 20 mensajes de historial, el bot "olvida"
rapidamente. En conversaciones largas o con mucho uso de tools (que generan
mensajes largos), se pierde contexto vital. La compactacion permite
conversaciones de horas sin perder el hilo, resumiendo lo viejo en vez de
descartarlo.

**Que implementar:**
- Estimacion de tokens por mensaje (tiktoken o similar)
- Deteccion de proximidad al limite de ventana de contexto del modelo
- Algoritmo de compactacion: dividir historial en chunks, resumir los mas viejos
- Inyeccion del resumen como contexto al inicio de la conversacion
- Configuracion: umbral de activacion, tokens reservados, modelo para resumir

**Impacto:** Conversaciones significativamente mas largas y coherentes.

---

## 3. Streaming de Respuestas (Prioridad: ALTA) — IMPLEMENTADO

**Estado actual:** ~~AIBot espera la respuesta completa del LLM antes de enviarla.
El usuario ve "escribiendo..." durante todo el procesamiento.~~ **IMPLEMENTADO.** Ollama token-by-token streaming integrado en `ConversationPipeline`. Streaming compatible con WebSocket (widget chat) via `streamToWebSocket()` en `src/channel/websocket.ts`.

**Lo que tiene OpenClaw:** Streaming en tiempo real a nivel de token, con
streaming tambien durante ejecucion de tools. El usuario ve la respuesta
aparecer progresivamente.

**Por que es importante:** En respuestas largas, el usuario puede esperar 30-60
segundos sin feedback. El streaming da sensacion de inmediatez y permite al
usuario empezar a leer antes de que termine. Tambien permite cancelar si la
respuesta va por mal camino.

**Que implementar:**
- Activar streaming en la llamada a Ollama (`stream: true`)
- Buffer de tokens con flush periodico (cada ~500ms o N tokens)
- Edicion de mensaje en Telegram (`editMessageText`) para actualizar progresivamente
- Streaming compatible con el loop agentico (pausar stream durante tool calls)
- Indicador visual de "pensando" vs "escribiendo" vs "ejecutando tool"

**Impacto:** UX dramaticamente mejor. El bot se siente mas rapido y responsivo.

---

## 4. Sistema de Subagentes / Multi-Agente (Prioridad: ALTA)

**Estado actual:** AIBot tiene un solo agente que maneja todo.

**Lo que tiene OpenClaw:** Capacidad de crear subagentes con workspaces aislados,
sesiones separadas, y politicas propias. Un agente puede delegar tareas a otro
agente especializado, cada uno con su propio modelo, tools, y memoria.

**Por que es importante:** Un solo agente generalista tiene limites. Con
subagentes, el bot puede delegar tareas complejas (ej: "investiga X" a un
agente con acceso a web, "programa Y" a un agente con herramientas de codigo)
mientras mantiene el hilo de la conversacion principal.

**Que implementar:**
- Concepto de `AgentRuntime` con workspace aislado
- Tool `spawn_agent` para crear subagentes desde el agente principal
- Canal de comunicacion inter-agente (mensajes/resultados)
- Politicas de herencia (tools, permisos, modelo)
- Ciclo de vida del subagente (spawn, ejecutar, retornar resultado, limpiar)

**Impacto:** Capacidad de resolver tareas complejas que requieren especializacion.

---

## 5. Modos de Razonamiento Extendido (Prioridad: ALTA)

**Estado actual:** AIBot envia el prompt al modelo y recibe la respuesta directa.
No hay control sobre el proceso de razonamiento.

**Lo que tiene OpenClaw:** Soporte para "thinking levels" (off, low, medium,
high) y extended thinking de Claude (budget de tokens de razonamiento
configurable por sesion). Separa los bloques de pensamiento del contenido final.

**Por que es importante:** Para preguntas complejas (matematicas, logica, codigo,
analisis), el razonamiento paso-a-paso produce respuestas significativamente
mejores. Los modelos con thinking habilitado resuelven problemas que no pueden
resolver sin el.

**Que implementar:**
- Parametro `thinking` en la configuracion (off/low/medium/high)
- Para Ollama: prompt engineering con instrucciones de chain-of-thought
- Para APIs cloud (futuro): uso nativo de thinking tokens
- Separacion de bloques de pensamiento vs respuesta final
- Opcion de mostrar/ocultar el razonamiento al usuario
- Configuracion por skill o por tipo de consulta

**Impacto:** Respuestas mucho mas precisas en tareas que requieren razonamiento.

---

## 6. Pipeline de Hooks / Middleware (Prioridad: MEDIA-ALTA) — IMPLEMENTADO

**Estado actual:** ~~AIBot tiene un pipeline lineal fijo: mensaje -> debounce ->
session -> LLM -> respuesta. Las skills solo pueden registrar commands y
`onMessage`.~~ **IMPLEMENTADO.** `HookEmitter` en `src/bot/hooks.ts` con 8 eventos: `message_received`, `message_sent`, `before_llm_call`, `after_llm_call`, `before_tool_call`, `after_tool_call`, `before_compaction`, `agent_loop_cycle`. Wired en conversation pipeline, tool executor, y agent loop.

**Lo que tiene OpenClaw:** Sistema de hooks con 15+ puntos de intervencion:
`before_agent_start`, `message_received`, `before_tool_call`,
`after_tool_call`, `message_sending`, etc. Los hooks tienen prioridad ordenada,
aislamiento de errores, y encadenamiento de resultados.

**Por que es importante:** Los hooks permiten que skills/plugins modifiquen
comportamiento sin tocar el core. Ej: un plugin de moderacion puede interceptar
mensajes antes de enviarlos, un plugin de logging puede capturar tool calls, un
plugin de cache puede interceptar respuestas repetidas.

**Que implementar:**
- Definir eventos del ciclo de vida (message_received, before_llm_call,
  after_llm_call, before_tool_call, after_tool_call, before_send, after_send)
- Sistema de registro de handlers con prioridad
- Ejecucion ordenada con aislamiento de errores
- Capacidad de modificar/cancelar el flujo (ej: bloquear un mensaje)
- Exponer hooks a las skills via el SkillContext

**Impacto:** Framework mucho mas extensible. Cada skill puede ser mas "inteligente".

---

## 7. Failover Avanzado y Recuperacion de Errores (Prioridad: MEDIA) — PARCIALMENTE IMPLEMENTADO

**Estado actual:** ~~AIBot tiene fallback basico de modelos (lista de fallbacks en
Ollama). Si falla la llamada, intenta el siguiente modelo. No hay clasificacion
de errores ni cooldowns.~~ **PARCIALMENTE IMPLEMENTADO.** Model failover con 9 `FailoverReason` types, cooldown tracker, failover orchestrator en `src/bot/model-failover/`. Agent retry engine con backoff exponencial en `src/bot/agent-retry-engine.ts`. **Pendiente:** unificación de 3 clasificadores de errores fragmentados (GAP-E1).

**Lo que tiene OpenClaw:** Clasificacion detallada de errores (auth, billing,
rate_limit, timeout, context_overflow, tool_error), cooldowns por perfil
(5 min default), tracking de intentos con diagnostico, reparacion automatica
de transcripts corruptos, y sintesis de resultados de tools en caso de error.

**Por que es importante:** Un bot "inteligente" no solo da buenas respuestas,
sino que se recupera gracefully de fallos. Clasificar errores permite tomar
acciones diferentes (rate limit -> esperar, auth -> rotar key, context overflow
-> compactar y reintentar).

**Que implementar:**
- Enum de razones de fallo (rate_limit, timeout, context_overflow, etc.)
- Cooldown por modelo/perfil con ventana configurable
- Estrategia diferenciada por tipo de error
- Retry inteligente: compactar en context_overflow, esperar en rate_limit
- Logging estructurado de fallos para diagnostico
- Reparacion de sesiones corruptas

**Impacto:** Bot mas robusto y confiable. Menos "se rompio" para el usuario.

---

## 8. Herramientas de Navegador (Prioridad: MEDIA)

**Estado actual:** AIBot tiene `web_fetch` (HTTP GET con conversion a markdown)
y `web_search` (Brave API). No puede interactuar con paginas dinamicas.

**Lo que tiene OpenClaw:** Instancias dedicadas de Chrome/Chromium con
snapshots, acciones (click, type, scroll), gestion de perfiles, y capacidad
de interactuar con paginas SPA/JavaScript-rendered.

**Por que es importante:** Muchas paginas modernas son SPAs que no funcionan con
simple HTTP GET. Un bot con browser puede: llenar formularios, extraer datos de
apps web, tomar screenshots, interactuar con servicios que no tienen API.

**Que implementar:**
- Integracion con Playwright o Puppeteer
- Tool `browser_navigate` para abrir URLs en browser headless
- Tool `browser_action` para interactuar (click, type, screenshot)
- Gestion de sesiones de browser (crear, reutilizar, cerrar)
- Limites de seguridad (dominios permitidos, timeout, memoria)
- Screenshots como respuesta al usuario

**Impacto:** El bot puede acceder a informacion que antes era inaccesible.

---

## 9. Soporte Multi-Canal (Prioridad: MEDIA) — IMPLEMENTADO

**Estado actual:** ~~AIBot solo soporta Telegram via grammy.~~ **IMPLEMENTADO.** 7 channel adapters en `src/channel/`: Telegram, REST, WebSocket, WhatsApp (Cloud API), Discord (REST + Gateway WebSocket), Outbound. Abstracción `Channel`/`InboundMessage`/`ChannelKind` en `src/channel/types.ts`. Pipeline channel-agnostic via `handleChannelMessage()`.

**Lo que tiene OpenClaw:** 15+ canales (WhatsApp, Discord, Slack, Signal,
iMessage, Matrix, Teams, etc.) unificados bajo una sola API de mensajeria.

**Por que es importante:** No todos usan Telegram. Soportar Discord y WhatsApp
cubriria la gran mayoria de usuarios. La abstraccion multi-canal tambien fuerza
un mejor diseno de la capa de mensajeria.

**Que implementar:**
- Interfaz `Channel` abstracta (send, receive, edit, delete, typing)
- Adaptador Telegram (refactorizar el actual)
- Adaptador Discord (discord.js)
- Adaptador WhatsApp (Baileys o similar)
- Router de mensajes por canal
- Normalizacion de formatos (markdown, media, stickers, reacciones)

**Impacto:** Alcance mucho mas amplio, misma inteligencia en cualquier plataforma.

---

## 10. Framework de Testing y Evaluacion (Prioridad: MEDIA)

**Estado actual:** AIBot tiene infraestructura minima de testing. Solo un archivo
`test-bot.ts` manual y Biome para linting.

**Lo que tiene OpenClaw:** Vitest con tests unitarios, E2E, tests live con APIs
reales, cobertura V8 (umbrales de 70%), tests de Docker, y tests de onboarding
completo.

**Por que es importante:** Sin tests, cada cambio puede romper funcionalidad
existente. Para un bot "inteligente", es critico poder verificar que los tools
funcionan, que la memoria se indexa correctamente, que el failover opera bien,
y que las respuestas mantienen calidad.

**Que implementar:**
- Configuracion de Bun test con estructura de tests
- Tests unitarios para: tools, memory manager, session manager, config
- Tests de integracion para: skill loading, tool execution pipeline
- Mocks de Ollama para tests sin servidor LLM
- Tests de regresion para respuestas del bot (input -> output esperado)
- CI/CD con checks automaticos (lint + test)

**Impacto:** Confianza para iterar rapido sin romper cosas. Base para mejoras continuas.

---

## Matriz de Prioridad

| # | Mejora | Prioridad | Esfuerzo | Impacto en Inteligencia | Estado |
|---|--------|-----------|----------|------------------------|--------|
| 1 | Multi-Proveedor LLM | CRITICA | Alto | Directo - acceso a mejores modelos | **DONE** |
| 2 | Compactacion de Contexto | CRITICA | Medio | Directo - conversaciones mas largas | **DONE** |
| 3 | Streaming de Respuestas | ALTA | Medio | Indirecto - UX de inteligencia | **DONE** |
| 4 | Subagentes / Multi-Agente | ALTA | Alto | Directo - tareas complejas | Pendiente |
| 5 | Razonamiento Extendido | ALTA | Medio | Directo - mejor razonamiento | Pendiente |
| 6 | Pipeline de Hooks | MEDIA-ALTA | Medio | Indirecto - extensibilidad | **DONE** |
| 7 | Failover Avanzado | MEDIA | Medio | Indirecto - confiabilidad | **PARCIAL** (GAP-E1 pendiente) |
| 8 | Herramientas de Navegador | MEDIA | Alto | Directo - mas capacidades | Pendiente |
| 9 | Soporte Multi-Canal | MEDIA | Alto | Indirecto - alcance | **DONE** |
| 10 | Testing y Evaluacion | MEDIA | Medio | Indirecto - calidad sostenida | Pendiente |

---

## Orden de Implementacion Sugerido

```
Fase 1 - Fundamentos ✅ COMPLETADA
  [1] Multi-Proveedor LLM ✅
  [2] Compactacion de Contexto ✅

Fase 2 - Experiencia (parcial)
  [3] Streaming de Respuestas ✅
  [5] Razonamiento Extendido — pendiente

Fase 3 - Arquitectura (parcial)
  [6] Pipeline de Hooks ✅
  [7] Failover Avanzado — parcial (GAP-E1 pendiente)

Fase 4 - Capacidades — pendiente
  [4] Subagentes / Multi-Agente
  [8] Herramientas de Navegador

Fase 5 - Escala (parcial)
  [9] Soporte Multi-Canal ✅
  [10] Testing y Evaluacion — pendiente
```

---

## Lo que AIBot ya hace bien

No todo es carencia. AIBot tiene ventajas que vale la pena mantener:

- **Simplicidad**: ~30 archivos vs ~2,665 de OpenClaw. Mas facil de entender y mantener.
- **Memoria semantica solida**: Hybrid search (vector + keyword) bien implementado.
- **Message buffer inteligente**: Debounce de 2 capas para batching de mensajes.
- **Soul system**: Sistema de personalidad con IDENTITY + SOUL + memoria diaria es elegante.
- **Tools bien disenados**: 13 tools con buenas protecciones de seguridad.
- **Bun como runtime**: Mas rapido que Node.js, startup instantaneo.
- **Auto-flush de memoria**: Resumen automatico de conversaciones a memoria persistente.
