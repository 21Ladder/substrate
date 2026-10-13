import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { ID } from "../../api/types";
import { editorUI } from "../ui";

// Erkennt "/", "@" und "[[" und steuert die zugehörigen Vorschlagsmenüs.

interface SuggestPluginState {
  from: number;
  trigger: "/" | "@" | "[[";
}

export const suggestKey = new PluginKey<SuggestPluginState | null>("suggest");

/** Tastatur-Handler des gerade offenen Menüs (wird von der Menükomponente gesetzt). */
let menuKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
export function setSuggestKeyHandler(h: ((e: KeyboardEvent) => boolean) | null) {
  menuKeyHandler = h;
}

export function closeSuggest(view: EditorView) {
  if (suggestKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(suggestKey, { close: true }));
}

/** Löscht Auslöser + Suchtext aus dem Dokument und schließt das Menü. */
export function consumeSuggest(view: EditorView) {
  const st = suggestKey.getState(view.state);
  if (!st) return;
  const to = view.state.selection.head;
  const tr = view.state.tr.delete(st.from, Math.max(st.from, to)).setMeta(suggestKey, { close: true });
  view.dispatch(tr);
}

export function suggestPlugin(pageId: ID) {
  return new Plugin<SuggestPluginState | null>({
    key: suggestKey,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(suggestKey);
        if (meta?.close) return null;
        if (meta?.open) return { from: meta.from, trigger: meta.trigger };
        if (!value) return null;
        const from = tr.mapping.map(value.from);
        const sel = state.selection;
        const len = value.trigger.length;
        if (!sel.empty || sel.head < from + len) return null;
        const $from = state.doc.resolve(from);
        if ($from.parent !== sel.$head.parent) return null;
        const text = state.doc.textBetween(from, sel.head, "\n", "\n");
        if (!text.startsWith(value.trigger)) return null;
        const query = text.slice(len);
        if (query.length > 50 || query.includes("\n")) return null;
        if (value.trigger === "/" && /\s\s/.test(query)) return null;
        return { from, trigger: value.trigger };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view;
        const $from = state.doc.resolve(from);
        if ($from.parent.type.spec.code) return false;
        let trigger: SuggestPluginState["trigger"] | null = null;
        let start = from;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
        // Nur am Anfang oder nach Leerzeichen – sonst blitzt das Menü bei „und/oder“ oder URLs auf
        if (text === "/") {
          if (!before || /\s/.test(before)) trigger = "/";
        } else if (text === "@") {
          // Nicht mitten in einem Wort (z. B. E-Mail-Adressen)
          if (!before || /\s/.test(before)) trigger = "@";
        } else if (text === "[" && $from.parentOffset > 0) {
          const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset);
          if (before === "[") {
            trigger = "[[";
            start = from - 1;
          }
        }
        if (!trigger) return false;
        const tr = state.tr.insertText(text, from, to).setMeta(suggestKey, { open: true, from: start, trigger });
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view, event) {
        const st = suggestKey.getState(view.state);
        if (!st) return false;
        if (event.key === "Escape") {
          closeSuggest(view);
          return true;
        }
        if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key) && menuKeyHandler) {
          return menuKeyHandler(event);
        }
        return false;
      },
    },
    view(editorView) {
      return {
        update(view) {
          const st = suggestKey.getState(view.state);
          const cur = editorUI.suggest();
          if (st) {
            const query = view.state.doc.textBetween(st.from + st.trigger.length, view.state.selection.head, "\n", "\n");
            if (!cur || cur.view !== view || cur.query !== query || cur.from !== st.from || cur.trigger !== st.trigger) {
              editorUI.setSuggest({ view, from: st.from, query, trigger: st.trigger, pageId });
            }
          } else if (cur && cur.view === view) {
            editorUI.setSuggest(null);
          }
        },
        destroy() {
          if (editorUI.suggest()?.view === editorView) editorUI.setSuggest(null);
        },
      };
    },
  });
}
