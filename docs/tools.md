# Tools — Sistema de Herramientas LLM

El framework expone herramientas (tools) al LLM siguiendo el formato de function-calling de OpenAI. Cada tool tiene un schema (`ToolDefinition`), lógica de ejecución, y puede habilitarse/deshabilitarse por bot y por contexto.

---

## Arquitectura

### Tipos core (`src/tools/types.ts`)

| Interfaz | Descripción |
|---|---|
| `ToolDefinition` | Schema enviado al LLM (`type: 'function'`, `function.name`, `function.description`, `function.parameters`) |
| `ToolCall` | Tool call parseado del output del LLM (`function.name`, `function.arguments`) |
| `ToolResult` | Resultado de ejecución (`success: boolean`, `content: string`) |
| `Tool` | Herramienta completa: `definition` + `execute(args, logger)` |
| `ToolExecutor` | Callback `(name, args) => Promise<ToolResult>` usado por el cliente LLM |

### ToolRegistry (`src/bot/tool-registry.ts`)

Orquestador central de todas las tools. Responsabilidades:

- **Inicialización** (`initializeAll()`): Crea tools en orden según flags de config. Usa lazy callbacks `() => collaborationManager` para resolver dependencias circulares.
- **Filtrado por bot**: `getDefinitionsForBot(botId)` / `getToolsForBot(botId)` excluyen tools listadas en `config.bots[].disabledTools`.
- **Filtrado collaboration-safe**: `getCollaborationTools()` excluye `collaborate` y `delegate_to_bot` para evitar loops recursivos.
- **Creación de executor**: `createExecutor(chatId, botId)` retorna un `ToolExecutor` que inyecta `_chatId` y `_botId` como args internos en cada llamada.

### Multi-Turn Tool Loop (`src/ollama.ts`)

El loop de tools funciona así:

1. El LLM recibe mensajes + definiciones de tools
2. Si responde con `tool_calls`, se ejecuta cada tool y se agregan los resultados como mensajes `role: 'tool'`
3. Se repite hasta `maxToolRounds` iteraciones (default: 5, configurable via `config.webTools.maxToolRounds`)
4. En la última ronda se omiten las tools para forzar respuesta de texto
5. Si se agotan las rondas, retorna un mensaje fallback

> **Nota:** El backend Claude CLI NO soporta tool calling. `LLMClientWithFallback` rutea automáticamente al fallback Ollama cuando se necesitan tools.

---

## Inventario de Tools

### Web Tools

#### `web_search`
| | |
|---|---|
| **Archivo** | `src/tools/web-search.ts` |
| **Descripción** | Busca en la web usando Brave Search API |
| **Parámetros** | `query` (string, requerido) |
| **Config** | `config.webTools.search` — `apiKey`, `maxResults` (5), `timeout` (30s), `cacheTtlMs` |
| **Collab-safe** | Sí |
| **Notas** | Resultados cacheados via `TtlCache` (15 min). Output envuelto con marcadores `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`. |

#### `web_fetch`
| | |
|---|---|
| **Archivo** | `src/tools/web-fetch.ts` |
| **Descripción** | Obtiene y lee el contenido de una página web |
| **Parámetros** | `url` (string, requerido) |
| **Config** | `config.webTools.fetch` — `maxContentLength` (50000), `timeout` (30s), `cacheTtlMs` |
| **Collab-safe** | Sí |
| **Notas** | Protección SSRF: bloquea localhost, IPs privadas (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, IPv6 local), y schemes no HTTP(S). HTML convertido a texto plano. Contenido truncado a `maxContentLength`. |

### Soul & Memory Tools

#### `save_memory`
| | |
|---|---|
| **Archivo** | `src/tools/soul.ts` |
| **Descripción** | Guarda un hecho, preferencia o contexto en el daily memory log |
| **Parámetros** | `fact` (string, requerido) |
| **Config** | `config.soul.enabled` |
| **Collab-safe** | Sí |
| **Notas** | Usa `_botId` para resolver el SoulLoader por bot. NO guarda credenciales, API keys, tokens, teléfonos, ni hechos ya conocidos. |

#### `update_soul`
| | |
|---|---|
| **Archivo** | `src/tools/soul.ts` |
| **Descripción** | Reescribe personalidad, tono y reglas de comportamiento (reemplaza SOUL.md completo) |
| **Parámetros** | `content` (string, requerido) |
| **Config** | `config.soul.enabled` |
| **Collab-safe** | Sí |

#### `update_identity`
| | |
|---|---|
| **Archivo** | `src/tools/soul.ts` |
| **Descripción** | Cambia nombre, emoji o vibe en IDENTITY.md |
| **Parámetros** | `name` (string, opc), `emoji` (string, opc), `vibe` (string, opc) — al menos uno requerido |
| **Config** | `config.soul.enabled` |
| **Collab-safe** | Sí |

#### `manage_goals`
| | |
|---|---|
| **Archivo** | `src/tools/goals.ts` |
| **Descripción** | Gestiona metas estructuradas en GOALS.md |
| **Parámetros** | `action` (requerido: `list`/`add`/`update`/`complete`), `goal`, `status`, `priority`, `notes`, `outcome` |
| **Config** | `config.soul.enabled` |
| **Collab-safe** | Sí |
| **Notas** | Persiste en formato markdown con checkboxes. Mantiene solo las últimas 10 metas completadas. Match de metas por substring (case-insensitive). |

### Memory Search Tools

#### `memory_search`
| | |
|---|---|
| **Archivo** | `src/tools/memory-search.ts` |
| **Descripción** | Busca en memoria persistente (daily logs, notas legacy, historial de sesión) |
| **Parámetros** | `query` (string, req), `maxResults` (number, opc, default 5), `minScore` (number, opc, default 0.1) |
| **Config** | Requiere `ctx.searchEnabled` y `ctx.memoryManager` |
| **Collab-safe** | Sí |

#### `memory_get`
| | |
|---|---|
| **Archivo** | `src/tools/memory-get.ts` |
| **Descripción** | Obtiene contenido de un archivo de memoria específico con números de línea |
| **Parámetros** | `path` (string, req), `from` (number, opc), `lines` (number, opc) |
| **Config** | Requiere `ctx.searchEnabled` y `ctx.memoryManager` |
| **Collab-safe** | Sí |
| **Notas** | Seguridad: rechaza paths absolutos y traversal con `..`. Pensado como follow-up de `memory_search`. |

### Execution Tools

#### `exec`
| | |
|---|---|
| **Archivo** | `src/tools/exec.ts` |
| **Descripción** | Ejecuta un comando shell en la máquina host |
| **Parámetros** | `command` (string, req), `workdir` (string, opc), `background` (boolean, opc) |
| **Config** | `config.exec` — `enabled`, `timeout` (30s), `maxOutputLength` (10000), `workdir`, `allowedPatterns`, `deniedPatterns` |
| **Collab-safe** | Sí |
| **Notas** | Deny list builtin: `rm -rf /`, `mkfs`, `dd` a `/dev`, fork bombs, `chmod 777 /`, `shutdown`, `reboot`. Allow/deny patterns configurables (regex). Modo background: registra proceso con `registerProcess()`, retorna session ID + PID. |

#### `process`
| | |
|---|---|
| **Archivo** | `src/tools/process.ts` |
| **Descripción** | Gestiona procesos en background |
| **Parámetros** | `action` (req: `list`/`poll`/`write`/`kill`/`clear`), `session_id`, `input` |
| **Config** | `config.processTools` — `enabled`, `maxSessions` (10), `finishedTtlMs` (10 min), `maxOutputChars` (200000) |
| **Collab-safe** | Sí |
| **Notas** | Registro singleton de procesos. Auto-limpieza de sesiones terminadas tras TTL. Funciona con `exec` en modo `background=true`. |

### File Tools

#### `file_read`
| | |
|---|---|
| **Archivo** | `src/tools/file.ts` |
| **Descripción** | Lee contenido de archivo con números de línea, soporta offset/limit |
| **Parámetros** | `path` (string, req), `offset` (number, opc), `limit` (number, opc) |
| **Config** | `config.fileTools` — `enabled`, `basePath`, `maxFileSizeBytes` (1MB), `deniedPatterns` |
| **Collab-safe** | Sí |
| **Notas** | Validación de path dentro de `basePath`. Deniega: `.env`, credentials, `.key`, `.pem`, `.p12`, `.pfx`, `id_rsa`, `id_ed25519`, `.ssh/`, `shadow`, `.secret`, `token.json`. Detección de escape por symlinks. |

#### `file_write`
| | |
|---|---|
| **Archivo** | `src/tools/file.ts` |
| **Descripción** | Escribe contenido a un archivo (crear/sobrescribir/append) |
| **Parámetros** | `path` (string, req), `content` (string, req), `append` (boolean, opc, default false) |
| **Config** | Igual que `file_read` |
| **Collab-safe** | Sí |
| **Notas** | Auto-crea directorios intermedios. Misma validación de path y denied patterns. |

#### `file_edit`
| | |
|---|---|
| **Archivo** | `src/tools/file.ts` |
| **Descripción** | Edita archivo existente por reemplazo exacto de texto |
| **Parámetros** | `path` (string, req), `old_text` (string, req), `new_text` (string, req), `replace_all` (boolean, opc) |
| **Config** | Igual que `file_read` |
| **Collab-safe** | Sí |
| **Notas** | Falla si `old_text` no existe o si hay múltiples ocurrencias sin `replace_all=true`. |

### Scheduling & Time

#### `get_datetime`
| | |
|---|---|
| **Archivo** | `src/tools/datetime.ts` |
| **Descripción** | Obtiene fecha, hora, día, timezone e ISO 8601 actual |
| **Parámetros** | `timezone` (string, opc — override IANA) |
| **Config** | `config.datetime` — `enabled`, `timezone` (default "America/Argentina/Buenos_Aires"), `locale` (default "es-AR") |
| **Collab-safe** | Sí |

#### `cron`
| | |
|---|---|
| **Archivo** | `src/tools/cron.ts` |
| **Descripción** | Gestiona trabajos programados y recordatorios |
| **Parámetros** | `action` (req: `add`/`list`/`remove`/`run`/`status`), `name`, `schedule` (objeto con `kind`: `at`/`every`/`cron`), `text`, `deleteAfterRun`, `jobId`, `includeDisabled` |
| **Config** | `config.cron.enabled` |
| **Collab-safe** | Sí |
| **Notas** | Tres tipos de schedule: one-shot (`at` con ISO-8601), intervalo (`every` con ms), expresión cron (`cron` con 5-field + tz). Soporta recuperación de params aplanados por el LLM. |

### Communication Tools

#### `phone_call`
| | |
|---|---|
| **Archivo** | `src/tools/phone-call.ts` |
| **Descripción** | Realiza llamadas telefónicas y gestiona contactos via Twilio |
| **Parámetros** | `action` (req: `call`/`add_contact`/`list_contacts`/`remove_contact`), `contact`, `message`, `phone_number`, `loop` |
| **Config** | `config.phoneCall` — `accountSid`, `authToken`, `fromNumber`, `defaultNumber`, `language`, `voice`, `contactsFile` |
| **Collab-safe** | Sí |
| **Notas** | Agenda de contactos en archivo JSON. Usa Twilio API con TwiML. Soporta números directos (con `+`) o contactos nombrados. |

### Collaboration Tools

#### `delegate_to_bot`
| | |
|---|---|
| **Archivo** | `src/tools/delegate.ts` |
| **Descripción** | Delega un mensaje a otro bot — el bot destino responde como sí mismo |
| **Parámetros** | `targetBotId` (string, req), `message` (string, req) |
| **Config** | Requiere `config.bots.length > 1` |
| **Collab-safe** | **NO** — excluido en modo collaboration |
| **Notas** | No puede delegarse a sí mismo. El bot destino corre SIN tools para prevenir loops de delegación. |

#### `collaborate`
| | |
|---|---|
| **Archivo** | `src/tools/collaborate.ts` |
| **Descripción** | Colaboración multi-acción con otros agentes |
| **Parámetros** | `action` (req: `discover`/`send`/`end_session`), `targetBotId`, `message`, `sessionId`, `visible` |
| **Config** | Requiere `config.collaboration.enabled` y `config.bots.length > 1` |
| **Collab-safe** | **NO** — excluido en modo collaboration |
| **Notas** | `discover`: lista agentes con capabilities. `send` interno: multi-turn con sessionId, target tiene tools collab-safe. `send` visible: envía en grupo con @mention. No puede colaborar consigo mismo. |

### Self-Improvement Tools

#### `improve`
| | |
|---|---|
| **Archivo** | `src/tools/improve.ts` |
| **Descripción** | Lanza una sesión de Claude Code para revisar y mejorar archivos de soul/personalidad/memoria |
| **Parámetros** | `focus` (opc: `memory`/`soul`/`motivations`/`identity`/`all`), `context` (string, opc) |
| **Config** | `config.improve` — `enabled`, `claudePath`, `timeout`, `maxOutputLength`, `soulDir`, `allowedFocus` |
| **Collab-safe** | Sí |
| **Notas** | Spawn de proceso Claude Code CLI. Backup de archivos soul antes de modificar. Resuelve directorio soul por bot. |

### Dynamic Tools

#### `create_tool`
| | |
|---|---|
| **Archivo** | `src/tools/create-tool.ts` |
| **Descripción** | Crea una nueva herramienta custom (pendiente aprobación humana) |
| **Parámetros** | `name` (string, req), `description` (string, req), `type` (`typescript`/`command`), `source` (string, req), `parameters` (object, opc), `scope` (opc: `all` o botId) |
| **Config** | `config.dynamicTools` — `enabled`, `storePath`, `maxToolsPerBot` (20) |
| **Collab-safe** | Sí |
| **Notas** | Nombre debe ser snake_case, único, y no conflictar con los 20 nombres reservados (built-in tools). Análisis estático bloquea patrones peligrosos (`process.exit`, `child_process`, `eval`, `Function`, etc). Status inicial: `pending`, requiere aprobación humana via web UI. |

---

## Dynamic Tools — Subsistema

El subsistema de dynamic tools permite a los bots crear nuevas herramientas en runtime:

### Componentes

| Componente | Archivo | Responsabilidad |
|---|---|---|
| `DynamicToolStore` | `src/tools/dynamic-tool-store.ts` | Persistencia en filesystem (`<storePath>/<toolId>/meta.json` + `tool.ts`/`tool.sh`) |
| `DynamicToolLoader` | `src/tools/dynamic-tool-loader.ts` | Convierte meta+source en instancias `Tool` runtime |
| `DynamicToolRegistry` | `src/bot/dynamic-tool-registry.ts` | Registro runtime con hot-load/unload |

### Ciclo de vida

```
Bot llama create_tool → DynamicToolStore.create() → status: "pending"
                                    ↓
                          Human review (web UI)
                                    ↓
                    ┌───────────────┴───────────────┐
                    ↓                               ↓
            approve() → hot-load              reject() → remove
            a ctx.tools[] y                   de runtime
            ctx.toolDefinitions[]
```

### Ejecución

- **TypeScript tools**: Se ejecutan como `bun run tool.ts <JSON args>` con timeout de 30s. Output parseado como JSON `{ success, content }` si es posible.
- **Command tools**: Template shell con placeholders `{{param}}`. Sanitización de valores para prevenir inyección (strips `;`, `&`, `|`, backtick, `$`, parens, braces).

### Scoping

Cada dynamic tool tiene `scope`: `all` (disponible para todos los bots) o un `botId` específico. `DynamicToolRegistry.getToolsForBot()` filtra por scope o creador.

---

## Integración con System Prompt

El `SystemPromptBuilder` (`src/bot/system-prompt-builder.ts`) agrega bloques de instrucciones específicas por cada grupo de tools habilitado:

| Método | Tools cubiertas |
|---|---|
| `webToolsInstructions()` | Guía sobre marcadores `EXTERNAL_UNTRUSTED_CONTENT` |
| `soulToolsInstructions()` | `save_memory`, `update_soul`, `update_identity` |
| `goalsToolInstructions()` | `manage_goals` |
| `execToolInstructions()` | Seguridad en ejecución shell |
| `fileToolsInstructions()` | Operaciones de archivo, preferir edit sobre write |
| `processToolInstructions()` | Gestión de procesos background |
| `memorySearchInstructions()` | RAG awareness, búsqueda obligatoria antes de responder |
| `datetimeToolInstructions()` | Nunca adivinar fecha, siempre llamar al tool |
| `phoneCallInstructions()` | Flujo de gestión de contactos |
| `cronToolInstructions()` | Tipos de schedule, obtener datetime primero |
| `delegationInstructions()` | Lista de bots disponibles |
| `collaborationInstructions()` | Modos visible vs interno, limitaciones de @mention |
| `createToolInstructions()` | Guía de creación de dynamic tools |

Tres modos de prompt: `conversation` (full tools), `collaboration` (solo memory_search + soul), `autonomous` (full + goals + preámbulo autónomo).

---

## Configuración

### Habilitar/deshabilitar tools globalmente

Cada grupo de tools se habilita con un flag en `config/config.json`:

```jsonc
{
  "webTools": { "enabled": true, "maxToolRounds": 5 },
  "exec": { "enabled": true },
  "fileTools": { "enabled": true },
  "processTools": { "enabled": true },
  "datetime": { "enabled": true },
  "phoneCall": { "enabled": false },
  "cron": { "enabled": true },
  "soul": { "enabled": true },
  "improve": { "enabled": true },
  "collaboration": { "enabled": true },
  "dynamicTools": { "enabled": true }
}
```

### Deshabilitar tools por bot

```jsonc
{
  "bots": [
    {
      "id": "therapist",
      "disabledTools": ["exec", "file_write", "file_edit", "phone_call", "improve", "process", "cron"]
    }
  ]
}
```

### Seguridad

| Capa | Mecanismo |
|---|---|
| Web fetch | SSRF protection: bloqueo de IPs privadas, localhost, schemes no HTTP(S) |
| Web content | Marcadores `EXTERNAL_UNTRUSTED_CONTENT` para prevenir inyección de prompts |
| File tools | Path validation, denied patterns (secrets), symlink escape detection, size limits |
| Exec | Deny list builtin + allow/deny patterns configurables |
| Dynamic tools | Análisis estático de código, aprobación humana requerida, sanitización de placeholders |
| Memory | Rechazo de paths absolutos y directory traversal |
| Collaboration | Exclusión de `collaborate`/`delegate_to_bot` en modo collab para prevenir loops |
