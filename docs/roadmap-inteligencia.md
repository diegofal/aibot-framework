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

## 1. Soporte Multi-Proveedor de LLM (Prioridad: CRITICA)

**Estado actual:** AIBot esta atado exclusivamente a Ollama (modelos locales).

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

## 2. Compactacion Inteligente de Contexto (Prioridad: CRITICA)

**Estado actual:** AIBot carga los ultimos N mensajes (`maxHistory`, default 20)
y resetea sesiones por tiempo/dia. No hay manejo de ventana de contexto.

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

## 3. Streaming de Respuestas (Prioridad: ALTA)

**Estado actual:** AIBot espera la respuesta completa del LLM antes de enviarla.
El usuario ve "escribiendo..." durante todo el procesamiento.

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

## 6. Pipeline de Hooks / Middleware (Prioridad: MEDIA-ALTA)

**Estado actual:** AIBot tiene un pipeline lineal fijo: mensaje -> debounce ->
session -> LLM -> respuesta. Las skills solo pueden registrar commands y
`onMessage`.

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

## 7. Failover Avanzado y Recuperacion de Errores (Prioridad: MEDIA)

**Estado actual:** AIBot tiene fallback basico de modelos (lista de fallbacks en
Ollama). Si falla la llamada, intenta el siguiente modelo. No hay clasificacion
de errores ni cooldowns.

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

## 9. Soporte Multi-Canal (Prioridad: MEDIA)

**Estado actual:** AIBot solo soporta Telegram via grammy.

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

| # | Mejora | Prioridad | Esfuerzo | Impacto en Inteligencia |
|---|--------|-----------|----------|------------------------|
| 1 | Multi-Proveedor LLM | CRITICA | Alto | Directo - acceso a mejores modelos |
| 2 | Compactacion de Contexto | CRITICA | Medio | Directo - conversaciones mas largas |
| 3 | Streaming de Respuestas | ALTA | Medio | Indirecto - UX de inteligencia |
| 4 | Subagentes / Multi-Agente | ALTA | Alto | Directo - tareas complejas |
| 5 | Razonamiento Extendido | ALTA | Medio | Directo - mejor razonamiento |
| 6 | Pipeline de Hooks | MEDIA-ALTA | Medio | Indirecto - extensibilidad |
| 7 | Failover Avanzado | MEDIA | Medio | Indirecto - confiabilidad |
| 8 | Herramientas de Navegador | MEDIA | Alto | Directo - mas capacidades |
| 9 | Soporte Multi-Canal | MEDIA | Alto | Indirecto - alcance |
| 10 | Testing y Evaluacion | MEDIA | Medio | Indirecto - calidad sostenida |

---

## Orden de Implementacion Sugerido

```
Fase 1 - Fundamentos (desbloquea todo lo demas)
  [1] Multi-Proveedor LLM
  [2] Compactacion de Contexto

Fase 2 - Experiencia (el bot se siente mas inteligente)
  [3] Streaming de Respuestas
  [5] Razonamiento Extendido

Fase 3 - Arquitectura (el bot puede hacer mas)
  [6] Pipeline de Hooks
  [7] Failover Avanzado

Fase 4 - Capacidades (el bot llega a mas)
  [4] Subagentes / Multi-Agente
  [8] Herramientas de Navegador

Fase 5 - Escala (el bot crece)
  [9] Soporte Multi-Canal
  [10] Testing y Evaluacion
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
