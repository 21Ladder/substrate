import type {
  CreatePageInput,
  DatabaseData,
  DocJSON,
  Edge,
  HistoryItem,
  ID,
  ImportFile,
  PageFull,
  PageMeta,
  PagePatch,
  PropertyDef,
  SearchResult,
  TrashItem,
  ViewDef,
} from "./types";
import { extOf, fileToBase64 } from "../lib/util";
import type { McpStatus } from "../lib/mcp";

interface NativeBridge {
  postMessage(msg: { method: string; params: unknown }): Promise<unknown>;
}

export interface PickedFile {
  url: string;
  name: string;
  mime: string;
  size: number;
}

const MAX_INLINE_UPLOAD = 100 * 1024 * 1024;

/** Fehlermeldungen der Dateiauswahl (wird von der Oberfläche gesetzt, um Hinweise anzuzeigen). */
let pickErrors: (errors: string[]) => void = () => undefined;
export function onPickErrors(fn: (errors: string[]) => void) {
  pickErrors = fn;
}

const native: NativeBridge | undefined = (window as any).webkit?.messageHandlers?.bridge;
export const isNative = !!native;

/** Methoden, die Daten verändern – ihr Erfolg/Misserfolg wird für den Hinweis „Nicht gespeichert“ gemeldet. */
const WRITE_METHODS = new Set(["page.create", "page.update", "page.trash", "page.restore", "page.purge", "db.update", "batch", "settings.set", "layout.save", "asset.save"]);
let writeState: (method: string, ok: boolean, error?: unknown) => void = () => undefined;
export function onWriteState(fn: (method: string, ok: boolean, error?: unknown) => void) {
  writeState = fn;
}

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!WRITE_METHODS.has(method)) return rawCall<T>(method, params);
  try {
    const r = await rawCall<T>(method, params);
    writeState(method, true);
    return r;
  } catch (e) {
    writeState(method, false, e);
    throw e;
  }
}

async function rawCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  // JSON-Roundtrip entfernt undefined-Werte und Prototypen (Solid-Proxies).
  const clean = JSON.parse(JSON.stringify(params));
  if (native) return (await native.postMessage({ method, params: clean })) as T;
  // Browser-Entwicklung ohne macOS-App: Speicher-Attrappe (im Release-Build nicht enthalten)
  if (import.meta.env.DEV) {
    const { mockCall } = await import("./mock");
    return (await mockCall(method, clean)) as T;
  }
  throw new Error("Substrat läuft nur in der macOS-App.");
}

// ---------- Normalisierung der Rohdaten aus SQLite ----------

function parseJSON<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function normalizeMeta(r: any): PageMeta {
  return {
    id: r.id,
    parentId: r.parentId ?? null,
    databaseId: r.databaseId ?? null,
    kind: r.kind === "database" ? "database" : "page",
    title: r.title ?? "",
    icon: r.icon ?? null,
    sortKey: r.sortKey ?? "",
    favorite: !!r.favorite,
    inline: !!r.inline,
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? 0,
  };
}

function normalizeFull(r: any): PageFull {
  return {
    ...normalizeMeta(r),
    cover: r.cover ?? null,
    props: parseJSON(r.props, {}),
    content: parseJSON<DocJSON | null>(r.content, null),
    settings: parseJSON(r.settings, {}),
    deletedAt: r.deletedAt ?? null,
  };
}

function serializePatch(p: PagePatch | CreatePageInput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if ("props" in p && p.props !== undefined) out.props = JSON.stringify(p.props);
  if ("propsPatch" in p && p.propsPatch !== undefined) out.propsPatch = JSON.stringify(p.propsPatch);
  if ("content" in p && p.content !== undefined) out.content = p.content === null ? null : JSON.stringify(p.content);
  if ("settings" in p && p.settings !== undefined) out.settings = JSON.stringify(p.settings);
  if ("schema" in p && p.schema !== undefined) out.schema = JSON.stringify(p.schema);
  if ("views" in p && p.views !== undefined) out.views = JSON.stringify(p.views);
  return out;
}

export const api = {
  async bootstrap(): Promise<{ pages: PageMeta[]; settings: Record<string, string> }> {
    const r = await call<any>("bootstrap");
    return { pages: (r.pages as any[]).map(normalizeMeta), settings: r.settings ?? {} };
  },
  async getPage(id: ID): Promise<PageFull | null> {
    const r = await call<any>("page.get", { id });
    return r ? normalizeFull(r) : null;
  },
  async getPages(ids: ID[]): Promise<PageFull[]> {
    const out: PageFull[] = [];
    // In Paketen, damit einzelne Antworten nicht riesig werden
    for (let i = 0; i < ids.length; i += 200) {
      const r = await call<any[]>("page.getMany", { ids: ids.slice(i, i + 200) });
      out.push(...r.map(normalizeFull));
    }
    return out;
  },
  async createPage(input: CreatePageInput): Promise<PageFull> {
    return normalizeFull(await call<any>("page.create", serializePatch(input)));
  },
  async updatePage(id: ID, patch: PagePatch): Promise<{ updatedAt: number }> {
    return call("page.update", { id, patch: serializePatch(patch) });
  },
  trashPage: (id: ID) => call<ID[]>("page.trash", { id }),
  restorePage: (id: ID) => call<ID[]>("page.restore", { id }),
  purgePage: (id: ID) => call<null>("page.purge", { id }),
  listTrash: () => call<TrashItem[]>("trash.list"),
  async getDatabase(id: ID): Promise<DatabaseData | null> {
    const r = await call<any>("db.get", { id });
    if (!r) return null;
    return {
      id: r.id,
      schema: parseJSON<PropertyDef[]>(r.schema, []),
      views: parseJSON<ViewDef[]>(r.views, []),
      rows: (r.rows as any[]).map((row) => ({
        id: row.id,
        title: row.title ?? "",
        icon: row.icon ?? null,
        cover: row.cover ?? null,
        props: parseJSON(row.props, {}),
        sortKey: row.sortKey ?? "",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  },
  updateDatabase(id: ID, patch: { schema?: PropertyDef[]; views?: ViewDef[] }) {
    return call<null>("db.update", {
      id,
      patch: {
        ...(patch.schema ? { schema: JSON.stringify(patch.schema) } : {}),
        ...(patch.views ? { views: JSON.stringify(patch.views) } : {}),
      },
    });
  },
  search: (query: string, limit = 30) => call<SearchResult[]>("search", { query, limit }),
  backlinks: (id: ID) => call<{ id: ID; title: string; icon: string | null; kind: string }[]>("backlinks", { id }),
  graphEdges: () => call<Edge[]>("graph.edges"),
  history: (pageId: ID) => call<HistoryItem[]>("history.list", { pageId }),
  async historyEntry(id: number): Promise<{ content: DocJSON | null; title: string; createdAt: number } | null> {
    const r = await call<any>("history.get", { id });
    return r ? { content: parseJSON(r.content, null), title: r.title, createdAt: r.createdAt } : null;
  },
  setSetting: (key: string, value: string | null) => call<null>("settings.set", { key, value }),
  getLayout: (scope: string) => call<string | null>("layout.get", { scope }),
  saveLayout: (scope: string, data: string) => call<null>("layout.save", { scope, data }),
  saveAsset: (data: string, ext: string) => call<{ url: string }>("asset.save", { data, ext }),
  /** Eingefügte/gezogene Datei als Anhang speichern (inhaltsadressiert, max. 100 MB). */
  async uploadFile(file: File): Promise<{ url: string }> {
    if (file.size > MAX_INLINE_UPLOAD) throw new Error(`„${file.name}“ ist zu groß zum Einfügen (max. 100 MB). Bitte über „Datei hochladen“ wählen.`);
    return call<{ url: string }>("asset.save", { data: await fileToBase64(file), ext: extOf(file) });
  },
  /**
   * Dateien über den Auswahldialog wählen und als Anhang speichern. Nativ kopiert Swift die Datei direkt
   * (kein Umweg über den Arbeitsspeicher der Oberfläche); im Browser-Dev-Modus über ein Dateifeld.
   */
  async pickFiles(opts: { kind?: "image" | "any"; multiple?: boolean } = {}): Promise<PickedFile[]> {
    if (native) {
      const r = await call<any>("asset.pick", { kind: opts.kind ?? "any", multiple: !!opts.multiple });
      for (const e of r?.errors ?? []) console.warn(e);
      if (r?.errors?.length) pickErrors(r.errors);
      return (r?.files ?? []) as PickedFile[];
    }
    const files = await new Promise<File[]>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = !!opts.multiple;
      if (opts.kind === "image") input.accept = "image/*";
      let settled = false;
      const done = (list: File[]) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        resolve(list);
      };
      // Abbrechen: "cancel"-Ereignis bzw. Fokus kehrt ohne Auswahl zurück
      const onFocus = () => setTimeout(() => done(Array.from(input.files ?? [])), 500);
      input.onchange = () => done(Array.from(input.files ?? []));
      input.addEventListener("cancel", () => done([]));
      window.addEventListener("focus", onFocus);
      input.click();
    });
    const out: PickedFile[] = [];
    for (const f of files) out.push({ url: (await this.uploadFile(f)).url, name: f.name, mime: f.type, size: f.size });
    return out;
  },
  batch: (ops: { method: string; params: Record<string, unknown> }[]) => call<unknown[]>("batch", { ops }),
  /** Für Batch-Aufrufe: serialisierte Parameter für page.create. */
  createParams: (input: CreatePageInput) => serializePatch(input),
  // App-Funktionen (nur nativ sinnvoll)
  windowDrag: () => call<null>("window.drag"),
  windowZoom: () => call<null>("window.zoom"),
  openURL: (url: string) => call<null>("app.openURL", { url }),
  exportFile: (name: string, content: string) => call<boolean>("export.save", { name, content }),
  exportFiles: (folder: string, files: { path: string; content?: string; asset?: string }[]) =>
    call<boolean>("export.saveFiles", { folder, files }),
  backupNow: () => call<{ file: string }>("backup.now"),
  revealBackups: () => call<null>("backup.reveal"),
  async pickImport(): Promise<{ files: ImportFile[]; warnings: string[] }> {
    const r = await call<any>("import.pick");
    // Abbruch liefert eine leere Liste
    if (Array.isArray(r)) return { files: r, warnings: [] };
    return { files: r?.files ?? [], warnings: r?.warnings ?? [] };
  },
  // Claude-Zugriff (MCP)
  mcpStatus: () => call<McpStatus>("mcp.status"),
  mcpSetEnabled: (enabled: boolean) => call<McpStatus>("mcp.setEnabled", { enabled }),
  mcpRotateToken: () => call<McpStatus>("mcp.rotateToken"),
  mcpSetPort: (port: number) => call<McpStatus>("mcp.setPort", { port }),
  /** Externes Medium einmalig herunterladen und lokal speichern (nur nach Klick des Benutzers). */
  fetchAsset: (url: string) => call<{ url: string }>("asset.fetch", { url }),
};
