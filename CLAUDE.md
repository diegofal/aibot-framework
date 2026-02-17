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
| `tool-registry.ts` | Inicialización de tools, executor, filtro collaboration-safe |
| `system-prompt-builder.ts` | Composición unificada de system prompts (modo `conversation` y `collaboration`) |
| `memory-flush.ts` | Flush de sesión a daily memory log |
| `group-activation.ts` | Checks de relevancia en grupos: deference, LLM relevance, broadcast |
| `conversation-pipeline.ts` | Pipeline core: session expiry, RAG prefetch, LLM call, persist, reply |
| `collaboration.ts` | Bot-to-bot: visible, internal, delegation, multi-turn |
| `handler-registrar.ts` | Registro de handlers grammy: skills, commands, media, auth, built-ins |
| `index.ts` | Barrel re-export de `BotManager` |

### Patrón de composición

Todos los módulos reciben un `BotContext` compartido (estado mutable por referencia).
Las dependencias circulares (delegation/collaborate tools → CollaborationManager) se resuelven con lazy callbacks `() => collaborationManager`.

### Grafo de dependencias

```
BotManager (facade)
  ├── ToolRegistry            (sin deps de módulo)
  ├── SystemPromptBuilder     (lee ToolRegistry.getDefinitions())
  ├── MemoryFlusher           (sin deps de módulo)
  ├── GroupActivation         (sin deps de módulo)
  ├── ConversationPipeline    (usa SystemPromptBuilder, MemoryFlusher, ToolRegistry)
  ├── CollaborationManager    (usa SystemPromptBuilder, ToolRegistry)
  └── HandlerRegistrar        (usa ConversationPipeline, GroupActivation, MemoryFlusher)
```
