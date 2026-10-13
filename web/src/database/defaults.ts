import type { PropertyDef, SelectOption, ViewDef, ViewType } from "../api/types";
import { shortId } from "../lib/id";

export const VIEW_LABELS: Record<ViewType, string> = {
  table: "Tabelle",
  board: "Board",
  list: "Liste",
  gallery: "Galerie",
  calendar: "Kalender",
  graph: "Graph",
};

export function defaultStatusOptions(): SelectOption[] {
  return [
    { id: shortId(), name: "Nicht begonnen", color: "default", group: "todo" },
    { id: shortId(), name: "In Bearbeitung", color: "blue", group: "progress" },
    { id: shortId(), name: "Fertig", color: "green", group: "done" },
  ];
}

export function newView(type: ViewType, schema: PropertyDef[], name?: string): ViewDef {
  const groupProp = schema.find((p) => p.type === "status") ?? schema.find((p) => p.type === "select");
  const dateProp = schema.find((p) => p.type === "date");
  return {
    id: shortId(),
    name: name ?? VIEW_LABELS[type],
    type,
    filter: { op: "and", rules: [] },
    sorts: [],
    groupBy: type === "board" ? (groupProp?.id ?? null) : null,
    hidden: [],
    order: schema.map((p) => p.id),
    widths: {},
    calcs: {},
    cardSize: "medium",
    cardCover: type === "gallery" ? "cover" : "none",
    dateProp: type === "calendar" ? (dateProp?.id ?? null) : null,
  };
}

export function defaultDatabase(type: ViewType): { schema: PropertyDef[]; views: ViewDef[] } {
  const schema: PropertyDef[] = [{ id: "title", name: "Name", type: "title" }];
  if (type === "board") schema.push({ id: shortId(), name: "Status", type: "status", options: defaultStatusOptions() });
  if (type === "calendar") schema.push({ id: shortId(), name: "Datum", type: "date" });
  schema.push({ id: shortId(), name: "Tags", type: "multi_select", options: [] });
  return { schema, views: [newView(type, schema)] };
}
