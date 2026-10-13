// Graph-Analysen: Nachbarschaften, kürzeste Pfade, Cluster, Zentralität.

export interface GNode {
  id: string;
  label: string;
  color: string;
  group?: string;
  createdAt?: number;
  kind?: string;
  icon?: string | null;
}

export interface GEdge {
  s: string;
  t: string;
  kind: string;
  label?: string;
}

export function adjacency(nodes: GNode[], edges: GEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!adj.has(e.s) || !adj.has(e.t) || e.s === e.t) continue;
    adj.get(e.s)!.add(e.t);
    adj.get(e.t)!.add(e.s);
  }
  return adj;
}

/** Kürzester Pfad (ungerichtet, Breitensuche). */
export function shortestPath(adj: Map<string, Set<string>>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  // Warteschlange mit Lesezeiger statt shift() (shift kopiert das Array → quadratisch)
  const queue = [from];
  const seen = new Set([from]);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const nb of adj.get(cur) ?? []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === to) {
        const path = [to];
        let p = to;
        while (prev.has(p)) {
          p = prev.get(p)!;
          path.unshift(p);
        }
        return path;
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Alle Knoten bis zur Tiefe `depth` um `center`. */
export function neighborhood(adj: Map<string, Set<string>>, center: string, depth: number): Set<string> {
  const out = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!out.has(nb)) {
          out.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Cluster per Label Propagation (schnell, deterministisch durch feste Reihenfolge).
 * Gibt für jeden Knoten eine Cluster-ID zurück.
 */
export function clusters(adj: Map<string, Set<string>>): Map<string, string> {
  const label = new Map<string, string>();
  const ids = [...adj.keys()];
  for (const id of ids) label.set(id, id);
  // Reihenfolge nach Grad absteigend: Hubs prägen ihre Nachbarschaft
  ids.sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size) || (a < b ? -1 : 1));
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (const id of ids) {
      const nbs = adj.get(id)!;
      if (!nbs.size) continue;
      const counts = new Map<string, number>();
      for (const nb of nbs) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestCount = counts.get(best) ?? 0;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

export function degrees(adj: Map<string, Set<string>>): Map<string, number> {
  const d = new Map<string, number>();
  for (const [id, s] of adj) d.set(id, s.size);
  return d;
}

/** Ungefähre Betweenness-Zentralität (Brandes, auf Stichprobe beschränkt). Findet "Brücken"-Seiten. */
export function betweenness(adj: Map<string, Set<string>>, sample = 200): Map<string, number> {
  const ids = [...adj.keys()];
  const cb = new Map<string, number>(ids.map((id) => [id, 0]));
  const step = Math.max(1, Math.floor(ids.length / sample));
  for (let si = 0; si < ids.length; si += step) {
    const s = ids[si];
    const stackS: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>([[s, 1]]);
    const dist = new Map<string, number>([[s, 0]]);
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      stackS.push(v);
      for (const w of adj.get(v)!) {
        if (!dist.has(w)) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!);
          if (!pred.has(w)) pred.set(w, []);
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map<string, number>();
    while (stackS.length) {
      const w = stackS.pop()!;
      for (const v of pred.get(w) ?? []) {
        delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0)));
      }
      if (w !== s) cb.set(w, cb.get(w)! + (delta.get(w) ?? 0));
    }
  }
  return cb;
}

/** Gut unterscheidbare Farben für Cluster (funktionieren in hell und dunkel). */
export const PALETTE = ["#2383e2", "#e16259", "#4dab9a", "#d9730d", "#9065b0", "#cb912f", "#c14c8a", "#448361", "#337ea9", "#9f6b53", "#6940a5", "#0f7b6c"];

export function colorFor(key: string, index?: number): string {
  if (index !== undefined) return PALETTE[index % PALETTE.length];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
