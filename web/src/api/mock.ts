// Speicher-Backend für die Entwicklung im Browser (ohne macOS-App).
// Bildet das Verhalten von Store.swift nach und speichert in localStorage.

interface Row {
  id: string;
  parentId: string | null;
  databaseId: string | null;
  kind: string;
  title: string;
  icon: string | null;
  cover: string | null;
  sortKey: string;
  favorite: number;
  inline: number;
  props: string;
  content: string | null;
  settings: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  trashRoot: number;
  text: string;
}

interface State {
  pages: Record<string, Row>;
  databases: Record<string, { schema: string; views: string }>;
  links: { src: string; dst: string; kind: string; prop: string }[];
  history: { id: number; pageId: string; createdAt: number; title: string; content: string | null }[];
  layouts: Record<string, string>;
  settings: Record<string, string>;
  seq: number;
}

const KEY = "substrat-mock-v1";
let state: State = load();
let saveTimer: number | undefined;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignorieren */
  }
  return { pages: {}, databases: {}, links: [], history: [], layouts: {}, settings: {}, seq: 1 };
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* Speicher voll – im Mock egal */
    }
  }, 200);
}

const meta = (r: Row) => ({
  id: r.id,
  parentId: r.parentId,
  databaseId: r.databaseId,
  kind: r.kind,
  title: r.title,
  icon: r.icon,
  sortKey: r.sortKey,
  favorite: r.favorite,
  inline: r.inline,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const full = (r: Row) => ({ ...meta(r), cover: r.cover, props: r.props, content: r.content, settings: r.settings, deletedAt: r.deletedAt });

const byKey = (a: Row, b: Row) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1);

function subtree(id: string, deletedAt: number | null): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const p of Object.values(state.pages)) {
      if (p.parentId === out[i] && p.deletedAt === deletedAt && !(deletedAt !== null && p.trashRoot) && !out.includes(p.id)) out.push(p.id);
    }
  }
  return out;
}

function replaceLinks(src: string, links: any) {
  if (!links) return;
  const kinds: string[] = links.kinds ?? [];
  state.links = state.links.filter((l) => !(l.src === src && kinds.includes(l.kind)));
  for (const it of links.items ?? []) {
    if (it.dst === src) continue;
    const prop = it.prop ?? "";
    if (!state.links.some((l) => l.src === src && l.dst === it.dst && l.kind === it.kind && l.prop === prop)) {
      state.links.push({ src, dst: it.dst, kind: it.kind, prop });
    }
  }
}

function norm(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

const handlers: Record<string, (p: any) => unknown> = {
  bootstrap: () => ({
    pages: Object.values(state.pages).filter((p) => p.deletedAt === null).sort(byKey).map(meta),
    settings: state.settings,
  }),
  "page.get": ({ id }) => (state.pages[id] ? full(state.pages[id]) : null),
  "page.getMany": ({ ids }) => (ids as string[]).filter((id) => state.pages[id]).map((id) => full(state.pages[id])),
  "page.create": (p) => {
    if (state.pages[p.id]) throw new Error("UNIQUE constraint failed: pages.id");
    const now = Date.now();
    const row: Row = {
      id: p.id,
      parentId: p.parentId ?? null,
      databaseId: p.databaseId ?? null,
      kind: p.kind ?? "page",
      title: p.title ?? "",
      icon: p.icon ?? null,
      cover: p.cover ?? null,
      sortKey: p.sortKey ?? "",
      favorite: 0,
      inline: p.inline ? 1 : 0,
      props: p.props ?? "{}",
      content: p.content ?? null,
      settings: p.settings ?? "{}",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      trashRoot: 0,
      text: p.text ?? "",
    };
    state.pages[p.id] = row;
    if (row.kind === "database") state.databases[p.id] = { schema: p.schema ?? "[]", views: p.views ?? "[]" };
    replaceLinks(p.id, p.links);
    return full(row);
  },
  "page.update": ({ id, patch }) => {
    const r = state.pages[id];
    if (!r) throw new Error(`Seite ${id} nicht gefunden`);
    const touch = ["title", "icon", "cover", "props", "content"].some((k) => k in patch);
    const now = Date.now();
    if ("content" in patch && r.content !== null) {
      // Wie Store.swift: bisherigen Inhalt vor dem Überschreiben sichern
      const last = state.history.filter((h) => h.pageId === id).reduce((m, h) => Math.max(m, h.createdAt), 0);
      if (patch.snapshot || now - last >= 10 * 60 * 1000) {
        state.history.push({ id: state.seq++, pageId: id, createdAt: now, title: r.title, content: r.content });
      }
    }
    for (const k of ["title", "icon", "cover", "props", "content", "settings", "sortKey", "parentId", "databaseId"]) {
      if (k in patch) (r as any)[k] = patch[k];
    }
    if (typeof patch.propsPatch === "string") {
      const cur = JSON.parse(r.props || "{}");
      for (const [k, v] of Object.entries(JSON.parse(patch.propsPatch))) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
      r.props = JSON.stringify(cur);
      r.updatedAt = now;
    }
    if ("favorite" in patch) r.favorite = patch.favorite ? 1 : 0;
    if ("inline" in patch) r.inline = patch.inline ? 1 : 0;
    if (typeof patch.text === "string") r.text = patch.text;
    replaceLinks(id, patch.links);
    if (touch) r.updatedAt = now;
    return { id, updatedAt: r.updatedAt };
  },
  "page.trash": ({ id }) => {
    const now = Date.now();
    const ids = subtree(id, null);
    for (const sid of ids) {
      state.pages[sid].deletedAt = now;
      state.pages[sid].trashRoot = sid === id ? 1 : 0;
    }
    return ids;
  },
  "page.restore": ({ id }) => {
    const r = state.pages[id];
    if (!r || r.deletedAt === null) return [];
    const ids = subtree(id, r.deletedAt);
    for (const sid of ids) {
      state.pages[sid].deletedAt = null;
      state.pages[sid].trashRoot = 0;
    }
    const parent = r.parentId ? state.pages[r.parentId] : null;
    if (r.parentId && (!parent || parent.deletedAt !== null)) {
      r.parentId = null;
      r.databaseId = null;
    }
    return ids;
  },
  "page.purge": ({ id }) => {
    // Wie die App: bereits entfernte Seite = nichts zu tun; lebende Seiten sind geschützt
    if (!state.pages[id]) return null;
    if (state.pages[id].deletedAt === null) throw new Error("Nur Seiten im Papierkorb können endgültig gelöscht werden.");
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const p of Object.values(state.pages)) if (p.parentId === ids[i] && !ids.includes(p.id)) ids.push(p.id);
    }
    for (const sid of ids) {
      delete state.pages[sid];
      delete state.databases[sid];
    }
    state.links = state.links.filter((l) => !ids.includes(l.src) && !ids.includes(l.dst));
    state.history = state.history.filter((h) => !ids.includes(h.pageId));
    return null;
  },
  "trash.list": () =>
    Object.values(state.pages)
      .filter((p) => p.deletedAt !== null && p.trashRoot)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, parentId: p.parentId, deletedAt: p.deletedAt })),
  "db.get": ({ id }) => {
    const d = state.databases[id];
    if (!d) return null;
    const rows = Object.values(state.pages)
      .filter((p) => p.databaseId === id && p.deletedAt === null)
      .sort(byKey)
      .map((p) => ({ id: p.id, title: p.title, icon: p.icon, cover: p.cover, props: p.props, sortKey: p.sortKey, createdAt: p.createdAt, updatedAt: p.updatedAt }));
    return { id, schema: d.schema, views: d.views, rows };
  },
  "db.update": ({ id, patch }) => {
    const d = state.databases[id];
    if (!d) throw new Error("Datenbank nicht gefunden");
    if (patch.schema) d.schema = patch.schema;
    if (patch.views) d.views = patch.views;
    return null;
  },
  search: ({ query, limit }) => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out: any[] = [];
    for (const p of Object.values(state.pages)) {
      if (p.deletedAt !== null) continue;
      const t = norm(p.title);
      const b = norm(p.text);
      if (!words.every((w) => t.includes(w) || b.includes(w))) continue;
      let snippet = "";
      const i = b.indexOf(words[0]);
      if (i >= 0) {
        const s = Math.max(0, i - 40);
        const raw = p.text.slice(s, i + 60);
        const j = i - s;
        snippet = (s > 0 ? "…" : "") + raw.slice(0, j) + "\u0001" + raw.slice(j, j + words[0].length) + "\u0002" + raw.slice(j + words[0].length) + "…";
      }
      out.push({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, parentId: p.parentId, databaseId: p.databaseId, updatedAt: p.updatedAt, snippet, score: t.includes(words[0]) ? 0 : 1 });
    }
    return out.sort((a, b) => a.score - b.score || b.updatedAt - a.updatedAt).slice(0, limit ?? 30);
  },
  backlinks: ({ id }) => {
    const ids = new Set(state.links.filter((l) => l.dst === id && l.kind === "mention").map((l) => l.src));
    return [...ids]
      .map((s) => state.pages[s])
      .filter((p) => p && p.deletedAt === null)
      .map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind }));
  },
  "graph.edges": () =>
    state.links.filter((l) => state.pages[l.src]?.deletedAt === null && state.pages[l.dst]?.deletedAt === null),
  "history.list": ({ pageId }) =>
    state.history
      .filter((h) => h.pageId === pageId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((h) => ({ id: h.id, createdAt: h.createdAt, title: h.title })),
  "history.get": ({ id }) => state.history.find((h) => h.id === id) ?? null,
  "settings.set": ({ key, value }) => {
    if (value === null || value === undefined) delete state.settings[key];
    else state.settings[key] = value;
    return null;
  },
  "layout.get": ({ scope }) => state.layouts[scope] ?? null,
  "layout.save": ({ scope, data }) => {
    state.layouts[scope] = data;
    return null;
  },
  "asset.save": ({ data, ext }) => {
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { url: `data:${mime};base64,${data}` };
  },
  batch: ({ ops }) => {
    const snapshot = JSON.stringify(state);
    try {
      return ops.map((op: any) => handlers[op.method](op.params ?? {}));
    } catch (e) {
      state = JSON.parse(snapshot);
      throw e;
    }
  },
  "window.drag": () => null,
  "window.zoom": () => null,
  "app.openURL": ({ url }) => {
    window.open(url, "_blank", "noopener");
    return null;
  },
  "export.save": ({ name, content }) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    a.download = name;
    a.click();
    return true;
  },
  "export.saveFiles": ({ files }) => {
    console.info("[mock] export", files.length, "Dateien");
    return true;
  },
  "import.pick": () => ({ files: [], warnings: [] }),
  "asset.fetch": ({ url }) => ({ url }),
  "backup.now": () => ({ file: "" }),
  "backup.reveal": () => null,
  // Im Browser gibt es keinen MCP-Server
  "mcp.status": () => ({ ...mcp }),
  "mcp.setEnabled": ({ enabled }) => Object.assign(mcp, { enabled, state: "failed", error: "Nur in der macOS-App verfügbar" }),
  "mcp.rotateToken": () => ({ ...mcp }),
  "mcp.setPort": ({ port }) => Object.assign(mcp, { port }),
};

const mcp = { enabled: false, port: 47321, token: "", state: "off" };

export async function mockCall(method: string, params: any): Promise<unknown> {
  const h = handlers[method];
  if (!h) throw new Error(`Unbekannte Methode: ${method}`);
  const result = h(params);
  persist();
  // Wie die echte Bridge: Ergebnis kopieren, damit niemand den internen Zustand verändert.
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

export function resetMock() {
  state = { pages: {}, databases: {}, links: [], history: [], layouts: {}, settings: {}, seq: 1 };
  localStorage.removeItem(KEY);
}
