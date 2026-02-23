# Soul & Memory — Personalidad y Memoria

El "soul" es el conjunto de archivos Markdown persistentes que definen la personalidad, identidad, motivaciones, metas y memoria acumulada de un bot. Es la base del system prompt — le dice al LLM *quién es* antes de cualquier conversación.

---

## Sistema de Soul

### Capas del Soul

El soul se compone de hasta 6 capas de archivos, cargadas en orden por `SoulLoader.composeSystemPrompt()` (`src/soul.ts`):

| Archivo | Propósito | Inyectado como |
|---------|-----------|----------------|
| `IDENTITY.md` | Nombre, emoji, vibe (key-value) | Intro en lenguaje natural |
| `SOUL.md` | Personalidad, estilo, boundaries | Markdown raw |
| `MOTIVATIONS.md` | Core drives, current focus, preguntas, observaciones | `## Your Inner Motivations` |
| `GOALS.md` | Metas activas/completadas estructuradas | `## Goals` |
| `memory/legacy.md` | Datos biográficos core | `## Core Memory` |
| `memory/YYYY-MM-DD.md` | Daily memory logs (solo hoy + ayer) | `## Recent Memory` |

### Directorios Per-Bot

Cada bot tiene su propio directorio soul en `config/soul/{botId}/`:

```
config/soul/
  default/          # Bot principal
  Therapist/        # Bot terapeuta
  cryptik/
  job-seeker/
  selfimproveaibot/
```

Resuelto en `config.ts`:
```typescript
soulDir: botConfig.soulDir ?? `${globalConfig.soul.dir}/${botConfig.id}`
```

**Migración automática**: Al startup, `migrateSoulRootToPerBot()` detecta archivos soul en la raíz y los mueve a un subdirectorio `default/`.

### Inicialización

En `BotManager.startBot()`, cada bot crea su propio `SoulLoader`:
- Crea directorio soul y subdirectorio `memory/`
- Ejecuta migración legacy (`MEMORY.md` → `memory/legacy.md`)

---

## Formatos de Archivos Soul

### IDENTITY.md (key-value)

```
name: Finny
emoji: 🤖
vibe: directa, picante, leal — tu amiga que te dice las cosas sin filtro
```

Parseado a: *"Your name is Finny. Your emoji is 🤖. Your vibe: directa, picante, leal..."*

### SOUL.md (Markdown libre)

Secciones típicas:
- `## Personality Foundation`
- `## Communication Style`
- `## Boundaries`
- Secciones adicionales por bot (ej: `## Therapeutic Approach`)

### MOTIVATIONS.md (secciones estructuradas)

5 secciones requeridas:
- `## Core Drives` — Principios universales de personalidad
- `## Current Focus` — Prioridades situacionales actuales
- `## Open Questions` — Preguntas sin responder
- `## Self-Observations` — Auto-observaciones
- `## Last Reflection` — Watermark con fecha/trigger/cambios (usado por reflexión)

### GOALS.md (checkboxes)

```markdown
## Active Goals

- [ ] 🔴 Goal text here
  Notes: Additional context
  Status: in_progress

## Completed

- [x] ~~Completed goal~~ ✅ 2026-01-15
  Outcome: What was achieved
```

Últimas 10 metas completadas retenidas.

---

## Arquitectura de Memoria (4 Capas)

### Capa 1: Session Memory (corto plazo)

**Source**: `src/session.ts` — `SessionManager`

- Almacenada como JSONL en `data/sessions/transcripts/{session-key}.jsonl`
- Sliding window: `getHistory()` retorna últimos N mensajes (default maxHistory: 20)
- Compactación: Cuando el archivo excede 2x maxHistory, trunca a maxHistory
- Reset policies:
  - **Daily**: Reset a hora configurable
  - **Idle**: Reset tras N minutos de inactividad
- Metadata en `data/sessions/sessions.json`
- Forum topic isolation: Cada topic es una sesión independiente

### Capa 2: Daily Memory Logs (mediano plazo)

**Source**: `SoulLoader.appendDailyMemory()` en `src/soul.ts`

- Archivos en `config/soul/{botId}/memory/YYYY-MM-DD.md`
- Bullet points con timestamp: `- [14:30] Diego mentioned...`
- Solo hoy + ayer se incluyen en el system prompt (`readRecentDailyLogs()`)
- Logs más antiguos accesibles solo via búsqueda semántica

### Capa 3: Legacy Memory (largo plazo core)

- `config/soul/{botId}/memory/legacy.md`
- Siempre incluida en system prompt como `## Core Memory`
- Contiene datos biográficos core: nombres, edades, relaciones, preferencias
- Migrada del layout plano anterior (`MEMORY.md`)

### Capa 4: Semantic Search Index (SQLite)

**Source**: `src/memory/` (todos los archivos)

- Database: `data/memory.db` (SQLite con WAL mode)
- Tablas: `files`, `chunks`, `chunks_fts` (FTS5), `embedding_cache`
- Column `source_type`: `'memory'` (soul files) o `'session'` (transcripts)
- Embedding model: configurable via `soul.search.embeddingModel`, 768 dimensiones default, via Ollama

**Chunking**:
- Split por headings de Markdown
- 400 target tokens, 80 overlap tokens

**File watcher**: Auto-reindexa archivos `.md` cambiados con 2s debounce.

**Session indexing**: Transcripts de sesión indexados por `session-indexer.ts` cuando `sessionMemory.enabled`.

---

## Memory Flush

### Trigger: Session Expiry

En `conversation-pipeline.ts`: Cuando una sesión expira, el historial completo se flushea a daily memory antes de limpiar.

### Trigger: Proactive Flush

Cuando `meta.messageCount >= memoryFlush.messageThreshold` (default: 5) y la sesión no ha sido flusheada desde la última compactación, se ejecuta un flush fire-and-forget.

### Pipeline de Summarización (`MemoryFlusher.flushToDaily()`)

1. Filtra a mensajes user/assistant
2. Envía transcript con prompt de summarización
3. Usa Claude CLI si configurado, fallback a Ollama
4. Appenda summary al daily log per-bot via `soulLoader.appendDailyMemory()`

### Redacción de Datos Sensibles

`sanitizeFact()` en `src/soul.ts`: Redacta API keys, tokens, agent IDs, passwords, números de teléfono. Salta el hecho completo si > 50% fue redactado.

---

## RAG: Retrieval-Augmented Generation

### Auto-RAG Pre-Fetch

En `ConversationPipeline.prefetchMemoryContext()`:

1. Corre en paralelo con setup de sesión
2. Salta queries < 8 caracteres
3. Busca con config auto-RAG (default: 3 resultados, minScore 0.25)
4. Filtra logs de hoy/ayer y transcripts de sesión (ya están en el prompt)
5. Cap a 2000 chars
6. Inyectado como `## Relevant Memory Context`

### Búsqueda Híbrida (`src/memory/search.ts`)

Combina dos estrategias:

| Estrategia | Mecanismo | Peso default |
|------------|-----------|--------------|
| **Vector** | Cosine similarity contra embeddings almacenados | 0.7 |
| **Keyword** | FTS5 con ranking BM25, stop words (ES + EN), prefix matching | 0.3 |

Score final: `vectorWeight * vectorScore + keywordWeight * keywordScore`

Resultados incluyen source type (`vector`, `keyword`, `both`) y file source type (`memory`, `session`).

---

## Tools de Memoria (accesibles al LLM)

| Tool | Archivo | Descripción |
|------|---------|-------------|
| `save_memory` | `src/tools/soul.ts` | Append hecho al daily memory log |
| `update_soul` | `src/tools/soul.ts` | Reescribir SOUL.md completo |
| `update_identity` | `src/tools/soul.ts` | Merge campos en IDENTITY.md |
| `memory_search` | `src/tools/memory-search.ts` | Búsqueda híbrida en toda la memoria |
| `memory_get` | `src/tools/memory-get.ts` | Leer archivo específico con números de línea |
| `manage_goals` | `src/tools/goals.ts` | CRUD en GOALS.md |
| `improve` | `src/tools/improve.ts` | Spawn Claude Code para editar archivos soul |

---

## Auto-Reflexión (`src/skills/reflection/`)

Pipeline de 4 fases, nightly a las 03:30 (o manual via `/reflect`):

### Fase 1: Gather Context
Recopila soul files + daily logs desde la última reflexión (watermark en `MOTIVATIONS.md`).

### Fase 2: The Mirror (Análisis)
LLM evalúa en 6 dimensiones:
1. **Consistencia**: ¿Las acciones se alinean con el soul?
2. **Personas**: ¿Con quién interactuó y cómo?
3. **Gaps**: ¿Qué preguntas quedaron sin responder?
4. **Patrones**: ¿Qué patrones emergieron?
5. **Alineación**: ¿Las metas progresan?
6. **Amplitud**: ¿Se está explorando lo suficiente?

### Fase 3: The Explorer (opcional)
Búsqueda web autónoma sobre preguntas abiertas usando `web_search` + `web_fetch` en loop agéntico.

### Fase 4: The Architect (Mejora)
Genera:
- MOTIVATIONS.md actualizado
- Patch opcional de SOUL.md (50-3000 chars)
- Entrada de journal

**Anti-drift**: Core Drives deben mantenerse como principios universales. Prioridades situacionales van en Current Focus.

### Fase 4.5: Memory Compaction
Si el log de ayer excede threshold (default 15 líneas), el LLM deduplica y consolida.

---

## AI Soul Generation (`src/soul-generator.ts`)

Generación automática de personalidad para nuevos bots:

1. Triggered via web dashboard: `POST /agents/:id/generate-soul`
2. Acepta: name, role, personalityDescription, language (default: Spanish), emoji
3. Recopila hasta 2 souls existentes como few-shot examples
4. Llama a Claude CLI para producir JSON con `identity`, `soul`, `motivations`
5. `POST /:id/apply-soul` escribe archivos a disco con backup

---

## Versionado y Backup

`backupSoulFile()` en `src/soul.ts`:

- Crea subdirectorio `.versions/`
- Copia archivo con timestamp ISO + `.bak` (excluido del indexer)
- Poda más allá de `maxVersionsPerFile` (default: 10)
- Llamado antes de todos los writes: tools, reflexión, improve, apply-soul

---

## Inyección en System Prompt

`SystemPromptBuilder` (`src/bot/system-prompt-builder.ts`) orquesta el prompt completo:

1. `soulLoader.composeSystemPrompt()` — carga todos los archivos soul
2. Fallback a `config.conversation.systemPrompt` si no hay archivos soul
3. Humanizer prompt (si habilitado)
4. Bloques de instrucciones por tool (según modo)
5. Group chat awareness
6. **RAG context injection** (cerca del final para recency bias)
7. Memory search reminder

Tres modos:
- **`conversation`**: Tools completas
- **`collaboration`**: Solo `memory_search` + `save_memory`
- **`autonomous`**: Tools completas + preámbulo autónomo + goals

---

## Configuración

```jsonc
{
  "soul": {
    "enabled": true,
    "dir": "config/soul",
    "search": {
      "enabled": true,
      "embeddingModel": "your-embedding-model",
      "chunkTargetTokens": 400,
      "vectorWeight": 0.7,
      "keywordWeight": 0.3,
      "autoRag": {
        "enabled": true,
        "maxResults": 3,
        "minScore": 0.25,
        "maxContentChars": 2000
      }
    },
    "memoryFlush": {
      "enabled": true,
      "messageThreshold": 5
    },
    "sessionMemory": {
      "enabled": true,
      "indexOnStartup": true
    },
    "versioning": {
      "enabled": true,
      "maxVersionsPerFile": 10
    }
  }
}
```
