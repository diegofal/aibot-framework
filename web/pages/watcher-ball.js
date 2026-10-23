/**
 * The ball: the watcher's graph as glowing points in a dark unit sphere.
 *
 * Three.js is loaded here and only here, with a dynamic import of the
 * vendored build (`web/vendor/three.module.js`, version in
 * `web/vendor/README.md`), so no other module (and no Bun test) ever touches
 * WebGL. Positions come from the server (`neuron.pos`); a neuron without one
 * sits on its kind's shell (`neuronPosition`). Colour, size, brightness and
 * pacing come from `watcher-helpers.js`.
 *
 * One `THREE.Points` holds every neuron (one vertex each, per-vertex
 * attributes for colour, size, brightness, spawn and pulse time, highlight);
 * a custom shader draws each as a soft glow. Edges above a weight are one
 * `LineSegments`. Orbit (drag), zoom (wheel), slow auto-rotate and picking
 * (nearest projected point) are hand-written: no OrbitControls import.
 */
import {
  SPAWN_PACE,
  autoRotates,
  drainCount,
  edgeVisible,
  flashBuffers,
  neuronBrightness,
  neuronColour,
  neuronPosition,
  neuronRadius,
  wheelZooms,
} from './watcher-helpers.js';

const THREE_URL = '/vendor/three.module.js';
const BACKGROUND = 0x05070b;
const FOV = 45;
const halfTan = Math.tan((FOV * Math.PI) / 360);
const SPAWN_SECONDS = 0.9;
/** How long a neuron glides to its new place after a relayout (`watcher:layout`). */
const MOVE_SECONDS = 1.2;
const AUTO_ROTATE_RAD_PER_S = 0.06;
const AUTO_ROTATE_IDLE_MS = 3000;
const BRIGHTNESS_REFRESH_MS = 5000;
const EDGE_REBUILD_MS = 400;
const MAX_EDGES_DRAWN = 30_000;
const PICK_SLOP_PX = 5;

const VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aBright;
attribute float aBorn;
attribute float aPulse;
attribute float aHl;
uniform float uTime;
uniform float uScale;
uniform float uHlOn;
uniform float uGain;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aBorn;
  float s = clamp(age / ${SPAWN_SECONDS.toFixed(2)}, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - s, 3.0);
  vec4 mv = modelViewMatrix * vec4(position * e, 1.0);
  float pulse = aPulse > 0.0 ? exp(-max(0.0, uTime - aPulse) * 2.5) : 0.0;
  float flash = 1.0 - s;
  float hl = uHlOn > 0.5 ? (aHl > 0.5 ? 1.7 : 0.8) : 1.0;
  float size = aSize * (1.0 + 1.3 * pulse + 1.6 * flash) * hl;
  gl_PointSize = max(1.5, size * uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
  vColor = mix(aColor, vec3(1.0), clamp(pulse * 0.7 + flash * 0.6, 0.0, 1.0));
  float dim = uHlOn > 0.5 ? (aHl > 0.5 ? 1.0 : 0.15) : 1.0;
  float gain = uHlOn > 0.5 && aHl > 0.5 ? 1.0 : uGain;
  vAlpha = clamp(aBright + pulse * 0.6 + flash * 0.4, 0.0, 1.0) * dim * gain * step(0.0, age);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.42, 0.0, d);
  float glow = exp(-d * d * 5.0);
  gl_FragColor = vec4(vColor * (0.55 + core * 0.9), (core * 0.9 + glow * 0.5) * vAlpha);
}`;

/**
 * Mount the ball into `host`. Resolves to a handle, or null when there is no
 * DOM, Three.js does not load or WebGL is unavailable (the page then shows
 * the log alone).
 *
 * @param {HTMLElement} host
 * @param {{ neurons: Map<string, object>, edges: Map<string, object> }} model  read live, never copied
 * @param {{ onPick?: (id: string | null) => void, pace?: number }} [opts]
 */
export async function mountBall(host, model, { onPick, pace = SPAWN_PACE } = {}) {
  if (typeof document === 'undefined' || !host) return null;
  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch {
    return null;
  }
  if (!host.isConnected) return null;

  const canvas = document.createElement('canvas');
  canvas.className = 'watcher-canvas';
  host.appendChild(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch {
    canvas.remove();
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(BACKGROUND, 1);

  const tip = document.createElement('div');
  tip.className = 'watcher-tip';
  tip.hidden = true;
  host.appendChild(tip);

  const hint = document.createElement('div');
  hint.className = 'watcher-hint';
  hint.textContent = 'Click the ball, then scroll to zoom (or Ctrl + scroll)';
  host.appendChild(hint);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
  const orbit = { theta: 0.6, phi: 1.2, dist: 3.1 };

  // Orientation: three faint great circles on the unit sphere.
  const ringMat = new THREE.LineBasicMaterial({
    color: 0x7c9cff,
    transparent: true,
    opacity: 0.07,
    depthWrite: false,
  });
  const rings = [];
  for (const axis of ['x', 'y', 'z']) {
    const pts = [];
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pts.push(
        axis === 'x'
          ? new THREE.Vector3(0, c, s)
          : axis === 'y'
            ? new THREE.Vector3(c, 0, s)
            : new THREE.Vector3(c, s, 0)
      );
    }
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
    rings.push(ring);
    scene.add(ring);
  }

  /* ── Points ──────────────────────────────────────────────────── */

  let capacity = 0;
  let count = 0;
  let highlighted = new Set();
  let edgesDirty = false;
  const slotOf = new Map();
  const idAt = [];
  let arr = null;
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1 },
      uHlOn: { value: 0 },
      uGain: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  function allocate(min) {
    let cap = Math.max(1024, capacity);
    while (cap < min) cap *= 2;
    if (cap === capacity) return;
    const next = {
      position: new Float32Array(cap * 3),
      aColor: new Float32Array(cap * 3),
      aSize: new Float32Array(cap),
      aBright: new Float32Array(cap),
      aBorn: new Float32Array(cap),
      aPulse: new Float32Array(cap),
      aHl: new Float32Array(cap),
    };
    if (arr) for (const k of Object.keys(next)) next[k].set(arr[k].subarray(0, next[k].length));
    arr = next;
    capacity = cap;
    geometry.dispose();
    for (const [k, a] of Object.entries(arr)) {
      const attr = new THREE.BufferAttribute(a, k === 'position' || k === 'aColor' ? 3 : 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(k, attr);
    }
    geometry.setDrawRange(0, count);
  }
  allocate(1024);

  const dirty = new Set();
  const touch = (...keys) => {
    for (const k of keys) dirty.add(k);
  };
  // The shader writes gl_FragColor as is (no colour-space chunk), so feed it
  // the sRGB bytes directly instead of THREE.Color's linearised values.
  const rgb = (hex) => [1, 3, 5].map((o) => Number.parseInt(hex.slice(o, o + 2), 16) / 255);

  // Slots gliding to a new layout position: slot → { from, to, start }.
  const moving = new Map();

  function writeSlot(i, neuron, nowMs) {
    // A gliding slot keeps its in-between position; the tick finishes the move.
    if (!moving.has(i)) arr.position.set(neuronPosition(neuron), i * 3);
    arr.aColor.set(rgb(neuronColour(neuron)), i * 3);
    arr.aSize[i] = neuronRadius(neuron);
    arr.aBright[i] = neuronBrightness(neuron, nowMs);
    touch('position', 'aColor', 'aSize', 'aBright');
  }

  let time = 0;
  function add(id, animate) {
    const neuron = model.neurons.get(id);
    if (!neuron) return false;
    if (slotOf.has(id)) {
      update(id);
      return false;
    }
    if (count >= capacity) allocate(count + 1);
    const i = count++;
    slotOf.set(id, i);
    idAt[i] = id;
    writeSlot(i, neuron, Date.now());
    arr.aBorn[i] = animate ? time : time - SPAWN_SECONDS - 1;
    arr.aPulse[i] = 0;
    arr.aHl[i] = highlighted.has(id) ? 1 : 0;
    touch('aBorn', 'aPulse', 'aHl');
    geometry.setDrawRange(0, count);
    material.uniforms.uGain.value = Math.max(0.25, Math.min(1, 1 / Math.sqrt(count / 400)));
    edgesDirty = true;
    return true;
  }

  function update(id) {
    const i = slotOf.get(id);
    const neuron = model.neurons.get(id);
    if (i === undefined || !neuron) return;
    writeSlot(i, neuron, Date.now());
    edgesDirty = true;
  }

  /** Glide the given neurons from where they are drawn to their model position. */
  function move(ids) {
    for (const id of ids ?? []) {
      const i = slotOf.get(id);
      const neuron = model.neurons.get(id);
      if (i === undefined || !neuron) continue;
      const from = [arr.position[i * 3], arr.position[i * 3 + 1], arr.position[i * 3 + 2]];
      moving.set(i, { from, to: neuronPosition(neuron), start: time });
    }
  }

  function stepMoves() {
    for (const [i, m] of moving) {
      const k = Math.min(1, (time - m.start) / MOVE_SECONDS);
      const e = k * k * (3 - 2 * k);
      for (let a = 0; a < 3; a++) arr.position[i * 3 + a] = m.from[a] + (m.to[a] - m.from[a]) * e;
      if (k >= 1) moving.delete(i);
    }
    touch('position');
    edgesDirty = true;
  }

  function pulse(id) {
    const i = slotOf.get(id);
    if (i === undefined) return;
    update(id);
    arr.aPulse[i] = time;
    touch('aPulse');
  }

  /* ── Edges ───────────────────────────────────────────────────── */

  const edgeGeometry = new THREE.BufferGeometry();
  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  lines.frustumCulled = false;
  scene.add(lines);
  let lastEdgeBuild = 0;

  // The edge from a pulsed goal/topic to its bot, brightened for a moment.
  const flashGeometry = new THREE.BufferGeometry();
  const flashMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flashLines = new THREE.LineSegments(flashGeometry, flashMaterial);
  flashLines.frustumCulled = false;
  scene.add(flashLines);
  /** `{ from, to, at }` with `at` in performance.now() ms. */
  let flashes = [];

  function flashEdge(from, to) {
    if (!slotOf.has(from) || !slotOf.has(to)) return;
    flashes = flashes.filter((f) => !(f.from === from && f.to === to));
    flashes.push({ from, to, at: performance.now() });
  }

  function writeFlashes(out) {
    flashes = out.live;
    flashGeometry.setAttribute('position', new THREE.Float32BufferAttribute(out.position, 3));
    flashGeometry.setAttribute('color', new THREE.Float32BufferAttribute(out.color, 3));
  }

  function drawFlashes(now) {
    if (!flashes.length) return;
    writeFlashes(flashBuffers(flashes, now, slotOf, arr));
  }

  function rebuildEdges() {
    const pos = [];
    const col = [];
    let pending = false;
    let n = 0;
    for (const e of model.edges.values()) {
      if (n >= MAX_EDGES_DRAWN) break;
      if (!edgeVisible(e)) continue;
      const a = slotOf.get(e.from);
      const b = slotOf.get(e.to);
      if (a === undefined || b === undefined) continue;
      if (time - arr.aBorn[a] < SPAWN_SECONDS || time - arr.aBorn[b] < SPAWN_SECONDS) {
        pending = true;
        continue;
      }
      for (const i of [a, b]) {
        pos.push(arr.position[i * 3], arr.position[i * 3 + 1], arr.position[i * 3 + 2]);
        col.push(arr.aColor[i * 3] * 0.6, arr.aColor[i * 3 + 1] * 0.6, arr.aColor[i * 3 + 2] * 0.6);
      }
      n++;
    }
    edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    edgesDirty = pending;
  }

  /* ── Highlight ───────────────────────────────────────────────── */

  function highlight(ids) {
    highlighted = new Set(Array.isArray(ids) ? ids : []);
    let any = false;
    for (let i = 0; i < count; i++) {
      const on = highlighted.has(idAt[i]);
      arr.aHl[i] = on ? 1 : 0;
      if (on) any = true;
    }
    material.uniforms.uHlOn.value = any ? 1 : 0;
    lines.visible = !any;
    touch('aHl');
  }

  /* ── Camera, input, picking ──────────────────────────────────── */

  function placeCamera() {
    const { theta, phi, dist } = orbit;
    camera.position.set(
      dist * Math.sin(phi) * Math.sin(theta),
      dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, 0, 0);
  }

  function resize() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const px = h * renderer.getPixelRatio();
    material.uniforms.uScale.value = (2.4 * px) / halfTan;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(host);
  resize();

  const v = new THREE.Vector3();
  const w3 = new THREE.Vector3();
  /** Nearest projected neuron under (x, y) in canvas CSS pixels, or null. */
  function pickAt(x, y) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    camera.updateMatrixWorld();
    let best = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      w3.set(arr.position[i * 3], arr.position[i * 3 + 1], arr.position[i * 3 + 2]);
      v.copy(w3).project(camera);
      if (v.z > 1 || v.z < -1) continue;
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((1 - v.y) / 2) * h;
      const d = Math.hypot(sx - x, sy - y);
      const reach = Math.max(8, (arr.aSize[i] * h) / (camera.position.distanceTo(w3) * halfTan));
      if (d <= reach && d < bestD) {
        bestD = d;
        best = idAt[i];
      }
    }
    return best;
  }

  let drag = null;
  let lastInput = 0;
  let pausedUntil = 0;
  // The wheel zooms only once the ball was clicked (until the pointer leaves).
  let engaged = false;
  let hoverAt = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e) => {
    engaged = true;
    host.classList.add('engaged');
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
    lastInput = performance.now();
    canvas.setPointerCapture?.(e.pointerId);
    tip.hidden = true;
  };
  const onMove = (e) => {
    if (drag) {
      orbit.theta -= (e.clientX - drag.x) * 0.005;
      orbit.phi = Math.min(
        Math.PI - 0.15,
        Math.max(0.15, orbit.phi - (e.clientY - drag.y) * 0.005)
      );
      drag.x = e.clientX;
      drag.y = e.clientY;
      lastInput = performance.now();
      return;
    }
    hoverAt = local(e);
  };
  const onUp = (e) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    drag = null;
    canvas.releasePointerCapture?.(e.pointerId);
    if (moved < PICK_SLOP_PX) {
      const p = local(e);
      onPick?.(pickAt(p.x, p.y));
    }
  };
  const onLeave = () => {
    hoverAt = null;
    tip.hidden = true;
    engaged = false;
    host.classList.remove('engaged');
  };
  const onWheel = (e) => {
    // Not engaged: let the page scroll.
    if (!wheelZooms({ engaged, ctrlKey: e.ctrlKey, metaKey: e.metaKey })) return;
    e.preventDefault();
    orbit.dist = Math.min(8, Math.max(1.3, orbit.dist * Math.exp(e.deltaY * 0.001)));
    lastInput = performance.now();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function showTip() {
    if (!hoverAt) return;
    const at = hoverAt;
    hoverAt = null;
    const id = pickAt(at.x, at.y);
    const n = id ? model.neurons.get(id) : null;
    if (!n) {
      tip.hidden = true;
      canvas.style.cursor = '';
      return;
    }
    tip.textContent = `${n.kind}: ${String(n.text ?? '').slice(0, 140)}`;
    tip.style.left = `${at.x + 14}px`;
    tip.style.top = `${at.y + 14}px`;
    tip.hidden = false;
    canvas.style.cursor = 'pointer';
  }

  /* ── Loop ────────────────────────────────────────────────────── */

  const queue = [];
  let carry = 0;
  let last = performance.now();
  let lastBrightness = 0;
  let frame = 0;
  let disposed = false;

  function tick(now) {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const dt = Math.min(100, now - last);
    last = now;
    time += dt / 1000;
    material.uniforms.uTime.value = time;

    if (queue.length) {
      const r = drainCount(carry, dt, pace);
      carry = r.carry;
      for (let k = 0; k < r.n && queue.length; k++) add(queue.shift(), true);
    } else {
      carry = 0;
    }
    if (moving.size) stepMoves();
    if (
      autoRotates(now, {
        lastInputMs: lastInput,
        pausedUntilMs: pausedUntil,
        dragging: !!drag,
        idleMs: AUTO_ROTATE_IDLE_MS,
      })
    )
      orbit.theta += (dt / 1000) * AUTO_ROTATE_RAD_PER_S;
    drawFlashes(now);
    placeCamera();

    if (now - lastBrightness > BRIGHTNESS_REFRESH_MS) {
      lastBrightness = now;
      const nowMs = Date.now();
      for (let i = 0; i < count; i++) {
        const n = model.neurons.get(idAt[i]);
        if (n) arr.aBright[i] = neuronBrightness(n, nowMs);
      }
      touch('aBright');
    }
    if (edgesDirty && now - lastEdgeBuild > EDGE_REBUILD_MS) {
      lastEdgeBuild = now;
      rebuildEdges();
    }
    for (const k of dirty) {
      const attr = geometry.getAttribute(k);
      if (attr) attr.needsUpdate = true;
    }
    dirty.clear();
    showTip();
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(tick);

  return {
    /** Queue for the paced spawn animation (live arrivals). */
    spawn(id) {
      if (!slotOf.has(id)) queue.push(id);
      else pulse(id);
    },
    /** Add now, with the spawn animation (replay steps are already paced). */
    add(id) {
      add(id, true);
    },
    /** Add without animation (the graph that already exists when the page opens). */
    place(ids) {
      for (const id of ids) add(id, false);
    },
    /** Add every model neuron the ball does not show yet, and refresh the rest. */
    sync() {
      queue.length = 0;
      for (const id of model.neurons.keys()) {
        if (slotOf.has(id)) update(id);
        else add(id, false);
      }
      edgesDirty = true;
    },
    update,
    /** Glide moved neurons to their new layout position (a `watcher:layout`). */
    move,
    archive: update,
    pulse,
    /** Brighten the edge between two shown neurons for `EDGE_FLASH_MS`. */
    flashEdge,
    /** Hold auto-rotation still for `ms` (a pulse, so the eye can find it). */
    pauseRotation(ms) {
      pausedUntil = Math.max(pausedUntil, performance.now() + ms);
    },
    edgesChanged() {
      edgesDirty = true;
    },
    highlight,
    has: (id) => slotOf.has(id),
    queued: () => queue.length,
    /** Empty the ball (before a replay). */
    clear() {
      queue.length = 0;
      // Zero the flash vertices too: emptying the list alone left the last
      // bright edge drawn after a replay clear.
      writeFlashes(flashBuffers([], 0, slotOf, arr));
      moving.clear();
      slotOf.clear();
      idAt.length = 0;
      count = 0;
      geometry.setDrawRange(0, 0);
      highlight([]);
      edgesDirty = true;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      geometry.dispose();
      material.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      flashGeometry.dispose();
      flashMaterial.dispose();
      hint.remove();
      for (const r of rings) r.geometry.dispose();
      ringMat.dispose();
      renderer.dispose();
      canvas.remove();
      tip.remove();
    },
  };
}
