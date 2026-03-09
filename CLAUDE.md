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
| `bot-manager.ts` | Facade slim: constructor, `startBot`, `stopBot`, `sendMessage`, API pública |
| `tenant-facade.ts` | Tenant/billing/metering — delegado desde BotManager |
| `tool-registry.ts` | Inicialización de tools, categorías (`TOOL_CATEGORIES`), pre-selección por categoría, filtro collaboration-safe |
| `tool-executor.ts` | Ejecución de tools con lifecycle events, retry y loop detection |
| `tool-loop-detector.ts` | 4-strategy tool loop detection: circuit breaker, poll no-progress, ping-pong, generic repeat |
| `system-prompt-builder.ts` | Composición unificada de system prompts (modo `conversation` y `collaboration`) |
| `memory-flush.ts` | Flush de sesión a daily memory log |
| `group-activation.ts` | Checks de relevancia en grupos: deference, LLM relevance, broadcast |
| `context-compaction.ts` | LLM-based context compaction: token estimation, truncation, summarization, overflow retry |
| `conversation-pipeline.ts` | Pipeline core: session expiry, RAG prefetch, compaction, LLM call, persist, reply. Channel-agnostic entry: `handleChannelMessage()` |
| `conversation-gate.ts` | Pre-condiciones de mensajes: auth, grupo, bot-to-bot, ask_human |
| `ask-permission-store.ts` | Cola de permisos: request → approve/deny → consume en agent loop |
| `collaboration.ts` | Bot-to-bot: visible, internal, delegation, multi-turn |
| `handler-registrar.ts` | Registro de handlers grammy: skills, commands, media, built-ins |
| `telegram-poller.ts` | Custom polling loop: getUpdates + 409/429 backoff + abort |
| `bot-reset.ts` | Reset de soul files, memoria, sessions, stores |
| `bot-export-service.ts` | Export/import de bots como .tar.gz (soul, config, core_memory, productions, etc.) |
| `agent-loop.ts` | Orquestador del agent loop: ejecuta bots periódica/continuamente |
| `agent-scheduler.ts` | Scheduling, concurrency, sleep, bot loops |
| `agent-retry-engine.ts` | Retry con backoff exponencial, clasificación de errores |
| `agent-planner.ts` | LLM planner con retry (periódico y continuo) |
| `agent-strategist.ts` | Strategist: reflexión, operaciones de goals, cadencia |
| `agent-loop-utils.ts` | Funciones puras: digest, dedup, file scan, memory log |
| `agent-loop-prompts.ts` | Prompt builders para planner, strategist, executor, feedback |
| `llm-json-parser.ts` | Parser genérico de JSON desde output LLM |
| `soul-health-check.ts` | Orquestador: lint + consolidación + quality review |
| `soul-lint.ts` | Lint estructural de soul directory (sin LLM) |
| `soul-memory-consolidator.ts` | Consolidación de daily logs → MEMORY.md |
| `soul-quality-reviewer.ts` | Quality review de soul files (Claude CLI) |
| `index.ts` | Barrel re-export de `BotManager` |

### Módulos Channel (`src/channel/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | `InboundMessage`, `Channel`, `ChannelKind` — interfaces canal-agnósticas |
| `telegram.ts` | Adapter grammy Context → InboundMessage + Channel |
| `rest.ts` | Adapter REST API request → InboundMessage + Channel (collect-reply pattern) |
| `websocket.ts` | Adapter WebSocket connection → InboundMessage + Channel (widget chat) |
| `whatsapp.ts` | Adapter WhatsApp Cloud API → InboundMessage + Channel (webhook signature verification, message extraction) |
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
  ├── McpClientPool           (MCP server connections, shared pool)
  ├── ToolRegistry            (sin deps de módulo, registra MCP tools)
  ├── SystemPromptBuilder     (lee ToolRegistry.getDefinitions())
  ├── MemoryFlusher           (sin deps de módulo)
  ├── GroupActivation         (sin deps de módulo)
  ├── ContextCompactor        (usa MemoryFlusher, LLMClient, SessionManager)
  ├── ConversationPipeline    (usa SystemPromptBuilder, MemoryFlusher, ToolRegistry, ContextCompactor, Channel)
  ├── CollaborationManager    (usa SystemPromptBuilder, ToolRegistry)
  ├── TelegramPoller          (polling loop, inyectado en startTelegramBot)
  ├── BotResetService         (reset soul/memory/sessions/stores)
  ├── BotExportService        (export/import bots as .tar.gz archives)
  ├── HandlerRegistrar        (usa ConversationPipeline, GroupActivation, ConversationGate)
  │   └── ConversationGate    (auth, grupo, bot-to-bot gates)
  └── AgentLoop               (orquestador)
      ├── AgentScheduler      (scheduling, concurrency, sleep)
      ├── AgentRetryEngine    (retry con backoff)
      ├── AgentPlanner        (LLM planner)
      ├── AgentStrategist     (strategist, goals)
      └── AgentLoopUtils      (funciones puras)
```
