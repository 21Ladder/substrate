import type { Component } from "solid-js";
import type { DatabaseData, DatabaseRow, ID, NumberFormat, PropType, PropertyDef, RollupFn } from "../api/types";
import { formatDateValue, median, minMax, pageTitle, parseDateValue } from "../lib/util";
import { ws } from "../state/workspace";
import { getDatabase } from "./store";
import { evaluate, isEmptyValue, toText, type FPage, type FValue } from "./formula";
import {
  IconCalendar,
  IconCheckbox,
  IconClock,
  IconFile,
  IconFormula,
  IconHash,
  IconId,
  IconLink,
  IconMultiSelect,
  IconPhone,
  IconRelation,
  IconRollup,
  IconSelect,
  IconStatus,
  IconText,
  IconAt,
} from "../components/Icons";

export const PROP_TYPES: { type: PropType; label: string; icon: Component }[] = [
  { type: "text", label: "Text", icon: IconText },
  { type: "number", label: "Zahl", icon: IconHash },
  { type: "select", label: "Auswahl", icon: IconSelect },
  { type: "multi_select", label: "Mehrfachauswahl", icon: IconMultiSelect },
  { type: "status", label: "Status", icon: IconStatus },
  { type: "date", label: "Datum", icon: IconCalendar },
  { type: "checkbox", label: "Checkbox", icon: IconCheckbox },
  { type: "url", label: "URL", icon: IconLink },
  { type: "email", label: "E-Mail", icon: IconAt },
  { type: "phone", label: "Telefon", icon: IconPhone },
  { type: "files", label: "Dateien & Medien", icon: IconFile },
  { type: "relation", label: "Relation", icon: IconRelation },
  { type: "rollup", label: "Rollup", icon: IconRollup },
  { type: "formula", label: "Formel", icon: IconFormula },
  { type: "created_time", label: "Erstellt am", icon: IconClock },
  { type: "last_edited_time", label: "Zuletzt bearbeitet", icon: IconClock },
  { type: "unique_id", label: "ID", icon: IconId },
];

export function propIcon(type: PropType): Component {
  if (type === "title") return IconText;
  return PROP_TYPES.find((t) => t.type === type)?.icon ?? IconText;
}

export function propTypeLabel(type: PropType): string {
  if (type === "title") return "Titel";
  return PROP_TYPES.find((t) => t.type === type)?.label ?? type;
}

export const READONLY_TYPES = new Set<PropType>(["formula", "rollup", "created_time", "last_edited_time", "unique_id"]);

export function rowTitle(row: DatabaseRow): string {
  return ws.pages[row.id]?.title ?? row.title;
}

// ---------- Werte ----------

const evaluating = new Set<string>();

/** Rohwert einer Eigenschaft (inkl. berechneter Werte). */
export function getValue(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): unknown {
  switch (prop.type) {
    case "title":
      return rowTitle(row);
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return ws.pages[row.id]?.updatedAt ?? row.updatedAt;
    case "formula":
      return formulaValue(db, row, prop);
    case "rollup":
      return rollupValue(db, row, prop);
    default:
      return row.props[prop.id] ?? null;
  }
}

function pageValue(dbId: ID | undefined, rowId: ID): FPage {
  return {
    __page: rowId,
    title: pageTitle(ws.pages[rowId]?.title),
    prop: (name: string) => {
      const d = dbId ? getDatabase(dbId) : undefined;
      const r = d?.rows.find((x) => x.id === rowId);
      const p = d?.schema.find((x) => x.name === name);
      return d && r && p ? toFormulaValue(d, r, p) : null;
    },
  };
}

/** Wert für die Formel-Auswertung. */
export function toFormulaValue(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): FValue {
  const v = getValue(db, row, prop);
  switch (prop.type) {
    case "number":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return !!v;
    case "select":
    case "status":
      return prop.options?.find((o) => o.id === v)?.name ?? "";
    case "multi_select":
      return Array.isArray(v) ? v.map((id) => prop.options?.find((o) => o.id === id)?.name ?? "").filter(Boolean) : [];
    case "date": {
      const d = v as { start?: string } | null;
      return d?.start ? parseDateValue(d.start) : null;
    }
    case "created_time":
    case "last_edited_time":
      return typeof v === "number" ? new Date(v) : null;
    case "relation":
      return Array.isArray(v) ? v.map((id) => pageValue(prop.relation?.databaseId, id)) : [];
    case "files":
      return Array.isArray(v) ? v.map((f: any) => String(f?.name ?? "")) : [];
    case "formula":
    case "rollup":
      return (v as FValue) ?? null;
    case "unique_id":
      return typeof v === "number" ? v : null;
    default:
      return v === null || v === undefined ? "" : String(v);
  }
}

export function formulaValue(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): FValue | { error: string } {
  if (!prop.formula?.trim()) return null;
  const key = `${row.id}:${prop.id}`;
  if (evaluating.has(key)) return { error: "Zirkelbezug" };
  evaluating.add(key);
  try {
    return evaluate(prop.formula ?? "", {
      id: row.id,
      prop: (name) => {
        const p = db.schema.find((x) => x.name === name);
        if (!p) throw new Error(`Eigenschaft „${name}“ nicht gefunden`);
        const v = toFormulaValue(db, row, p);
        if (v && typeof v === "object" && "error" in (v as object)) throw new Error((v as any).error);
        return v;
      },
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    evaluating.delete(key);
  }
}

export function rollupValue(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): FValue {
  const cfg = prop.rollup;
  if (!cfg) return null;
  // Gegenseitig verweisende Rollups würden sonst endlos rekursiv auswerten
  const key = `rollup:${row.id}:${prop.id}`;
  if (evaluating.has(key)) return null;
  evaluating.add(key);
  try {
    return rollupInner(db, row, cfg);
  } finally {
    evaluating.delete(key);
  }
}

function rollupInner(db: DatabaseData, row: DatabaseRow, cfg: NonNullable<PropertyDef["rollup"]>): FValue {
  const rel = db.schema.find((p) => p.id === cfg.relationProp);
  if (!rel || rel.type !== "relation" || !rel.relation) return null;
  const target = getDatabase(rel.relation.databaseId);
  if (!target) return null;
  const ids = (row.props[rel.id] as ID[]) ?? [];
  const tprop = cfg.targetProp === "title" ? target.schema.find((p) => p.type === "title") : target.schema.find((p) => p.id === cfg.targetProp);
  if (!tprop) return null;
  const values: FValue[] = [];
  for (const id of ids) {
    const r = target.rows.find((x) => x.id === id);
    if (r) values.push(toFormulaValue(target, r, tprop));
  }
  return aggregate(values, cfg.fn);
}

function aggregate(values: FValue[], fn: RollupFn): FValue {
  const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const nums = flat.filter((v): v is number => typeof v === "number");
  const dates = flat.filter((v): v is Date => v instanceof Date).map((d) => d.getTime());
  switch (fn) {
    case "show":
      return flat;
    case "count":
      return values.length;
    case "count_values":
      return flat.filter((v) => !isEmptyValue(v)).length;
    case "unique":
      return new Set(flat.map(toText)).size;
    case "empty":
      return values.filter((v) => isEmptyValue(v)).length;
    case "not_empty":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "average":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "median":
      return median(nums);
    case "min":
      return minMax(nums)?.min ?? null;
    case "max":
      return minMax(nums)?.max ?? null;
    case "range": {
      const mm = minMax(nums);
      return mm ? mm.max - mm.min : null;
    }
    case "checked":
      return flat.filter((v) => v === true).length;
    case "percent_checked":
      return flat.length ? Math.round((flat.filter((v) => v === true).length / flat.length) * 100) : 0;
    case "earliest": {
      const mm = minMax(dates);
      return mm ? new Date(mm.min) : null;
    }
    case "latest": {
      const mm = minMax(dates);
      return mm ? new Date(mm.max) : null;
    }
  }
}

export const ROLLUP_FNS: { fn: RollupFn; label: string }[] = [
  { fn: "show", label: "Original anzeigen" },
  { fn: "count", label: "Alle zählen" },
  { fn: "count_values", label: "Werte zählen" },
  { fn: "unique", label: "Eindeutige Werte zählen" },
  { fn: "empty", label: "Leere zählen" },
  { fn: "not_empty", label: "Nicht leere zählen" },
  { fn: "sum", label: "Summe" },
  { fn: "average", label: "Durchschnitt" },
  { fn: "median", label: "Median" },
  { fn: "min", label: "Minimum" },
  { fn: "max", label: "Maximum" },
  { fn: "range", label: "Spanne" },
  { fn: "checked", label: "Angehakt" },
  { fn: "percent_checked", label: "% angehakt" },
  { fn: "earliest", label: "Frühestes Datum" },
  { fn: "latest", label: "Spätestes Datum" },
];

// ---------- Darstellung ----------

const numberFormats: Record<NumberFormat, (n: number) => string> = {
  number: (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6)),
  comma: (n) => n.toLocaleString("de-DE", { maximumFractionDigits: 6 }),
  percent: (n) => `${(n * 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`,
  euro: (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }),
  dollar: (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" }),
  bar: (n) => String(n),
  ring: (n) => String(n),
};

export function formatNumber(n: number, format: NumberFormat = "number"): string {
  return numberFormats[format]?.(n) ?? String(n);
}

/** Textdarstellung für Suche, Sortierung nach Text, Export und Kalkulation. */
export function displayText(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): string {
  const v = getValue(db, row, prop);
  switch (prop.type) {
    case "title":
      return String(v ?? "");
    case "number":
      return typeof v === "number" ? formatNumber(v, prop.format) : "";
    case "select":
    case "status":
      return prop.options?.find((o) => o.id === v)?.name ?? "";
    case "multi_select":
      return Array.isArray(v) ? v.map((id) => prop.options?.find((o) => o.id === id)?.name ?? "").filter(Boolean).join(", ") : "";
    case "date": {
      const d = v as { start?: string; end?: string } | null;
      if (!d?.start) return "";
      return formatDateValue(d.start, prop.dateFormat ?? "full") + (d.end ? ` → ${formatDateValue(d.end, prop.dateFormat ?? "full")}` : "");
    }
    case "checkbox":
      return v ? "✓" : "";
    case "relation":
      return Array.isArray(v) ? v.map((id) => pageTitle(ws.pages[id]?.title)).join(", ") : "";
    case "files":
      return Array.isArray(v) ? v.map((f: any) => f?.name ?? "").join(", ") : "";
    case "created_time":
    case "last_edited_time":
      return typeof v === "number" ? new Date(v).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "";
    case "formula":
    case "rollup": {
      if (v && typeof v === "object" && "error" in (v as object)) return `#Fehler`;
      if (typeof v === "number") return formatNumber(v, prop.format);
      return toText(v as FValue);
    }
    case "unique_id":
      return v === null || v === undefined ? "" : `${prop.prefix ? prop.prefix + "-" : ""}${v}`;
    default:
      return v === null || v === undefined ? "" : String(v);
  }
}

export function isEmpty(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): boolean {
  const v = getValue(db, row, prop);
  if (prop.type === "checkbox") return !v;
  if (prop.type === "date") return !(v as any)?.start;
  if (prop.type === "formula" || prop.type === "rollup") return isEmptyValue(v as FValue);
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Sortierschlüssel einer Eigenschaft (Zahl oder Text). */
export function sortValue(db: DatabaseData, row: DatabaseRow, prop: PropertyDef): number | string | null {
  const v = getValue(db, row, prop);
  switch (prop.type) {
    case "number":
    case "unique_id":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return v ? 1 : 0;
    case "date": {
      const d = v as { start?: string } | null;
      return d?.start ? parseDateValue(d.start).getTime() : null;
    }
    case "created_time":
    case "last_edited_time":
      return typeof v === "number" ? v : null;
    case "select":
    case "status": {
      const i = prop.options?.findIndex((o) => o.id === v) ?? -1;
      return i >= 0 ? i : null;
    }
    case "formula":
    case "rollup": {
      if (typeof v === "number") return v;
      if (v instanceof Date) return v.getTime();
      if (typeof v === "boolean") return v ? 1 : 0;
      const t = toText(v as FValue);
      return t || null;
    }
    default: {
      const t = displayText(db, row, prop);
      return t ? t.toLowerCase() : null;
    }
  }
}
