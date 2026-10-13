import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { history } from "prosemirror-history";
import { gapCursor } from "prosemirror-gapcursor";
import { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { api } from "../api/client";
import type { DocJSON, ID } from "../api/types";
import { analyzeDoc, type DocInfo } from "./doc";
import { docToMarkdown, looksLikeMarkdown, markdownToDoc } from "./markdown";
import { buildKeymap } from "./keymap";
import { buildNodeViews } from "./nodeviews";
import { blockHandlePlugin } from "./plugins/blockhandle";
import { focusPlugin, structurePlugin } from "./plugins/decorations";
import { buildInputRules } from "./plugins/inputrules";
import { suggestPlugin } from "./plugins/suggest";
import { codeHighlightPlugin } from "./plugins/highlight";
import { blockAt, insertBlock } from "./blocks";
import { emptyDoc, schema } from "./schema";
import { editorContexts, editorUI, openEditors, type EditorContext } from "./ui";
import { pageTitle, safeHref } from "../lib/util";
import { registerPending, reportSaveState, trackWrite, unregisterPending, ws } from "../state/workspace";
import { uuid } from "../lib/id";
import { saveContent } from "../state/pageSave";
import { createDatabasePage, createSubpageFromEditor } from "./actions";
import { toast } from "../components/popovers";

export interface EditorHandle {
  view: EditorView;
  focusStart: () => void;
  flush: () => Promise<void>;
}

const SAVE_DELAY = 400;

/** Ungespeicherte Stände geschlossener Editoren (Speichern schlug fehl) – je Seite der neueste. */
const unsavedClosed = new Map<ID, { key: string; json: DocJSON; handOver: () => void }>();

/** Verschachtelte HTML-Listen (z. B. aus Google Docs) in flache Blöcke mit Einzug umwandeln. */
export function flattenLists(html: string): string {
  if (!/<(ul|ol)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const process = (list: Element, depth: number): Element[] => {
    const out: Element[] = [];
    for (const li of Array.from(list.children)) {
      if (li.tagName !== "LI") continue;
      const div = doc.createElement("div");
      const box = li.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]") as HTMLInputElement | null;
      div.setAttribute("data-block", box ? "todo" : list.tagName === "OL" ? "numbered" : "bullet");
      if (box) div.setAttribute("data-checked", String(box.checked || box.hasAttribute("checked")));
      div.setAttribute("data-indent", String(Math.min(depth, 12)));
      const nested: Element[] = [];
      for (const child of Array.from(li.childNodes)) {
        if (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL")) nested.push(...process(child, depth + 1));
        else if (child instanceof Element && child.tagName === "INPUT") continue;
        else if (child instanceof Element && child.tagName === "P") div.append(...Array.from(child.childNodes).filter((n) => !(n instanceof HTMLInputElement)));
        else div.append(child);
      }
      out.push(div, ...nested);
    }
    return out;
  };
  for (const list of Array.from(doc.body.querySelectorAll("ul, ol"))) {
    if (list.closest("li")) continue;
    list.replaceWith(...process(list, 0));
  }
  return doc.body.innerHTML;
}

async function uploadFiles(files: File[]): Promise<PMNode[]> {
  const nodes: PMNode[] = [];
  for (const f of files) {
    let url: string;
    try {
      url = (await api.uploadFile(f)).url;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (f.type.startsWith("image/")) nodes.push(schema.nodes.image.create({ src: url }));
    else if (f.type.startsWith("video/")) nodes.push(schema.nodes.file.create({ src: url, name: f.name, kind: "video" }));
    else if (f.type.startsWith("audio/")) nodes.push(schema.nodes.file.create({ src: url, name: f.name, kind: "audio" }));
    else nodes.push(schema.nodes.file.create({ src: url, name: f.name, kind: "file" }));
  }
  return nodes;
}

export function Editor(props: {
  pageId: ID;
  content: DocJSON | null;
  readOnly?: boolean;
  onReady?: (h: EditorHandle) => void;
  onFocusTitle?: () => void;
}) {
  let mount!: HTMLDivElement;
  let view: EditorView | undefined;
  const [version, setVersion] = createSignal(0);
  let lastInfo: DocInfo | null = analyzeDoc(props.content);
  let dirty = false;
  let timer: number | undefined;
  let saving: Promise<void> = Promise.resolve();
  /** Noch nicht erfolgreich gespeicherter Stand – bleibt auch nach dem Schließen erhalten (Wiederholung). */
  let pendingJson: DocJSON | null = null;
  const pendingKey = `editor:${props.pageId}:${uuid()}`;
  /** Wartezeit bis zum nächsten Versuch nach einem Fehler (2 s, 4 s, … höchstens 30 s). */
  let retryDelay = 2000;
  /** Editor geschlossen: nach dem letzten erfolgreichen Speichern abmelden. */
  let closed = false;
  /** Von einem neu geöffneten Editor derselben Seite übernommen: nicht mehr selbst speichern. */
  let handedOver = false;

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    if (view && dirty) {
      pendingJson = view.state.doc.toJSON() as DocJSON;
      dirty = false;
    }
    if (!pendingJson || handedOver) return saving;
    const json = pendingJson;
    saving = saving.then(async () => {
      if (pendingJson !== json) return; // ein neuerer Stand folgt ohnehin
      try {
        // Vergleich mit dem Stand des vorherigen (abgeschlossenen) Speicherns
        lastInfo = await saveContent(props.pageId, json, lastInfo);
        if (pendingJson === json) pendingJson = null;
        retryDelay = 2000;
        reportSaveState(pendingKey, false);
        // Geschlossener Editor: erst jetzt (auch nach späteren Wiederholungen) abmelden
        if (closed && !pendingJson) {
          unregisterPending(pendingKey);
          if (unsavedClosed.get(props.pageId)?.key === pendingKey) unsavedClosed.delete(props.pageId);
        }
      } catch (e) {
        console.error("Speichern fehlgeschlagen", e);
        if (handedOver) return;
        reportSaveState(pendingKey, true);
        clearTimeout(timer);
        timer = window.setTimeout(() => void flush(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    });
    return trackWrite(saving);
  };

  const schedule = () => {
    dirty = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), SAVE_DELAY);
  };

  const ctx: EditorContext = {
    pageId: props.pageId,
    readOnly: !!props.readOnly,
    docVersion: version,
    createSubpage: (v) => createSubpageFromEditor(v, props.pageId, flush),
    createDatabase: (v, viewType, inline) => createDatabasePage(v, props.pageId, viewType as any, inline, flush),
    // Pfeil hoch/Backspace am Anfang → Titel (als Tastenbefehl, damit offene Menüs Vorrang haben)
    // Ohne Titel (z. B. Versionsverlauf) keinen Befehl – sonst verschluckt er ↑ und Backspace
    focusTitle: props.onFocusTitle ? () => props.onFocusTitle?.() : undefined,
  };

  // Ein geschlossener Editor dieser Seite konnte zuletzt nicht speichern: seinen neueren Stand übernehmen
  // (sonst würde seine spätere Wiederholung die neuen Änderungen überschreiben)
  const inherited = props.readOnly ? undefined : unsavedClosed.get(props.pageId);
  if (inherited) {
    unsavedClosed.delete(props.pageId);
    inherited.handOver();
  }

  onMount(() => {
    let doc: PMNode;
    try {
      const initial = inherited?.json ?? props.content;
      doc = initial ? PMNode.fromJSON(schema, initial) : emptyDoc();
      doc.check();
    } catch (e) {
      console.error("Ungültiges Dokument, wird repariert", e);
      // Den übernommenen ungespeicherten Stand reparieren, nicht verwerfen
      doc = repairDoc(inherited?.json ?? props.content);
    }

    // Während die Maus noch markiert, keine Leiste zeigen (kein Flackern) – erst nach dem Loslassen
    // Ende: Maus losgelassen, Ziehen begonnen (danach kommt kein mouseup) oder eine Taste gedrückt.
    let mouseSelecting = false;
    let endMouseSelect: ((silent?: boolean) => void) | null = null;
    const toolbarPlugin = new Plugin({
      view: () => ({
        update(v) {
          const sel = v.state.selection;
          const show =
            !mouseSelecting &&
            v.hasFocus() &&
            !sel.empty &&
            sel instanceof TextSelection &&
            !sel.$from.parent.type.spec.code &&
            v.state.doc.textBetween(sel.from, sel.to).trim().length > 0;
          const cur = editorUI.toolbar();
          if (show && (!cur || cur.view !== v)) editorUI.setToolbar({ view: v, pageId: props.pageId });
          else if (!show && cur?.view === v) editorUI.setToolbar(null);
        },
        destroy() {
          endMouseSelect?.(true); // nur aufräumen – während destroy nichts mehr in die View schicken
          if (editorUI.toolbar()?.view === view) editorUI.setToolbar(null);
        },
      }),
      props: {
        handleDOMEvents: {
          blur: (v) => {
            setTimeout(() => {
              if (!v.isDestroyed && !v.hasFocus() && editorUI.toolbar()?.view === v && !document.activeElement?.closest(".format-toolbar, .popover")) editorUI.setToolbar(null);
            }, 0);
            return false;
          },
          mousedown: (v, e) => {
            if (e.button !== 0) return false;
            endMouseSelect?.();
            mouseSelecting = true;
            if (editorUI.toolbar()?.view === v) editorUI.setToolbar(null);
            const events = ["mouseup", "dragstart", "keydown"] as const;
            const end = (silent?: boolean) => {
              events.forEach((t) => window.removeEventListener(t, onEvent, true));
              endMouseSelect = null;
              mouseSelecting = false;
              // Leiste jetzt für die fertige Auswahl berechnen
              if (!silent && !v.isDestroyed) v.dispatch(v.state.tr.setMeta("toolbar-refresh", true));
            };
            const onEvent = () => end();
            events.forEach((t) => window.addEventListener(t, onEvent, true));
            endMouseSelect = end;
            return false;
          },
        },
      },
    });

    const state = EditorState.create({
      doc,
      plugins: [
        suggestPlugin(props.pageId),
        buildInputRules(),
        ...buildKeymap(ctx),
        history({ depth: 200, newGroupDelay: 600 }),
        focusPlugin,
        structurePlugin,
        codeHighlightPlugin,
        // Cursor auch zwischen zwei Bildern/Datenbanken bzw. vor dem ersten Atom-Block setzen
        gapCursor(),
        blockHandlePlugin(props.pageId, !!props.readOnly),
        toolbarPlugin,
      ],
    });

    view = new EditorView(mount, {
      state,
      editable: () => !props.readOnly,
      nodeViews: buildNodeViews(ctx) as any,
      attributes: { class: "editor", spellcheck: "true", "data-page": props.pageId },
      dispatchTransaction(tr) {
        if (!view) return;
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.docChanged) {
          setVersion((v) => v + 1);
          schedule();
        }
        editorUI.bump();
      },
      transformPastedHTML: flattenLists,
      // Internes Verschieben per Drag & Drop ist ein Umzug, kein Kopieren
      transformPasted: (slice, v) => (v.dragging?.move ? slice : keepPageOwnership(slice, props.pageId)),
      clipboardTextParser(text, $context, plain) {
        if (plain || $context.parent.type.spec.code || !looksLikeMarkdown(text)) return undefined as unknown as Slice;
        try {
          const json = markdownToDoc(text);
          const d = PMNode.fromJSON(schema, json);
          const first = d.firstChild!;
          const last = d.lastChild!;
          const open = first.isTextblock && last.isTextblock && d.childCount === 1 ? 1 : 0;
          return new Slice(d.content, open, open);
        } catch {
          return undefined as unknown as Slice;
        }
      },
      clipboardTextSerializer(slice) {
        let blockContent = false;
        slice.content.forEach((n) => {
          if (n.isBlock) blockContent = true;
        });
        if (!blockContent) return slice.content.textBetween(0, slice.content.size, "\n\n", "\n");
        const json = { type: "doc", content: (slice.content.toJSON() as DocJSON[]) ?? [] };
        return docToMarkdown(json, { titleOf: (id) => pageTitle(ws.pages[id]?.title) }).trimEnd();
      },
      handlePaste(v, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length || props.readOnly) {
          // URL einfügen auf markierten Text → Link setzen (wie Notion)
          const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
          const href = /^https?:\/\/\S+$/.test(text) ? safeHref(text) : null;
          if (href && !v.state.selection.empty && !v.state.selection.$from.parent.type.spec.code) {
            v.dispatch(v.state.tr.addMark(v.state.selection.from, v.state.selection.to, schema.marks.link.create({ href })));
            return true;
          }
          return false;
        }
        event.preventDefault();
        void uploadFiles(files).then((nodes) => {
          let st = v.state;
          for (const n of nodes) {
            const tr = insertBlock(st, n, { trailingParagraph: false });
            v.dispatch(tr);
            st = v.state;
          }
        });
        return true;
      },
      handleDrop(v, event, _slice, moved) {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !files.length || props.readOnly) return false;
        event.preventDefault();
        const coords = v.posAtCoords({ left: event.clientX, top: event.clientY });
        const at = coords ? blockAt(v.state.doc, coords.pos) : null;
        const docAtDrop = v.state.doc;
        void uploadFiles(files).then((nodes) => {
          if (v.isDestroyed) return;
          // Wurde während des Hochladens bearbeitet, ist die alte Position ungültig → ans Ende
          const pos = at && v.state.doc === docAtDrop ? at.pos + at.node.nodeSize : v.state.doc.content.size;
          v.dispatch(v.state.tr.insert(pos, Fragment.from(nodes)));
        });
        return true;
      },
      handleClickOn(_v, _pos, node, _nodePos, event) {
        // Links öffnen (Notion öffnet Links per Klick)
        const a = (event.target as HTMLElement).closest("a.link") as HTMLAnchorElement | null;
        if (a && node.isTextblock) {
          event.preventDefault();
          const href = safeHref(a.getAttribute("href") ?? "");
          if (href) void api.openURL(href);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        click: (_v, e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (a) e.preventDefault();
          return false;
        },
      },
    });

    editorContexts.set(view, ctx);
    if (!props.readOnly) openEditors.set(props.pageId, view);
    registerPending(pendingKey, flush);
    // Übernommener, noch nicht gespeicherter Stand: sofort (erneut) speichern
    if (inherited) schedule();
    // Sperren/Entsperren: "editable" neu auswerten, ohne den Editor neu aufzubauen
    createEffect(
      on(
        () => props.readOnly,
        () => view?.setProps({}),
        { defer: true },
      ),
    );
    props.onReady?.({
      view,
      focusStart: () => {
        if (!view) return;
        view.focus();
        view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView());
      },
      flush,
    });
  });

  onCleanup(() => {
    // Abmelden erst, wenn wirklich gespeichert ist (sonst wartet flushAll beim Beenden weiter darauf).
    // Schlägt das Speichern fehl, übernimmt der Wiederholungs-Timer – und meldet nach dem Erfolg ab.
    closed = true;
    void flush().then(() => {
      if (!pendingJson) unregisterPending(pendingKey);
      else if (!handedOver) {
        // Speichern scheitert weiter: Stand für einen neu geöffneten Editor bereithalten
        unsavedClosed.set(props.pageId, {
          key: pendingKey,
          json: pendingJson,
          handOver: () => {
            handedOver = true;
            clearTimeout(timer);
            reportSaveState(pendingKey, false);
            unregisterPending(pendingKey);
          },
        });
      }
    });
    if (view && openEditors.get(props.pageId) === view) openEditors.delete(props.pageId);
    view?.destroy();
    view = undefined;
  });

  return <div class="editor-container" ref={mount} />;
}

/**
 * Eine Seite hat genau einen Elternblock. Wird ein Seiten-/Datenbankblock kopiert (statt ausgeschnitten),
 * fügen wir stattdessen eine Erwähnung ein – sonst würde die Seite ihrem Original „gestohlen“.
 */
function keepPageOwnership(slice: Slice, targetPage: ID): Slice {
  let changed = false;
  const map = (frag: Fragment): Fragment => {
    const out: PMNode[] = [];
    frag.forEach((n) => {
      const ref = n.type === schema.nodes.page ? n.attrs.pageId : n.type === schema.nodes.database ? n.attrs.databaseId : null;
      if (ref && stillReferencedElsewhere(String(ref), targetPage)) {
        changed = true;
        out.push(schema.nodes.paragraph.create({ indent: n.attrs.indent }, schema.nodes.mention.create({ pageId: ref })));
      } else out.push(n);
    });
    return Fragment.from(out);
  };
  const content = map(slice.content);
  return changed ? new Slice(content, slice.openStart, slice.openEnd) : slice;
}

/** Steht der Block noch in der Elternseite? (Ausschneiden entfernt ihn dort sofort aus dem offenen Editor.) */
function stillReferencedElsewhere(pageId: ID, targetPage: ID): boolean {
  const page = ws.pages[pageId];
  if (!page || !page.parentId) return false;
  const parentView = openEditors.get(page.parentId);
  if (!parentView || parentView.isDestroyed) {
    // Elternseite nicht offen: Block gilt als vorhanden, außer die Seite wird in ihre eigene Elternseite eingefügt
    return page.parentId !== targetPage;
  }
  let found = false;
  parentView.state.doc.forEach((n) => {
    if ((n.attrs.pageId ?? n.attrs.databaseId) === pageId && (n.type === schema.nodes.page || n.type === schema.nodes.database)) found = true;
  });
  return found;
}

/** Repariert ein ungültiges Dokument, indem nur gültige Blöcke übernommen werden. */
function repairDoc(json: DocJSON | null): PMNode {
  const blocks: PMNode[] = [];
  for (const b of json?.content ?? []) {
    try {
      const n = PMNode.fromJSON(schema, b);
      n.check();
      blocks.push(n);
    } catch {
      const text = (b.content ?? []).map((c) => c.text ?? "").join("");
      if (text) blocks.push(schema.nodes.paragraph.create(null, schema.text(text)));
    }
  }
  return schema.node("doc", null, blocks.length ? blocks : [schema.nodes.paragraph.create()]);
}
