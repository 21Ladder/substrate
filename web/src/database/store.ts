import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../api/client";
import type { DatabaseData, DatabaseRow, ID, LinkItem, PropertyDef, ViewDef } from "../api/types";
import { newSortKey } from "../lib/sortkey";
import { createPage, emit, on, trashPages, updatePage, ws } from "../state/workspace";

// Zwischenspeicher geladener Datenbanken (Schema, Ansichten, Zeilen).

const [dbs, setDbs] = createStore<Record<ID, DatabaseData>>({});
const loading = new Map<ID, Promise<void>>();
const failedAt = new Map<ID, number>();
/** Lokale Änderungen je Datenbank; Ladeantworten von davor werden verworfen und neu angefordert. */
const localVersion = new Map<ID, number>();
const bump = (id: ID) => localVersion.set(id, (localVersion.get(id) ?? 0) + 1);

export { dbs };

export function loadDatabase(id: ID, force = false): Promise<void> {
  if (!force && dbs[id]) return Promise.resolve();
  const existing = loading.get(id);
  if (existing && !force) return existing;
  const startVersion = localVersion.get(id) ?? 0;
  const p = api
    .getDatabase(id)
    .then((d) => {
      if ((localVersion.get(id) ?? 0) !== startVersion) {
        // Während des Ladens lokal geändert: Antwort ist veraltet → neu laden
        loading.delete(id);
        return loadDatabase(id, true);
      }
      if (d) setDbs(id, d);
    })
    .catch((e) => {
      failedAt.set(id, Date.now());
      console.error("Datenbank konnte nicht geladen werden", e);
    })
    .finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

export function getDatabase(id: ID): DatabaseData | undefined {
  // Nach einem Fehler höchstens alle 5 s erneut versuchen
  if (!dbs[id] && !loading.has(id) && Date.now() - (failedAt.get(id) ?? 0) > 5000) void loadDatabase(id);
  return dbs[id];
}

export function rowById(dbId: ID, rowId: ID): DatabaseRow | undefined {
  return dbs[dbId]?.rows.find((r) => r.id === rowId);
}

/** Datenbank, zu der eine Seite als Zeile gehört. */
export function databaseOfRow(rowId: ID): ID | null {
  return ws.pages[rowId]?.databaseId ?? null;
}

export function relationLinks(schema: PropertyDef[], props: Record<string, unknown>): LinkItem[] {
  const items: LinkItem[] = [];
  for (const p of schema) {
    if (p.type !== "relation") continue;
    const v = props[p.id];
    if (Array.isArray(v)) for (const dst of v) if (typeof dst === "string") items.push({ dst, kind: "relation", prop: p.id });
  }
  return items;
}

// Jede lokale Änderung erhöht die Version: eine vorher gestartete Ladeantwort ist dann veraltet
// und wird verworfen (sonst überschreibt sie die frische Änderung).
export async function updateSchema(dbId: ID, schema: PropertyDef[]) {
  bump(dbId);
  setDbs(dbId, "schema", schema);
  await api.updateDatabase(dbId, { schema: JSON.parse(JSON.stringify(schema)) });
}

export async function updateViews(dbId: ID, views: ViewDef[]) {
  bump(dbId);
  setDbs(dbId, "views", views);
  await api.updateDatabase(dbId, { views: JSON.parse(JSON.stringify(views)) });
}

export function updateView(dbId: ID, viewId: string, patch: Partial<ViewDef>) {
  const d = dbs[dbId];
  if (!d) return;
  const views = d.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v));
  void updateViews(dbId, views);
}

export async function addRow(
  dbId: ID,
  opts: { title?: string; props?: Record<string, unknown>; after?: ID | null; before?: ID | null; atStart?: boolean } = {},
): Promise<DatabaseRow | null> {
  await loadDatabase(dbId);
  const d = dbs[dbId];
  if (!d) return null;
  const rows = [...d.rows].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  let sortKey: string;
  if (opts.after) {
    const i = rows.findIndex((r) => r.id === opts.after);
    sortKey = newSortKey(rows[i]?.sortKey, rows[i + 1]?.sortKey);
  } else if (opts.before) {
    const i = rows.findIndex((r) => r.id === opts.before);
    sortKey = newSortKey(rows[i - 1]?.sortKey, rows[i]?.sortKey);
  } else if (opts.atStart) {
    sortKey = newSortKey(null, rows[0]?.sortKey);
  } else {
    sortKey = newSortKey(rows[rows.length - 1]?.sortKey, null);
  }
  const props: Record<string, unknown> = { ...(opts.props ?? {}) };
  Object.assign(props, await takeUniqueIds(dbId));
  const meta = await createPage({
    parentId: dbId,
    databaseId: dbId,
    title: opts.title ?? "",
    sortKey,
    props,
    links: { kinds: ["relation"], items: relationLinks(d.schema, props) },
  });
  const row: DatabaseRow = { id: meta.id, title: meta.title, icon: null, cover: null, props, sortKey, createdAt: meta.createdAt, updatedAt: meta.updatedAt };
  bump(dbId);
  setDbs(dbId, "rows", (r) => [...r, row]);
  // Zweiseitige Relationen der neuen Zeile nachziehen
  for (const p of d.schema) {
    if (p.type === "relation" && Array.isArray(props[p.id]) && (props[p.id] as ID[]).length) {
      await syncReverse(row.id, p, [], props[p.id] as ID[]);
    }
  }
  return row;
}

/** Setzt Eigenschaftswerte einer Zeile; zweiseitige Relationen werden synchron gehalten. */
export async function setRowProps(dbId: ID, rowId: ID, patch: Record<string, unknown>, opts: { skipReverse?: boolean } = {}) {
  await loadDatabase(dbId);
  const d = dbs[dbId];
  const row = d?.rows.find((r) => r.id === rowId);
  if (!d || !row) return;
  const before = { ...row.props };
  const props = { ...row.props, ...patch };
  const mergePatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) {
      delete props[k];
      mergePatch[k] = null;
    } else mergePatch[k] = v;
  }
  bump(dbId);
  const now = Date.now();
  setDbs(
    dbId,
    "rows",
    (r) => r.id === rowId,
    produce((r: DatabaseRow) => {
      r.props = props;
      r.updatedAt = now;
    }),
  );
  const touchesRelation = d.schema.some((p) => p.type === "relation" && p.id in patch);
  // Nur die geänderten Schlüssel senden; SQLite führt sie zusammen (keine verlorenen Änderungen)
  await updatePage(rowId, {
    propsPatch: mergePatch,
    ...(touchesRelation ? { links: { kinds: ["relation"], items: relationLinks(d.schema, props) } } : {}),
  });
  if (touchesRelation) emit("links-changed", { id: rowId });
  if (!opts.skipReverse) {
    for (const p of d.schema) {
      if (p.type !== "relation" || !(p.id in patch)) continue;
      await syncReverse(rowId, p, (before[p.id] as ID[]) ?? [], (props[p.id] as ID[]) ?? []);
    }
  }
}

/** Vergibt für alle ID-Eigenschaften die nächste Nummer (Zähler im Schema, keine Wiederverwendung). */
export async function takeUniqueIds(dbId: ID): Promise<Record<string, number>> {
  const d = dbs[dbId];
  if (!d) return {};
  const out: Record<string, number> = {};
  let changed = false;
  const schema = d.schema.map((p) => {
    if (p.type !== "unique_id") return p;
    const max = d.rows.reduce((m, r) => Math.max(m, Number(r.props[p.id]) || 0), 0);
    const n = Math.max(p.nextId ?? 1, max + 1);
    out[p.id] = n;
    changed = true;
    return { ...p, nextId: n + 1 };
  });
  if (changed) await updateSchema(dbId, schema);
  return out;
}

/** Gegenrichtung aller Relationen einer Zeile nachziehen (z. B. nach dem Duplizieren). */
export async function syncAllReverse(dbId: ID, rowId: ID) {
  const d = dbs[dbId];
  const row = d?.rows.find((r) => r.id === rowId);
  if (!d || !row) return;
  for (const p of d.schema) {
    const v = row.props[p.id];
    if (p.type === "relation" && Array.isArray(v) && v.length) await syncReverse(rowId, p, [], v as ID[]);
  }
}

/** Relations-Links aller Zeilen neu schreiben (nach Schemaänderungen an Relationen). */
export async function rebuildRelationLinks(dbId: ID) {
  const d = dbs[dbId];
  if (!d) return;
  const ops = d.rows.map((r) => ({
    method: "page.update",
    params: { id: r.id, patch: { links: { kinds: ["relation"], items: relationLinks(d.schema, r.props) } } },
  }));
  for (let i = 0; i < ops.length; i += 500) await api.batch(ops.slice(i, i + 500));
  emit("links-changed", { id: dbId });
}

/** Entfernt die Gegen-Eigenschaft einer zweiseitigen Relation samt Werten und Links. */
export async function dropReverseRelation(prop: PropertyDef) {
  const target = prop.relation?.databaseId;
  const rev = prop.relation?.reverseProp;
  if (!target || !rev) return;
  await loadDatabase(target);
  const td = dbs[target];
  if (!td || !td.schema.some((p) => p.id === rev)) return;
  const schema = td.schema.filter((p) => p.id !== rev);
  await updateSchema(target, schema);
  const ops = td.rows
    .filter((r) => rev in r.props)
    .map((r) => {
      const props = { ...r.props };
      delete props[rev];
      return { method: "page.update", params: { id: r.id, patch: { props: JSON.stringify(props) } } };
    });
  for (let i = 0; i < ops.length; i += 500) await api.batch(ops.slice(i, i + 500));
  await loadDatabase(target, true);
  await rebuildRelationLinks(target);
}

async function syncReverse(rowId: ID, prop: PropertyDef, before: ID[], after: ID[]) {
  const target = prop.relation?.databaseId;
  const reverse = prop.relation?.reverseProp;
  if (!target || !reverse) return;
  await loadDatabase(target);
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  for (const id of added) {
    const r = rowById(target, id);
    if (!r) continue;
    const cur = (r.props[reverse] as ID[]) ?? [];
    if (!cur.includes(rowId)) await setRowProps(target, id, { [reverse]: [...cur, rowId] }, { skipReverse: true });
  }
  for (const id of removed) {
    const r = rowById(target, id);
    if (!r) continue;
    const cur = (r.props[reverse] as ID[]) ?? [];
    if (cur.includes(rowId)) await setRowProps(target, id, { [reverse]: cur.filter((x) => x !== rowId) }, { skipReverse: true });
  }
}

export async function setRowTitle(dbId: ID, rowId: ID, title: string) {
  bump(dbId);
  setDbs(dbId, "rows", (r) => r.id === rowId, "title", title);
  await updatePage(rowId, { title });
}

export async function setRowSortKey(dbId: ID, rowId: ID, sortKey: string) {
  bump(dbId);
  setDbs(dbId, "rows", (r) => r.id === rowId, "sortKey", sortKey);
  await updatePage(rowId, { sortKey });
}

export async function deleteRows(ids: ID[]) {
  await trashPages(ids);
}

export function patchRowLocal(dbId: ID, rowId: ID, patch: Partial<DatabaseRow>) {
  if (!dbs[dbId]) return;
  setDbs(dbId, "rows", (r) => r.id === rowId, patch);
}

// Änderungen aus anderen Teilen der App übernehmen
on("trashed", ({ ids }: { ids: ID[] }) => {
  const set = new Set(ids);
  batch(() => {
    for (const dbId of Object.keys(dbs)) {
      if (set.has(dbId)) {
        setDbs(produce((s) => void delete s[dbId]));
        continue;
      }
      if (dbs[dbId].rows.some((r) => set.has(r.id))) setDbs(dbId, "rows", (rows) => rows.filter((r) => !set.has(r.id)));
    }
  });
});

on("restored", ({ ids }: { ids: ID[] }) => {
  const affected = new Set<ID>();
  for (const id of ids) {
    const dbId = ws.pages[id]?.databaseId;
    if (dbId && dbs[dbId]) affected.add(dbId);
  }
  for (const dbId of affected) void loadDatabase(dbId, true);
});

on("moved", ({ id }: { id: ID }) => {
  for (const dbId of Object.keys(dbs)) {
    if (dbs[dbId].rows.some((r) => r.id === id) || ws.pages[id]?.databaseId === dbId) void loadDatabase(dbId, true);
  }
});

on("page-props", ({ id, cover, icon }: { id: ID; cover?: string | null; icon?: string | null }) => {
  const dbId = ws.pages[id]?.databaseId;
  if (!dbId || !dbs[dbId]) return;
  const patch: Partial<DatabaseRow> = {};
  if (cover !== undefined) patch.cover = cover;
  if (icon !== undefined) patch.icon = icon;
  patchRowLocal(dbId, id, patch);
});
