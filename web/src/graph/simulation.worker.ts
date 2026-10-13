/// <reference lib="webworker" />
// Kräftebasiertes Layout (angelehnt an d3-force): Federn für Kanten, Barnes-Hut-Abstoßung,
// schwache Zentrierung. Läuft im Worker, damit die Oberfläche flüssig bleibt.

export interface SimParams {
  linkDistance: number;
  linkStrength: number;
  repulsion: number;
  center: number;
}

type InMsg =
  | { type: "init"; gen: number; n: number; edges: Uint32Array; x: Float32Array; y: Float32Array; alpha: number; params: SimParams }
  | { type: "drag"; i: number; x: number; y: number }
  | { type: "release"; i: number }
  | { type: "params"; params: SimParams }
  | { type: "reheat"; alpha: number }
  | { type: "stop" };

let n = 0;
let x: Float32Array = new Float32Array(0);
let y: Float32Array = new Float32Array(0);
let vx: Float32Array = new Float32Array(0);
let vy: Float32Array = new Float32Array(0);
let fx: Float32Array = new Float32Array(0);
let fy: Float32Array = new Float32Array(0);
let edges: Uint32Array = new Uint32Array(0);
let degree: Uint32Array = new Uint32Array(0);
let params: SimParams = { linkDistance: 40, linkStrength: 1, repulsion: 60, center: 0.04 };
let alpha = 1;
const alphaMin = 0.002;
const alphaDecay = 1 - Math.pow(alphaMin, 1 / 300);
const velocityDecay = 0.4;
let running = false;
/** Kennung der aktuellen Daten; Ticks tragen sie, damit die Oberfläche veraltete verwirft. */
let gen = 0;
let timer: number | undefined;

// ---------- Barnes-Hut-Quadtree (flache Arrays) ----------

let cap = 0;
let qx0 = new Float32Array(0);
let qy0 = new Float32Array(0);
let qsize = new Float32Array(0);
let qmass = new Float32Array(0);
let qcx = new Float32Array(0);
let qcy = new Float32Array(0);
let qbody = new Int32Array(0);
let qchild = new Int32Array(0);
let qcount = 0;

function ensureCap(c: number) {
  if (c <= cap) return;
  cap = Math.max(c, cap * 2, 64);
  qx0 = new Float32Array(cap);
  qy0 = new Float32Array(cap);
  qsize = new Float32Array(cap);
  qmass = new Float32Array(cap);
  qcx = new Float32Array(cap);
  qcy = new Float32Array(cap);
  qbody = new Int32Array(cap);
  qchild = new Int32Array(cap * 4);
}

function newCell(x0: number, y0: number, size: number): number {
  if (qcount >= cap) {
    // Kapazität verdoppeln und Inhalte übernehmen
    const old = { qx0, qy0, qsize, qmass, qcx, qcy, qbody, qchild };
    const c = cap;
    cap = 0;
    ensureCap(c * 2);
    qx0.set(old.qx0);
    qy0.set(old.qy0);
    qsize.set(old.qsize);
    qmass.set(old.qmass);
    qcx.set(old.qcx);
    qcy.set(old.qcy);
    qbody.set(old.qbody);
    qchild.set(old.qchild);
  }
  const i = qcount++;
  qx0[i] = x0;
  qy0[i] = y0;
  qsize[i] = size;
  qmass[i] = 0;
  qcx[i] = 0;
  qcy[i] = 0;
  qbody[i] = -1;
  qchild[i * 4] = qchild[i * 4 + 1] = qchild[i * 4 + 2] = qchild[i * 4 + 3] = -1;
  return i;
}

function quadrant(cell: number, px: number, py: number): number {
  const half = qsize[cell] / 2;
  return (px >= qx0[cell] + half ? 1 : 0) + (py >= qy0[cell] + half ? 2 : 0);
}

function childCell(cell: number, q: number): number {
  let c = qchild[cell * 4 + q];
  if (c < 0) {
    const half = qsize[cell] / 2;
    c = newCell(qx0[cell] + (q & 1 ? half : 0), qy0[cell] + (q & 2 ? half : 0), half);
    qchild[cell * 4 + q] = c;
  }
  return c;
}

function insert(cell: number, b: number, depth: number) {
  for (;;) {
    const isLeaf = qchild[cell * 4] < 0 && qchild[cell * 4 + 1] < 0 && qchild[cell * 4 + 2] < 0 && qchild[cell * 4 + 3] < 0;
    if (isLeaf && qbody[cell] < 0) {
      qbody[cell] = b;
      return;
    }
    if (depth > 40) {
      // Fast identische Punkte: nicht weiter unterteilen
      return;
    }
    if (isLeaf) {
      const existing = qbody[cell];
      qbody[cell] = -1;
      insert(childCell(cell, quadrant(cell, x[existing], y[existing])), existing, depth + 1);
    }
    cell = childCell(cell, quadrant(cell, x[b], y[b]));
    depth++;
  }
}

/** Masse und Schwerpunkt bottom-up berechnen (Zellen werden nach ihren Kindern angelegt). */
function accumulate() {
  for (let c = qcount - 1; c >= 0; c--) {
    let m = 0;
    let sx = 0;
    let sy = 0;
    const b = qbody[c];
    if (b >= 0) {
      m = 1;
      sx = x[b];
      sy = y[b];
    }
    for (let k = 0; k < 4; k++) {
      const ch = qchild[c * 4 + k];
      if (ch >= 0 && qmass[ch] > 0) {
        m += qmass[ch];
        sx += qcx[ch] * qmass[ch];
        sy += qcy[ch] * qmass[ch];
      }
    }
    qmass[c] = m;
    if (m > 0) {
      qcx[c] = sx / m;
      qcy[c] = sy / m;
    }
  }
}

const stack: number[] = [];

function manyBody() {
  if (n < 2) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i];
    if (y[i] < minY) minY = y[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
  qcount = 0;
  ensureCap(n * 2 + 16);
  const root = newCell(minX, minY, size);
  for (let i = 0; i < n; i++) insert(root, i, 0);
  accumulate();
  const theta2 = 0.81;
  const strength = -params.repulsion * alpha;
  for (let i = 0; i < n; i++) {
    stack.length = 0;
    stack.push(root);
    let ax = 0;
    let ay = 0;
    while (stack.length) {
      const c = stack.pop()!;
      if (qmass[c] === 0) continue;
      const dx = qcx[c] - x[i];
      const dy = qcy[c] - y[i];
      let d2 = dx * dx + dy * dy;
      const s = qsize[c];
      const b = qbody[c];
      const isLeaf = qchild[c * 4] < 0 && qchild[c * 4 + 1] < 0 && qchild[c * 4 + 2] < 0 && qchild[c * 4 + 3] < 0;
      if (isLeaf || (s * s) / d2 < theta2) {
        if (isLeaf && b === i && qmass[c] === 1) continue;
        if (d2 < 1) d2 = 1;
        const m = isLeaf && b === i ? qmass[c] - 1 : qmass[c];
        const f = (strength * m) / d2;
        if (d2 === 1 && dx === 0 && dy === 0) {
          ax += (Math.random() - 0.5) * 1e-3;
          ay += (Math.random() - 0.5) * 1e-3;
        } else {
          ax += dx * f;
          ay += dy * f;
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const ch = qchild[c * 4 + k];
          if (ch >= 0) stack.push(ch);
        }
      }
    }
    vx[i] += ax;
    vy[i] += ay;
  }
}

function links() {
  const m = edges.length / 2;
  for (let e = 0; e < m; e++) {
    const s = edges[e * 2];
    const t = edges[e * 2 + 1];
    let dx = x[t] + vx[t] - x[s] - vx[s] || (Math.random() - 0.5) * 1e-3;
    let dy = y[t] + vy[t] - y[s] - vy[s] || (Math.random() - 0.5) * 1e-3;
    let l = Math.sqrt(dx * dx + dy * dy);
    const strength = params.linkStrength / Math.min(degree[s], degree[t]);
    l = ((l - params.linkDistance) / l) * alpha * strength;
    dx *= l;
    dy *= l;
    const bias = degree[s] / (degree[s] + degree[t]);
    vx[t] -= dx * bias;
    vy[t] -= dy * bias;
    vx[s] += dx * (1 - bias);
    vy[s] += dy * (1 - bias);
  }
}

function centering() {
  const k = params.center * alpha;
  for (let i = 0; i < n; i++) {
    vx[i] -= x[i] * k;
    vy[i] -= y[i] * k;
  }
}

function tick() {
  alpha += (0 - alpha) * alphaDecay;
  links();
  manyBody();
  centering();
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(fx[i])) {
      x[i] = fx[i];
      y[i] = fy[i];
      vx[i] = vy[i] = 0;
      continue;
    }
    vx[i] *= 1 - velocityDecay;
    vy[i] *= 1 - velocityDecay;
    x[i] += vx[i];
    y[i] += vy[i];
  }
}

function loop() {
  if (!running) return;
  const start = performance.now();
  // Mehrere Schritte pro Frame bei kleinen Graphen, damit das Layout schnell steht
  do tick();
  while (performance.now() - start < 8 && alpha > alphaMin && n < 3000);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "tick", gen, x: x.slice(), y: y.slice(), alpha });
  if (alpha <= alphaMin) {
    running = false;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "end", gen });
    return;
  }
  timer = setTimeout(loop, 16) as unknown as number;
}

function start() {
  if (running) return;
  running = true;
  loop();
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const m = e.data;
  switch (m.type) {
    case "init": {
      clearTimeout(timer);
      running = false;
      gen = m.gen;
      n = m.n;
      x = m.x;
      y = m.y;
      vx = new Float32Array(n);
      vy = new Float32Array(n);
      fx = new Float32Array(n).fill(NaN);
      fy = new Float32Array(n).fill(NaN);
      edges = m.edges;
      degree = new Uint32Array(n);
      for (let i = 0; i < edges.length; i++) degree[edges[i]]++;
      for (let i = 0; i < n; i++) if (degree[i] === 0) degree[i] = 1;
      params = m.params;
      alpha = m.alpha;
      start();
      break;
    }
    case "drag":
      fx[m.i] = m.x;
      fy[m.i] = m.y;
      if (alpha < 0.3) alpha = 0.3;
      start();
      break;
    case "release":
      fx[m.i] = NaN;
      fy[m.i] = NaN;
      break;
    case "params":
      params = m.params;
      alpha = Math.max(alpha, 0.5);
      start();
      break;
    case "reheat":
      alpha = Math.max(alpha, m.alpha);
      start();
      break;
    case "stop":
      running = false;
      clearTimeout(timer);
      break;
  }
};
