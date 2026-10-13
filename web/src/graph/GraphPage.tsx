import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { minMax, pageTitle } from "../lib/util";
import { jsonSetting, navigation, setSetting, ws } from "../state/workspace";
import { openPagePicker } from "../components/popovers";
import { IconClose, IconSearch } from "../components/Icons";
import { PageIcon } from "../components/PageIcon";
import { GraphCanvas, type GraphCanvasApi } from "./GraphCanvas";
import { adjacency, betweenness, degrees, shortestPath } from "./analysis";
import { buildGraph, clusterSummary, DEFAULT_GRAPH_OPTIONS, graphEdges, graphStructure, loadAllDatabases, type GraphOptions } from "./data";

/** Globaler Graph des gesamten Workspaces mit Filter-, Darstellungs- und Analysefunktionen. */
export function GraphPage() {
  const [opts, setOpts] = createSignal<GraphOptions>({ ...DEFAULT_GRAPH_OPTIONS, ...jsonSetting<Partial<GraphOptions>>("graphOptions", {}), until: null });
  const [display, setDisplay] = createSignal(jsonSetting("graphDisplay", { labels: "auto" as "auto" | "always" | "never", arrows: false, nodeScale: 1, distance: 45, repulsion: 80 }));
  const [search, setSearch] = createSignal("");
  const [path, setPath] = createSignal<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [focusCluster, setFocusCluster] = createSignal<string | null>(null);
  const [panel, setPanel] = createSignal(true);
  const [tab, setTab] = createSignal<"filter" | "analyse">("filter");
  const [playing, setPlaying] = createSignal(false);
  let canvasApi: GraphCanvasApi | undefined;

  onMount(() => graphEdges.ensure());
  createEffect(() => {
    if (opts().tags) void loadAllDatabases();
  });

  const updateOpts = (p: Partial<GraphOptions>) => {
    const next = { ...opts(), ...p };
    setOpts(next);
    // "until" (Zeitreise) ist flüchtig und wird nicht gespeichert
    if (Object.keys(p).some((k) => k !== "until")) {
      const { until: _u, ...persist } = next;
      setSetting("graphOptions", JSON.stringify(persist));
    }
  };
  const updateDisplay = (p: Partial<ReturnType<typeof display>>) => {
    const next = { ...display(), ...p };
    setDisplay(next);
    setSetting("graphDisplay", JSON.stringify(next));
  };

  // Vollständiger Graph (Farben/Cluster stabil) – die Zeitreise blendet nur Knoten aus, statt neu zu färben
  // Optionen ohne Zeitpunkt: Zeitreise-Schritte bauen den vollständigen Graphen nicht neu
  const baseOpts = createMemo(
    () => {
      const { until: _u, ...o } = opts();
      return o;
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const fullGraph = createMemo(() => {
    graphEdges.version();
    graphStructure();
    const o = baseOpts();
    return untrack(() => buildGraph(graphEdges.edges(), { ...o, until: null }));
  });
  const graph = createMemo(() => {
    const full = fullGraph();
    const until = opts().until;
    if (!until) return full;
    const keep = new Set(full.nodes.filter((n) => n.createdAt !== undefined && n.createdAt <= until).map((n) => n.id));
    // Tag-Knoten (ohne Datum) erscheinen, sobald ein verbundener Eintrag sichtbar ist
    for (const e of full.edges) {
      if (e.kind === "tag" && keep.has(e.s)) keep.add(e.t);
    }
    const edges = full.edges.filter((e) => keep.has(e.s) && keep.has(e.t));
    // „Unverbundene Seiten“ aus: auch zum gewählten Zeitpunkt nur Knoten mit sichtbarer Verbindung
    if (!baseOpts().orphans) {
      const linked = new Set<string>();
      for (const e of edges) linked.add(e.s).add(e.t);
      for (const id of [...keep]) if (!linked.has(id)) keep.delete(id);
    }
    return { nodes: full.nodes.filter((n) => keep.has(n.id)), edges };
  });
  const adj = createMemo(() => adjacency(graph().nodes, graph().edges));

  const timeRange = createMemo(() => {
    return minMax(Object.values(ws.pages).map((p) => p.createdAt)) ?? { min: 0, max: 0 };
  });

  const searchHits = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return null;
    return new Set(graph().nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
  });

  const pathIds = createMemo(() => {
    const { from, to } = path();
    if (!from || !to) return null;
    return shortestPath(adj(), from, to);
  });

  const clustersList = createMemo(() => (opts().colorBy === "cluster" ? clusterSummary(graph().nodes, graph().edges).slice(0, 12) : []));

  const highlight = createMemo(() => {
    const p = pathIds();
    if (p) return new Set(p);
    const c = focusCluster();
    if (c) return new Set(clustersList().find((x) => x.id === c)?.members ?? []);
    return searchHits();
  });
  const highlightEdges = createMemo(() => {
    const p = pathIds();
    if (!p) return null;
    const s = new Set<string>();
    for (let i = 0; i + 1 < p.length; i++) {
      s.add(`${p[i]}|${p[i + 1]}`);
      s.add(`${p[i + 1]}|${p[i]}`);
    }
    return s;
  });

  const stats = createMemo(() => {
    const deg = degrees(adj());
    const hubs = [...deg.entries()].filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const orphans = [...deg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    return { hubs, orphans };
  });
  const bridges = createMemo(() => {
    if (tab() !== "analyse") return [];
    const bc = betweenness(adj());
    return [...bc.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  });

  // Zeitreise: der Graph wächst Seite für Seite in der Reihenfolge, in der sie entstanden sind
  // (gleichmäßig, auch wenn viele Seiten fast gleichzeitig angelegt wurden)
  let playTimer: number | undefined;
  const play = () => {
    if (playing()) {
      setPlaying(false);
      clearInterval(playTimer);
      updateOpts({ until: null });
      return;
    }
    const times = fullGraph()
      .nodes.map((n) => n.createdAt)
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b);
    if (times.length < 2) return;
    setPlaying(true);
    const frames = Math.min(60, times.length);
    let frame = 1;
    updateOpts({ until: times[0] });
    playTimer = window.setInterval(() => {
      frame++;
      if (frame > frames) {
        clearInterval(playTimer);
        setPlaying(false);
        updateOpts({ until: null });
        return;
      }
      updateOpts({ until: times[Math.ceil((frame / frames) * times.length) - 1] });
    }, Math.max(120, Math.min(400, 6000 / frames)));
  };
  onCleanup(() => clearInterval(playTimer));

  const labelOf = (id: string) => graph().nodes.find((n) => n.id === id)?.label ?? pageTitle(ws.pages[id]?.title);
  const pickFor = (which: "from" | "to") => (e: MouseEvent) =>
    openPagePicker((e.currentTarget as HTMLElement).getBoundingClientRect(), (id) => id && setPath({ ...path(), [which]: id }), { placeholder: which === "from" ? "Start …" : "Ziel …" });

  const open = (id: string) => (id.startsWith("tag:") ? setSearch(labelOf(id).slice(1)) : navigation.setPeek(id));

  return (
    <div class="graph-page">
      <GraphCanvas
        nodes={graph().nodes}
        edges={graph().edges}
        layoutKey="global"
        isKnown={(id) => !!ws.pages[id] || id.startsWith("tag:")}
        insetRight={panel() ? 310 : 0}
        highlight={highlight()}
        highlightEdges={highlightEdges()}
        showLabels={display().labels}
        arrows={display().arrows}
        nodeScale={display().nodeScale}
        params={{ linkDistance: display().distance, repulsion: display().repulsion }}
        onNodeClick={(id) => open(id)}
        onNodeOpen={(id) => !id.startsWith("tag:") && navigation.open(id)}
        ref={(a) => (canvasApi = a)}
      />
      <div class="graph-search">
        <IconSearch />
        <input
          placeholder="Im Graph suchen …"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = [...(searchHits() ?? [])][0];
              if (first) canvasApi?.center(first);
            }
          }}
        />
        <Show when={search()}>
          <button class="icon-btn small" onClick={() => setSearch("")}>
            <IconClose />
          </button>
        </Show>
      </div>
      <div class="graph-stats muted">
        {graph().nodes.length} Knoten · {graph().edges.length} Verbindungen
      </div>
      <Show
        when={panel()}
        fallback={
          <button class="graph-panel-toggle btn" onClick={() => setPanel(true)}>
            Einstellungen
          </button>
        }
      >
        <div class="graph-panel">
          <div class="graph-panel-tabs">
            <button classList={{ active: tab() === "filter" }} onClick={() => setTab("filter")}>
              Ansicht
            </button>
            <button classList={{ active: tab() === "analyse" }} onClick={() => setTab("analyse")}>
              Zusammenhänge
            </button>
            <span style={{ flex: 1 }} />
            <button class="icon-btn small" onClick={() => setPanel(false)}>
              <IconClose />
            </button>
          </div>
          <Show when={tab() === "filter"}>
            <div class="graph-section">
              <div class="graph-section-title">Verbindungen</div>
              <Check label="Links & Erwähnungen" value={opts().links} onChange={(v) => updateOpts({ links: v })} />
              <Check label="Datenbank-Relationen" value={opts().relations} onChange={(v) => updateOpts({ relations: v })} />
              <Check label="Unterseiten (Hierarchie)" value={opts().hierarchy} onChange={(v) => updateOpts({ hierarchy: v })} />
              <Check label="Gemeinsame Tags als Knoten" value={opts().tags} onChange={(v) => updateOpts({ tags: v })} />
            </div>
            <div class="graph-section">
              <div class="graph-section-title">Knoten</div>
              <Check label="Datenbankeinträge" value={opts().rows} onChange={(v) => updateOpts({ rows: v })} />
              <Check label="Unverbundene Seiten" value={opts().orphans} onChange={(v) => updateOpts({ orphans: v })} />
            </div>
            <div class="graph-section">
              <div class="graph-section-title">Darstellung</div>
              <label class="graph-row">
                <span>Farbe nach</span>
                <select value={opts().colorBy} onChange={(e) => updateOpts({ colorBy: e.currentTarget.value as any })}>
                  <option value="cluster">Themen-Cluster</option>
                  <option value="type">Typ / Datenbank</option>
                </select>
              </label>
              <label class="graph-row">
                <span>Beschriftung</span>
                <select value={display().labels} onChange={(e) => updateDisplay({ labels: e.currentTarget.value as any })}>
                  <option value="auto">Automatisch</option>
                  <option value="always">Immer</option>
                  <option value="never">Nie</option>
                </select>
              </label>
              <Check label="Richtungspfeile" value={display().arrows} onChange={(v) => updateDisplay({ arrows: v })} />
              <Slider label="Knotengröße" min={0.5} max={2.5} step={0.1} value={display().nodeScale} onChange={(v) => updateDisplay({ nodeScale: v })} />
              <Slider label="Abstand" min={15} max={150} step={5} value={display().distance} onChange={(v) => updateDisplay({ distance: v })} />
              <Slider label="Abstoßung" min={10} max={300} step={10} value={display().repulsion} onChange={(v) => updateDisplay({ repulsion: v })} />
            </div>
            <div class="graph-section">
              <div class="graph-section-title">Zeitreise</div>
              <div class="graph-row">
                <button class="btn-outline" onClick={play}>
                  {playing() ? "⏸ Anhalten" : "▶ Wachstum abspielen"}
                </button>
              </div>
              <input
                type="range"
                class="graph-range"
                min={timeRange().min}
                max={timeRange().max}
                value={opts().until ?? timeRange().max}
                onInput={(e) => {
                  const v = Number(e.currentTarget.value);
                  updateOpts({ until: v >= timeRange().max ? null : v });
                }}
              />
              <div class="muted small">
                {opts().until
                  ? `Stand: ${new Date(opts().until!).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })} · ${graph().nodes.length} von ${fullGraph().nodes.length} Knoten`
                  : "Heute"}
              </div>
            </div>
          </Show>
          <Show when={tab() === "analyse"}>
            <div class="graph-section">
              <div class="graph-section-title">Wie hängt das zusammen?</div>
              <div class="path-pick">
                <button class="btn-outline" onClick={pickFor("from")}>
                  {path().from ? labelOf(path().from!) : "Start wählen"}
                </button>
                <span>→</span>
                <button class="btn-outline" onClick={pickFor("to")}>
                  {path().to ? labelOf(path().to!) : "Ziel wählen"}
                </button>
              </div>
              <Show when={path().from && path().to}>
                <Show when={pathIds()} fallback={<div class="muted small">Keine Verbindung gefunden.</div>}>
                  <ol class="path-list">
                    <For each={pathIds()!}>
                      {(id) => (
                        <li onClick={() => canvasApi?.center(id)}>
                          <span>{labelOf(id)}</span>
                        </li>
                      )}
                    </For>
                  </ol>
                  <div class="muted small">{pathIds()!.length - 1} Schritte</div>
                </Show>
                <button class="btn" onClick={() => setPath({ from: null, to: null })}>
                  Zurücksetzen
                </button>
              </Show>
            </div>
            <Show when={clustersList().length}>
              <div class="graph-section">
                <div class="graph-section-title">Themen-Cluster</div>
                <For each={clustersList()}>
                  {(c) => (
                    <div class="graph-list-item" classList={{ active: focusCluster() === c.id }} onClick={() => setFocusCluster(focusCluster() === c.id ? null : c.id)}>
                      <span class="dot" style={{ background: c.color }} />
                      <span class="ellipsis">{c.name}</span>
                      <span class="muted">{c.members.length}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="graph-section">
              <div class="graph-section-title">Zentrale Seiten</div>
              <For each={stats().hubs} fallback={<div class="muted small">Noch keine Verbindungen.</div>}>
                {([id, d]) => (
                  <div class="graph-list-item" onClick={() => canvasApi?.center(id)}>
                    <Show when={ws.pages[id]}>
                      <PageIcon id={id} size={16} />
                    </Show>
                    <span class="ellipsis">{labelOf(id)}</span>
                    <span class="muted">{d}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={bridges().length}>
              <div class="graph-section">
                <div class="graph-section-title" title="Seiten, die sonst getrennte Bereiche verbinden">
                  Brücken zwischen Themen
                </div>
                <For each={bridges()}>
                  {([id]) => (
                    <div class="graph-list-item" onClick={() => canvasApi?.center(id)}>
                      <span class="ellipsis">{labelOf(id)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="graph-section">
              <div class="graph-section-title">Unverbundene Seiten ({stats().orphans.length})</div>
              <For each={stats().orphans.slice(0, 15)}>
                {(id) => (
                  <div class="graph-list-item" onClick={() => open(id)}>
                    <span class="ellipsis">{labelOf(id)}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Check(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="graph-row check">
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label class="graph-row slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.currentTarget.value))} />
    </label>
  );
}
