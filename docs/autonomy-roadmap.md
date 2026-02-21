# Autonomía — Capacidades Autónomas y Roadmap

Este documento describe las capacidades autónomas del framework, desde el agent loop hasta la auto-evolución, y el roadmap hacia autonomía completa.

---

## Niveles de Autonomía

| Nivel | Capacidad | Estado |
|-------|-----------|--------|
| 0 | Chatbot (responde mensajes) | Hecho |
| 1 | Agente con tools en conversaciones | Hecho |
| 2 | Tareas programadas (cron) | Hecho |
| 3 | Auto-dirigido (agent loop decide qué hacer) | Hecho |
| 4 | Auto-evolutivo (reflexión evoluciona personalidad) | Hecho |
| 5 | Auto-extensible (crea tools, gated por aprobación humana) | Hecho |
| 6 | Persigue metas (goal tracking multi-sesión) | Hecho |
| 7 | Colaborativo (coordinación multi-agente) | Hecho |
| 8 | Completamente autónomo (loop continuo, todo combinado) | En progreso |

---

## Agent Loop

### Arquitectura: Planner-Executor

El `AgentLoop` (`src/bot/agent-loop.ts`) es un timer auto-reprogramable que ejecuta para todos los bots activos en un intervalo configurable.

```
Timer dispara
    ↓
┌─────────────────────────────────┐
│  Fase 1: PLANNER               │
│  LLM ligero (temp 0.3)         │
│  Input: identity, soul,        │
│    motivations, goals,          │
│    recent memory, datetime,     │
│    available tools              │
│  Output: JSON estricto          │
│    { should_act, reasoning,     │
│      plan?, skip_reason? }      │
└───────────┬─────────────────────┘
            ↓ should_act=true
┌─────────────────────────────────┐
│  Fase 2: EXECUTOR               │
│  LLM agéntico completo          │
│  System prompt modo "autonomous" │
│  Acceso completo a tools         │
│  Max tool rounds: 10 (default)   │
│  Timeout: 300s (default)         │
└───────────┬─────────────────────┘
            ↓
┌─────────────────────────────────┐
│  Post-ejecución                  │
│  - Summary → daily memory        │
│  - Report → reportChatId         │
│  - AgentLoopResult registrado    │
└─────────────────────────────────┘
```

### Planner Prompt (`src/bot/agent-loop-prompts.ts`)

El planner recibe contexto completo del bot y decide si actuar:

- **Criterios de decisión**: motivaciones/goals, memoria reciente (evitar repeticiones), hora del día, tools disponibles
- **Plan**: 1-5 pasos concretos y accionables
- **Anti-vaguedad**: "BAD plan: Explore the codebase" / "GOOD plan: Run tests with exec"
- **Si `create_tool` está disponible**: sección especial sobre creación de tools dinámicas
- **Retry**: Si falla el parseo JSON a temp 0.3, reintenta a temp 0

### Executor Prompt

- Plan numerado con pasos específicos
- Contexto completo de identity/soul/motivations/goals
- Reglas de tools: paths relativos, usar `file_read` no `exec cat`, rondas limitadas
- Instrucciones para usar `manage_goals` para progreso y `save_memory` para hallazgos

### Estado y Concurrencia

```typescript
AgentLoopState = {
  running: boolean,
  lastRunAt: Date | null,
  lastResults: AgentLoopResult[],
  nextRunAt: Date | null
}

AgentLoopResult = {
  botId: string,
  botName: string,
  status: 'success' | 'skipped' | 'error',
  summary: string,
  durationMs: number,
  plannerReasoning: string,
  plan: string[],
  toolCalls: ToolCallLog[]
}
```

**Guard de concurrencia**: Si el loop ya está corriendo cuando el timer dispara, se salta con warning.

### Configuración

```jsonc
{
  "agentLoop": {
    "enabled": false,          // default: deshabilitado
    "every": "6h",             // intervalo entre ejecuciones
    "maxToolRounds": 10,       // máximo 20
    "maxDurationMs": 300000,   // timeout por ejecución
    "disabledTools": []        // tools deshabilitadas globalmente
  }
}
```

**Overrides por bot:**

```jsonc
{
  "bots": [{
    "id": "mybot",
    "agentLoop": {
      "reportChatId": 123456,    // chat donde enviar reportes
      "disabledTools": ["exec"]  // tools deshabilitadas para este bot
    }
  }]
}
```

Las `disabledTools` del agent loop se **mergean** con las globales y las per-bot.

---

## Sistema de Goals

### `manage_goals` tool (`src/tools/goals.ts`)

CRUD operando sobre archivos `GOALS.md` por bot (en su directorio soul):

| Acción | Descripción |
|--------|-------------|
| `list` | Lee todas las metas |
| `add` | Crea meta con prioridad (`high`/`medium`/`low`) y notas opcionales |
| `update` | Cambia status/notas/prioridad por match de substring |
| `complete` | Mueve a sección Completed con outcome y fecha |

### Formato en GOALS.md

```markdown
## Active Goals

- [ ] 🔴 Goal text here
  Notes: Additional context
  Status: in_progress

## Completed

- [x] ~~Completed goal~~ ✅ 2026-01-15
  Outcome: What was achieved
```

Mantiene solo las últimas 10 metas completadas.

### Integración

- **Agent loop planner**: Lee goals para decidir en qué trabajar
- **Agent loop executor**: Actualiza goals con progreso
- **Reflexión**: Lee goals durante análisis
- **System prompt**: Incluye sección de goals

---

## Servicio Cron (`src/cron/`)

Motor completo de scheduling con 9 archivos:

### Tipos de Schedule

| Tipo | Descripción | Ejemplo |
|------|-------------|---------|
| `at` | One-shot en fecha/hora específica | `{ kind: "at", datetime: "2026-02-20T15:00:00" }` |
| `every` | Intervalo con anchor | `{ kind: "every", ms: 3600000 }` |
| `cron` | Expresión cron 5-field con timezone | `{ kind: "cron", expr: "30 3 * * *", tz: "America/Argentina/Buenos_Aires" }` |

### Tipos de Payload

| Tipo | Descripción |
|------|-------------|
| `message` | Envía mensaje Telegram via bot |
| `skillJob` | Ejecuta handler de skill con override opcional de backend LLM |

### Componentes

| Archivo | Responsabilidad |
|---------|-----------------|
| `service.ts` | `CronService`: start/stop, CRUD, force run, status |
| `jobs.ts` | Creación de jobs, patch, cómputo de next-run, detección de runs stuck (2h) |
| `schedule.ts` | Cómputo de schedules usando librería `croner` |
| `timer.ts` | Timer arming (max 60s wake), ejecución, backoff de errores (30s→1m→5m→15m→60m) |
| `store.ts` | Persistencia en disco (`data/cron/jobs.json`) |
| `run-log.ts` | Logs append-only JSONL por job |
| `locked.ts` | Wrapper de serialización para concurrencia |

### Auto-registro de Skills

Los skill jobs se registran al startup. Ejemplo: la reflexión (`nightly-reflection`) corre a las `30 3 * * *`.

---

## Auto-Reflexión (`src/skills/reflection/`)

Pipeline de 4 fases que corre nightly (03:30 por default):

### Fase 1: Gather Context
Recopila identity, soul, motivations, goals, daily logs desde la última reflexión.

### Fase 2: The Mirror
Análisis LLM en 6 dimensiones:
1. **Consistencia**: ¿Las acciones se alinean con el soul?
2. **Personas**: ¿Con quién interactuó y cómo?
3. **Gaps**: ¿Qué preguntas quedaron sin responder?
4. **Patrones**: ¿Qué patrones emergieron?
5. **Alineación**: ¿Las metas progresan?
6. **Amplitud**: ¿Se está explorando lo suficiente?

### Fase 3: The Explorer (opcional)
Investigación web sobre preguntas abiertas usando `web_search` + `web_fetch` en loop agéntico.

### Fase 4: The Architect
Genera motivaciones actualizadas, patch opcional de soul, entrada de journal.

**Anti-drift**: Core Drives deben mantenerse como principios universales de personalidad. Prioridades situacionales van en Current Focus.

### Fase 4.5: Memory Compaction
Si el log de ayer excede threshold (default 15 líneas), el LLM deduplica y consolida.

**Seguridad de archivos soul**: Backup antes de escribir, soul patch debe ser 50-3000 chars.

---

## Dynamic Tools — Auto-Extensión

Los bots pueden crear sus propias herramientas (ver [docs/tools.md](tools.md#dynamic-tools--subsistema) para detalles completos).

**Flujo**:
1. Bot decide que necesita una herramienta nueva
2. Llama `create_tool` con nombre, descripción, tipo, código fuente
3. Tool se crea con status `pending`
4. Humano revisa en web UI → aprueba o rechaza
5. Si aprobada: hot-load inmediato al runtime

**Seguridad**: Análisis estático bloquea patrones peligrosos. Aprobación humana requerida.

---

## Self-Improvement (`improve` tool)

Spawna una sesión de Claude Code CLI con permisos restringidos (`Read`, `Edit`, `Write`, `Glob`, `Grep`) para revisar y mejorar archivos soul/personalidad/memoria.

5 áreas de foco: `memory`, `soul`, `motivations`, `identity`, `all`.

Backup automático de archivos antes de modificar.

---

## Dashboard y Monitoreo

### Web Dashboard (`web/`)

**Agent Loop** (`web/pages/dashboard.js`):
- Badge enabled/disabled, estado running, intervalo, next/last run
- Tabla de últimos resultados por bot con badges de status
- Filas expandibles: razonamiento del planner, plan numerado, tabla de tool calls (args/resultados), summary completo
- Botón "Run Now" para trigger manual

**Dynamic Tools** (`web/pages/tools.js`):
- Lista de tools con badges de status (pending/approved/rejected)
- Botones approve/reject/delete
- Vista detalle con metadata, parámetros, código fuente

**Live Logs**: WebSocket en `/ws/logs` transmite líneas de log pino JSON en tiempo real.

### REST API

| Endpoint | Descripción |
|----------|-------------|
| `GET/POST /api/agent-loop` | Estado, run all, run single bot |
| `/api/tools` | CRUD + approve/reject para dynamic tools |
| `/api/cron` | Gestión completa de cron |
| `/api/agents` | CRUD de bots con AI soul generation |
| `/api/sessions` | Gestión de sesiones |
| `/api/settings` | Configuración |
| `/api/status` | Estado del sistema |
| `/api/skills` | Skills disponibles |

---

## Backend LLM (`src/core/llm-client.ts`)

| Cliente | Descripción |
|---------|-------------|
| `OllamaLLMClient` | Wraps OllamaClient, soporta tool calling |
| `ClaudeCliLLMClient` | Spawna Claude CLI subprocess, NO soporta tools |
| `LLMClientWithFallback` | Primary + fallback, smart routing (tool calls → fallback si primary es claude-cli) |

Selección de backend por bot via `bots[].llmBackend`.

---

## Roadmap: Hacia Autonomía Completa

### Implementado

- [x] Agent loop con patrón planner-executor
- [x] Sistema de goals persistentes
- [x] Reflexión nocturna con evolución de personalidad
- [x] Dynamic tools con aprobación humana
- [x] Cron service completo
- [x] Colaboración multi-agente
- [x] Dashboard con monitoreo y control
- [x] Self-improvement via Claude Code

### En progreso / Próximos pasos

Referencia: [docs/roadmap-inteligencia.md](roadmap-inteligencia.md) para comparación con OpenClaw.

| Área | Prioridad | Descripción |
|------|-----------|-------------|
| Multi-Provider LLM | Crítica | API nativa de cloud (Anthropic, OpenAI) además de Ollama + Claude CLI |
| Context Compaction | Crítica | Superar límite de `maxHistory` 20 mensajes |
| Subagentes dinámicos | Alta | Spawning dinámico de agentes especializados (no solo colaboración estática) |
| Extended Reasoning | Alta | Soporte para thinking tokens |
| Agent Loop continuo | Alta | Loop sin intervalos fijos, event-driven |
| Aprobación automática de tools | Media | Políticas de auto-aprobación para tools de bajo riesgo |
| Métricas de autonomía | Media | Tracking de decisiones tomadas, éxito de planes, evolución de goals |
| Inter-agent delegation mejorada | Media | Delegación con tools habilitadas (con guards anti-loop) |
