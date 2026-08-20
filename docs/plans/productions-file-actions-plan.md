# Plan: Fullscreen view, Download, and Copy for the Productions file viewer

**Status:** proposed — not yet implemented
**Scope:** dashboard only (`web/`), plus tests, CHANGELOG, and docs sync
**Affected views:** `#/productions` (all-bots explorer) and `#/productions/:botId` (per-bot explorer)

## Goal

From the Productions file viewer panel (the one shown when a file is selected in the tree), the user can:

1. **Fullscreen** the rendered file content (markdown preview, HTML iframe, or plain text) in an overlay that uses the whole viewport.
2. **Download** the file to disk with its original filename.
3. **Copy** the raw file contents to the clipboard.

## Current state (what the code already gives us)

- `web/pages/productions.js` contains **two near-duplicate viewers**: `renderFileViewer()` inside `renderProductions()` (~line 501) and inside `renderBotProductions()` (~line 1170). Both fetch content as a **string** via `/api/productions/:botId/:id` or `/api/productions/:botId/file-content?path=...` and render it with `renderContent(content, node.name)` from `web/pages/shared.js`.
- `renderContent()` (shared.js:76) renders `.md` via marked, `.html/.htm` via a sandboxed `<iframe srcdoc>`, everything else as `<pre>`.
- Productions are read as **UTF-8 text** on the backend (`src/productions/files.ts:getFileContent`), so every viewable file is text — no binary handling needed.
- Auth is a **Bearer token** injected by the `api()` helper (shared.js:44). A plain `<a href="/api/...">` would not carry the token, so download must be **client-side** (Blob from the content string already in memory). This also means **zero backend changes** are required.

## Design

### New module: `web/pages/file-actions.js`

Small shared module, imported by `productions.js` (and reusable later by the `showFilePreview` modal in shared.js).

Pure, unit-testable functions:

- `getMimeType(filename)` → `text/markdown` (.md), `text/html` (.html/.htm), `application/json` (.json), `text/csv` (.csv), default `text/plain; charset=utf-8`.
- `downloadFilename(path)` → basename of a relative path (`reports/2026/a.md` → `a.md`; handles trailing/backslash edge cases).

DOM helpers (thin, not unit-tested):

- `downloadTextFile(filename, content)` — `new Blob([content], { type: getMimeType(filename) })` → object URL → temporary `<a download>` click → `URL.revokeObjectURL`.
- `copyTextToClipboard(text)` — `navigator.clipboard.writeText` when available; fallback to hidden `<textarea>` + `document.execCommand('copy')` (the dashboard may run over plain HTTP, where the Clipboard API is unavailable outside a secure context). Returns a boolean so the button can flash "Copied" / "Failed".
- `openFullscreenViewer({ titleHtml, bodyHtml })` — appends a `position:fixed; inset:0` overlay with:
  - header: file path title + **Copy**, **Download**, **Close** buttons,
  - scrollable body containing the same `renderContent()` output (HTML iframes stretched to fill the overlay height),
  - closes on the Close button and on `Escape` (listener registered with `capture` and removed on close; check the overlay exists before acting so it doesn't fight the existing modal/context-menu Escape handlers in shared.js and productions.js).

### Wiring into the viewers

Add one shared helper in `productions.js` (module scope, next to the other shared helpers at the top of the file):

```
attachFileActions(panel, { path, name, content })
```

It finds the actions container in the freshly rendered viewer HTML and binds the three buttons. Both `renderViewer()` implementations add the same markup in the title row:

```html
<div class="prod-file-actions">
  <button class="btn btn-sm" id="viewer-copy" title="Copy contents">Copy</button>
  <button class="btn btn-sm" id="viewer-download" title="Download file">Download</button>
  <button class="btn btn-sm" id="viewer-fullscreen" title="View fullscreen">Fullscreen</button>
</div>
```

Buttons are disabled when `content == null` (file not found/empty). The Copy button gives feedback by swapping its label to "Copied" for ~1.5s (same pattern the Save button already uses).

Fullscreen re-uses the exact `renderContent(content, node.name)` HTML so markdown/HTML/plain files look identical to the inline view, just bigger. The overlay's own Copy/Download buttons call the same helpers.

### CSS (`web/style.css`)

- `.prod-file-actions` — inline flex row, aligned right of the viewer title.
- `.prod-fullscreen-overlay`, `.prod-fullscreen-header`, `.prod-fullscreen-body` — fixed overlay, `z-index` above the modal overlay, background/border from existing theme vars, body `overflow:auto`, iframes inside get `height:100%`.

## TDD steps (per CLAUDE.md workflow)

1. **Red** — `tests/web/pages/file-actions.test.ts` (new directory; bun test imports the ESM module directly since the pure functions touch no DOM):
   - `getMimeType`: one test per extension branch + default branch.
   - `downloadFilename`: plain name, nested path, backslash separators, trailing slash.
   Run `bun test tests/web/pages` → fails (module doesn't exist).
2. **Green** — implement `web/pages/file-actions.js` pure functions until tests pass. Add the DOM helpers in the same commit (excluded from unit tests; they guard on `typeof document !== 'undefined'` is unnecessary since they only run in-browser).
3. **Wire UI** — add the actions markup + `attachFileActions()` call to both `renderFileViewer` variants; add CSS. No behavior change to existing approve/reject/save/archive/delete flows.
4. **Manual verification** — start the dashboard, open a markdown, an HTML, and a plain-text production; verify fullscreen render, Esc close, download filename/content, copy on both HTTPS and plain-HTTP contexts (fallback path).
5. **Exit gate** — full `bun test` clean (no new failures beyond known external-dependency ones).

## Documentation & bookkeeping (required by CLAUDE.md)

- `CHANGELOG.md` — entry: "Productions viewer: fullscreen view, download, and copy-to-clipboard actions".
- `docs/architecture-docs/web-dashboard.html` — update the Productions page section with the three new actions and the new `file-actions.js` module.
- `README.md` — only if it enumerates dashboard viewer capabilities; otherwise no change.

## Out of scope / follow-ups (noted, not implemented)

- **Binary/raw download endpoint** (`GET /api/productions/:botId/raw?path=...` with `Content-Disposition`) — needed only if productions ever hold non-UTF-8 files; would require fetch+Blob anyway because of Bearer auth.
- **Download folder as .zip** from the tree context menu.
- Reusing `openFullscreenViewer` from the generic `showFilePreview` modal in `shared.js`.
- De-duplicating the two `renderFileViewer` implementations entirely (bigger refactor, tracked separately in `docs/architecture-docs/productions-refactor.md` territory).

## Estimated size

~1 new JS module (+~120 lines), ~40 lines of CSS, ~30 lines wired into `productions.js`, 1 small test file. No backend or config changes.
