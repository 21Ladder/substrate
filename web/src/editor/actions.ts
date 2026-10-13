import { closeHistory } from "prosemirror-history";
import { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { api } from "../api/client";
import type { DocJSON } from "../api/types";
import { analyzeDoc } from "./doc";
import { saveContent } from "../state/pageSave";
import { openEditors } from "./ui";
import type { ID, ViewType } from "../api/types";
import { defaultDatabase } from "../database/defaults";
import { createPage, flushAll, navigation, nextSortKey, on, ws } from "../state/workspace";
import { insertBlock } from "./blocks";
import { schema } from "./schema";

/** "/Seite": Unterseite anlegen, als Block einfügen und öffnen (wie Notion). */
export async function createSubpageFromEditor(view: EditorView, pageId: ID, flush: () => Promise<void>) {
  const page = await createPage({ parentId: pageId, sortKey: nextSortKey(pageId) });
  if (view.isDestroyed) return;
  view.dispatch(insertBlock(view.state, schema.nodes.page.create({ pageId: page.id })));
  await flush();
  navigation.open(page.id);
}

/** Datenbank anlegen – inline als Block oder als ganze Seite (Unterseite). */
export async function createDatabasePage(view: EditorView, pageId: ID, viewType: ViewType, inline: boolean, flush: () => Promise<void>) {
  const { schema: props, views } = defaultDatabase(viewType);
  const db = await createPage({
    parentId: pageId,
    kind: "database",
    inline,
    title: "",
    sortKey: nextSortKey(pageId),
    schema: props,
    views,
  });
  if (view.isDestroyed) return;
  if (inline) {
    view.dispatch(insertBlock(view.state, schema.nodes.database.create({ databaseId: db.id })));
    await flush();
  } else {
    view.dispatch(insertBlock(view.state, schema.nodes.page.create({ pageId: db.id })));
    await flush();
    navigation.open(db.id);
  }
}

/** Zeigt ein Block (Seite oder Datenbank) auf diese Seite? */
const refersTo = (childId: ID) => (attrs: Record<string, unknown> | undefined) => attrs?.pageId === childId || attrs?.databaseId === childId;

/** Hängt einen Seitenblock an das Ende einer Seite an (offener Editor oder gespeicherter Inhalt). */
export async function appendPageBlock(parentId: ID, childId: ID, opts: { ifMissing?: boolean } = {}) {
  // Nur eingebettete Datenbanken sind Datenbank-Blöcke; ganzseitige erscheinen als Seitenlink
  const child = ws.pages[childId];
  const isDb = child?.kind === "database" && !!child.inline;
  const refers = refersTo(childId);
  const view = openEditors.get(parentId);
  if (view && !view.isDestroyed) {
    const { doc } = view.state;
    if (opts.ifMissing) {
      let present = false;
      doc.forEach((n) => {
        if (refers(n.attrs)) present = true;
      });
      if (present) return;
    }
    const last = doc.lastChild;
    const tr = view.state.tr;
    const node = isDb ? schema.nodes.database.create({ databaseId: childId }) : schema.nodes.page.create({ pageId: childId });
    if (last && last.type === schema.nodes.paragraph && last.content.size === 0 && doc.childCount > 1) {
      tr.insert(doc.content.size - last.nodeSize, node);
    } else if (last && last.type === schema.nodes.paragraph && last.content.size === 0) {
      tr.replaceWith(0, doc.content.size, node);
    } else {
      tr.insert(doc.content.size, node);
    }
    // Nicht rückgängig machbar: ⌘Z im Editor würde sonst die Verschiebung über die Seitenleiste halb zurückdrehen
    view.dispatch(tr.setMeta("addToHistory", false));
    return;
  }
  const page = await api.getPage(parentId);
  if (!page || page.kind !== "page") return;
  const prev: DocJSON = page.content ?? { type: "doc", content: [] };
  if (opts.ifMissing && (prev.content ?? []).some((b) => refers(b.attrs))) return;
  const blocks = (prev.content ?? []).filter((b, _i, arr) => !(arr.length === 1 && b.type === "paragraph" && !b.content?.length));
  const block = isDb ? { type: "database", attrs: { indent: 0, databaseId: childId } } : { type: "page", attrs: { indent: 0, pageId: childId } };
  const next: DocJSON = { type: "doc", content: [...blocks, block] };
  await saveContent(parentId, next, analyzeDoc(prev));
}

/** Entfernt Seiten-/Datenbankblöcke, die auf `childId` zeigen, aus der Elternseite. */
export async function removePageBlock(parentId: ID, childId: ID) {
  const refers = refersTo(childId);
  const view = openEditors.get(parentId);
  if (view && !view.isDestroyed) {
    const tr = view.state.tr;
    const ranges: [number, number][] = [];
    view.state.doc.forEach((n, pos) => {
      if ((n.type === schema.nodes.page || n.type === schema.nodes.database) && refers(n.attrs)) ranges.push([pos, pos + n.nodeSize]);
    });
    if (!ranges.length) return;
    for (const [from, to] of ranges.reverse()) tr.delete(from, to);
    if (tr.doc.childCount === 0) tr.insert(0, schema.nodes.paragraph.create());
    view.dispatch(tr.setMeta("addToHistory", false));
    return;
  }
  const page = await api.getPage(parentId);
  if (!page?.content) return;
  const prev = page.content;
  const blocks = (prev.content ?? []).filter((b) => !((b.type === "page" || b.type === "database") && refers(b.attrs)));
  if (blocks.length === (prev.content ?? []).length) return;
  await saveContent(parentId, { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] }, analyzeDoc(prev));
}

/**
 * Ändert den ganzen Inhalt einer Seite von außen (z. B. Claude über MCP). Ist die Seite offen, läuft die
 * Änderung als eigener Schritt durch ihren Editor (⌘Z macht sie rückgängig, der Editor speichert selbst);
 * sonst wird direkt gespeichert. `snapshot`: den bisherigen Stand vorher im Versionsverlauf sichern.
 */
export async function editPageContent(pageId: ID, edit: (doc: DocJSON) => DocJSON, opts: { snapshot?: boolean } = {}) {
  let view = openEditors.get(pageId);
  if (view && !view.isDestroyed) {
    if (opts.snapshot) {
      // Erst Ungespeichertes sichern, dann genau diesen Stand als Version festhalten
      await flushAll();
      view = openEditors.get(pageId);
      if (view && !view.isDestroyed) await api.updatePage(pageId, { content: view.state.doc.toJSON() as DocJSON, snapshot: true });
    }
  }
  if (view && !view.isDestroyed) {
    const next = PMNode.fromJSON(schema, edit(view.state.doc.toJSON() as DocJSON));
    next.check();
    view.dispatch(closeHistory(view.state.tr.replaceWith(0, view.state.doc.content.size, next.content)));
    return;
  }
  const page = await api.getPage(pageId);
  if (!page) throw new Error("Seite nicht gefunden");
  const prev: DocJSON = page.content ?? { type: "doc", content: [{ type: "paragraph" }] };
  const next = edit(prev);
  PMNode.fromJSON(schema, next).check();
  await saveContent(pageId, next, analyzeDoc(prev), opts);
}

// Verschieben über Seitenleiste/Titelleiste: Block wandert mit (alte Elternseite verliert ihn, neue bekommt ihn)
on("moved", ({ id, parentId, from }: { id: ID; parentId: ID | null; from?: ID | null }) => {
  if (from === undefined || from === parentId) return;
  if (from && ws.pages[from]?.kind === "page") void removePageBlock(from, id);
  if (parentId && ws.pages[parentId]?.kind === "page") void appendPageBlock(parentId, id, { ifMissing: true });
});

// Wiederhergestellte Seite bekommt ihren Block in der Elternseite zurück (sonst fehlt er dort dauerhaft)
on("restored", ({ rootId, reattach }: { rootId?: ID; reattach?: boolean }) => {
  if (!reattach) return;
  const parentId = rootId ? ws.pages[rootId]?.parentId : null;
  if (rootId && parentId && ws.pages[parentId]?.kind === "page") void appendPageBlock(parentId, rootId, { ifMissing: true });
});

// Wird eine Seite über Sidebar/Menü gelöscht, verschwindet ihr Block aus der Elternseite (wie in Notion).
on("trashed", ({ rootId, parentId }: { rootId?: ID; parentId?: ID | null }) => {
  // Datenbankzeilen haben keinen Block in ihrer Datenbank
  if (rootId && parentId && ws.pages[parentId]?.kind !== "database") void removePageBlock(parentId, rootId);
});
