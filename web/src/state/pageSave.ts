import { api } from "../api/client";
import type { DocJSON, ID } from "../api/types";
import { analyzeDoc, mentionLinks, type DocInfo } from "../editor/doc";
import { emit, getPage, nextSortKey, restorePage, setPageMeta, trashPage, updatePage, ws } from "./workspace";

/**
 * Speichert den Inhalt einer Seite und hält Unterseiten konsistent:
 * - Seitenblock gelöscht → Unterseite in den Papierkorb (wie Notion)
 * - Seitenblock wieder da (Rückgängig) → Unterseite wiederherstellen
 * - Seitenblock in andere Seite verschoben → Elternseite anpassen
 */
export async function saveContent(pageId: ID, doc: DocJSON, prev: DocInfo | null, opts: { snapshot?: boolean } = {}): Promise<DocInfo> {
  const info = analyzeDoc(doc);
  const r = await api.updatePage(pageId, {
    content: doc,
    text: info.text,
    links: { kinds: ["mention"], items: mentionLinks(info) },
    ...(opts.snapshot ? { snapshot: true } : {}),
  });
  if (ws.pages[pageId] && r?.updatedAt) setPageMeta(pageId, { updatedAt: r.updatedAt });
  if (!prev || prev.mentions.join() !== info.mentions.join()) emit("links-changed", { id: pageId });

  const now = new Set([...info.subpages, ...info.databases]);
  const before = new Set([...(prev?.subpages ?? []), ...(prev?.databases ?? [])]);

  for (const id of before) {
    if (now.has(id)) continue;
    const p = getPage(id);
    // Nur löschen, wenn die Seite noch hierher gehört (nicht woanders hin verschoben wurde)
    if (p && p.parentId === pageId) await trashPage(id);
  }
  for (const id of now) {
    const p = getPage(id);
    if (!p) {
      // Block wieder aufgetaucht (z. B. nach Rückgängig) → Seite aus dem Papierkorb holen.
      // War der Block schon vorher da, wurde die Seite bewusst anderswo gelöscht.
      if (before.has(id)) continue;
      const ids = await restorePage(id, { reattach: false });
      if (ids.length && getPage(id)?.parentId !== pageId) await updatePage(id, { parentId: pageId, sortKey: nextSortKey(pageId) });
    } else if (p.parentId !== pageId && !before.has(id)) {
      await updatePage(id, { parentId: pageId, databaseId: null, sortKey: nextSortKey(pageId) });
    }
  }
  return info;
}
