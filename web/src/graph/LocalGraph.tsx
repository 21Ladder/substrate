import { createMemo, onMount, untrack } from "solid-js";
import type { ID } from "../api/types";
import { navigation } from "../state/workspace";
import { GraphCanvas } from "./GraphCanvas";
import { adjacency, neighborhood } from "./analysis";
import { buildGraph, colorize, DEFAULT_GRAPH_OPTIONS, graphEdges, graphStructure } from "./data";

/** Verbindungen einer Seite bis zur Tiefe `depth`. */
export function LocalGraph(props: { pageId: ID; depth: number; height: number | string }) {
  onMount(() => graphEdges.ensure());
  const localGraph = (center: ID, depth: number) => {
    const full = buildGraph(graphEdges.edges(), { ...DEFAULT_GRAPH_OPTIONS, colorBy: "type" });
    const adj = adjacency(full.nodes, full.edges);
    const keep = neighborhood(adj, center, depth);
    const nodes = full.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n }));
    const edges = full.edges.filter((e) => keep.has(e.s) && keep.has(e.t));
    colorize(nodes, edges, "type");
    return { nodes, edges };
  };  const data = createMemo(() => {
    graphEdges.version();
    graphStructure();
    const depth = props.depth;
    const center = props.pageId;
    return untrack(() => localGraph(center, depth));
  });

  return (
    <GraphCanvas
      nodes={data().nodes}
      edges={data().edges}
      focusId={props.pageId}
      height={props.height}
      showLabels="always"
      params={{ linkDistance: 60, repulsion: 120, center: 0.06 }}
      onNodeClick={(id) => id !== props.pageId && navigation.open(id)}
      onNodeOpen={(id) => navigation.open(id)}
    />
  );
}
