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

## Proyecto
- Runtime: Bun
- Lenguaje: TypeScript
- Bot framework: grammy
- Skills: `src/skills/<id>/` con skill.json + index.ts
- Tools del LLM: `src/tools/`
- Config: `config/config.json`
