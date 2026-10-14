import { createSignal } from "solid-js";
import { Node as PMNode } from "prosemirror-model";
import { api } from "../api/client";
import type { DatabaseData, DatabaseRow, DocJSON, ID, NumberFormat, PageMeta, PropertyDef, PropType, ViewType } from "../api/types";
import { appendPageBlock, editPageContent } from "../editor/actions";
import { analyzeDoc, mentionLinks } from "../editor/doc";
import { docToMarkdown, markdownToDoc } from "../editor/markdown";
import { schema } from "../editor/schema";
import { addRow, dbs, loadDatabase, setRowProps, setRowTitle, updateSchema } from "../database/store";
import { defaultStatusOptions, newView } from "../database/defaults";
import { displayText, READONLY_TYPES } from "../database/properties";
import { searchRows } from "../database/query";
import { ancestors, childrenOf, createPage, movePage, navigation, nextSortKey, setting, setSetting, trashPage, updatePage, ws } from "../state/workspace";
import { toast } from "../components/popovers";
import { parseLooseDate } from "./csv";
import { shortId } from "./id";
import { COLORS, pageTitle, parseLocaleNumber, safeHref } from "./util";

// Werkzeuge für Claude Code (MCP). Die macOS-App nimmt die Anfragen entgegen, prüft Zugang und Werkzeugnamen
// und ruft dann `window.__substrat.mcp(name, args)` auf – nacheinander, nie gleichzeitig.
// Alles läuft über dieselben Funktionen wie die Oberfläche: offene Editoren, Link-Index, Suche und Seitenleiste
// bleiben dadurch stimmig.

export interface McpStatus {
  enabled: boolean;
  port: number;
  token: string;
  state: "off" | "starting" | "running" | "failed";
  error?: string;
}

/** Aktueller Zustand des MCP-Servers (für Einstellungen und Hinweis in der Seitenleiste). */
export const [mcpStatus, setMcpStatus] = createSignal<McpStatus | null>(null);

export function setupCommand(s: McpStatus): string {
  // --scope user: in allen Projekten verfügbar. Vorher einen alten Eintrag (gleich in welchem Bereich) entfernen,
  // damit ein neuer Schlüssel/Port ihn ersetzt; schlägt danach add fehl, zeigt add selbst den Grund.
  return `claude mcp remove substrat >/dev/null 2>&1; claude mcp add --scope user --transport http substrat http://127.0.0.1:${s.port}/mcp --header "Authorization: Bearer ${s.token}"`;
}

/** Fehler, die Claude als verständliche Meldung bekommt. */
class ToolError extends Error {}

type Args = Record<string, unknown>;
type Result = { ok: true; data: unknown } | { ok: false; error: string };

const INBOX_KEY = "mcpInbox";
const LINK = /^substrat:\/\/([A-Za-z0-9_-]{1,64})$/;

export async function runMcpTool(name: string, args: Args): Promise<Result> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Unbekanntes Werkzeug: ${name}` };
  try {
    return { ok: true, data: await tool(args ?? {}) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    console.error("MCP-Werkzeug fehlgeschlagen", name, e);
    return { ok: false, error: `Fehler: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------- Argumente ----------

function str(args: Args, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new ToolError(`Parameter „${key}“ fehlt`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`Parameter „${key}“ muss Text sein`);
  if (opts.max && v.length > opts.max) throw new ToolError(`Parameter „${key}“ ist zu lang (max. ${opts.max} Zeichen)`);
  return v;
}

function int(args: Args, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Parameter „${key}“ muss eine Zahl sein`);
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function page(id: string): PageMeta {
  const p = ws.pages[id];
  if (!p) throw new ToolError(`Seite nicht gefunden: ${id} (gelöscht oder falsche ID – mit search suchen)`);
  return p;
}

/** Seite, deren Inhalt geändert werden darf (keine Datenbank, nicht gesperrt). */
async function writablePage(id: string): Promise<PageMeta> {
  const p = page(id);
  if (p.kind === "database") throw new ToolError(`„${pageTitle(p.title)}“ ist eine Datenbank – Einträge mit add_database_row anlegen`);
  const full = await api.getPage(id);
  if (full?.settings?.locked) throw new ToolError(`„${pageTitle(p.title)}“ ist gesperrt und kann nicht geändert werden`);
  return p;
}

function icon(args: Args): string | null | undefined {
  if (!("icon" in args)) return undefined;
  const v = args.icon;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || [...v].length > 8 || /[\p{L}\p{N}]{2,}/u.test(v)) throw new ToolError("„icon“ muss ein einzelnes Emoji sein");
  return v;
}

// ---------- Darstellung ----------

function pathOf(id: ID): string {
  // ancestors() enthält die Seite selbst als letztes Glied
  return ancestors(id).map((a) => pageTitle(a.title)).join(" / ");
}

function summary(p: PageMeta) {
  return {
    id: p.id,
    title: pageTitle(p.title),
    ...(p.icon ? { icon: p.icon } : {}),
    kind: p.kind === "database" ? "database" : p.databaseId ? "database_row" : "page",
    path: pathOf(p.id),
  };
}

function titleOf(id: string): string {
  return pageTitle(ws.pages[id]?.title);
}

const linkOf = (id: string) => `substrat://${id}`;

// ---------- Markdown ----------

/** Markdown → Dokument. `[[Titel]]` und `substrat://<id>` werden zu Verweisen, Links auf Unterseiten zu Seitenblöcken. */
function toDoc(md: string, pageId?: ID): DocJSON {
  let byTitle: Map<string, ID> | null = null;
  const resolveWiki = (t: string) => {
    if (!byTitle) {
      byTitle = new Map();
      // Normale Seiten vor Datenbank-Zeilen, bei gleichem Titel die zuletzt bearbeitete
      const all = Object.values(ws.pages).sort((a, b) => Number(!!a.databaseId) - Number(!!b.databaseId) || b.updatedAt - a.updatedAt);
      for (const p of all) {
        const key = p.title.trim().toLowerCase();
        if (key && !byTitle.has(key)) byTitle.set(key, p.id);
      }
    }
    return byTitle.get(t.trim().toLowerCase()) ?? null;
  };
  const resolveLink = (href: string) => {
    const m = LINK.exec(href.trim());
    return m && ws.pages[m[1]] ? m[1] : null;
  };
  const doc = markdownToDoc(md, {
    resolveWiki,
    resolveLink,
    resolveAsset: (src) => src,
    pageBlockFor: (href) => {
      const id = resolveLink(href);
      return id && pageId && ws.pages[id]?.parentId === pageId ? id : null;
    },
  });
  return sanitize(doc);
}

/**
 * Nur sichere Inhalte übernehmen: Links nur http(s)/mailto, Bilder nur https oder eigene Anhänge,
 * Seitenblöcke nur für echte Unterseiten. Das Ergebnis muss ein gültiges Dokument sein.
 */
function sanitize(doc: DocJSON): DocJSON {
  const clean = (n: DocJSON): DocJSON | null => {
    if (n.type === "image") {
      const src = String(n.attrs?.src ?? "");
      if (!/^https:\/\//i.test(src) && !src.startsWith("app://asset/")) {
        const caption = String(n.attrs?.caption ?? "") || src;
        return { type: "paragraph", attrs: { indent: n.attrs?.indent ?? 0 }, content: caption ? [{ type: "text", text: caption }] : undefined };
      }
    }
    if (n.type === "file" || n.type === "bookmark" || n.type === "database") return null;
    const out: DocJSON = { ...n };
    if (n.marks) {
      out.marks = n.marks.flatMap((m) => {
        if (m.type !== "link") return [m];
        const href = safeHref(String(m.attrs?.href ?? ""));
        return href ? [{ ...m, attrs: { ...m.attrs, href } }] : [];
      });
      if (!out.marks.length) delete out.marks;
    }
    if (n.content) out.content = n.content.map(clean).filter((x): x is DocJSON => !!x);
    return out;
  };
  const result = clean(doc)!;
  if (!result.content?.length) result.content = [{ type: "paragraph" }];
  try {
    PMNode.fromJSON(schema, result).check();
  } catch (e) {
    throw new ToolError(`Der Inhalt konnte nicht umgewandelt werden: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

const isEmptyParagraph = (b: DocJSON) => b.type === "paragraph" && !b.content?.length;

// ---------- „Eingang“ ----------

async function inbox(): Promise<ID> {
  const id = setting(INBOX_KEY);
  if (id && ws.pages[id] && ws.pages[id].kind === "page" && !ws.pages[id].databaseId) return id;
  const p = await createPage({ parentId: null, title: "Eingang", icon: "📥" });
  setSetting(INBOX_KEY, p.id);
  return p.id;
}

function notify(text: string, id: ID) {
  toast(`Claude: ${text}`, { label: "Öffnen", run: () => navigation.open(id) });
}

// ---------- Datenbanken ----------

async function database(id: string): Promise<DatabaseData> {
  const p = page(id);
  if (p.kind !== "database") throw new ToolError(`„${pageTitle(p.title)}“ ist keine Datenbank`);
  await loadDatabase(id);
  const d = dbs[id];
  if (!d) throw new ToolError(`Datenbank „${pageTitle(p.title)}“ konnte nicht geladen werden`);
  return d;
}

function schemaInfo(d: DatabaseData) {
  return d.schema.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.options?.length ? { options: p.options.map((o) => o.name) } : {}),
    ...(READONLY_TYPES.has(p.type) ? { readonly: true } : {}),
    ...(p.type === "number" && p.format === "percent" ? { note: "Prozent als Anteil: 0.5 = 50 %" } : {}),
  }));
}

/**
 * Werte so ausgeben, dass Claude sie unverändert zurückschreiben kann: Zahlen roh (nicht „1.234“ oder „50 %“),
 * Kontrollkästchen als true, Datum als JJJJ-MM-TT. Alles andere als angezeigter Text.
 */
function rowInfo(d: DatabaseData, row: DatabaseRow) {
  const properties: Record<string, unknown> = {};
  for (const prop of d.schema) {
    if (prop.type === "title") continue;
    const raw = row.props[prop.id];
    if (prop.type === "number") {
      if (typeof raw === "number" && Number.isFinite(raw)) properties[prop.name] = raw;
    } else if (prop.type === "checkbox") {
      if (raw === true) properties[prop.name] = true;
    } else if (prop.type === "date") {
      const v = raw as { start?: string; end?: string } | undefined;
      if (v?.start) properties[prop.name] = v.end && v.end !== v.start ? `${v.start} bis ${v.end}` : v.start;
    } else {
      const text = displayText(d, row, prop);
      if (text) properties[prop.name] = text;
    }
  }
  return { id: row.id, title: pageTitle(row.title), properties };
}

function sortedRows(d: DatabaseData): DatabaseRow[] {
  return [...d.rows].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

function findProp(d: DatabaseData, name: string): PropertyDef {
  const key = name.trim().toLowerCase();
  const prop = d.schema.find((p) => p.name.trim().toLowerCase() === key);
  if (!prop) {
    const names = d.schema.filter((p) => p.type !== "title" && !READONLY_TYPES.has(p.type)).map((p) => `„${p.name}“`);
    throw new ToolError(`Unbekannte Eigenschaft „${name}“. Vorhanden: ${names.join(", ") || "keine"}`);
  }
  if (prop.type === "title") throw new ToolError(`„${prop.name}“ ist der Titel – bitte über „title“ setzen`);
  if (READONLY_TYPES.has(prop.type)) throw new ToolError(`„${prop.name}“ wird berechnet und kann nicht gesetzt werden`);
  if (prop.type === "files") throw new ToolError(`„${prop.name}“ (Dateien) kann über Claude nicht gesetzt werden`);
  return prop;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * Wandelt einen Wert aus Claude in den gespeicherten Wert um. `null` leert die Eigenschaft.
 * Neue Auswahl-Optionen werden angelegt (wie beim Tippen in Notion), Status-Optionen nicht.
 */
function convert(prop: PropertyDef, value: unknown, newOptions: Map<string, PropertyDef>): unknown {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  const text = typeof value === "string" ? value.trim() : String(value);
  switch (prop.type) {
    case "checkbox":
      if (typeof value === "boolean") return value || null;
      if (/^(true|ja|yes|x|✓|1)$/i.test(text)) return true;
      if (/^(false|nein|no|0)$/i.test(text)) return null;
      throw new ToolError(`„${prop.name}“ erwartet true oder false`);
    case "number": {
      // Gespeichert wird der Rohwert (bei Prozent der Anteil, 0.5 = 50 %); nur „50 %“ als Text wird umgerechnet
      const n = typeof value === "number" ? value : parseLocaleNumber(text);
      if (n === null || !Number.isFinite(n)) throw new ToolError(`„${prop.name}“ erwartet eine Zahl, nicht „${text}“`);
      return typeof value === "string" && text.includes("%") ? n / 100 : n;
    }
    case "date": {
      const [a, b] = text.split(/\s+(?:bis|–|-|to)\s+|\s*→\s*/);
      const start = parseLooseDate(a ?? "");
      const end = b ? parseLooseDate(b) : null;
      if (!start || (b && !end)) throw new ToolError(`„${prop.name}“ erwartet ein Datum wie 2026-10-13 (oder „2026-10-13 bis 2026-10-15“)`);
      return end && end !== start ? { start, end } : { start };
    }
    case "select":
    case "status": {
      // Ganzer Text = eine Option (Namen dürfen Kommas enthalten)
      const names = Array.isArray(value) ? list(value) : [text];
      if (names.length !== 1) throw new ToolError(`„${prop.name}“ erwartet genau eine Option`);
      return optionId(prop, names[0], newOptions);
    }
    case "multi_select":
      return [...new Set(list(value).map((n) => optionId(prop, n, newOptions)))];
    case "relation": {
      const target = prop.relation?.databaseId;
      const ids = list(value).map((v) => {
        const m = LINK.exec(v);
        const id = m ? m[1] : v;
        if (ws.pages[id]?.databaseId === target) return id;
        const byTitle = Object.values(ws.pages).find((p) => p.databaseId === target && p.title.trim().toLowerCase() === v.toLowerCase());
        if (byTitle) return byTitle.id;
        throw new ToolError(`„${v}“ ist kein Eintrag der verknüpften Datenbank „${titleOf(target ?? "")}“ (ID oder genauer Titel)`);
      });
      return [...new Set(ids)];
    }
    case "url":
    case "email":
    case "phone":
    case "text":
      if (text.length > 20_000) throw new ToolError(`„${prop.name}“ ist zu lang`);
      return text;
    default:
      throw new ToolError(`„${prop.name}“ kann nicht gesetzt werden`);
  }
}

function optionId(prop: PropertyDef, name: string, newOptions: Map<string, PropertyDef>): string {
  const pending = newOptions.get(prop.id) ?? prop;
  const found = pending.options?.find((o) => o.name.trim().toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  if (prop.type === "status") {
    throw new ToolError(`„${name}“ ist kein Status von „${prop.name}“. Möglich: ${(prop.options ?? []).map((o) => `„${o.name}“`).join(", ")}`);
  }
  if (name.length > 100) throw new ToolError(`Option „${name.slice(0, 20)}…“ ist zu lang`);
  const count = pending.options?.length ?? 0;
  const opt = { id: shortId(), name, color: COLORS[1 + (count % (COLORS.length - 1))] };
  newOptions.set(prop.id, { ...pending, options: [...(pending.options ?? []), opt] });
  return opt.id;
}

/** Wandelt alle Eigenschaften um; neue Optionen werden erst gespeichert, wenn alles gültig ist. */
async function convertAll(d: DatabaseData, raw: unknown): Promise<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("„properties“ muss ein Objekt { \"Name\": \"Wert\" } sein");
  const newOptions = new Map<string, PropertyDef>();
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const prop = findProp(d, name);
    out[prop.id] = convert(prop, value, newOptions);
  }
  if (newOptions.size) await updateSchema(d.id, d.schema.map((p) => newOptions.get(p.id) ?? p));
  return out;
}

// ---------- Neue Datenbank ----------

const CREATABLE_TYPES = new Set<PropType>(["text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone"]);
const VIEW_TYPES = new Set<ViewType>(["table", "board", "list", "gallery", "calendar"]);
const NUMBER_FORMATS = new Set<NumberFormat>(["number", "comma", "percent", "euro", "dollar"]);

/** Baut das Schema aus Claudes Spaltenliste; prüft Namen, Typen und Optionen. */
function buildSchema(rawProps: unknown, titleName: string, view: ViewType): PropertyDef[] {
  if (rawProps !== undefined && !Array.isArray(rawProps)) throw new ToolError("„properties“ muss eine Liste von { name, type } sein");
  const items = (rawProps as unknown[] | undefined) ?? [];
  if (items.length > 50) throw new ToolError("Höchstens 50 Spalten");
  const schema: PropertyDef[] = [{ id: "title", name: titleName, type: "title" }];
  const taken = new Set([titleName.toLowerCase()]);
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ToolError("Jede Spalte braucht { name, type }");
    const def = item as Args;
    const name = str(def, "name", { required: true, max: 100 })!.trim();
    if (!name) throw new ToolError("Spaltenname darf nicht leer sein");
    if (taken.has(name.toLowerCase())) throw new ToolError(`Spalte „${name}“ gibt es doppelt (die Titelspalte „${titleName}“ entsteht automatisch)`);
    taken.add(name.toLowerCase());
    const type = str(def, "type", { required: true }) as PropType;
    if (!CREATABLE_TYPES.has(type)) throw new ToolError(`Spaltentyp „${type}“ für „${name}“ wird nicht unterstützt. Möglich: ${[...CREATABLE_TYPES].join(", ")}`);
    const prop: PropertyDef = { id: shortId(), name, type };
    if (def.options !== undefined && type !== "select" && type !== "multi_select" && type !== "status") {
      throw new ToolError(`„${name}“ (${type}) hat keine Optionen`);
    }
    if (type === "select" || type === "multi_select" || type === "status") {
      if (def.options !== undefined && !Array.isArray(def.options)) throw new ToolError(`„options“ von „${name}“ muss eine Liste sein`);
      const names = [...new Map(list(def.options ?? []).map((n) => [n.toLowerCase(), n])).values()];
      if (names.length > 100) throw new ToolError(`„${name}“: höchstens 100 Optionen`);
      if (names.some((n) => n.length > 100)) throw new ToolError(`„${name}“: Option zu lang (höchstens 100 Zeichen)`);
      if (type === "status") {
        // Erste Option = offen, letzte = erledigt, dazwischen = in Arbeit (wie Notions Status-Gruppen)
        prop.options = names.length
          ? names.map((n, i) => {
              const group = i === 0 ? "todo" : i === names.length - 1 ? "done" : "progress";
              return { id: shortId(), name: n, color: group === "todo" ? "default" : group === "done" ? "green" : "blue", group };
            })
          : defaultStatusOptions();
      } else {
        prop.options = names.map((n, i) => ({ id: shortId(), name: n, color: COLORS[1 + (i % (COLORS.length - 1))] }));
      }
    }
    if (def.number_format !== undefined) {
      if (type !== "number") throw new ToolError(`„number_format“ gilt nur für Zahlen-Spalten („${name}“ ist ${type})`);
      if (!NUMBER_FORMATS.has(def.number_format as NumberFormat)) throw new ToolError(`Unbekanntes Zahlenformat „${String(def.number_format)}“`);
      prop.format = def.number_format as NumberFormat;
    }
    schema.push(prop);
  }
  // Board braucht eine Gruppierung, Kalender ein Datum – fehlt es, wie beim Anlegen in der App ergänzen
  if (view === "board" && !schema.some((p) => p.type === "status" || p.type === "select")) {
    if (taken.has("status")) throw new ToolError("Ein Board braucht eine Status- oder Auswahl-Spalte");
    schema.push({ id: shortId(), name: "Status", type: "status", options: defaultStatusOptions() });
  }
  if (view === "calendar" && !schema.some((p) => p.type === "date")) {
    if (taken.has("datum")) throw new ToolError("Ein Kalender braucht eine Datums-Spalte");
    schema.push({ id: shortId(), name: "Datum", type: "date" });
  }
  return schema;
}

// ---------- Werkzeuge ----------

const TOOLS: Record<string, (args: Args) => Promise<unknown>> = {
  async search(args) {
    const query = str(args, "query", { required: true, max: 500 })!;
    const results = await api.search(query, int(args, "limit", 20, 50));
    return results
      .filter((r) => ws.pages[r.id])
      .map((r) => ({ ...summary(ws.pages[r.id]), snippet: r.snippet.replace(/\u0001|\u0002/g, "**") }));
  },

  async list_pages(args) {
    const parentId = str(args, "parent_id") ?? null;
    if (parentId) {
      const p = page(parentId);
      if (p.kind === "database") throw new ToolError(`„${pageTitle(p.title)}“ ist eine Datenbank – Zeilen mit query_database lesen`);
    }
    return childrenOf(parentId)
      .slice(0, 500)
      .map((id) => ({ ...summary(ws.pages[id]), has_children: childrenOf(id).length > 0 }));
  },

  async read_page(args) {
    const p = page(str(args, "id", { required: true })!);
    if (p.kind === "database") {
      const d = await database(p.id);
      const rows = sortedRows(d);
      return { ...summary(p), schema: schemaInfo(d), row_count: rows.length, rows: rows.slice(0, 100).map((r) => rowInfo(d, r)) };
    }
    const full = await api.getPage(p.id);
    const out: Record<string, unknown> = {
      ...summary(p),
      updated_at: new Date(p.updatedAt).toISOString(),
      markdown: docToMarkdown(full?.content, { titleOf, linkOf }),
    };
    if (full?.settings?.locked) out.locked = true;
    if (p.databaseId) {
      const d = await database(p.databaseId);
      const row = d.rows.find((r) => r.id === p.id);
      if (row) out.properties = rowInfo(d, row).properties;
      out.database_id = p.databaseId;
    }
    const children = childrenOf(p.id).map((id) => summary(ws.pages[id]));
    if (children.length) out.children = children;
    return out;
  },

  async create_page(args) {
    const title = str(args, "title", { required: true, max: 500 })!;
    const md = str(args, "markdown") ?? "";
    const ic = icon(args);
    const parentId = str(args, "parent_id") ?? (await inbox());
    // Auch Datenbank-Zeilen dürfen Unterseiten haben; nur die Datenbank selbst nicht (writablePage)
    const parent = await writablePage(parentId);
    const doc = toDoc(md);
    const info = analyzeDoc(doc);
    const meta = await createPage({
      parentId: parent.id,
      title,
      icon: ic ?? null,
      sortKey: nextSortKey(parent.id),
      content: doc,
      text: info.text,
      links: { kinds: ["mention"], items: mentionLinks(info) },
    });
    // Wie über die Seitenleiste: Block in der Elternseite
    await appendPageBlock(parent.id, meta.id);
    notify(`„${title}“ angelegt`, meta.id);
    return { ...summary(meta), url: linkOf(meta.id) };
  },

  async create_database(args) {
    const title = str(args, "title", { required: true, max: 500 })!;
    const ic = icon(args);
    const view = (str(args, "view") ?? "table") as ViewType;
    if (!VIEW_TYPES.has(view)) throw new ToolError(`Unbekannte Ansicht „${view}“. Möglich: ${[...VIEW_TYPES].join(", ")}`);
    if (args.inline !== undefined && typeof args.inline !== "boolean") throw new ToolError("„inline“ muss true oder false sein");
    const inline = args.inline === true;
    const titleName = (str(args, "title_property", { max: 100 }) ?? "Name").trim() || "Name";
    const schemaDefs = buildSchema(args.properties, titleName, view);

    // Alle Zeilen vorab prüfen und umwandeln – bei einem Fehler entsteht gar nichts
    if (args.rows !== undefined && !Array.isArray(args.rows)) throw new ToolError("„rows“ muss eine Liste sein");
    const rawRows = (args.rows as unknown[] | undefined) ?? [];
    if (rawRows.length > 200) throw new ToolError("Höchstens 200 Zeilen auf einmal; weitere mit add_database_row");
    const draft = { id: "", schema: schemaDefs, rows: [], views: [] } as unknown as DatabaseData;
    const newOptions = new Map<string, PropertyDef>();
    const rows = rawRows.map((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`Zeile ${i + 1}: { title, properties } erwartet`);
      const r = raw as Args;
      const rowTitle = str(r, "title", { required: true, max: 500 })!;
      if (r.properties !== undefined && r.properties !== null && (typeof r.properties !== "object" || Array.isArray(r.properties))) {
        throw new ToolError(`Zeile „${rowTitle}“: „properties“ muss ein Objekt { "Name": "Wert" } sein`);
      }
      const props: Record<string, unknown> = {};
      try {
        for (const [name, value] of Object.entries((r.properties as Record<string, unknown>) ?? {})) {
          const prop = findProp(draft, name);
          const v = convert(prop, value, newOptions);
          if (v !== null) props[prop.id] = v;
        }
      } catch (e) {
        throw e instanceof ToolError ? new ToolError(`Zeile „${rowTitle}“: ${e.message}`) : e;
      }
      const md = str(r, "markdown");
      return { title: rowTitle, props, doc: md ? toDoc(md) : null };
    });
    // Optionen, die erst in den Zeilen vorkommen, gleich ins Schema übernehmen
    const finalSchema = schemaDefs.map((p) => newOptions.get(p.id) ?? p);

    const parentId = str(args, "parent_id") ?? (await inbox());
    const parent = await writablePage(parentId);
    const db = await createPage({
      parentId: parent.id,
      kind: "database",
      inline,
      title,
      icon: ic ?? null,
      sortKey: nextSortKey(parent.id),
      schema: finalSchema,
      views: [newView(view, finalSchema)],
    });
    // Wie über das /-Menü: eingebettet als Datenbank-Block, sonst als Seitenlink
    await appendPageBlock(parent.id, db.id);
    for (const r of rows) {
      const row = await addRow(db.id, { title: r.title, props: r.props });
      if (!row) throw new ToolError(`Datenbank angelegt, aber Zeile „${r.title}“ konnte nicht angelegt werden`);
      if (r.doc) await editPageContent(row.id, () => r.doc!);
    }
    notify(`Datenbank „${title}“ angelegt`, db.id);
    const d = await database(db.id);
    return { ...summary(ws.pages[db.id] ?? db), view, inline, schema: schemaInfo(d), row_count: d.rows.length, rows: sortedRows(d).slice(0, 20).map((r) => rowInfo(d, r)), url: linkOf(db.id) };
  },

  async append_to_page(args) {
    const p = await writablePage(str(args, "id", { required: true })!);
    const doc = toDoc(str(args, "markdown", { required: true })!, p.id);
    const added = (doc.content ?? []).filter((b) => !isEmptyParagraph(b));
    if (!added.length) throw new ToolError("Kein Inhalt zum Anhängen");
    await editPageContent(p.id, (prev) => {
      const blocks = (prev.content ?? []).filter((b, i, all) => !(i === all.length - 1 && isEmptyParagraph(b)));
      return { type: "doc", content: [...blocks, ...added] };
    });
    notify(`„${pageTitle(p.title)}“ ergänzt`, p.id);
    return { ...summary(p), blocks_added: added.length };
  },

  async replace_page_content(args) {
    const p = await writablePage(str(args, "id", { required: true })!);
    const doc = toDoc(str(args, "markdown") ?? "", p.id);
    let kept = 0;
    await editPageContent(
      p.id,
      (prev) => {
        // Unterseiten und Datenbanken bleiben (sonst landeten sie mit ihrem Block im Papierkorb)
        const present = new Set((doc.content ?? []).map((b) => String(b.attrs?.pageId ?? b.attrs?.databaseId ?? "")));
        const keep = (prev.content ?? []).filter((b) => (b.type === "page" || b.type === "database") && !present.has(String(b.attrs?.pageId ?? b.attrs?.databaseId ?? "")));
        kept = keep.length;
        const content = [...(doc.content ?? []).filter((b, _i, all) => !(all.length === 1 && isEmptyParagraph(b) && keep.length)), ...keep];
        return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
      },
      { snapshot: true },
    );
    notify(`Inhalt von „${pageTitle(p.title)}“ ersetzt (vorige Version im Verlauf)`, p.id);
    return { ...summary(p), kept_subpages: kept };
  },

  async update_page(args) {
    const p = page(str(args, "id", { required: true })!);
    const title = str(args, "title", { max: 500 });
    const ic = icon(args);
    if (title === undefined && ic === undefined) throw new ToolError("Nichts zu ändern: „title“ oder „icon“ angeben");
    const full = await api.getPage(p.id);
    if (full?.settings?.locked) throw new ToolError(`„${pageTitle(p.title)}“ ist gesperrt und kann nicht geändert werden`);
    if (title !== undefined) {
      if (p.databaseId) await setRowTitle(p.databaseId, p.id, title);
      else await updatePage(p.id, { title });
    }
    if (ic !== undefined) await updatePage(p.id, { icon: ic });
    notify(`„${pageTitle(ws.pages[p.id]?.title)}“ geändert`, p.id);
    return summary(ws.pages[p.id] ?? p);
  },

  async move_page(args) {
    const p = page(str(args, "id", { required: true })!);
    const parentId = str(args, "parent_id") ?? null;
    if (parentId) {
      const parent = page(parentId);
      if (parent.kind === "database") throw new ToolError("In Datenbanken bitte mit add_database_row eintragen, nicht verschieben");
    }
    if (p.parentId === parentId) return summary(p);
    const ok = await movePage(p.id, parentId, nextSortKey(parentId));
    if (!ok) throw new ToolError("Verschieben nicht möglich (z. B. in eine eigene Unterseite)");
    notify(`„${pageTitle(p.title)}“ verschoben`, p.id);
    return summary(ws.pages[p.id] ?? p);
  },

  async trash_page(args) {
    const p = page(str(args, "id", { required: true })!);
    const ids = await trashPage(p.id);
    toast(`Claude: „${pageTitle(p.title)}“ in den Papierkorb gelegt`);
    return { id: p.id, title: pageTitle(p.title), trashed_pages: ids.length, note: "30 Tage im Papierkorb wiederherstellbar" };
  },

  async query_database(args) {
    const d = await database(str(args, "database_id", { required: true })!);
    const text = str(args, "text", { max: 500 });
    const rows = text ? searchRows(d, sortedRows(d), text) : sortedRows(d);
    const limit = int(args, "limit", 100, 500);
    return { ...summary(ws.pages[d.id]), schema: schemaInfo(d), total: rows.length, rows: rows.slice(0, limit).map((r) => rowInfo(d, r)) };
  },

  async add_database_row(args) {
    const d = await database(str(args, "database_id", { required: true })!);
    const title = str(args, "title", { required: true, max: 500 })!;
    const md = str(args, "markdown");
    const doc = md ? toDoc(md) : null;
    const props = Object.fromEntries(Object.entries(await convertAll(d, args.properties)).filter(([, v]) => v !== null));
    const row = await addRow(d.id, { title, props });
    if (!row) throw new ToolError("Zeile konnte nicht angelegt werden");
    if (doc) await editPageContent(row.id, () => doc);
    notify(`„${title}“ in „${titleOf(d.id)}“ eingetragen`, row.id);
    const fresh = dbs[d.id]?.rows.find((r) => r.id === row.id) ?? row;
    return { ...rowInfo(dbs[d.id] ?? d, fresh), database_id: d.id, url: linkOf(row.id) };
  },

  async update_database_row(args) {
    const p = page(str(args, "row_id", { required: true })!);
    if (!p.databaseId) throw new ToolError(`„${pageTitle(p.title)}“ ist keine Datenbank-Zeile – update_page verwenden`);
    const d = await database(p.databaseId);
    const title = str(args, "title", { max: 500 });
    const patch = await convertAll(d, args.properties);
    if (title === undefined && !Object.keys(patch).length) throw new ToolError("Nichts zu ändern: „title“ oder „properties“ angeben");
    if (Object.keys(patch).length) await setRowProps(d.id, p.id, patch);
    if (title !== undefined) await setRowTitle(d.id, p.id, title);
    notify(`„${pageTitle(ws.pages[p.id]?.title)}“ geändert`, p.id);
    const row = dbs[d.id]?.rows.find((r) => r.id === p.id);
    return row ? { ...rowInfo(dbs[d.id], row), database_id: d.id } : summary(p);
  },
};
