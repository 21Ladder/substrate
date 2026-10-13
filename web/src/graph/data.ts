import { createRoot, createSignal } from "solid-js";
import { api } from "../api/client";
import type { Edge, ID } from "../api/types";
import { pageTitle } from "../lib/util";
import { childrenIndex, on, ws } from "../state/workspace";
import { dbs, loadDatabase } from "../database/store";
import { adjacency, clusters, colorFor, type GEdge, type GNode } from "./analysis";

export interface GraphOptions {
  links: boolean;
  relations: boolean;
  hierarchy: boolean;
  rows: boolean;
  tags: boolean;
  orphans: boolean;
  colorBy: "cluster" | "type";
  until?: number | null;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  links: true,
  relations: true,
  hierarchy: true,
  rows: true,
  tags: false,
  orphans: true,
  colorBy: "cluster",
  until: null,
};

const TYPE_COLORS = { page: "#2383e2", database: "#9065b0", tag: "#d9730d" };

// Kanten aus der Datenbank, mit automatischer Aktualisierung bei Änderungen.
export const graphEdges = createRoot(() => {
  const [edges, setEdges] = createSignal<Edge[]>([]);
  const [version, setVersion] = createSignal(0);
  let timer: number | undefined;
  let loaded = false;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      setEdges(await api.graphEdges());
      setVersion((v) => v + 1);
    }, 150);
  };
  for (const ev of ["links-changed", "trashed", "restored", "moved"]) on(ev, () => loaded && refresh());
  return {
    edges,
    version,
    ensure() {
      if (!loaded) {
        loaded = true;
        refresh();
      }
    },
    refresh,
  };
});

/**
 * Strukturelle Abhängigkeit für Graph-Memos: ändert sich nur, wenn Seiten hinzukommen, verschwinden
 * oder umgehängt werden – nicht bei jedem Tastendruck in einem Titel.
 */
export function graphStructure() {
  return childrenIndex();
}

/** Lädt alle Datenbanken (für Tags als Knoten). */
export async function loadAllDatabases() {
  const ids = Object.values(ws.pages)
    .filter((p) => p.kind === "database")
    .map((p) => p.id);
  await Promise.all(ids.map((id) => loadDatabase(id)));
}

export function buildGraph(edges: Edge[], opts: GraphOptions): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = [];
  const out: GEdge[] = [];
  const include = new Set<ID>();
  for (const p of Object.values(ws.pages)) {
    if (!opts.rows && p.databaseId) continue;
    if (opts.until && p.createdAt > opts.until) continue;
    include.add(p.id);
    nodes.push({
      id: p.id,
      label: (p.icon && !p.icon.startsWith("app://") && !p.icon.startsWith("data:") ? p.icon + " " : "") + pageTitle(p.title),
      color: "",
      kind: p.kind === "database" ? "database" : p.databaseId ? "row" : "page",
      group: p.databaseId ?? undefined,
      createdAt: p.createdAt,
      icon: p.icon,
    });
  }
  for (const e of edges) {
    if (!include.has(e.src) || !include.has(e.dst)) continue;
    if (e.kind === "mention" && !opts.links) continue;
    if (e.kind === "relation" && !opts.relations) continue;
    out.push({ s: e.src, t: e.dst, kind: e.kind });
  }
  if (opts.hierarchy) {
    const rowsPerDb = new Map<ID, number>();
    for (const id of include) {
      const db = ws.pages[id].databaseId;
      if (db) rowsPerDb.set(db, (rowsPerDb.get(db) ?? 0) + 1);
    }
    for (const id of include) {
      const p = ws.pages[id];
      // Einträge großer Datenbanken würden einen riesigen Stern bilden – dort nur Relationen zeigen
      if (p.databaseId && (rowsPerDb.get(p.databaseId) ?? 0) > 40) continue;
      if (p.parentId && include.has(p.parentId)) out.push({ s: p.parentId, t: id, kind: "child" });
    }
  }
  if (opts.tags) {
    const tagNodes = new Map<string, GNode>();
    for (const d of Object.values(dbs)) {
      const tagProps = d.schema.filter((p) => p.type === "multi_select" || p.type === "select");
      for (const r of d.rows) {
        if (!include.has(r.id)) continue;
        for (const tp of tagProps) {
          const v = r.props[tp.id];
          const ids = Array.isArray(v) ? v : v ? [v] : [];
          for (const oid of ids) {
            const opt = tp.options?.find((o) => o.id === oid);
            if (!opt) continue;
            const key = `tag:${opt.name.toLowerCase()}`;
            if (!tagNodes.has(key)) tagNodes.set(key, { id: key, label: `#${opt.name}`, color: TYPE_COLORS.tag, kind: "tag" });
            out.push({ s: r.id, t: key, kind: "tag" });
          }
        }
      }
    }
    nodes.push(...tagNodes.values());
  }
  let finalNodes = nodes;
  const adj = adjacency(nodes, out);
  if (!opts.orphans) finalNodes = nodes.filter((n) => (adj.get(n.id)?.size ?? 0) > 0);
  colorize(finalNodes, out, opts.colorBy);
  return { nodes: finalNodes, edges: out };
}

export function colorize(nodes: GNode[], edges: GEdge[], by: "cluster" | "type") {
  if (by === "type") {
    for (const n of nodes) {
      n.color = n.kind === "tag" ? TYPE_COLORS.tag : n.kind === "database" ? TYPE_COLORS.database : n.kind === "row" ? colorFor(n.group ?? "") : TYPE_COLORS.page;
    }
    return;
  }
  const adj = adjacency(nodes, edges);
  const labels = clusters(adj);
  const sizes = new Map<string, number>();
  for (const l of labels.values()) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const ranked = [...sizes.entries()].filter(([, s]) => s > 1).sort((a, b) => b[1] - a[1]);
  const rank = new Map(ranked.map(([l], i) => [l, i]));
  for (const n of nodes) {
    const l = labels.get(n.id)!;
    const r = rank.get(l);
    n.color = r === undefined ? "#9b9a97" : colorFor(l, r);
    n.group = l;
  }
}

export interface ClusterInfo {
  id: string;
  name: string;
  color: string;
  members: string[];
}

export function clusterSummary(nodes: GNode[], edges: GEdge[]): ClusterInfo[] {
  const adj = adjacency(nodes, edges);
  const byGroup = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.group) continue;
    let list = byGroup.get(n.group);
    if (!list) byGroup.set(n.group, (list = []));
    list.push(n.id);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return [...byGroup.entries()]
    .filter(([, m]) => m.length > 1)
    .map(([id, members]) => {
      // Benannt nach dem am stärksten vernetzten Mitglied
      const hub = members.reduce((a, b) => ((adj.get(a)?.size ?? 0) >= (adj.get(b)?.size ?? 0) ? a : b));
      return { id, name: nodeById.get(hub)?.label ?? "Cluster", color: nodeById.get(hub)?.color ?? "#999", members };
    })
    .sort((a, b) => b.members.length - a.members.length);
}
