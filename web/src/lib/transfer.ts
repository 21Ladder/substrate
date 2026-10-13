import { api } from "../api/client";
import type { DocJSON, ID, ImportFile, PropertyDef } from "../api/types";
import { analyzeDoc, mentionLinks } from "../editor/doc";
import { docToMarkdown, markdownToDoc } from "../editor/markdown";
import { newView } from "../database/defaults";
import { displayText } from "../database/properties";
import { dbs, loadDatabase } from "../database/store";
import { childrenOf, flushAll, loadWorkspace, navigation, nextSortKey, ws } from "../state/workspace";
import { toast } from "../components/popovers";
import { uuid } from "./id";
import { htmlTitle, htmlToDoc } from "./htmlImport";
import { inferSchema, parseCSV, parseLooseDate, toCSV } from "./csv";
import { keysBetween } from "./sortkey";
import { pageTitle, parseLocaleNumber, toDateValue } from "./util";

function cellValue(prop: PropertyDef, raw: string): unknown {
  const v = raw.trim();
  if (!v) return undefined;
  switch (prop.type) {
    case "checkbox":
      return /^(yes|ja|true|✓|x)$/i.test(v) ? true : undefined;
    case "number": {
      const n = parseLocaleNumber(v);
      return n === null ? undefined : prop.format === "percent" && v.includes("%") ? n / 100 : n;
    }
    case "date": {
      const d = parseLooseDate(v);
      return d ? { start: d } : undefined;
    }
    case "select":
    case "status":
      return prop.options?.find((o) => o.name === v)?.id;
    case "multi_select": {
      const ids = v.split(",").map((x) => prop.options?.find((o) => o.name === x.trim())?.id).filter(Boolean);
      return ids.length ? ids : undefined;
    }
    default:
      return v;
  }
}

// ---------- Import ----------

const NOTION_ID = /\s+([0-9a-f]{32})$/i;

function stripId(name: string): string {
  return name.replace(NOTION_ID, "").trim();
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function noExt(p: string): string {
  return p.replace(/\.[^/.]+$/, "");
}

function resolvePath(base: string, rel: string): string {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface Entry {
  key: string; // Pfad ohne Endung
  id: ID;
  kind: "page" | "database";
  title: string;
  parentKey: string | null;
  file?: ImportFile;
  csv?: string[][];
  rowOf?: string; // Datenbank-Schlüssel, falls Zeile
  props?: Record<string, unknown>;
  csvIndex?: number; // Position der Zeile in der CSV (Reihenfolge der Datenbank)
}

/** Wandelt eingelesene Dateien in Seiten und Datenbanken um. */
export async function importFiles(files: ImportFile[], rootTitle: string): Promise<ID | null> {
  const textFiles = files.filter((f) => f.text !== undefined && /\.(md|markdown|txt|csv|html?)$/i.test(f.path));
  if (!textFiles.length) return null;
  const assets = new Map(files.filter((f) => f.url).map((f) => [f.path, f.url!]));
  const entries = new Map<string, Entry>();
  const rootId = uuid();
  const rootKey = "__root__";
  entries.set(rootKey, { key: rootKey, id: rootId, kind: "page", title: rootTitle, parentKey: null });

  for (const f of textFiles) {
    const key = noExt(f.path);
    const isCsv = /\.csv$/i.test(f.path);
    // Notion exportiert "Name id.csv" (nur sichtbare Ansicht) und "Name id_all.csv" (alles) → _all bevorzugen
    if (isCsv && !/_all$/.test(key) && textFiles.some((x) => noExt(x.path) === `${key}_all`)) continue;
    const cleanKey = isCsv ? key.replace(/_all$/, "") : key;
    if (entries.has(cleanKey)) continue;
    entries.set(cleanKey, {
      key: cleanKey,
      id: uuid(),
      kind: isCsv ? "database" : "page",
      title: stripId(basename(cleanKey)),
      parentKey: null,
      file: f,
      csv: isCsv ? parseCSV(f.text!) : undefined,
    });
  }
  // Ordner ohne eigene Seite werden zu Seiten (Ordnerstruktur bleibt erhalten)
  const ensureDir = (dir: string): string => {
    if (!dir) return rootKey;
    if (entries.has(dir)) return dir;
    const parentKey = ensureDir(dirname(dir));
    entries.set(dir, { key: dir, id: uuid(), kind: "page", title: stripId(basename(dir)), parentKey });
    return dir;
  };
  for (const e of [...entries.values()]) {
    if (e.key === rootKey || e.parentKey) continue;
    e.parentKey = ensureDir(dirname(e.key));
  }
  // Datenbankzeilen: Markdown-Dateien im Ordner einer CSV
  for (const db of [...entries.values()].filter((e) => e.kind === "database" && e.csv)) {
    const [header = [], ...rows] = db.csv!;
    const schema = inferSchema(header, rows);
    (db as Entry & { schema?: PropertyDef[] }).schema = schema;
    // Mehrere Zeilen können gleich heißen ("Meeting") → je Titel eine Warteschlange
    const rowFiles = new Map<string, Entry[]>();
    for (const e of entries.values()) {
      if (e.parentKey !== db.key || e.kind !== "page") continue;
      const k = e.title.toLowerCase();
      rowFiles.set(k, [...(rowFiles.get(k) ?? []), e]);
    }
    for (const [rowIndex, r] of rows.entries()) {
      const title = (r[0] ?? "").trim();
      const props: Record<string, unknown> = {};
      schema.forEach((p, i) => {
        if (i === 0) return;
        const v = cellValue(p, r[i] ?? "");
        if (v !== undefined) props[p.id] = v;
      });
      const match = rowFiles.get(title.toLowerCase())?.shift();
      if (match) {
        match.rowOf = db.key;
        match.props = props;
        match.title = title || match.title;
        match.csvIndex = rowIndex;
        (match as Entry & { columns?: string[] }).columns = header;
      } else {
        const key = `${db.key}/__row_${uuid()}`;
        entries.set(key, { key, id: uuid(), kind: "page", title, parentKey: db.key, rowOf: db.key, props, csvIndex: rowIndex });
      }
    }
    // Übrige Dateien im Datenbankordner ohne passende CSV-Zeile werden trotzdem Einträge
    for (const list of rowFiles.values()) {
      for (const e of list) {
        e.rowOf = db.key;
        e.props = {};
        (e as Entry & { columns?: string[] }).columns = header;
      }
    }
  }
  // Seitenordner "Seite id/" gehören zu "Seite id.md": gleicher Schlüssel, daher automatisch Elternseite.

  const byPath = (href: string, fromKey: string): Entry | undefined => {
    if (/^[a-z]+:/i.test(href)) return undefined;
    const p = noExt(resolvePath(dirname(fromKey), safeDecode(href.split("#")[0])));
    return entries.get(p) ?? entries.get(p.replace(/_all$/, ""));
  };
  const byTitle = new Map<string, Entry>();
  for (const e of entries.values()) if (!byTitle.has(e.title.toLowerCase())) byTitle.set(e.title.toLowerCase(), e);

  const ops: { method: string; params: Record<string, unknown> }[] = [];
  const siblingsKeys = new Map<string, string[]>();
  for (const e of entries.values()) {
    const k = e.parentKey ?? "";
    siblingsKeys.set(k, [...(siblingsKeys.get(k) ?? []), e.key]);
  }
  const sortKeyOf = new Map<string, string>();
  for (const keys of siblingsKeys.values()) {
    // Datenbankzeilen in der Reihenfolge der CSV (Notion-Ansicht), alles andere alphabetisch
    keys.sort((a, b) => {
      const ea = entries.get(a)!;
      const eb = entries.get(b)!;
      if (ea.csvIndex !== undefined && eb.csvIndex !== undefined) return ea.csvIndex - eb.csvIndex;
      if (ea.csvIndex !== undefined || eb.csvIndex !== undefined) return ea.csvIndex !== undefined ? -1 : 1;
      return ea.title.localeCompare(eb.title, "de", { numeric: true });
    });
    const ks = keysBetween(null, null, keys.length);
    keys.forEach((k, i) => sortKeyOf.set(k, ks[i]));
  }

  for (const e of entries.values()) {
    let content: DocJSON | null = null;
    let title = e.title;
    const parent = e.parentKey ? entries.get(e.parentKey) : undefined;
    if (e.kind === "page" && e.file?.text !== undefined && /\.html?$/i.test(e.file.path)) {
      const fromKey = e.key;
      title = htmlTitle(e.file.text) ?? title;
      content = htmlToDoc(e.file.text, {
        resolveLink: (href) => byPath(href, fromKey)?.id ?? null,
        resolveAsset: (src) => assets.get(resolvePath(dirname(fromKey), safeDecode(src))) ?? (/^https:\/\//.test(src) ? src : null),
      });
    } else if (e.kind === "page" && e.file?.text !== undefined) {
      let md = e.file.text;
      // "# Titel" am Anfang übernehmen
      const h1 = /^\s*#\s+(.+)\n?/.exec(md);
      if (h1) {
        title = h1[1].trim();
        md = md.slice(h1[0].length);
      }
      // Notion schreibt Eigenschaften von Datenbankzeilen als "Name: Wert"-Zeilen direkt unter den Titel
      if (e.rowOf) {
        const columns = new Set(((e as Entry & { columns?: string[] }).columns ?? []).map((c) => c.trim().toLowerCase()));
        const lines = md.split("\n");
        let i = 0;
        while (i < lines.length && lines[i].trim() === "") i++;
        // Nur der zusammenhängende Block "Spalte: Wert" direkt unter dem Titel
        while (i < lines.length) {
          const m = /^([^:\n]{1,60}):\s/.exec(lines[i]);
          if (!m || !columns.has(m[1].trim().toLowerCase())) break;
          i++;
        }
        md = lines.slice(i).join("\n");
      }
      const fromKey = e.key;
      content = markdownToDoc(md, {
        resolveLink: (href) => byPath(href, fromKey)?.id ?? null,
        resolveWiki: (t) => byTitle.get(t.trim().toLowerCase())?.id ?? null,
        resolveAsset: (src) => assets.get(resolvePath(dirname(fromKey), safeDecode(src))) ?? (/^https:\/\//.test(src) ? src : null),
        pageBlockFor: (href) => {
          const target = byPath(href, fromKey);
          return target && target.parentKey === e.key ? target.id : null;
        },
      });
    } else if (e.kind === "page") {
      // Ordnerseite: Unterseiten als Blöcke auflisten
      const kids = (siblingsKeys.get(e.key) ?? []).map((k) => entries.get(k)!).filter((k) => !k.rowOf);
      content = { type: "doc", content: kids.length ? kids.map((k) => ({ type: "page", attrs: { indent: 0, pageId: k.id } })) : [{ type: "paragraph" }] };
    }
    // Datenbank-Unterseiten, die nicht verlinkt sind, als Blöcke anhängen (sonst nur in der Sidebar sichtbar)
    if (content && e.kind === "page" && e.file && !e.rowOf) {
      const info = analyzeDoc(content);
      const linked = new Set([...info.subpages, ...info.databases, ...info.mentions]);
      const kids = (siblingsKeys.get(e.key) ?? []).map((k) => entries.get(k)!).filter((k) => !k.rowOf && !linked.has(k.id));
      for (const k of kids) content.content!.push({ type: "page", attrs: { indent: 0, pageId: k.id } });
    }
    const info = analyzeDoc(content);
    const dbSchema = (e as Entry & { schema?: PropertyDef[] }).schema;
    ops.push({
      method: "page.create",
      params: api.createParams({
        id: e.id,
        parentId: parent?.id ?? null,
        databaseId: e.rowOf ? entries.get(e.rowOf)!.id : null,
        kind: e.kind,
        title,
        sortKey: e.key === rootKey ? nextSortKey(null) : sortKeyOf.get(e.key) ?? "V",
        props: e.props ?? {},
        content,
        text: info.text,
        links: { kinds: ["mention"], items: mentionLinks(info) },
        ...(e.kind === "database" ? { schema: dbSchema ?? [{ id: "title", name: "Name", type: "title" }], views: [newView("table", dbSchema ?? [])] } : {}),
      }),
    });
  }
  // Eltern immer vor ihren Kindern schreiben: Schlägt ein späteres Paket fehl, hängt alles bereits
  // Geschriebene lückenlos unter der Import-Wurzel und wird beim Aufräumen vollständig erreicht.
  const depthOf = (key: string): number => {
    let d = 0;
    for (let k = entries.get(key)?.parentKey; k && d < 1000; k = entries.get(k)?.parentKey) d++;
    return d;
  };
  const depth = new Map([...entries.values()].map((e) => [e.id, depthOf(e.key)]));
  ops.sort((x, y) => (depth.get(x.params.id as string) ?? 0) - (depth.get(y.params.id as string) ?? 0));
  // In Paketen schreiben, damit die Oberfläche reaktionsfähig bleibt. Alles hängt unter der
  // Import-Wurzel – schlägt ein Paket fehl, wird der bereits geschriebene Teil wieder entfernt.
  try {
    for (let i = 0; i < ops.length; i += 300) await api.batch(ops.slice(i, i + 300));
  } catch (e) {
    // Endgültiges Löschen ist nur aus dem Papierkorb erlaubt
    await api.trashPage(rootId).catch(() => undefined);
    await api.purgePage(rootId).catch(() => undefined);
    throw e;
  }
  return rootId;
}

export async function importFromDisk() {
  const { files, warnings } = await api.pickImport();
  for (const w of warnings.slice(0, 3)) toast(w);
  if (warnings.length > 3) toast(`… und ${warnings.length - 3} weitere Hinweise`);
  if (!files?.length) return;
  const roots = new Set(files.map((f) => f.path.split("/")[0]));
  const rootTitle = roots.size === 1 ? `Import: ${stripId([...roots][0].replace(/\.(md|csv|zip)$/i, ""))}` : "Import";
  // Einzelner gemeinsamer Wurzelordner → Pfade relativ dazu
  const prefix = roots.size === 1 && files.every((f) => f.path.includes("/")) ? [...roots][0] + "/" : "";
  const normalized = files.map((f) => ({ ...f, path: prefix ? f.path.slice(prefix.length) : f.path }));
  toast(`Importiere ${files.length} Dateien …`);
  try {
    const id = await importFiles(normalized, rootTitle);
    await loadWorkspace();
    if (id) {
      navigation.open(id);
      toast("Import abgeschlossen");
    } else toast("Keine importierbaren Dateien gefunden");
  } catch (e) {
    console.error(e);
    toast(`Import fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- Export ----------

function safeName(s: string): string {
  // Nach Zeichen (nicht UTF-16-Einheiten) kürzen: sonst zerteilt ein Emoji an Stelle 100 den Namen
  const cleaned = (s || "Unbenannt").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "");
  return Array.from(cleaned).slice(0, 100).join("").trim() || "Unbenannt";
}

async function databaseCSV(id: ID): Promise<string> {
  await loadDatabase(id, true);
  const d = dbs[id];
  if (!d) return "";
  // Rollups und Formeln über Relationen brauchen die Zieldatenbanken
  for (const p of d.schema) if (p.type === "relation" && p.relation) await loadDatabase(p.relation.databaseId);
  const header = d.schema.map((p) => p.name);
  const rows = d.rows.map((r) => d.schema.map((p) => displayText(d, { ...r, title: ws.pages[r.id]?.title ?? r.title }, p)));
  return toCSV([header, ...rows]);
}

export async function exportPage(id: ID) {
  await flushAll();
  const page = await api.getPage(id);
  if (!page) return;
  if (page.kind === "database") {
    await api.exportFile(`${safeName(page.title)}.csv`, await databaseCSV(id));
    return;
  }
  const md = `# ${pageTitle(page.title)}\n\n` + docToMarkdown(page.content, { titleOf: (x) => pageTitle(ws.pages[x]?.title) });
  await api.exportFile(`${safeName(page.title)}.md`, md);
}

/** Exportiert den gesamten Workspace als Ordner mit Markdown, CSV und Anhängen. */
export async function exportWorkspace() {
  await flushAll();
  const paths = new Map<ID, string>();
  const used = new Set<string>();
  const assign = (id: ID, dir: string) => {
    const p = ws.pages[id];
    if (!p) return;
    const base = safeName(pageTitle(p.title));
    let name = base;
    for (let i = 2; used.has(`${dir}${name}`.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(`${dir}${name}`.toLowerCase());
    paths.set(id, `${dir}${name}`);
    for (const c of childrenOf(id)) assign(c, `${dir}${name}/`);
  };
  for (const id of childrenOf(null)) assign(id, "");

  const files: { path: string; content?: string; asset?: string }[] = [];
  const assets = new Set<string>();
  const rel = (from: string, to: string) => {
    const a = from.split("/").slice(0, -1);
    const b = to.split("/");
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].map(encodeURIComponent).join("/");
  };
  const pages = new Map((await api.getPages([...paths.keys()])).map((p) => [p.id, p]));
  for (const [id, path] of paths) {
    const page = pages.get(id);
    if (!page) continue;
    if (page.kind === "database") {
      files.push({ path: `${path}.csv`, content: await databaseCSV(id) });
      continue;
    }
    const md =
      `# ${pageTitle(page.title)}\n\n` +
      docToMarkdown(page.content, {
        titleOf: (x) => pageTitle(ws.pages[x]?.title),
        linkOf: (x) => (paths.has(x) ? rel(path, `${paths.get(x)}.${ws.pages[x]?.kind === "database" ? "csv" : "md"}`) : "#"),
        assetOf: (src) => {
          const m = /^app:\/\/asset\/(.+)$/.exec(src);
          if (!m) return src;
          assets.add(m[1]);
          return rel(path, `_assets/${m[1]}`);
        },
      });
    files.push({ path: `${path}.md`, content: md });
  }
  for (const a of assets) files.push({ path: `_assets/${a}`, asset: a });
  const ok = await api.exportFiles(`Substrat Export ${toDateValue(new Date())}`, files);
  if (ok) toast(`${paths.size} Seiten exportiert`);
}
