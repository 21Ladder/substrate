import { createMemo, Show } from "solid-js";
import type { DatabaseData, DatabaseRow, ID } from "../api/types";
import { pageTitle } from "../lib/util";
import { navigation, ws } from "../state/workspace";
import { getValue, rowTitle } from "../database/properties";
import { GraphCanvas } from "./GraphCanvas";
import { colorFor, type GEdge, type GNode } from "./analysis";

const TAG_COLORS: Record<string, string> = {
  default: "#9b9a97",
  gray: "#9b9a97",
  brown: "#9f6b53",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
};

/** Datenbank als Graph: Einträge sind Knoten, Relationen sind Kanten. Farbe aus Status/Auswahl. */
export function DbGraph(props: { db: DatabaseData; rows: DatabaseRow[]; height: number }) {
  const colorProp = () => props.db.schema.find((p) => p.type === "status") ?? props.db.schema.find((p) => p.type === "select");
  const data = createMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const ids = new Set(props.rows.map((r) => r.id));
    const cp = colorProp();
    for (const r of props.rows) {
      let color = colorFor(props.db.id);
      if (cp) {
        const opt = cp.options?.find((o) => o.id === getValue(props.db, r, cp));
        if (opt) color = TAG_COLORS[opt.color] ?? color;
      }
      nodes.push({ id: r.id, label: pageTitle(rowTitle(r)), color, kind: "row" });
    }
    const external = new Set<ID>();
    for (const p of props.db.schema) {
      if (p.type !== "relation") continue;
      for (const r of props.rows) {
        for (const dst of (r.props[p.id] as ID[]) ?? []) {
          if (!ids.has(dst)) {
            if (!ws.pages[dst]) continue;
            external.add(dst);
          }
          edges.push({ s: r.id, t: dst, kind: "relation", label: p.name });
        }
      }
    }
    for (const id of external) nodes.push({ id, label: pageTitle(ws.pages[id]?.title), color: "#b4b4b0", kind: "external" });
    return { nodes, edges, hasRelations: props.db.schema.some((p) => p.type === "relation") };
  });
  return (
    <div class="db-graph">
      <Show when={!data().hasRelations}>
        <div class="db-graph-hint muted">Tipp: Füge eine Relation-Eigenschaft hinzu, um Einträge miteinander zu verbinden.</div>
      </Show>
      <GraphCanvas
        nodes={data().nodes}
        edges={data().edges}
        layoutKey={`db:${props.db.id}`}
        height={props.height}
        showLabels="auto"
        onNodeClick={(id) => navigation.setPeek(id)}
        onNodeOpen={(id) => navigation.open(id)}
      />
    </div>
  );
}
