import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { api } from "../api/client";
import type { CreatePageInput, ID, PageMeta, PagePatch } from "../api/types";
import { uuid } from "../lib/id";
import { newSortKey } from "../lib/sortkey";

// ---------- Seiten-Metadaten (für Sidebar, Erwähnungen, Breadcrumbs, Graph) ----------

const [ws, setWs] = createStore<{ pages: Record<ID, PageMeta>; settings: Record<string, string>; loaded: boolean }>({
  pages: {},
  settings: {},
  loaded: false,
});
export { ws };

/** parentId → Kinder-IDs, sortiert nach sortKey. Reagiert nur auf Struktur, nicht auf Titel. */
export const childrenIndex = createRoot(() =>
  createMemo(() => {
    const map = new Map<ID | null, ID[]>();
    for (const id of Object.keys(ws.pages)) {
      const p = ws.pages[id];
      const key = p.parentId;
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(id);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ka = ws.pages[a].sortKey;
        const kb = ws.pages[b].sortKey;
        return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : 1;
      });
    }
    return map;
  }),
);

export function childrenOf(parentId: ID | null): ID[] {
  return childrenIndex().get(parentId) ?? [];
}

export function getPage(id: ID | null | undefined): PageMeta | undefined {
  return id ? ws.pages[id] : undefined;
}

/** Kette von der Wurzel bis zur Seite (für Breadcrumbs). */
export function ancestors(id: ID): PageMeta[] {
  const chain: PageMeta[] = [];
  const seen = new Set<ID>();
  let cur = ws.pages[id];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? ws.pages[cur.parentId] : (undefined as any);
  }
  return chain;
}

export function isDescendant(id: ID, ancestorId: ID): boolean {
  let cur = ws.pages[id];
  const seen = new Set<ID>();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    if (cur.parentId === ancestorId) return true;
    seen.add(cur.id);
    cur = ws.pages[cur.parentId];
  }
  return false;
}

export async function loadWorkspace() {
  const { pages, settings } = await api.bootstrap();
  const map: Record<ID, PageMeta> = {};
  for (const p of pages) map[p.id] = p;
  setWs({ pages: map, settings, loaded: true });
}

export function setPageMeta(id: ID, patch: Partial<PageMeta>) {
  if (!ws.pages[id]) return;
  setWs("pages", id, patch);
}

export function upsertMeta(p: PageMeta) {
  setWs("pages", p.id, reconcile(p));
}

export function removeMetas(ids: ID[]) {
  setWs(
    "pages",
    produce((pages) => {
      for (const id of ids) delete pages[id];
    }),
  );
}

// ---------- Einstellungen ----------

export function setting(key: string): string | undefined {
  return ws.settings[key];
}

export function setSetting(key: string, value: string | null) {
  setWs(
    "settings",
    produce((s) => {
      if (value === null) delete s[key];
      else s[key] = value;
    }),
  );
  void api.setSetting(key, value);
}

export function jsonSetting<T>(key: string, fallback: T): T {
  const raw = ws.settings[key];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------- Seiten-Aktionen ----------

/** Sortierschlüssel für eine neue Seite am Ende (oder nach `afterId`) unter `parentId`. */
export function nextSortKey(parentId: ID | null, afterId?: ID | null): string {
  const siblings = childrenOf(parentId);
  if (afterId) {
    const i = siblings.indexOf(afterId);
    if (i >= 0) {
      const next = siblings[i + 1];
      return newSortKey(ws.pages[afterId].sortKey, next ? ws.pages[next].sortKey : null);
    }
  }
  const last = siblings[siblings.length - 1];
  return newSortKey(last ? ws.pages[last].sortKey : null, null);
}

export async function createPage(input: Partial<CreatePageInput> & { parentId: ID | null }): Promise<PageMeta> {
  const full = await api.createPage({
    id: input.id ?? uuid(),
    sortKey: input.sortKey ?? nextSortKey(input.parentId),
    ...input,
  });
  const { cover: _c, props: _p, content: _ct, settings: _s, deletedAt: _d, ...meta } = full;
  upsertMeta(meta);
  return meta;
}

/** Ändert Metadaten lokal sofort und speichert sie. */
export async function updatePage(id: ID, patch: PagePatch) {
  const local: Partial<PageMeta> = {};
  for (const k of ["title", "icon", "sortKey", "parentId", "databaseId", "favorite", "inline"] as const) {
    if (k in patch) (local as any)[k] = (patch as any)[k];
  }
  if (Object.keys(local).length) setPageMeta(id, local);
  const r = await api.updatePage(id, patch);
  if (ws.pages[id] && r?.updatedAt) setPageMeta(id, { updatedAt: r.updatedAt });
  return r;
}

/** Verschiebt eine Seite. Gibt false zurück, wenn das Ziel nicht erlaubt ist. */
export async function movePage(id: ID, parentId: ID | null, sortKey: string): Promise<boolean> {
  if (id === parentId || (parentId && isDescendant(parentId, id))) return false;
  const p = ws.pages[id];
  if (!p) return false;
  const parent = parentId ? ws.pages[parentId] : undefined;
  // Datenbanken können keine Einträge anderer Datenbanken werden
  if (parent?.kind === "database" && p.kind === "database") return false;
  const databaseId = parent?.kind === "database" ? parent.id : null;
  const patch: PagePatch = { parentId, sortKey, databaseId };
  if (p.databaseId !== databaseId && p.databaseId) {
    // Eigenschaften und Relationen gehören zum alten Schema → verwerfen
    patch.props = {};
    patch.links = { kinds: ["relation"], items: [] };
  }
  const from = p.parentId;
  await updatePage(id, patch);
  emit("moved", { id, parentId, from });
  if (patch.links) emit("links-changed", { id });
  return true;
}

export async function trashPage(id: ID) {
  const parentId = ws.pages[id]?.parentId ?? null;
  const ids = await api.trashPage(id);
  batch(() => {
    removeMetas(ids);
    navigation.onRemoved(new Set(ids));
  });
  emit("trashed", { ids, rootId: id, parentId });
  return ids;
}

/** Mehrere Seiten in einem Schritt in den Papierkorb (z. B. ausgewählte Datenbankzeilen). */
export async function trashPages(rootIds: ID[]) {
  if (!rootIds.length) return [];
  const results = (await api.batch(rootIds.map((id) => ({ method: "page.trash", params: { id } })))) as ID[][];
  const ids = results.flat();
  batch(() => {
    removeMetas(ids);
    navigation.onRemoved(new Set(ids));
  });
  emit("trashed", { ids });
  return ids;
}

/**
 * Holt eine Seite aus dem Papierkorb. `reattach`: ihren Block in der Elternseite wiederherstellen
 * (Papierkorb, „Rückgängig“-Hinweis). Aus dem Editor heraus (Einfügen, ⌘Z) ist der Block schon da.
 */
export async function restorePage(id: ID, opts: { reattach?: boolean } = { reattach: true }) {
  const ids = await api.restorePage(id);
  // Nur die wiederhergestellten Seiten nachladen (ein Aufruf)
  const pages = await api.getPages(ids);
  batch(() => {
    for (const full of pages) {
      const { cover: _c, props: _p, content: _ct, settings: _s, deletedAt: _d, ...meta } = full;
      upsertMeta(meta);
    }
  });
  emit("restored", { ids, rootId: id, reattach: !!opts.reattach });
  return ids;
}

export function toggleFavorite(id: ID) {
  const p = ws.pages[id];
  if (p) void updatePage(id, { favorite: !p.favorite });
}

// ---------- Einfacher Event-Bus ----------

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();

export function on(event: string, h: Handler): () => void {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(h);
  return () => set!.delete(h);
}

export function emit(event: string, data?: unknown) {
  handlers.get(event)?.forEach((h) => h(data));
}

// ---------- Speicherfehler (sichtbar in der Titelleiste) ----------

const [failingSaves, setFailingSaves] = createSignal<ReadonlySet<string>>(new Set());
export { failingSaves };

/** Meldet, ob ein Speichervorgang (z. B. ein Editor) gerade fehlschlägt. */
export function reportSaveState(key: string, failing: boolean) {
  const cur = failingSaves();
  if (cur.has(key) === failing) return;
  const next = new Set(cur);
  if (failing) next.add(key);
  else next.delete(key);
  setFailingSaves(next);
}

// ---------- Laufende Schreibvorgänge ----------

const inflight = new Set<Promise<unknown>>();

/** Merkt sich einen laufenden Schreibvorgang, damit nachfolgende Lesevorgänge darauf warten können. */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  void p.finally(() => inflight.delete(p)).catch(() => undefined);
  return p;
}

/** Wartet auf alle bereits gestarteten Schreibvorgänge (die Bridge arbeitet sie der Reihe nach ab). */
export async function settleWrites() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

// ---------- Ausstehende Speichervorgänge (für sauberes Beenden) ----------

const pending = new Map<string, () => Promise<void> | void>();

export function registerPending(key: string, flush: () => Promise<void> | void) {
  pending.set(key, flush);
}

export function unregisterPending(key: string) {
  pending.delete(key);
}

export async function flushAll() {
  await Promise.all([...pending.values()].map((f) => f()));
  await settleWrites();
}

// ---------- Navigation ----------

export type Route = { kind: "page"; id: ID } | { kind: "graph" } | { kind: "none" };

function createNavigation() {
  const [route, setRoute] = createSignal<Route>({ kind: "none" });
  const [peek, setPeek] = createSignal<ID | null>(null);
  const back: Route[] = [];
  const forward: Route[] = [];
  const [canBack, setCanBack] = createSignal(false);
  const [canForward, setCanForward] = createSignal(false);

  const sync = () => {
    setCanBack(back.length > 0);
    setCanForward(forward.length > 0);
  };

  // Wird vor jedem Seitenwechsel aufgerufen (z. B. um die Scrollposition der alten Seite zu sichern)
  const beforeChange = new Set<(current: Route) => void>();
  const leaving = () => beforeChange.forEach((f) => f(route()));

  const same = (a: Route, b: Route) => a.kind === b.kind && (a.kind !== "page" || a.id === (b as any).id);

  function remember(r: Route) {
    if (r.kind === "page") {
      const recent = jsonSetting<ID[]>("recent", []).filter((x) => x !== r.id);
      recent.unshift(r.id);
      setSetting("recent", JSON.stringify(recent.slice(0, 30)));
      setSetting("lastRoute", JSON.stringify(r));
    } else if (r.kind === "graph") {
      setSetting("lastRoute", JSON.stringify(r));
    }
  }

  function go(r: Route) {
    const cur = route();
    setPeek(null);
    if (same(cur, r)) return;
    leaving();
    if (cur.kind !== "none") back.push(cur);
    if (back.length > 100) back.shift();
    forward.length = 0;
    setRoute(r);
    sync();
    remember(r);
  }

  return {
    route,
    peek,
    canBack,
    canForward,
    go,
    open: (id: ID) => go({ kind: "page", id }),
    replace(r: Route) {
      setRoute(r);
      remember(r);
    },
    back() {
      const r = back.pop();
      if (!r) return;
      leaving();
      forward.push(route());
      setPeek(null);
      setRoute(r);
      sync();
    },
    forward() {
      const r = forward.pop();
      if (!r) return;
      leaving();
      back.push(route());
      setPeek(null);
      setRoute(r);
      sync();
    },
    /** Rückruf vor jedem Seitenwechsel (bekommt die noch aktuelle Route). */
    onBeforeChange(fn: (current: Route) => void) {
      beforeChange.add(fn);
      return () => beforeChange.delete(fn);
    },
    /** Vorschau öffnen – nie für die bereits offene Hauptseite (sonst zwei Editoren auf derselben Seite). */
    setPeek(id: ID | null) {
      const cur = route();
      setPeek(id && cur.kind === "page" && cur.id === id ? null : id);
    },
    onRemoved(ids: Set<ID>) {
      const keep = (r: Route) => r.kind !== "page" || !ids.has(r.id);
      const filteredBack = back.filter(keep);
      back.length = 0;
      back.push(...filteredBack);
      const filteredFwd = forward.filter(keep);
      forward.length = 0;
      forward.push(...filteredFwd);
      const p = peek();
      if (p && ids.has(p)) setPeek(null);
      const cur = route();
      if (!keep(cur)) {
        const prev = back.pop();
        setRoute(prev ?? { kind: "none" });
      }
      sync();
    },
  };
}

export const navigation = createRoot(createNavigation);
