# Vendored browser libraries

`web/` is served raw (no build step, no import map), so third-party code the
dashboard loads lives here, pinned. Biome ignores this directory.

## Three.js

| | |
|---|---|
| Version | `three@0.186.1` (r186) |
| Source | `https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js` and `.../build/three.core.js` |
| Fetched | 2026-10-23 |
| License | MIT (header of each file) |
| `three.module.js` sha256 | `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea` |
| `three.core.js` sha256 | `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6` |

Since r171 the ES module build is split: `three.module.js` (the WebGL
renderer) imports `./three.core.js`, so both files ship together, unmodified.

Only `web/pages/watcher-ball.js` loads it, with
`import('/vendor/three.module.js')`. No `*-helpers.js` may import it (they run
under Bun in `tests/web/`).

To upgrade: download both files of the new version into a fresh temp
directory, check they are the ES module build (`export { … }`, the core import
is `./three.core.js`), record the version and both sha256 sums here, then
copy them over.
