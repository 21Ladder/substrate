import type { CalcFn, DatabaseData, DatabaseRow, FilterCond, FilterGroup, FilterRule, PropType, PropertyDef, SortRule, ViewDef } from "../api/types";
import { addDays, median, minMax, parseDateValue, toDateValue } from "../lib/util";
import { displayText, formatNumber, getValue, isEmpty, sortValue } from "./properties";

// Filtern, Sortieren, Gruppieren und Berechnen – rein im Speicher (schnell genug für zehntausende Zeilen).

export const FILTER_CONDS: Record<string, { cond: FilterCond; label: string; noValue?: boolean }[]> = {
  text: [
    { cond: "contains", label: "enthält" },
    { cond: "not_contains", label: "enthält nicht" },
    { cond: "is", label: "ist" },
    { cond: "is_not", label: "ist nicht" },
    { cond: "starts", label: "beginnt mit" },
    { cond: "ends", label: "endet mit" },
    { cond: "empty", label: "ist leer", noValue: true },
    { cond: "not_empty", label: "ist nicht leer", noValue: true },
  ],
  number: [
    { cond: "eq", label: "=" },
    { cond: "neq", label: "≠" },
    { cond: "gt", label: ">" },
    { cond: "lt", label: "<" },
    { cond: "gte", label: "≥" },
    { cond: "lte", label: "≤" },
    { cond: "empty", label: "ist leer", noValue: true },
    { cond: "not_empty", label: "ist nicht leer", noValue: true },
  ],
  select: [
    { cond: "is", label: "ist" },
    { cond: "is_not", label: "ist nicht" },
    { cond: "empty", label: "ist leer", noValue: true },
    { cond: "not_empty", label: "ist nicht leer", noValue: true },
  ],
  multi: [
    { cond: "contains", label: "enthält" },
    { cond: "not_contains", label: "enthält nicht" },
    { cond: "empty", label: "ist leer", noValue: true },
    { cond: "not_empty", label: "ist nicht leer", noValue: true },
  ],
  date: [
    { cond: "is", label: "ist" },
    { cond: "before", label: "ist vor" },
    { cond: "after", label: "ist nach" },
    { cond: "on_or_before", label: "ist am oder vor" },
    { cond: "on_or_after", label: "ist am oder nach" },
    { cond: "empty", label: "ist leer", noValue: true },
    { cond: "not_empty", label: "ist nicht leer", noValue: true },
  ],
  checkbox: [
    { cond: "checked", label: "ist angehakt", noValue: true },
    { cond: "unchecked", label: "ist nicht angehakt", noValue: true },
  ],
};

export function condGroup(type: PropType): keyof typeof FILTER_CONDS {
  switch (type) {
    case "number":
    case "unique_id":
      return "number";
    case "select":
    case "status":
      return "select";
    case "multi_select":
      return "multi";
    case "date":
    case "created_time":
    case "last_edited_time":
      return "date";
    case "checkbox":
      return "checkbox";
    default:
      return "text";
  }
}

/** Relative Datumswerte wie "today" auflösen. */
export function resolveDateFilter(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const shift = (days: number) => toDateValue(addDays(new Date(), days));
  switch (value) {
    case "today":
      return shift(0);
    case "tomorrow":
      return shift(1);
    case "yesterday":
      return shift(-1);
    case "week_ago":
      return shift(-7);
    case "week_ahead":
      return shift(7);
    case "month_ago": {
      const m = new Date();
      m.setMonth(m.getMonth() - 1);
      return toDateValue(m);
    }
    case "month_ahead": {
      const m = new Date();
      m.setMonth(m.getMonth() + 1);
      return toDateValue(m);
    }
    default:
      return value;
  }
}

function dayOf(v: unknown, type: PropType): string | null {
  if (type === "created_time" || type === "last_edited_time") return typeof v === "number" ? toDateValue(new Date(v)) : null;
  const d = v as { start?: string } | null;
  return d?.start ? toDateValue(parseDateValue(d.start)) : null;
}

function matchRule(db: DatabaseData, row: DatabaseRow, rule: FilterRule): boolean {
  const prop = db.schema.find((p) => p.id === rule.prop);
  if (!prop) return true;
  if (rule.cond === "empty") return isEmpty(db, row, prop);
  if (rule.cond === "not_empty") return !isEmpty(db, row, prop);
  const group = condGroup(prop.type);
  const v = getValue(db, row, prop);
  const fv = rule.value;
  // Unvollständige Filter (ohne Wert) filtern nichts heraus – wie Notion
  if (fv === undefined || fv === null || fv === "") {
    if (group !== "checkbox") return true;
  }
  switch (group) {
    case "checkbox":
      return rule.cond === "checked" ? !!v : !v;
    case "number": {
      const n = typeof v === "number" ? v : Number(sortValue(db, row, prop));
      const x = Number(fv);
      if (v === null || v === undefined || Number.isNaN(n)) return rule.cond === "neq";
      switch (rule.cond) {
        case "eq":
          return n === x;
        case "neq":
          return n !== x;
        case "gt":
          return n > x;
        case "lt":
          return n < x;
        case "gte":
          return n >= x;
        case "lte":
          return n <= x;
      }
      return true;
    }
    case "select":
      return rule.cond === "is" ? v === fv : v !== fv;
    case "multi": {
      const list = Array.isArray(v) ? v : [];
      const has = list.includes(fv);
      return rule.cond === "contains" ? has : !has;
    }
    case "date": {
      const day = dayOf(v, prop.type);
      const target = resolveDateFilter(fv);
      if (!target) return true;
      if (!day) return false;
      switch (rule.cond) {
        case "is":
          return day === target;
        case "before":
          return day < target;
        case "after":
          return day > target;
        case "on_or_before":
          return day <= target;
        case "on_or_after":
          return day >= target;
      }
      return true;
    }
    default: {
      const t = displayText(db, row, prop).toLowerCase();
      const q = String(fv).toLowerCase();
      switch (rule.cond) {
        case "contains":
          return t.includes(q);
        case "not_contains":
          return !t.includes(q);
        case "is":
          return t === q;
        case "is_not":
          return t !== q;
        case "starts":
          return t.startsWith(q);
        case "ends":
          return t.endsWith(q);
      }
      return true;
    }
  }
}

function isGroup(r: FilterRule | FilterGroup): r is FilterGroup {
  return "rules" in r;
}

export function matchFilter(db: DatabaseData, row: DatabaseRow, f: FilterGroup | undefined): boolean {
  if (!f || !f.rules.length) return true;
  const results = f.rules.map((r) => (isGroup(r) ? matchFilter(db, row, r) : matchRule(db, row, r)));
  return f.op === "or" ? results.some(Boolean) : results.every(Boolean);
}

export function sortRows(db: DatabaseData, rows: DatabaseRow[], sorts: SortRule[]): DatabaseRow[] {
  const manual = (a: DatabaseRow, b: DatabaseRow) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);
  const active = sorts.map((s) => ({ s, prop: db.schema.find((p) => p.id === s.prop) })).filter((x) => x.prop);
  if (!active.length) return [...rows].sort(manual);
  // Werte einmal vorberechnen (Formeln können teuer sein)
  const keyed = rows.map((r) => ({ r, keys: active.map((a) => sortValue(db, r, a.prop!)) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < active.length; i++) {
      const a = x.keys[i];
      const b = y.keys[i];
      if (a === b) continue;
      // Leere Werte immer ans Ende
      if (a === null) return 1;
      if (b === null) return -1;
      let c: number;
      if (typeof a === "number" && typeof b === "number") c = a - b;
      else c = String(a).localeCompare(String(b), "de", { numeric: true });
      if (c !== 0) return active[i].s.dir === "desc" ? -c : c;
    }
    return manual(x.r, y.r);
  });
  return keyed.map((k) => k.r);
}

export function searchRows(db: DatabaseData, rows: DatabaseRow[], q: string): DatabaseRow[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => db.schema.some((p) => displayText(db, r, p).toLowerCase().includes(s)));
}

export function visibleRows(db: DatabaseData, view: ViewDef, search = ""): DatabaseRow[] {
  const filtered = db.rows.filter((r) => matchFilter(db, r, view.filter));
  return sortRows(db, searchRows(db, filtered, search), view.sorts);
}

// ---------- Gruppieren ----------

export interface Group {
  key: string;
  label: string;
  color: string;
  rows: DatabaseRow[];
}

export const NO_VALUE = "__none__";

export function groupRows(db: DatabaseData, rows: DatabaseRow[], prop: PropertyDef | undefined): Group[] {
  if (!prop) return [{ key: "all", label: "", color: "default", rows }];
  const groups = new Map<string, Group>();
  const ensure = (key: string, label: string, color = "default") => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label, color, rows: [] }));
    return g;
  };
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    ensure(NO_VALUE, `Ohne ${prop.name}`);
    for (const o of prop.options ?? []) ensure(o.id, o.name, o.color);
    for (const r of rows) {
      const v = getValue(db, r, prop);
      const keys = Array.isArray(v) ? (v.length ? v : [NO_VALUE]) : [v ?? NO_VALUE];
      for (const k of keys) (groups.get(String(k)) ?? ensure(NO_VALUE, `Ohne ${prop.name}`)).rows.push(r);
    }
    // "Keine" zuerst wie in Notion
    return [...groups.values()];
  }
  if (prop.type === "checkbox") {
    ensure("true", "Angehakt");
    ensure("false", "Nicht angehakt");
    for (const r of rows) groups.get(getValue(db, r, prop) ? "true" : "false")!.rows.push(r);
    return [...groups.values()];
  }
  // Zahlen und Daten nach Wert sortieren (nicht nach Beschriftung: sonst „10“ vor „9“, „1. Januar 2027“ vor „7. Oktober 2026“)
  const order = new Map<string, number>();
  for (const r of rows) {
    const t = displayText(db, r, prop);
    ensure(t || NO_VALUE, t || `Ohne ${prop.name}`).rows.push(r);
    const sv = sortableValue(getValue(db, r, prop));
    if (t && sv !== null && !order.has(t)) order.set(t, sv);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === NO_VALUE) return -1;
    if (b.key === NO_VALUE) return 1;
    // Erst alle Gruppen mit Zahl/Datum (nach Wert), dann die übrigen (nach Text) – stets widerspruchsfrei
    const x = order.get(a.key);
    const y = order.get(b.key);
    if (x !== undefined && y !== undefined) return x - y || a.label.localeCompare(b.label, "de", { numeric: true });
    if (x !== undefined || y !== undefined) return x !== undefined ? -1 : 1;
    return a.label.localeCompare(b.label, "de", { numeric: true });
  });
}

/** Zahl für Sortierung: Zahlen direkt, Daten als Zeitpunkt (auch Datumsbereiche über ihren Beginn). */
function sortableValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  const s = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { start?: unknown }).start === "string" ? (v as { start: string }).start : null;
  if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.length === 10 ? s + "T00:00:00" : s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// ---------- Berechnungen (Fußzeile) ----------

export const CALC_LABELS: Record<CalcFn, string> = {
  none: "Keine",
  count: "Alle zählen",
  count_values: "Werte zählen",
  unique: "Eindeutige zählen",
  empty: "Leere zählen",
  not_empty: "Nicht leere zählen",
  percent_empty: "% leer",
  percent_not_empty: "% nicht leer",
  sum: "Summe",
  average: "Durchschnitt",
  median: "Median",
  min: "Minimum",
  max: "Maximum",
  range: "Spanne",
  checked: "Angehakt",
  unchecked: "Nicht angehakt",
  percent_checked: "% angehakt",
  earliest: "Frühestes Datum",
  latest: "Spätestes Datum",
};

export function calcOptions(type: PropType): CalcFn[] {
  const base: CalcFn[] = ["none", "count", "count_values", "unique", "empty", "not_empty", "percent_empty", "percent_not_empty"];
  if (type === "number" || type === "formula" || type === "rollup") return [...base, "sum", "average", "median", "min", "max", "range"];
  if (type === "checkbox") return ["none", "count", "checked", "unchecked", "percent_checked"];
  if (type === "date" || type === "created_time" || type === "last_edited_time") return [...base, "earliest", "latest", "range"];
  return base;
}

export function calculate(db: DatabaseData, rows: DatabaseRow[], prop: PropertyDef, fn: CalcFn): string {
  const n = rows.length;
  const pct = (x: number) => (n ? `${Math.round((x / n) * 1000) / 10} %` : "0 %");
  const empties = () => rows.filter((r) => isEmpty(db, r, prop)).length;
  const nums = () => rows.map((r) => getValue(db, r, prop)).filter((v): v is number => typeof v === "number");
  const times = () => rows.map((r) => sortValue(db, r, prop)).filter((v): v is number => typeof v === "number");
  switch (fn) {
    case "none":
      return "";
    case "count":
      return String(n);
    case "count_values":
      return String(n - empties());
    case "unique":
      return String(new Set(rows.map((r) => displayText(db, r, prop)).filter(Boolean)).size);
    case "empty":
      return String(empties());
    case "not_empty":
      return String(n - empties());
    case "percent_empty":
      return pct(empties());
    case "percent_not_empty":
      return pct(n - empties());
    case "sum":
      return formatNumber(nums().reduce((a, b) => a + b, 0), prop.format);
    case "average": {
      const xs = nums();
      return xs.length ? formatNumber(Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100, prop.format) : "";
    }
    case "median": {
      const m = median(nums());
      return m === null ? "" : formatNumber(m, prop.format);
    }
    case "min": {
      const mm = minMax(nums());
      return mm ? formatNumber(mm.min, prop.format) : "";
    }
    case "max": {
      const mm = minMax(nums());
      return mm ? formatNumber(mm.max, prop.format) : "";
    }
    case "range": {
      if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
        const mm = minMax(times());
        return mm ? `${Math.round((mm.max - mm.min) / 86400000)} Tage` : "";
      }
      const mm = minMax(nums());
      return mm ? formatNumber(mm.max - mm.min, prop.format) : "";
    }
    case "checked":
      return String(rows.filter((r) => !!getValue(db, r, prop)).length);
    case "unchecked":
      return String(rows.filter((r) => !getValue(db, r, prop)).length);
    case "percent_checked":
      return pct(rows.filter((r) => !!getValue(db, r, prop)).length);
    case "earliest": {
      const mm = minMax(times());
      return mm ? new Date(mm.min).toLocaleDateString("de-DE", { dateStyle: "medium" }) : "";
    }
    case "latest": {
      const mm = minMax(times());
      return mm ? new Date(mm.max).toLocaleDateString("de-DE", { dateStyle: "medium" }) : "";
    }
  }
}
