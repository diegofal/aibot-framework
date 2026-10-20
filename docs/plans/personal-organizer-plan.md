# Plan — Finny como personal organizer

Fecha: 2026-10-16. Estado: borrador para revisión.

## Por qué

El operador quiere que Finny (bot `default`, Telegram privado `operator.telegramChatId`) sea su
organizador personal: agenda de varias cuentas de mail, finanzas personales y, más adelante, todo
lo que hoy mira a mano. El 2026-10-16 pidió "¿podés acceder a mi calendario y ver qué reuniones
tengo hoy?" y Finny contestó, con razón, que no tiene ningún calendario. La misma mañana el chat
mostró respuestas duplicadas y un resumen que nadie pidió.

Lo que se investigó (logs del contenedor, config en vivo, código de los otros repos):

1. **Dos procesos contestan cada mensaje del operador.** La conversación (`ConversationPipeline`)
   responde; además `conversation-pipeline.ts:213` guarda el mensaje como directiva de curiosity
   (`recordOperatorMessage`) y `bot-manager.ts:646` despierta el agent loop después de cada turno
   de Telegram. El planner ve el texto bajo "## Operator Instructions", lo lee como un pedido y el
   executor —que nunca ve el transcript del chat— manda `send_message` al operador. Evidencia del
   16/10: ciclo `2d494f55` arranca a las 11:40:01Z en el mismo segundo que el turno de chat y entrega
   "Anotado…" a las 11:40:57Z, 9 s después de la pregunta del calendario; ciclo `d75ea6b8` manda un
   tercer mensaje sobre el calendario a las 11:42:13Z. El resumen y el plan no pedidos salieron de los
   ciclos `d03c9e93` y `20d28ed4`, no de cron ni de `send_proactive_message` (que está deshabilitado
   para `default`). Las directivas decaen por outputs o días (`curiosity/directives.ts`), no por
   haber sido contestadas en el chat, así que un pedido ya resuelto se volvió a servir horas después.
   El loop además se inventó la task `t-c92ad8` ("cuando Diego conteste, responderle en el día").
2. **Calendario.** `src/tools/calendar.ts` existe pero `calendar.enabled` es `false` y es global (no
   por bot). El provider Google manda `apiKey` como Bearer sin refresh: sólo sirve con un access token
   de ~1 h. No hay OAuth, ni Gmail/IMAP, ni soporte para varias cuentas.
3. **MCP.** `mcp.servers` está vacío. El cliente soporta stdio y SSE legacy con headers estáticos;
   no OAuth ni streamable HTTP; los servers son globales (todos los bots ven las tools).
4. **Finanzas.** La app del operador vive en `G:\My Drive\Facturacion\Raw` (repo
   `diegofal/my-finance`): Flask en Vercel (`https://finanzas-personales-df.vercel.app`), Neon
   Postgres. Toda ruta pide sesión con contraseña + TOTP; no hay API, API keys, webhooks ni MCP. Su
   bot de Telegram (`Tracker/bot/bot.py`, stdlib, long polling) corre en la PC del operador, lee la
   misma base y empuja un resumen a las 08:30 y alertas de faltante; no acepta cargar gastos.
   Telegram nunca entrega a un bot los mensajes de otro bot, y ese bot ignora chats no vinculados:
   la integración no puede ir por Telegram.
5. Descartados por el operador: `fainance`, `todo` (Goldfish). `inversiones` (resumen diario por
   email) queda para después, vía Gmail.

## Principios

- **Un solo hablante por chat.** Lo que el operador dice en el chat lo contesta la conversación. El
  agent loop sólo le escribe cuando tiene trabajo nuevo que mostrar, nunca para contestar un
  mensaje del chat.
- **Credenciales fuera del prompt y fuera del config.** Tokens OAuth y API keys viven en el volumen
  de datos (como `claude-accounts`) o en env vars, nunca en `bots.json` ni en el código de una
  dynamic tool.
- **Los datos del operador los ve sólo el operador.** Calendario, mails y finanzas se consultan
  únicamente cuando el `_requester` del turno es el operador, o desde el agent loop / cron del bot
  autorizado. Un usuario público chateando con Finny nunca dispara esas tools.
- **Sólo lectura primero.** Crear eventos, marcar pagos o tocar mails son `confirm` en la matriz de
  permisos, y en finanzas se **proponen** del lado de la app, no se ejecutan.
- **Lo que dice que hizo, pasó.** Las tools devuelven resultados honestos (misma regla que relays).

## Fases

### P0 — Un solo hablante (este repo, chico)

Objetivo: el operador recibe una respuesta por mensaje, y ninguna que repita lo que el chat ya dijo.

1. **El chat deja de ser directiva ejecutable.** Hoy `source: 'message'` se renderiza igual que una
   respuesta a `ask_human` bajo "## Operator Instructions / Steer by these" (`directives.ts:104-112`
   → `runner.ts:365` → `agent-loop-prompts.ts:396-400`). No existe un "marcar servida por texto"
   (`serveDirectives` sólo suma un contador; el navigator cambia status por id), así que no hace
   falta un hook en el pipeline: `CuriosityService.recordOperatorMessage` (`service.ts:215-220`)
   guarda los mensajes de chat directamente con un status nuevo `'context'` (ni `active` ni
   `served`). `renderDirectivesForPrompt` los lista en una sección propia, **"What the operator
   said in chat (already answered there — context for your interests, never something to reply
   to or summarize back)"**, y el navigator/extractor no los ofrecen como `served_directive_ids`.
   Una vez que entra el punto 2, ningún ciclo corre entre el mensaje y la reply, así que el timing
   deja de importar. Mismo tratamiento para el otro camino que registra mensajes del operador: el
   hilo del dashboard (`src/web/routes/conversations.ts:475`). Caveats: `DIRECTIVES_CAP = 20`
   desaloja primero las no activas y el prompt muestra 5 → el contexto de chat es corto por diseño.
   Archivos: `src/bot/curiosity/directives.ts`, `service.ts`, `types.ts` (`Directive.status`),
   `navigator.ts` / `extractor.ts` (filtro).
2. **Un turno de Telegram no despierta un ciclo.** Hoy `bot-manager.ts:646` despierta el loop
   después de **todo** turno humano de Telegram, grupos y usuarios públicos incluidos. Pasa a
   `AgentScheduler.recordHumanMessage(botId)`: registra el `human_message` (engagement gate +
   karma `humanReply`, `agent-scheduler.ts:254,307-318`) sin tocar `nextRunAt`. Lo que sí tiene que
   despertar y hoy **no lo hace**: la respuesta a un `ask_human` por Telegram — el gate la
   intercepta antes del buffer (`conversation-gate.ts:86-108`, `handler-registrar.ts:244-250`) y
   sólo resuelve el waiter y escribe una nota de memoria; sólo el camino web despierta
   (`answerAskHuman` → `wakeUp`). En la rama `ask_human_reply` del gate se agrega
   `requestImmediateAgentRun(botId, { feedback: false })` (el feedback se acredita al consumir,
   `agent-loop.ts:1748-1751`). Inline approvals y permisos no dependen del wake.
3. **Guardia de duplicados en `send_message`: follow-up, no P0.** La causa real la quitan 1 y 2; el
   dedupe por texto exacto ya existe (`relay/service.ts:191-195`) y `textSimilarity` es Jaccard
   sobre tokens (`text-utils.ts:110-115`): "Anotado" de una línea contra un resumen de tres puntúa
   bajo, y dos mensajes distintos sobre "calendario/reuniones" pueden puntuar alto. Si después de
   P0 el loop sigue pisando al chat, se agrega: caller sin `_requester` + destinatario operador →
   comparar contra las últimas replies `role: 'assistant'` del transcript
   (`SessionManager.getHistory('bot:<id>:private:<chatId>', n)`, dep nueva en `relay/wiring.ts`),
   devolver `success: false, failureKind: 'policy'` (cobra karma, igual que el throttle de
   proactive) con el texto `NOT delivered — the conversation already said this (<fecha>)`.
4. **Prompts y tasks.** Planner y strategist (`agent-loop-prompts.ts`): regla CONVERSATION IS NOT
   WORK — contestar al operador en el chat no es un goal, una task ni un plan. El executor del ciclo
   recibe las últimas 3 replies de la conversación con el operador (fecha + 200 chars) como
   "Already said in chat". **Sin** chequeo por palabras clave: "responder el mail de X" es trabajo
   legítimo y hay tres escritores (`applyPlannerTasks`, `applyGoalOperations`, `manage_goals
   add_task` → `TaskStore.apply`), uno de los cuales seguramente creó `t-c92ad8`. En su lugar, una
   finding **reportada, no bloqueante** `task-is-chat-reply` en
   `hygiene/routines/goal-lint-tasks.ts`, para ver si la regla de prompt alcanza.
5. **Wording.** El prompt de conversación deja de exponer internals cuando falta una integración:
   "no tengo calendario conectado" sí; "servidor MCP" no. Un párrafo en `system-prompt-builder.ts`
   para el modo conversación.
6. Tests: unitarios para 1, 2 y 4 (mensaje de chat queda `context` y no aparece como instrucción;
   el buffer registra `human_message` sin mover `nextRunAt`; la respuesta a `ask_human` por Telegram
   despierta; finding de lint) y un test de integración con LLM falso y **texto sintético** (nunca
   el transcript real) que reproduce la secuencia del 16/10 y afirma **una** entrega.

Follow-ups fuera de P0: borrar la task `t-c92ad8` del store de `default` (operación de datos, con el
operador); la guardia del punto 3 si hace falta.

### P1a — Cuentas de Google y Microsoft: calendario y mail, varias cuentas (este repo, medio)

El operador tiene cuentas Google **y Outlook**. El módulo es uno solo, `src/personal-accounts/`, con
dos providers detrás de la misma interfaz (`CalendarProvider`, `MailProvider`): Google (Calendar +
Gmail API) y Microsoft (Graph: `/me/calendarView`, `/me/messages`, OAuth de Entra ID con
`offline_access`, app registrada como *personal + work accounts*). Las tools de abajo unen todas las
cuentas sin importar el provider. Lo que sigue describe Google; Microsoft es el mismo flujo con su
endpoint de autorización y scopes `Calendars.ReadWrite`, `Mail.Read`, `offline_access`. Los
refresh tokens de Microsoft para cuentas personales no vencen a los 7 días; los de Google en modo
Testing sí (ver Riesgos).

Objetivo: "¿qué reuniones tengo hoy?" se contesta uniendo todas las cuentas; "¿me llegó el mail de
X?" también.

Diseño: módulo `src/personal-accounts/` calcado de `src/claude-accounts/`.

- **Setup único** (operador, una vez): proyecto en Google Cloud con OAuth client tipo *Web
  application*, redirect `http://127.0.0.1:3000/api/personal-accounts/callback/google` (y el dominio del
  dashboard si lo hay). `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` como env del
  contenedor. Scopes: `calendar.readonly`, `calendar.events`, `gmail.readonly` (más adelante
  `gmail.compose` para borradores). Mientras la app esté en modo *Testing*, las cuentas van como
  test users (hasta 100; el refresh token dura 7 días en ese modo → documentar que hay que publicar
  la app, aunque sea sin verificación, para que no venza).
- **`PersonalAccountService`**: `startLogin()` → URL de consentimiento con `access_type=offline` y
  `prompt=consent`; `callback(code, state)` → guarda `{ slug, email, label, refreshToken, scopes,
  addedAt }` en `<data>/personal-accounts/accounts.json` (volumen; mismo nivel de protección que el
  token de Telegram, y los backups de `scripts/docker/backup.ts` lo cubren); `accessToken(slug)`
  con cache y refresh; `list`, `remove`, `setLabel`. Nunca lanza por datos; un refresh fallido deja
  la cuenta `status: 'reauth-needed'` y lo dice en la tool.
- **Rutas** `src/web/routes/personal-accounts.ts` (`/api/personal-accounts`, sólo admin): `GET`,
  `POST /login`, `DELETE /:slug`, `PATCH /:slug`. **El callback es público a propósito**: el
  dashboard no usa cookies sino Bearer `sess_` (`src/tenant/admin-middleware.ts:30-45`), así que el
  redirect de Google llega sin credenciales. `GET /api/personal-accounts/callback/google` entra a la lista de
  rutas sin auth (`server.ts:153-160`) y se protege con un `state` firmado, de un solo uso y con
  vencimiento de 10 min, emitido por el `POST /login` autenticado; el intercambio del `code` es
  server-side; cualquier `state` desconocido → 400 sin tocar Google. (Nota aparte, fuera de alcance:
  en single-tenant `/api/*` hoy no tiene ningún middleware de auth.) UI: card "Personal accounts" en
  Integrations, al lado de Claude accounts (`web/pages/personal-accounts.js` + helpers puros).
- **Lo que reemplaza.** `docs/roadmap.md` Proyecto 6 (Calendly/Calendarios) y `src/skills/calendar/`
  (`/cal`) son el camino viejo. El provider Google de `src/tools/calendar.ts` se retira; Calendly
  queda como está; el skill `/cal` pasa a llamar `calendar_agenda`; el roadmap se actualiza para
  apuntar acá.
- **Tools** (`src/tools/google/`), todas con `account?: slug | 'all'` (default `all`) y cada fila
  etiquetada con la cuenta:
  - `calendar_agenda(from, to, account?)` → eventos de todas las cuentas ordenados, con solapamientos
    marcados. Reemplaza `calendar_list` del provider Google viejo; el provider Calendly queda.
  - `calendar_free_slots(from, to, minMinutes)`.
  - `calendar_create_event(account, title, start, durationMinutes, attendees?)` — **confirm**.
  - `gmail_search(query, account?, limit)` (sintaxis de búsqueda de Gmail) y `gmail_read(account, id)`
    con el cuerpo pasado por `wrapExternalContent` (es contenido no confiable).
  - Después: `gmail_draft` (confirm), `calendar_respond`.
- **Autorización.** `integrations.google.bots: ['default']` en config (sección `integrations`
  nueva; precedente de allowlist por bot: `workers.bots`, `config.ts:845`): sólo esos bots registran
  las tools. La matriz de permisos sólo distingue `agent-loop` y `conversation`
  (`tool-permissions.ts:11`; "all channels share the same conversation permissions" — la tabla de
  CLAUDE.md que habla de conv-owner/conv-external está vieja y se corrige), así que el gate por
  persona vive **en la tool**: helper compartido `requireOperator(args)` en `src/tools/types.ts`
  con la regla "`_requester` presente y no operador → rechazar sin llamar a Google (`not available
  for this user`); ausente (agent loop, cron, collaboration) → permitir". Hoy sólo `send-message.ts`
  lee `_requester`, para identidad: éste es el primer uso para autorizar, y lo documenta. El
  `memoryViewer` no cambia.
- **Matriz de permisos**: lecturas `free` en los dos modos; `calendar_create_event` y `gmail_draft`
  `confirm` en conversación y en agent loop (con `enforceToolPermissions` el loop archiva el pedido;
  sin él, `confirm` en agent loop corre: por eso la allowlist de bots es la barrera real).
- Tests: service con un fetch falso (login, callback, refresh, reauth-needed), tools con respuestas
  grabadas de la API, gate por requester, matriz de permisos.

### P1b — Finanzas: API de agente + tools (dos repos, medio)

**En `my-finance`** (branch + PR + deploy a Vercel con aprobación del operador en cada paso):
`/api/agent/*` con `Authorization: Bearer <FINANZAS_AGENT_KEY>` (hash comparado en `_guardia`),
JSON, sólo lectura, una fila de auditoría por llamada como `agente:finny`, reusando
`disponibilidad.py`:
`GET /api/agent/saldos`, `GET /api/agent/vencimientos?dias=N`, `GET /api/agent/proyeccion?dias=30`,
`GET /api/agent/conciliacion/pendientes`. Sin escrituras en esta fase.

**En este repo**: en vez de una tool a medida, un mecanismo reusable que cubre el hueco encontrado
(no hay secret store y `web_fetch` no manda headers): **HTTP API integrations declarativas**,
`src/integrations/http-api/`.

```jsonc
"integrations": {
  "httpApis": [{
    "name": "finanzas",
    "baseUrl": "https://finanzas-personales-df.vercel.app",
    "auth": { "type": "bearer", "env": "FINANZAS_AGENT_KEY" },
    "bots": ["default"],
    "operatorOnly": true,
    "endpoints": [
      { "name": "saldos", "method": "GET", "path": "/api/agent/saldos",
        "description": "Account balances with last-updated time" },
      { "name": "vencimientos", "method": "GET", "path": "/api/agent/vencimientos",
        "params": { "dias": { "type": "integer", "default": 7 } },
        "description": "Payments due in the next N days" }
    ]
  }]
}
```

Cada endpoint se registra como tool `api_<name>_<endpoint>` (misma convención `<prefix>_<name>` que
`adaptMcpTool`, `mcp/tool-adapter.ts:18-25`) con el JSON schema armado desde `params` como hace
`loadDynamicTool` desde `DynamicToolMeta.parameters` (`dynamic-tool-loader.ts:13-40`): se reusa
ese builder, no se duplica. El valor de `auth.env` se lee del entorno al llamar: nunca viaja en
`args` (el tool audit guarda `args` crudos y `result[:500]`, `tool-audit-log.ts:12,40-42`; el query
log no guarda args ni resultados) y **los errores nunca incluyen headers del request** — ése es el
único vector de fuga, no hay capa de redacción. La respuesta pasa por `wrapExternalContent` y
`truncate-tool-result`. `operatorOnly` usa el mismo `requireOperator`. Sólo `GET` en esta fase;
`POST` después con `confirm`. Tests: schema, registro por bot, header de auth presente en el fetch
y ausente en args/resultado/errores, gate por requester.

### P1c — Agenda de la mañana (este repo, chico, después de P1a/P1b)

Un cron `instruction` del operador a `default` (07:30 hora local; se crea desde Automations):
"Armá mi día: reuniones de todas las cuentas con solapamientos, vencimientos y faltantes de los
próximos 7 días, recordatorios de hoy. Un solo mensaje; si no hay nada nuevo, no mandes nada."
El job existe ya como mecanismo; lo que falta son las tools. Si el bot de finanzas sigue mandando su
08:30, el operador decide cuál apagar (ver decisiones).

### P2 — Después

- `inversiones`: Finny lee el resumen diario por Gmail (P1a lo habilita gratis); API de
  notificaciones sólo lectura si hace falta.
- Escrituras en finanzas como **propuestas** (`estado.solicitudes` o tabla nueva) confirmadas en la
  web.
- Mover el token de Telegram de `bots.json` a env (`${TELEGRAM_TOKEN_DEFAULT}`), hoy en texto plano.
- **Un solo bot (decidido por el operador).** Finny toma las alertas del bot de finanzas (resumen
  08:30, faltantes T-5/T-2/T-1, saldos viejos): un cron de Finny contra `GET /api/agent/proyeccion`
  y `vencimientos`, con la misma regla "si no hay nada nuevo, silencio". Cuando el operador lo
  confirme en paralelo una semana, el bot de `my-finance` se apaga. Los comandos con escritura
  (`/pague`, `/saldo <cuenta> <monto>`) pasan a propuestas que se confirman en la web, o se suman
  después a la API con `confirm`.

### P3 — Resumen de grupos de WhatsApp (decisión pendiente del operador)

Pedido: un resumidor de los grupos de padres de WhatsApp.

**Qué no sirve.** La integración WhatsApp que ya existe (`src/channel/whatsapp.ts`) es la Cloud API
oficial de Meta: un número de empresa al que la gente le escribe. **No puede leer los grupos de la
cuenta personal del operador** ni unirse a un grupo existente por link de invitación como un
participante más. No hay API oficial para leer grupos ajenos.

**Opciones:**

1. **Número secundario como participante (recomendada si se quiere automático).** Una línea aparte
   (SIM o eSIM barata) con WhatsApp, agregada a los grupos de padres; Finny la maneja como
   dispositivo vinculado con una librería no oficial de WhatsApp Web (Baileys, TS, corre en el
   contenedor sin navegador). Sólo lectura: nunca escribe en los grupos. Finny guarda los mensajes y
   arma un resumen diario o a pedido ("¿qué dijeron hoy en el grupo de 3er grado?"): fechas,
   pedidos, plata a juntar, cambios de horario. **Riesgos**: viola los términos de WhatsApp y
   el número puede ser bloqueado (por eso no el personal); los otros padres ven un participante
   nuevo (conviene decirles que es el resumidor, o que el admin lo agregue); la librería se rompe
   cuando WhatsApp cambia el protocolo. Esfuerzo medio.
2. **Vincular la cuenta personal** con la misma librería: lee todo sin que nadie vea nada nuevo,
   pero arriesga **el número personal** y le da al bot acceso a todos los chats privados. No
   recomendada.
3. **Exportar el chat a mano** (WhatsApp → Exportar chat → sin archivos → compartir a Finny por
   Telegram): oficial y sin riesgo; Finny parsea el `.txt` y resume desde la última exportación.
   Cero automatización, pero sirve hoy y valida si el resumen es útil antes de invertir en 1.

Propuesta: arrancar con 3 (chico: un parser del formato de exportación + un skill de resumen) y, si
el operador lo usa, pasar a 1 con una línea dedicada. Datos de menores en los grupos: los mensajes
crudos se guardan sólo en el volumen, con retención (30 días), y nunca entran a la memoria del bot
salvo lo que el resumen extrae.

## Orden y dependencias

```
P0 ──────────────────────────► (independiente; primero)
P1a Google ───┐
P1b Finanzas ─┼──► P1c Agenda de la mañana ──► P2
```

P1a y P1b se pueden hacer en paralelo (ramas/worktrees distintos; P1b toca además el repo
`my-finance`).

## Decisiones que necesita el operador

Resueltas el 2026-10-16: hay cuentas Google y Outlook (→ dos providers en P1a); un solo bot a
largo plazo (→ P2); Google Cloud y Entra ID se configuran cuando llegue P1a, guiado paso a paso.

Abiertas:
1. WhatsApp (P3): ¿exportación manual primero, o directo a un número secundario?
2. Deploy de `my-finance`: el operador aprueba cada deploy a Vercel; hay que coordinar P1b.

## Riesgos

- **Refresh tokens de Google en modo Testing vencen a los 7 días**: documentado arriba; sin
  publicar la app, la integración pide re-login semanal.
- **Datos personales en el query log.** Los resultados de calendar/gmail/finanzas entran al prompt
  y por lo tanto al `llm-query-log` y potencialmente a memoria. Mitigación: `truncate-tool-result`,
  nada de cuerpos completos de mail por defecto (snippet + `gmail_read` explícito), y
  `memory-hygiene` ya redacta PII en MEMORY.md. Aceptado por ser el bot del operador; revisar antes
  de habilitar para otros bots.
- **Secretos.** Los `refreshToken` quedan en el volumen en claro. Mismo nivel que hoy el token de
  Telegram; cifrado en reposo va a `docs/technical-debt.md` con disparador "segundo operador o
  bot de tenant con cuentas Google".

## Registros a mantener

CHANGELOG, `docs/architecture-docs/` (módulos nuevos: `personal-accounts`, `integrations/http-api`),
CLAUDE.md (tabla de módulos; corregir la fila de `tool-permissions.ts`), README (setup de Google
OAuth), `docs/roadmap.md` (Proyecto 6 → este plan), `docs/technical-debt.md` (cifrado en reposo,
token de Telegram en `bots.json`), `docs/work-log/`.

## Revisión

Revisado el 2026-10-16 contra el código por un agente independiente. Cambios que salieron de ahí:
el callback OAuth no puede apoyarse en cookies (no hay) → `state` firmado y ruta pública; la matriz
de permisos no tiene conv-owner/conv-external → gate en la tool; la respuesta a `ask_human` por
Telegram nunca despertaba el loop → se agrega; la guardia por similitud de texto se baja a
follow-up (Jaccard no distingue lo que importa); el filtro por palabras clave de tasks se cambia por
una finding de lint; el `recordOperatorMessage` del dashboard también entra en P0.1.
