# Task brief: fix review findings in the Productions file-actions feature

**Context:** The feature planned in `docs/plans/productions-file-actions-plan.md` (Copy / Download / Fullscreen buttons in the Productions file viewer) has been implemented in:

- `web/pages/file-actions.js` (new module)
- `web/pages/productions.js` (buttons + `attachFileActions()` in both viewers)
- `web/style.css` (`.prod-file-actions`, `.prod-fullscreen-*`)
- `tests/web/pages/file-actions.test.ts` (14 passing tests)

A code review found **1 real bug and 3 minor issues**. Fix them as described below. Follow the repo rules in `CLAUDE.md`: TDD where testable, `bun test` must run clean before you're done, update `CHANGELOG.md`, and keep `docs/architecture-docs/web-dashboard.html` in sync if behavior descriptions change.

---

## 1. BUG (must fix): fullscreen overlay's Copy and Download buttons do nothing

**Where:** `web/pages/file-actions.js` — `openFullscreenViewer()` (~line 59), and its caller `attachFileActions()` in `web/pages/productions.js`.

**Problem:** The overlay header renders `#prod-fullscreen-copy` and `#prod-fullscreen-download` buttons, but only the Close button is ever wired (`file-actions.js:104`). The caller ignores the returned `{ overlay, close }`. Clicking Copy or Download inside fullscreen silently does nothing. The `CHANGELOG.md` entry currently (and wrongly, until fixed) claims the overlay has "its own Copy / Download / Close actions".

**Fix:** Extend `openFullscreenViewer` to accept the data it needs and bind the buttons itself. Recommended signature:

```js
openFullscreenViewer({ titleHtml, bodyHtml, path, content })
```

Inside, bind:

- `#prod-fullscreen-copy` → `copyTextToClipboard(content)`, then flash the button label to `Copied` / `Failed` for ~1.5s (same pattern as `flashButtonLabel` in `productions.js` — either duplicate the tiny helper locally or move `flashButtonLabel` into `file-actions.js` and import it from `productions.js`, your call; moving it is cleaner).
- `#prod-fullscreen-download` → `downloadTextFile(path, content)`.

Update the call site in `attachFileActions()` (`web/pages/productions.js`) to pass `path: path || name` and `content`.

If `content`/`path` are not provided (defensive), hide or disable the two buttons rather than rendering dead ones.

## 2. Minor: dead CSS selectors in the fullscreen body

**Where:** `web/style.css` — the two rules targeting `.prod-fullscreen-body .production-content`.

**Problem:** `bodyHtml` passed to the overlay is raw `renderContent()` output (`.md-preview` div, a bare `<iframe>`, or `<pre>`) — it's never wrapped in `.production-content`, so both rules never match. HTML files only fill the overlay by accident via the inline `height:calc(100vh - 120px)` that `renderContent()` puts on its iframe.

**Fix (pick one, prefer a):**
- **(a)** In `openFullscreenViewer`, wrap the body: `<div class="prod-fullscreen-body"><div class="production-content">${bodyHtml}</div></div>` — the existing CSS then applies as intended.
- (b) Retarget the selectors to `.prod-fullscreen-body iframe` etc.

Either way, verify an `.html` production genuinely fills the overlay height (not just approximately via the inline style).

## 3. Minor: overlay survives page navigation

**Where:** `web/pages/file-actions.js` + `web/pages/productions.js` — `destroyProductions()`.

**Problem:** The overlay is appended to `document.body` and removed only by Close/Escape. If the user navigates (e.g. browser back, or clicking a sidebar link) while fullscreen is open, the overlay stays on top of the new page with stale content.

**Fix:** Export a `closeFullscreenViewer()` from `file-actions.js` (it can reuse the internal `close` logic: remove `#prod-fullscreen-overlay` if present, detach the keydown listener). Call it from `destroyProductions()` in `productions.js`, which the router already invokes on page changes.

## 4. Minor: test-coverage gap for `.markdown`

**Where:** `tests/web/pages/file-actions.test.ts`.

**Problem:** `getMimeType` handles `.markdown` (`file-actions.js:4`) but no test exercises it.

**Fix:** One-line addition to the existing `.md` test: `expect(getMimeType('notes.markdown')).toBe('text/markdown');`

## 5. Optional cleanup (do only if trivial): dead "topmost overlay" scan

**Where:** `web/pages/file-actions.js:94-97` — the Escape handler scans all `.prod-fullscreen-overlay` elements to find the topmost, but only one overlay can ever exist (any existing one is removed on open). Safe to simplify to a direct `overlay.isConnected` check. Do not change the `capture: true` registration or the `stopPropagation()`/`preventDefault()` — they intentionally prevent the shared modal and context-menu Escape handlers from also firing.

---

## Acceptance criteria

1. In fullscreen, Copy puts the raw file contents on the clipboard (button flashes "Copied") and Download saves the file with the basename of its production path — for productions opened from **both** `#/productions` and `#/productions/:botId`.
2. An `.html` production fills the overlay body height; `.md` and plain-text scroll inside the body.
3. Navigating away from the Productions page while fullscreen is open removes the overlay.
4. `bun test` clean — all of `tests/web/pages/file-actions.test.ts` (including the new `.markdown` case) and no new failures elsewhere (pre-existing failures from Playwright/API-key deps don't count).
5. `CHANGELOG.md`: append a short entry noting the fullscreen Copy/Download fix (the existing feature entry's claim then becomes true — leave it as is).
6. `docs/architecture-docs/web-dashboard.html`: no change needed unless you altered described behavior; the overlay-closes-on-navigation detail is worth one added sentence in the Productions section.

## What NOT to do

- Do not `git commit` or `git push` (repo rule — user decides).
- Do not refactor the two duplicated `renderFileViewer` implementations in `productions.js`; that's tracked separately.
- Do not add a backend raw-download endpoint; out of scope (see the plan's follow-ups).
