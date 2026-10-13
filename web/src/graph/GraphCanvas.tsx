import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import { api } from "../api/client";
import type { GEdge, GNode } from "./analysis";
import type { SimParams } from "./simulation.worker";

// Canvas-Renderer für Graphen: Zoomen (Pinch/⌘-Scroll), Verschieben, Hover-Hervorhebung,
// Knoten ziehen, Klick/Doppelklick. Positionen werden pro "layoutKey" gespeichert.

export interface GraphCanvasProps {
  nodes: GNode[];
  edges: GEdge[];
  layoutKey?: string;
  /** Gibt es diesen Knoten noch? Unbekannte werden beim Speichern des Layouts entfernt. */
  isKnown?: (id: string) => boolean;
  height?: number | string;
  params?: Partial<SimParams>;
  /** Hervorgehobene Knoten (z. B. Pfad, Suchtreffer); andere werden abgedunkelt. */
  highlight?: Set<string> | null;
  highlightEdges?: Set<string> | null;
  focusId?: string | null;
  showLabels?: "auto" | "always" | "never";
  arrows?: boolean;
  nodeScale?: number;
  /** Rechts verdeckter Bereich (z. B. Einstellungs-Panel), der beim Einpassen frei bleibt. */
  insetRight?: number;
  onNodeClick?: (id: string, e: MouseEvent) => void;
  onNodeOpen?: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** Liefert die Ansicht nach außen, z. B. zum Zentrieren. */
  ref?: (api: GraphCanvasApi) => void;
}

export interface GraphCanvasApi {
  center: (id: string) => void;
  fit: () => void;
  reheat: () => void;
}

const DEFAULT_PARAMS: SimParams = { linkDistance: 45, linkStrength: 0.9, repulsion: 80, center: 0.035 };

function cssVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function GraphCanvas(props: GraphCanvasProps) {
  let wrap!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let worker: Worker | null = null;
  let xs = new Float32Array(0);
  let ys = new Float32Array(0);
  let index = new Map<string, number>();
  let nodes: GNode[] = [];
  let edgeIdx = new Uint32Array(0);
  let edgeKinds: string[] = [];
  let edgeKeys: string[] = [];
  let neighbors: Set<number>[] = [];
  let deg = new Uint32Array(0);
  const view = { k: 1, x: 0, y: 0 };
  let width = 0;
  let height = 0;
  let dpr = window.devicePixelRatio || 1;
  let hover = -1;
  let dragging = -1;
  let panning: { x: number; y: number; vx: number; vy: number } | null = null;
  let moved = false;
  let dirty = true;
  let raf = 0;
  let fitted = false;
  let saveTimer: number | undefined;
  let colors = { edge: "rgba(55,53,47,0.16)", edgeHi: "rgba(35,131,226,0.75)", text: "rgb(55,53,47)", textDim: "rgba(55,53,47,0.35)", bg: "#fff", ring: "#fff" };

  const radius = (i: number) => (3.2 + Math.min(14, Math.sqrt(deg[i]) * 1.9)) * (props.nodeScale ?? 1);

  const readColors = () => {
    colors = {
      edge: cssVar(wrap, "--graph-edge", colors.edge),
      edgeHi: cssVar(wrap, "--graph-edge-hi", colors.edgeHi),
      text: cssVar(wrap, "--text", colors.text),
      textDim: cssVar(wrap, "--text-tertiary", colors.textDim),
      bg: cssVar(wrap, "--bg", colors.bg),
      ring: cssVar(wrap, "--bg", colors.ring),
    };
  };

  const requestDraw = () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(draw);
  };

  const toWorld = (cx: number, cy: number) => ({ x: (cx - view.x) / view.k, y: (cy - view.y) / view.k });

  const hit = (cx: number, cy: number): number => {
    const p = toWorld(cx, cy);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const dx = xs[i] - p.x;
      const dy = ys[i] - p.y;
      const d = dx * dx + dy * dy;
      const r = radius(i) + 4 / view.k;
      if (d < r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  };

  function draw() {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    const hl = props.highlight ?? null;
    const hlEdges = props.highlightEdges ?? null;
    const focus = hover >= 0 ? hover : props.focusId ? (index.get(props.focusId) ?? -1) : -1;
    const focusSet = focus >= 0 ? neighbors[focus] : null;
    const isActive = (i: number) => (focusSet ? i === focus || focusSet.has(i) : hl ? hl.has(nodes[i].id) : true);

    // Kanten
    const m = edgeIdx.length / 2;
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = colors.edge;
    ctx.beginPath();
    for (let e = 0; e < m; e++) {
      const s = edgeIdx[e * 2];
      const t = edgeIdx[e * 2 + 1];
      const strong = focusSet ? s === focus || t === focus : hlEdges ? hlEdges.has(edgeKeys[e]) : false;
      if (strong) continue;
      if (edgeKinds[e] === "child") continue;
      ctx.moveTo(xs[s], ys[s]);
      ctx.lineTo(xs[t], ys[t]);
    }
    ctx.globalAlpha = focusSet || hl ? 0.35 : 1;
    ctx.stroke();
    // Hierarchie-Kanten gestrichelt
    ctx.beginPath();
    ctx.setLineDash([3 / view.k, 3 / view.k]);
    for (let e = 0; e < m; e++) {
      if (edgeKinds[e] !== "child") continue;
      const s = edgeIdx[e * 2];
      const t = edgeIdx[e * 2 + 1];
      ctx.moveTo(xs[s], ys[s]);
      ctx.lineTo(xs[t], ys[t]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Hervorgehobene Kanten
    ctx.strokeStyle = colors.edgeHi;
    ctx.lineWidth = 1.6 / view.k;
    ctx.beginPath();
    for (let e = 0; e < m; e++) {
      const s = edgeIdx[e * 2];
      const t = edgeIdx[e * 2 + 1];
      const strong = focusSet ? s === focus || t === focus : hlEdges ? hlEdges.has(edgeKeys[e]) : false;
      if (!strong) continue;
      ctx.moveTo(xs[s], ys[s]);
      ctx.lineTo(xs[t], ys[t]);
    }
    ctx.stroke();
    // Pfeile für gerichtete Kanten
    if (props.arrows && view.k > 0.6) {
      ctx.fillStyle = colors.edge;
      for (let e = 0; e < m; e++) {
        if (edgeKinds[e] === "child") continue;
        const s = edgeIdx[e * 2];
        const t = edgeIdx[e * 2 + 1];
        const dx = xs[t] - xs[s];
        const dy = ys[t] - ys[s];
        const l = Math.hypot(dx, dy) || 1;
        const r = radius(t) + 1;
        const ex = xs[t] - (dx / l) * r;
        const ey = ys[t] - (dy / l) * r;
        const a = 4 / view.k;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - (dx / l) * a * 1.6 - (dy / l) * a, ey - (dy / l) * a * 1.6 + (dx / l) * a);
        ctx.lineTo(ex - (dx / l) * a * 1.6 + (dy / l) * a, ey - (dy / l) * a * 1.6 - (dx / l) * a);
        ctx.fill();
      }
    }

    // Knoten
    for (let i = 0; i < nodes.length; i++) {
      const active = isActive(i);
      ctx.globalAlpha = active ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(xs[i], ys[i], radius(i), 0, Math.PI * 2);
      ctx.fillStyle = nodes[i].color;
      ctx.fill();
      if (i === focus || (props.focusId && nodes[i].id === props.focusId)) {
        ctx.lineWidth = 2.5 / view.k;
        ctx.strokeStyle = colors.edgeHi;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Beschriftungen
    const mode = props.showLabels ?? "auto";
    if (mode !== "never") {
      const fontSize = 12 / view.k;
      ctx.font = `${fontSize}px ui-sans-serif, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i < nodes.length; i++) {
        const active = isActive(i);
        const important = i === focus || (focusSet?.has(i) ?? false) || (hl?.has(nodes[i].id) ?? false);
        const show = mode === "always" || important || view.k > 1.1 || (view.k > 0.55 && deg[i] >= 4) || nodes.length < 40;
        if (!show) continue;
        const label = nodes[i].label.length > 32 ? nodes[i].label.slice(0, 31) + "…" : nodes[i].label;
        const y = ys[i] + radius(i) + 3 / view.k;
        ctx.lineWidth = 3 / view.k;
        ctx.strokeStyle = colors.bg;
        ctx.globalAlpha = active ? 1 : 0.25;
        ctx.strokeText(label, xs[i], y);
        ctx.fillStyle = active ? colors.text : colors.textDim;
        ctx.fillText(label, xs[i], y);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  const fit = () => {
    if (!nodes.length || !width) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      minX = Math.min(minX, xs[i]);
      minY = Math.min(minY, ys[i]);
      maxX = Math.max(maxX, xs[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    const w = Math.max(maxX - minX, 60);
    const h = Math.max(maxY - minY, 60);
    const usable = Math.max(120, width - (props.insetRight ?? 0));
    view.k = Math.max(0.05, Math.min(2, Math.min((usable - 60) / w, (height - 60) / h)));
    view.x = usable / 2 - ((minX + maxX) / 2) * view.k;
    view.y = height / 2 - ((minY + maxY) / 2) * view.k;
    requestDraw();
  };

  const center = (id: string) => {
    const i = index.get(id);
    if (i === undefined) return;
    view.k = Math.max(view.k, 1.2);
    view.x = Math.max(120, width - (props.insetRight ?? 0)) / 2 - xs[i] * view.k;
    view.y = height / 2 - ys[i] * view.k;
    requestDraw();
  };

  const savePositions = () => {
    if (!props.layoutKey || !nodes.length) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      // Alle bekannten Positionen speichern – auch die gerade ausgeblendeter Knoten (Zeitreise, Filter)
      remember();
      const data: Record<string, [number, number]> = {};
      for (const [id, [x, y]] of memory) {
        // Gelöschte Seiten nicht ewig mitschleppen
        if (props.isKnown && !props.isKnown(id)) {
          memory.delete(id);
          continue;
        }
        data[id] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
      }
      void api.saveLayout(props.layoutKey!, JSON.stringify(data));
    }, 500);
  };

  /** Gedächtnis aller je gezeigten Positionen: ausgeblendete Knoten kehren an ihren Platz zurück. */
  const memory = new Map<string, [number, number]>();
  /** Gespeichertes Layout – einmal geladen, jeder load() wartet darauf (auch bei schnellen Folgeaufrufen). */
  let layoutLoad: Promise<void> | null = null;
  /** Zählt load()-Aufrufe: ein überholter Aufruf bricht nach dem Warten ab. */
  let loadSeq = 0;
  /** Kennung der Daten im Worker: steigt nur, wenn wirklich neue Daten gesendet werden. */
  let gen = 0;
  let signature = "";
  /** Aktuelle „Energie“ der Simulation (aus den Ticks). */
  let simAlpha = 0;

  const remember = () => {
    for (let i = 0; i < nodes.length; i++) memory.set(nodes[i].id, [xs[i], ys[i]]);
  };

  /** Daten in den Worker laden. Bekannte Knoten behalten ihre Position, die Ansicht springt nicht. */
  const load = async () => {
    const mySeq = ++loadSeq;
    if (props.layoutKey) {
      const key = props.layoutKey;
      layoutLoad ??= (async () => {
        try {
          const cached: Record<string, [number, number]> = JSON.parse((await api.getLayout(key)) ?? "{}");
          for (const [id, pos] of Object.entries(cached)) if (!memory.has(id)) memory.set(id, pos);
        } catch {
          /* kein gespeichertes Layout */
        }
      })();
      await layoutLoad;
      if (mySeq !== loadSeq) return; // inzwischen neuere Daten
    }
    if (nodes.length) remember();
    const nextNodes = props.nodes;
    const nextSignature = nextNodes.map((n) => n.id).join("\u0001") + "\u0002" + props.edges.map((e) => `${e.s}|${e.t}|${e.kind}`).join("\u0001");
    if (nextSignature === signature) {
      // Gleiche Struktur: nur Beschriftungen/Farben übernehmen, Simulation läuft ungestört weiter
      nodes = nextNodes;
      requestDraw();
      return;
    }
    // Erstes Laden = noch nie eingepasst (auch wenn zuvor leere Daten kamen)
    const firstLoad = !fitted;
    signature = nextSignature;
    // Hover/Ziehen zeigen per Index auf Knoten – über die ID auf die neue Reihenfolge übertragen
    const hoverId = hover >= 0 ? nodes[hover]?.id : undefined;
    const dragId = dragging >= 0 ? nodes[dragging]?.id : undefined;
    nodes = nextNodes;
    index = new Map(nodes.map((n, i) => [n.id, i]));
    hover = hoverId !== undefined ? index.get(hoverId) ?? -1 : -1;
    dragging = dragId !== undefined ? index.get(dragId) ?? -1 : -1;
    const pairs: number[] = [];
    edgeKinds = [];
    edgeKeys = [];
    neighbors = nodes.map(() => new Set<number>());
    deg = new Uint32Array(nodes.length);
    const seen = new Set<string>();
    for (const e of props.edges) {
      const s = index.get(e.s);
      const t = index.get(e.t);
      if (s === undefined || t === undefined || s === t) continue;
      const key = s < t ? `${s}:${t}:${e.kind}` : `${t}:${s}:${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(s, t);
      edgeKinds.push(e.kind);
      edgeKeys.push(`${e.s}|${e.t}`);
      neighbors[s].add(t);
      neighbors[t].add(s);
      deg[s]++;
      deg[t]++;
    }
    edgeIdx = new Uint32Array(pairs);
    xs = new Float32Array(nodes.length);
    ys = new Float32Array(nodes.length);
    let known = 0;
    const spread = Math.sqrt(nodes.length) * 20 + 20;
    for (let i = 0; i < nodes.length; i++) {
      const p = memory.get(nodes[i].id);
      if (p) {
        xs[i] = p[0];
        ys[i] = p[1];
        known++;
      } else {
        // Neue Knoten dicht neben einem bekannten Nachbarn einsetzen
        const nb = [...neighbors[i]].find((j) => memory.has(nodes[j].id));
        const base = nb !== undefined ? memory.get(nodes[nb].id)! : null;
        const angle = i * 2.39996;
        const r = base ? 18 : spread * Math.sqrt((i + 0.5) / nodes.length);
        xs[i] = (base?.[0] ?? 0) + Math.cos(angle) * r;
        ys[i] = (base?.[1] ?? 0) + Math.sin(angle) * r;
        memory.set(nodes[i].id, [xs[i], ys[i]]);
      }
    }
    const added = nodes.length - known;
    // Nur so viel "Energie" wie nötig: Bekanntes bleibt ruhig, Neues findet sanft seinen Platz
    // Nur Verbindungen geändert: genug Energie, damit neue Kanten wirken. Eine laufende Anordnung wird nie gebremst.
    // Viele nie angeordnete Knoten (erstes Laden, auch wenn zuvor leere Daten kamen): volle Energie
    const wanted = (firstLoad || added >= 5) && known < nodes.length * 0.8 ? 1 : added === 0 ? 0.15 : Math.min(0.35, 0.08 + (0.3 * added) / Math.max(1, nodes.length));
    const alpha = Math.max(wanted, simAlpha);
    if (!worker) {
      worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = (e) => console.error("Graph-Worker-Fehler:", e.message);
      worker.onmessage = (e) => {
        // Ticks zu älteren Daten verwerfen (sonst landen Positionen bei den falschen Knoten)
        if (e.data.gen !== gen) return;
        if (e.data.type === "tick") {
          if (import.meta.env.VITE_SELFTEST) wrap.dataset.ticks = String(Number(wrap.dataset.ticks ?? 0) + 1);
          if (e.data.x.length !== nodes.length) return;
          xs = e.data.x;
          ys = e.data.y;
          simAlpha = e.data.alpha;
          // Leere Daten zählen nicht als eingepasst – sonst würde nach dem echten Laden nie eingepasst
          if (!fitted && nodes.length) {
            fitted = true;
            fit();
          }
          requestDraw();
        } else if (e.data.type === "end") {
          simAlpha = 0;
          remember();
          savePositions();
        }
      };
    }
    // Erst jetzt neue Kennung: bei „gleicher Struktur“ oben läuft die alte Simulation mit ihrer Kennung weiter
    const myGen = ++gen;
    worker.postMessage({ type: "init", gen: myGen, n: nodes.length, edges: edgeIdx, x: xs.slice(), y: ys.slice(), alpha, params: { ...DEFAULT_PARAMS, ...props.params } });
    // Nur beim ersten Laden einpassen – danach bleibt die Ansicht, wo der Benutzer sie hat
    if (firstLoad && known === nodes.length && nodes.length) {
      fit();
      fitted = true;
    }
    requestDraw();
  };

  const resize = () => {
    const r = wrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    const firstSize = !width;
    width = r.width;
    height = r.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (firstSize && nodes.length) fit();
    requestDraw();
  };

  onMount(() => {
    // Für den automatischen Test: sofort zeichnen (requestAnimationFrame pausiert in verdeckten Fenstern)
    if (import.meta.env.VITE_SELFTEST) {
      const w = wrap as HTMLElement & { __drawNow?: () => void; __state?: () => unknown };
      w.__drawNow = () => {
        dirty = true;
        draw();
      };
      // Zustand für den Test: Ansicht, Positionen und Farben
      w.__state = () => ({
        view: { ...view },
        pos: Object.fromEntries(nodes.map((n, i) => [n.id, [xs[i], ys[i]]])),
        color: Object.fromEntries(nodes.map((n) => [n.id, n.color])),
      });
    }
    readColors();
    // resize() ändert die Canvas-Größe und damit evtl. den beobachteten Rahmen: im nächsten Frame
    // ausführen, sonst meldet WebKit eine ResizeObserver-Schleife
    let resizeFrame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    ro.observe(wrap);
    resize();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const themeObs = new MutationObserver(() => {
      readColors();
      requestDraw();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const onScheme = () => {
      readColors();
      requestDraw();
    };
    mq.addEventListener("change", onScheme);
    props.ref?.({ center, fit, reheat: () => worker?.postMessage({ type: "reheat", alpha: 0.6 }) });
    // Wheel nicht passiv, damit Scrollen/Zoomen die Seite nicht mitbewegt.
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Safari meldet Trackpad-Pinch als GestureEvent (nicht als ctrl+wheel).
    let gestureStartK = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStartK = view.k;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const r = canvas.getBoundingClientRect();
      const px = ge.clientX - r.left;
      const py = ge.clientY - r.top;
      const k = Math.max(0.05, Math.min(8, gestureStartK * ge.scale));
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      requestDraw();
    };
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);
    onCleanup(() => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      ro.disconnect();
      themeObs.disconnect();
      mq.removeEventListener("change", onScheme);
      worker?.terminate();
      worker = null;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeFrame);
      clearTimeout(saveTimer);
    });
  });

  createEffect(on(() => [props.nodes, props.edges], () => void load()));
  createEffect(on(() => [props.highlight, props.highlightEdges, props.focusId, props.showLabels, props.arrows, props.nodeScale], () => requestDraw()));
  // Nach Inhalt vergleichen: ein neu gebautes, gleiches Objekt (z. B. bei Anzeigeänderungen) heizt nicht neu an
  const paramsKey = createMemo(() => JSON.stringify(props.params ?? null));
  createEffect(
    on(
      paramsKey,
      () => {
        const p = props.params;
        if (p && worker) worker.postMessage({ type: "params", params: { ...DEFAULT_PARAMS, ...p } });
      },
      { defer: true },
    ),
  );

  // ---------- Interaktion ----------

  const local = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    if (e.ctrlKey || e.metaKey) {
      // Pinch-Zoom (Trackpad) bzw. ⌘ + Scrollrad
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const k = Math.max(0.05, Math.min(8, view.k * factor));
      view.x = p.x - ((p.x - view.x) * k) / view.k;
      view.y = p.y - ((p.y - view.y) * k) / view.k;
      view.k = k;
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
    }
    requestDraw();
  };

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = local(e);
    moved = false;
    const i = hit(p.x, p.y);
    if (i >= 0) {
      dragging = i;
    } else {
      panning = { x: p.x, y: p.y, vx: view.x, vy: view.y };
    }
    const move = (ev: MouseEvent) => {
      const q = local(ev);
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 3) moved = true;
      if (dragging >= 0 && moved) {
        const w = toWorld(q.x, q.y);
        xs[dragging] = w.x;
        ys[dragging] = w.y;
        worker?.postMessage({ type: "drag", i: dragging, x: w.x, y: w.y });
        requestDraw();
      } else if (panning) {
        view.x = panning.vx + q.x - panning.x;
        view.y = panning.vy + q.y - panning.y;
        requestDraw();
      }
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (dragging >= 0) {
        if (!moved) props.onNodeClick?.(nodes[dragging].id, ev);
        else worker?.postMessage({ type: "release", i: dragging });
      }
      dragging = -1;
      panning = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMove = (e: MouseEvent) => {
    if (dragging >= 0 || panning) return;
    const p = local(e);
    const i = hit(p.x, p.y);
    if (i !== hover) {
      hover = i;
      canvas.style.cursor = i >= 0 ? "pointer" : "grab";
      props.onHover?.(i >= 0 ? nodes[i].id : null);
      requestDraw();
    }
  };

  const onLeave = () => {
    if (hover >= 0) {
      hover = -1;
      props.onHover?.(null);
      requestDraw();
    }
  };

  const onDbl = (e: MouseEvent) => {
    const p = local(e);
    const i = hit(p.x, p.y);
    if (i >= 0) props.onNodeOpen?.(nodes[i].id);
    else fit();
  };

  return (
    <div ref={wrap} class="graph-canvas" style={{ height: typeof props.height === "number" ? `${props.height}px` : (props.height ?? "100%") }}>
      <canvas ref={canvas} onMouseDown={onDown} onMouseMove={onMove} onMouseLeave={onLeave} onDblClick={onDbl} />
    </div>
  );
}
