import { api } from "../api/client";
import type { DocJSON, ID } from "../api/types";
import { uuid } from "../lib/id";
import { analyzeDoc, mentionLinks } from "../editor/doc";
import { childrenOf, loadWorkspace, nextSortKey, ws } from "./workspace";
import { loadDatabase, setRowProps, syncAllReverse, takeUniqueIds } from "../database/store";

/**
 * Dupliziert eine Seite samt Unterseiten (und Datenbank-Einträgen).
 * Verweise auf duplizierte Unterseiten werden auf die Kopien umgebogen.
 */
export async function duplicatePage(id: ID): Promise<ID | null> {
  const root = ws.pages[id];
  if (!root) return null;
  // Teilbaum sammeln
  const ids: ID[] = [id];
  for (let i = 0; i < ids.length; i++) ids.push(...childrenOf(ids[i]));
  const map = new Map(ids.map((x) => [x, uuid()]));
  const ops: { method: string; params: Record<string, unknown> }[] = [];
  const remap = (doc: DocJSON | null): DocJSON | null => {
    if (!doc) return doc;
    const walk = (n: DocJSON): DocJSON => {
      const attrs = n.attrs ? { ...n.attrs } : undefined;
      if (attrs) {
        for (const k of ["pageId", "databaseId"]) {
          const v = attrs[k];
          if (typeof v === "string" && map.has(v)) attrs[k] = map.get(v);
        }
      }
      return { ...n, ...(attrs ? { attrs } : {}), ...(n.content ? { content: n.content.map(walk) } : {}) };
    };
    return walk(doc);
  };
  const schemas = new Map<ID, Awaited<ReturnType<typeof api.getDatabase>>>();
  const schemaOf = async (dbId: ID) => {
    if (!schemas.has(dbId)) schemas.set(dbId, await api.getDatabase(dbId));
    return schemas.get(dbId)?.schema ?? [];
  };
  const fulls = new Map((await api.getPages(ids)).map((p) => [p.id, p]));
  for (const oldId of ids) {
    const full = fulls.get(oldId);
    if (!full) continue;
    const isRoot = oldId === id;
    const content = remap(full.content);
    const info = analyzeDoc(content);
    const props = { ...full.props };
    // Einträge einer nicht mitkopierten Datenbank bekommen neue IDs (unten), die alte nicht übernehmen
    const rowOfExistingDb = !!full.databaseId && !map.has(full.databaseId);
    if (rowOfExistingDb) for (const p of await schemaOf(full.databaseId!)) if (p.type === "unique_id") delete props[p.id];
    // Relationen innerhalb der Kopie umbiegen
    for (const [k, v] of Object.entries(props)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) props[k] = v.map((x) => map.get(x as string) ?? x);
    }
    const db = full.kind === "database" ? await api.getDatabase(oldId) : null;
    const relationItems = full.databaseId
      ? (await schemaOf(full.databaseId))
          .filter((p) => p.type === "relation")
          .flatMap((p) => ((props[p.id] as ID[]) ?? []).map((dst) => ({ dst, kind: "relation" as const, prop: p.id })))
      : [];
    ops.push({
      method: "page.create",
      params: api.createParams({
        id: map.get(oldId)!,
        parentId: isRoot ? full.parentId : (map.get(full.parentId!) ?? full.parentId),
        databaseId: full.databaseId ? (map.get(full.databaseId) ?? full.databaseId) : null,
        kind: full.kind,
        title: isRoot ? `${full.title || "Unbenannt"} (Kopie)` : full.title,
        icon: full.icon,
        cover: full.cover,
        sortKey: isRoot ? nextSortKey(full.parentId, oldId) : full.sortKey,
        inline: full.inline,
        props,
        content,
        settings: full.settings,
        text: info.text,
        links: { kinds: ["mention", "relation"], items: [...mentionLinks(info), ...relationItems] },
        ...(db ? { schema: db.schema, views: db.views } : {}),
      }),
    });
  }
  for (let i = 0; i < ops.length; i += 300) await api.batch(ops.slice(i, i + 300));
  await loadWorkspace();
  // Nacharbeiten für kopierte Datenbankeinträge: neue IDs und Gegenrichtung zweiseitiger Relationen
  const reloaded = new Set<ID>();
  for (const oldId of ids) {
    const full = fulls.get(oldId);
    if (!full?.databaseId) continue;
    const dbId = map.get(full.databaseId) ?? full.databaseId;
    const copyId = map.get(oldId)!;
    if (!reloaded.has(dbId)) {
      reloaded.add(dbId);
      await loadDatabase(dbId, true);
    }
    if (!map.has(full.databaseId)) {
      const ids2 = await takeUniqueIds(dbId);
      if (Object.keys(ids2).length) await setRowProps(dbId, copyId, ids2, { skipReverse: true });
    }
    await syncAllReverse(dbId, copyId);
  }
  return map.get(id) ?? null;
}
