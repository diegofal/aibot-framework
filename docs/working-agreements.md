# Working agreements — AIBot Framework

<!--
  Reglas canónicas del proyecto. Instaladas por /zero (stage "rules"); CLAUDE.md enlaza acá en vez
  de repetirlas. Este archivo es tuyo: editalo libremente, las actualizaciones de Zero nunca lo tocan.

  Mantener los marcadores zero:rule alrededor de cada regla: son invisibles al renderizar y le
  permiten a /zero saber qué reglas ya tiene este documento. El texto entre ellos se edita libre.

  Deliberadamente liviano: un solo desarrollador, sin tracker ni PRs; cada cambio en su propio
  worktree, mergeado a main. Las reglas de equipo que Zero trae (branch por ticket, labels de
  entorno, gate de producción por ticket, etc.) están declinadas con su motivo en
  .claude/zero.config.json.
-->

Cómo se trabaja en este repo. Aplica igual a una persona que a un agente. Si `CLAUDE.md`
contradice este archivo, gana este archivo.

---

## 1. El loop: entender, planear, construir, verificar

<!-- zero:rule loop.understand since=0.1.0 section=1 -->
### Entender antes de tocar código

Leer el pedido y decirlo de vuelta en lenguaje simple antes de arrancar: qué se construye, qué
queda afuera, qué está sin decidir. Dos respuestas cortan el loop acá:

- **El pedido es una pregunta, no una orden de trabajo.** Se responde y se para.
- **Quedó superado** (otro cambio ya lo resolvió, o el alcance se movió). Decirlo y trabajar sobre
  lo actual.

Antes de refactorizar, agregar features o corregir bugs en el bot core, leer la sección
"Arquitectura del Bot" de `CLAUDE.md` para saber qué módulo tocar. Antes de proponer features o
integraciones nuevas, consultar `docs/roadmap.md` para no duplicar trabajo.
<!-- /zero:rule -->

<!-- zero:rule loop.plan since=0.1.0 section=1 -->
### Planear cambios no triviales

Para un cambio que toca varios archivos o decide algo de diseño, el plan nombra: los archivos que
cambian (citando el código que se leyó para saberlo), los tests que lo prueban, qué queda fuera de
alcance, y cada decisión abierta con una recomendación. Preguntar sólo las decisiones que cambian
lo que se construye; el resto decidirlo y decir qué se decidió.

Antes de cada ciclo, confirmar que lo que se implementa está en el plan acordado. Lo que surja
fuera del plan se anota como follow-up y no se implementa en el mismo ciclo.

Un fix chico y obvio no necesita plan formal.
<!-- /zero:rule -->

<!-- zero:rule loop.build since=0.1.0 section=1 -->
### Construir con el test primero (TDD obligatorio)

Para todo código nuevo o refactor:

1. **Red**: escribir primero el test que describe el comportamiento deseado (o el contrato que se
   mantiene durante un refactor) y verlo fallar, por la razón esperada, antes de tocar la
   implementación.
2. **Green**: el mínimo de código de producción para que pase. Nada extra.
3. **Refactor**: limpiar sin romper los tests. Re-correr `bun test`.
4. **Cobertura por función**: toda función/método público nuevo tiene al menos un test dedicado;
   una rama con comportamiento divergente (errores, edge cases, valores límite) tiene el suyo.

Los tests viven en `tests/` (o `__tests__/` junto al módulo). **Nunca debilitar un test para que
pase**: si el test está mal, se corrige como cambio deliberado y se dice por qué.
<!-- /zero:rule -->

<!-- zero:rule loop.verify since=0.1.0 section=1 -->
### Verificar, después cerrar

Un cambio no está terminado hasta que `bun test` corre limpio para los archivos tocados y los
tests pre-existentes no se rompen. Los que ya fallaban por dependencias externas (Playwright, API
keys) no cuentan como fallos nuevos, pero se nombran.

Juzgar el resultado contra lo pedido, no contra el diff. Cada criterio queda **probado** (se puede
nombrar qué lo prueba), **no entregado**, o **sin probar** — y sin probar no se reporta como
probado. Revisar alcance en las dos direcciones: menos de lo acordado, o más (refactors o "ya que
estaba" no pedidos).
<!-- /zero:rule -->

---

## 2. El gate local

<!-- zero:rule gate.local since=0.1.0 section=2 -->
Los mismos checks que corre CI (`.github/workflows/ci.yml`), acá primero:

```bash
bun run lint && bun run typecheck && bun test
```

Sólo checks de lectura: `bun run format` reescribe archivos y no es un check. Si algo no puede
correr localmente, decir cuál y que queda sin probar.
<!-- /zero:rule -->

---

## 3. Un cambio, un worktree

<!-- zero:rule branch.one-worktree since=0.4.0 section=3 -->
**Cada cambio se hace en su propio worktree, nunca con `git checkout -b` / `git switch` en
`D:\aibot-framework`.** Varias sesiones (personas o agentes) comparten esa carpeta: si una cambia de
branch, el árbol de trabajo de las demás pasa a ser el de otro cambio, en silencio. Pasó el
2026-10-03: un commit destinado a `main` cayó en `feat/ux-overhaul` porque otra sesión había
cambiado el branch de la carpeta.

```bash
git worktree add ../aibot-<slug> -b <tipo>/<slug> main   # tipo: feat, fix, docs, chore
cd ../aibot-<slug> && bun install
# ... trabajo, gate local, commit ...
git -C D:/aibot-framework merge --ff-only <tipo>/<slug>   # main está checked out ahí: sólo fast-forward
git merge-base --is-ancestor <tipo>/<slug> main && git worktree remove ../aibot-<slug> && git branch -D <tipo>/<slug>
```

Si `main` no está checked out en ninguna carpeta, el equivalente es `git fetch . <tipo>/<slug>:main`
(git rechaza ese fetch sobre un branch checked out). Si `main` avanzó y el fast-forward falla, rebasear el branch sobre `main` dentro del worktree y
repetir. `git branch -d` no sirve acá: compara contra el branch de la carpeta actual, no contra `main`; por eso el `merge-base` antes del `-D`. Antes de borrar un worktree, confirmar que no queda nada: sin cambios sin commitear ni
commits sin mergear.

La carpeta principal se queda en el branch en que está; no se cambia de branch ahí. `git switch`,
`git checkout -b/-B` están en el deny list.
<!-- /zero:rule -->

---

## 4. Verificar antes de afirmar, preguntar antes de actuar

<!-- zero:rule assert.verified since=0.1.0 section=4 -->
**Reportar sólo lo que se comprobó.** "Los tests pasan" significa que se corrieron y se vieron
pasar, en este árbol, ahora. "Está deployado" significa que se comprobó lo que sirve el
contenedor, no que el build terminó. Un test fallido se reporta como fallo, nunca como "debería
andar cuando X". Si algo no se pudo verificar, decirlo y decir qué haría falta.
<!-- /zero:rule -->

<!-- zero:rule ask.reversibility since=0.1.0 section=4 -->
La línea para preguntar es la **reversibilidad**, no la dificultad:

- **Una pregunta no es una orden de trabajo.** "¿Podríamos…?" recibe una respuesta, no un cambio.
- **Nunca `git commit` ni `git push` sin pedido explícito.** Al implementar, sólo escribir código;
  el commit/push es decisión del usuario.
- **Lo que sale hacia afuera se confirma cada vez:** mandar mensajes (Telegram, Slack, mail),
  rebuild/restart del contenedor en vivo, o escribir en los volúmenes de datos. Una aprobación no
  cubre la siguiente.
- **Una denegación es el guardrail funcionando.** Si algo queda bloqueado, se le pasa a una persona;
  nunca se reintenta con otra variante del comando.
<!-- /zero:rule -->

<!-- zero:rule ask.credentials-per-command since=0.94.117 section=4 -->
**La cuenta va en el comando, no en la máquina.** Esta máquina tiene dos cuentas de GitHub
(`diegofal` y `agilityio-dfalciola`) y la cuenta activa de `gh` es una sola para todas las sesiones:
otra sesión puede cambiarla entre un dry run y la escritura. Pasó dos veces el 2026-10-04 (un
sign-off y un push fallaron como la cuenta que no ve el repo). Todo comando que escribe en GitHub
lleva su cuenta: `GH_TOKEN=$(gh auth token --user diegofal) gh ...`, y el mismo prefijo en
`git push`. `gh auth switch` es para una persona en una terminal, no para una sesión.
<!-- /zero:rule -->

---

## 5. Mantener el registro al día, en el mismo cambio

<!-- zero:rule records.same-change since=0.1.0 section=5 -->
La documentación es parte del trabajo; **un doc desactualizado es un bug**.

| Registro | Cuándo se actualiza |
| --- | --- |
| `CHANGELOG.md` (raíz) | Todo cambio relevante: qué cambió y **por qué** |
| `docs/architecture-docs/` (páginas HTML) | Cambios en arquitectura, módulos, tools, skills, rutas web, config schemas o memoria |
| `README.md` | Cambios en la lista de skills, tools, sistemas core, páginas del dashboard, estructura del proyecto o stack |
| Tabla "Arquitectura del Bot" en `CLAUDE.md` | Cuando cambia la responsabilidad de un módulo de `src/bot/` (u otros paquetes listados) |
| `docs/work-log/YYYY-MM-DD.md` | Al terminar un trabajo significativo (en la práctica, al pushear a main): qué, dónde, estado, cómo se verificó, y lo que queda abierto al final del día |
| `docs/runbook.md` | En el momento en que corre un comando manual sobre el contenedor o los volúmenes (rebuild/restart, backup/restore, edición del config vivo), con su resultado |
| `docs/technical-debt.md` | Cuando se decide diferir algo a propósito |
<!-- /zero:rule -->

<!-- zero:rule records.changelog-is-record since=0.1.0 section=5 -->
**El changelog es el registro; un mensaje de commit no.** Cuando el diseño cambia en el camino, se
actualiza la entrada del changelog en el mismo cambio.
<!-- /zero:rule -->

<!-- zero:rule records.debt-trigger since=0.1.0 section=5 -->
Una deuda sin **trigger** no es deuda registrada, es un deseo. Nombrar la condición que la vuelve urgente.
<!-- /zero:rule -->

---

## 6. Datos reales

<!-- zero:rule data.production since=0.1.0 section=6 -->
Los volúmenes Docker `aibot-framework_aibot_config`, `_aibot_data` y `_aibot_productions` son
**producción**: conversaciones, contactos y memoria de usuarios reales de Telegram. Se pueden leer
para depurar, pero:

- no se modifican ni se borran sin confirmación explícita (hacer backup antes: `bun scripts/docker/backup.ts backup`);
- su contenido no se pega en servicios externos, issues ni commits (el repo es **público**);
- los tests usan datos sintéticos, nunca copias de esos volúmenes.

`data/` y `config/bots.json` en el host están viejos: el estado vivo está en los volúmenes.
<!-- /zero:rule -->

---

## 7. Deploy

<!-- zero:rule deploy.sequence since=0.1.0 section=7 -->
Un solo entorno: el contenedor `aibot-framework-aibot-1` en esta máquina (`127.0.0.1:3000`).

1. **Preflight:** el gate local (sección 2) en verde.
2. **Una confirmación explícita** justo antes de `docker compose up -d --build` (reinicia la flota en vivo).
3. **Comprobar que llegó**, no que el build terminó: el asset o endpoint servido muestra el cambio
   (`curl -s http://127.0.0.1:3000/<asset> | grep <cambio>`), y los logs del contenedor arrancan limpios.
4. Anotar en `CHANGELOG.md` cualquier cambio operativo aplicado al volumen de config.
<!-- /zero:rule -->

---

## 8. Toda afirmación de proceso se apoya en algo commiteado acá

<!-- zero:rule provenance since=0.1.0 section=8 -->
Una regla o práctica entra en estos documentos **sólo si este proyecto realmente la hace**. Si no
se puede señalar el commit, el doc o la práctica de donde salió, no entra, por bien que suene.
<!-- /zero:rule -->
