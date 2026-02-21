# Features — Panorama de Funcionalidades

Resumen de alto nivel de todas las capacidades del AIBot Framework. Para detalles específicos, ver los documentos dedicados enlazados en cada sección.

---

## Core Messaging

### Conversaciones 1-a-1 y Grupos

- Soporte completo para chats privados y grupos de Telegram
- Typing indicators mientras el bot procesa
- Auto-split de mensajes largos para cumplir límites de Telegram
- Forum topic isolation (cada topic es una conversación independiente)

### Sesiones (`src/session.ts`)

- Transcripts persistidos en formato JSONL
- Reset automático: diario e idle (por inactividad)
- Compactación de sesiones largas
- Flush proactivo de memoria al expirar

### Comandos Built-in

| Comando | Descripción |
|---------|-------------|
| `/start` | Bienvenida inicial |
| `/help` | Lista de comandos disponibles |
| `/clear` | Limpia historial de conversación |
| `/model` | Cambia modelo LLM en runtime |
| `/who` | Muestra usuarios vistos en el grupo |
| `/memory` | Acceso a memoria del bot |

### Message Buffer (`src/message-buffer.ts`)

Arquitectura de 2 capas para prevenir llamadas LLM redundantes:
- **Inbound debounce**: Agrupa mensajes rápidos consecutivos
- **Followup queue**: Cola de mensajes de seguimiento
- Deduplicación por messageId

---

## Skills System

Arquitectura de plugins con manifiestos `skill.json` en `src/skills/<id>/`.

Cada skill puede registrar: commands, scheduled jobs, message handlers, callback query handlers.

Los skills reciben un `SkillContext` con acceso a Ollama, Telegram API, data store y sesión.

Ver [docs/skills.md](skills.md) para documentación detallada.

### Skills Incluidos

| Skill | Descripción |
|-------|-------------|
| `reflection` | Reflexión nocturna en 4 fases: análisis, exploración web, evolución de personalidad |
| `improve` | Self-improvement via Claude Code CLI con permisos restringidos |
| `calibrate` | Calibración de personalidad y comportamiento |
| `intel-gatherer` | Recopilación de inteligencia y noticias |
| `phone-call` | Gestión de llamadas telefónicas via Twilio |
| `humanizer` | Inyección de guidelines anti-AI-writing en system prompt |
| `example` | Template de ejemplo para crear nuevos skills |

---

## Tools System

20+ herramientas callable por el LLM, organizadas en categorías:

| Categoría | Tools |
|-----------|-------|
| Web | `web_search`, `web_fetch` |
| Soul & Memory | `save_memory`, `update_soul`, `update_identity`, `manage_goals` |
| Memory Search | `memory_search`, `memory_get` |
| Ejecución | `exec`, `process` |
| Archivos | `file_read`, `file_write`, `file_edit` |
| Tiempo | `get_datetime`, `cron` |
| Comunicación | `phone_call` |
| Colaboración | `delegate_to_bot`, `collaborate` |
| Self-improvement | `improve` |
| Extensibilidad | `create_tool` |

Filtrado per-bot via `disabledTools`. Dynamic tools con aprobación humana.

Ver [docs/tools.md](tools.md) para documentación detallada.

---

## Memory y Personalidad

### Sistema de Soul

Archivos de personalidad en capas, por bot:

| Archivo | Contenido |
|---------|-----------|
| `IDENTITY.md` | Nombre, emoji, vibe |
| `SOUL.md` | Personalidad, tono, reglas de comportamiento |
| `MOTIVATIONS.md` | Core drives y current focus |
| `GOALS.md` | Metas estructuradas con prioridad y status |

- Directorios soul per-bot (`souls/<botId>/`)
- AI soul generation via Claude Code CLI
- Versionado con backups en `.versions/`
- Redacción de datos sensibles

### Memoria

- **Daily memory logs**: Hechos con timestamps, uno por día
- **Session transcripts**: JSONL con compactación
- **Legacy memory**: Migración de formato anterior
- **Memory flush**: Summarización LLM al expirar sesión + flush proactivo

### Búsqueda Semántica (RAG)

- Hybrid search: vector embeddings + FTS5 via SQLite (`src/memory/manager.ts`)
- RAG pre-fetch automático en cada conversación
- File watcher para indexación de cambios
- Session indexing para historial

Ver [docs/soul-and-memory.md](soul-and-memory.md) para documentación detallada.

---

## Media Handling

| Tipo | Soporte |
|------|---------|
| **Fotos** | Base64 para vision models (LLM multimodal) |
| **Documentos** | PDF, texto, markdown, CSV, JSON, HTML — extracción de texto |
| **Audio/Voz** | Whisper STT endpoint para transcripción |

- Validación de MIME type
- Límites de tamaño de archivo
- Timeout de descarga configurable

---

## Bot-to-Bot Collaboration

### Modos de Colaboración

| Modo | Descripción |
|------|-------------|
| **Visible** | Multi-turn público en grupo, con @mentions |
| **Internal** | Behind-the-scenes con historial de sesión y acceso a tools |
| **Delegation** | One-shot, el bot destino responde sin tools |

### Capacidades

- Agent discovery (listar bots con capabilities, skills, tools, modelo)
- Multi-turn con session history
- Collaboration-safe tool filtering (excluye `collaborate`/`delegate_to_bot`)
- Rate limiting via `CollaborationTracker`
- Session TTL management
- API para colaboración autónoma multi-turn

---

## Group Intelligence

### Activación en Grupos

5 triggers para decidir si el bot responde:

| Trigger | Descripción |
|---------|-------------|
| Direct mention | @botname en el mensaje |
| Mention patterns | Patrones configurables de mención |
| Reply to bot | Respuesta a un mensaje del bot |
| Reply window | Ventana temporal post-interacción |
| Broadcast | Mensajes relevantes para todos |

### Multi-Bot Deference

- **Deference determinístico**: Si otro bot es @mencionado, el bot actual cede
- **LLM relevance check**: Evaluación de relevancia (fail-open: responde si falla el check)
- **Broadcast relevance check**: Evaluación para mensajes no dirigidos (fail-closed: no responde si falla)
- Classifier prompts conscientes de multi-bot

### User Tracking

Tracking de usuarios vistos en grupos, accesible via `/who`.

---

## Autonomous Agent Loop

Patrón planner-executor de 2 fases para acción autónoma:

1. **Planner**: LLM ligero decide si actuar basándose en goals, memoria, hora del día
2. **Executor**: LLM agéntico con acceso completo a tools ejecuta el plan

- Intervalo configurable (default: 6h)
- Per-bot disabled tools y report chat
- Resultados logueados a daily memory
- Trigger manual via API/dashboard
- Awareness de `create_tool` en planner

Ver [docs/autonomy-roadmap.md](autonomy-roadmap.md) para documentación detallada.

---

## Admin y Auth

### Autorización

- Array `allowedUsers` per-bot
- Enforcement en commands, mensajes, media y callbacks
- Token masking en API responses

### Gestión de Bots

- CRUD completo (crear, leer, actualizar, clonar, eliminar)
- Start/stop individual de bots
- AI soul generation en flujo de creación
- Env var substitution en config (`$ENV_VAR`)

---

## Web Dashboard y API

### Dashboard (`web/`)

- Server: Hono + Bun.serve
- SPA con static serving y fallback routing
- WebSocket real-time log streaming (`/ws/logs`)

### Páginas

| Página | Funcionalidad |
|--------|---------------|
| Dashboard | Agent loop status, últimos resultados expandibles, Run Now |
| Agents | CRUD de bots, soul generation, start/stop |
| Sessions | Transcripts paginados, clear |
| Cron | Gestión de jobs, force-run, run logs |
| Tools | Dynamic tools: approve/reject/delete, vista detalle |
| Skills | Lista de skills con metadata |
| Settings | Configuración de sesión y colaboración |

### REST API

25+ endpoints en 8 módulos de rutas:

| Módulo | Endpoints |
|--------|-----------|
| `/api/status` | Uptime, conteo de bots |
| `/api/agents` | CRUD + start/stop/clone/init-soul/generate-soul/apply-soul |
| `/api/sessions` | List, transcript (paginado), clear |
| `/api/cron` | CRUD + force-run + run logs |
| `/api/settings` | Session y collaboration settings |
| `/api/skills` | Lista de skills |
| `/api/tools` | Dynamic tool CRUD + approve/reject |
| `/api/agent-loop` | Estado, run all, run single bot |

---

## Scheduled Tasks (Cron)

Motor de scheduling completo con persistencia.

| Tipo de Schedule | Descripción |
|------------------|-------------|
| `at` | One-shot en fecha/hora específica |
| `every` | Intervalo recurrente con anchor |
| `cron` | Expresión cron 5-field con timezone |

| Tipo de Payload | Descripción |
|-----------------|-------------|
| `message` | Envía mensaje Telegram |
| `skillJob` | Ejecuta handler de skill con override de backend LLM |

- Persistent storage (`data/cron/jobs.json`)
- Run log con historial por job
- Error backoff progresivo (30s → 1m → 5m → 15m → 60m)
- Detección de runs stuck (2h threshold)

---

## Multi-Backend LLM

| Backend | Características |
|---------|----------------|
| **Ollama** | Local, tool calling, vision, embeddings |
| **Claude CLI** | Text-only subprocess, sin tools |
| **Fallback composite** | Primary + fallback automático |

- Per-bot backend selection via `bots[].llmBackend`
- Runtime model switching via `/model`
- Smart routing: tool calls se rutean al fallback si primary es Claude CLI
- Per-skill y per-cron-job backend override

---

## Humanizer

Sistema anti-AI-writing basado en la guía de Wikipedia "Signs of AI writing":

- Inyección en system prompt cuando el skill está habilitado
- 60+ patrones blacklisted de escritura AI
- Reglas de voz, ritmo y estructura
- Definición: `src/humanizer-prompt.ts`
