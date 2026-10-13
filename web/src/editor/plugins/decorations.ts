import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";

// Nummerierung, eingeklappte Toggles, Aufzählungszeichen je Ebene und Platzhalter.

const roman = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];

function alpha(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function formatNumber(n: number, depth: number): string {
  switch (depth % 3) {
    case 1:
      return alpha(n) + ".";
    case 2:
      return (roman[n - 1] ?? String(n)) + ".";
    default:
      return n + ".";
  }
}

const PLACEHOLDERS: Record<string, string> = {
  bullet: "Liste",
  numbered: "Liste",
  todo: "To-do",
  toggle: "Toggle",
  quote: "Leeres Zitat",
  callout: "Leer",
};

export const focusKey = new PluginKey<boolean>("focus");

/** Merkt sich, ob der Editor fokussiert ist (für Platzhalter). */
export const focusPlugin = new Plugin<boolean>({
  key: focusKey,
  state: {
    init: () => false,
    apply: (tr, value) => {
      const meta = tr.getMeta(focusKey);
      return typeof meta === "boolean" ? meta : value;
    },
  },
  props: {
    handleDOMEvents: {
      focus: (view) => {
        view.dispatch(view.state.tr.setMeta(focusKey, true));
        return false;
      },
      blur: (view) => {
        // Kurz verzögert, damit Klicks in Menüs nicht flackern.
        setTimeout(() => {
          if (!view.isDestroyed && !view.hasFocus()) view.dispatch(view.state.tr.setMeta(focusKey, false));
        }, 0);
        return false;
      },
    },
  },
});

function structureDecorations(doc: PMNode): Decoration[] {
  const decos: Decoration[] = [];
  const counters: number[] = [];
  const lastType: (string | undefined)[] = [];
  let hideAbove = -1; // Einzug des eingeklappten Toggles, unter dem verborgen wird
  let pos = 0;
  doc.forEach((node) => {
    const indent = node.attrs.indent as number;
    const end = pos + node.nodeSize;
    if (hideAbove >= 0 && indent > hideAbove) {
      decos.push(Decoration.node(pos, end, { class: "hidden-block" }));
    } else {
      hideAbove = -1;
      if (node.type === schema.nodes.toggle && !node.attrs.open) hideAbove = indent;
    }
    // Ebenen tiefer als der aktuelle Block beenden ihre Listen.
    lastType.length = Math.min(lastType.length, indent + 1);
    counters.length = Math.min(counters.length, indent + 1);
    if (node.type === schema.nodes.numbered) {
      const n = lastType[indent] === "numbered" ? (counters[indent] ?? 0) + 1 : 1;
      counters[indent] = n;
      decos.push(Decoration.node(pos, end, { "data-num": formatNumber(n, indent) }));
    }
    lastType[indent] = node.type.name;
    pos = end;
  });
  return decos;
}

/**
 * Ändert die Transaktion nur Inhalte INNERHALB von Blöcken (Tippen, Löschen, Markierungen)?
 * Dann bleiben Art, Attribute und Anzahl aller Blöcke gleich, und die Dekorationen lassen sich verschieben.
 */
function onlyInsideBlocks(tr: Transaction): boolean {
  return tr.steps.every((step, i) => {
    if (!(step instanceof ReplaceStep || step instanceof AddMarkStep || step instanceof RemoveMarkStep)) return false;
    const { from, to } = step as unknown as { from: number; to: number };
    const $from = tr.docs[i].resolve(from);
    if ($from.depth < 1 || $from.sharedDepth(to) < 1) return false;
    // Eingefügter Inhalt muss reiner Inline-Inhalt sein (Enter teilt sonst „innerhalb“ einen Block)
    if (step instanceof ReplaceStep) {
      const slice = step.slice;
      if (slice.openStart !== 0 || slice.openEnd !== 0) return false;
      let inline = true;
      slice.content.forEach((n) => {
        if (!n.isInline) inline = false;
      });
      return inline;
    }
    return true;
  });
}

export const structureKey = new PluginKey<DecorationSet>("structure");

export const structurePlugin = new Plugin<DecorationSet>({
  key: structureKey,
  state: {
    init: (_, state) => DecorationSet.create(state.doc, structureDecorations(state.doc)),
    apply: (tr, old, _o, state) => {
      if (!tr.docChanged) return old;
      // Häufigster Fall (Tippen): Blöcke unverändert in Art/Attributen → Dekorationen nur verschieben.
      // Neu berechnen kostet bei langen Seiten sonst ~20 ms pro Taste.
      return onlyInsideBlocks(tr) ? old.map(tr.mapping, state.doc) : DecorationSet.create(state.doc, structureDecorations(state.doc));
    },
  },
  props: {
    decorations(state) {
      const base = structureKey.getState(state)!;
      const extra: Decoration[] = [];
      const focused = focusKey.getState(state);
      const { selection, doc } = state;
      // Überschriften zeigen ihren Platzhalter immer, andere nur am Cursor.
      doc.forEach((node, pos) => {
        if (!node.isTextblock || node.content.size > 0 || node.type === schema.nodes.code_block) return;
        const hasCursor = focused && selection.empty && selection.$from.depth === 1 && selection.$from.before(1) === pos;
        let text: string | null = null;
        if (node.type === schema.nodes.heading) text = `Überschrift ${node.attrs.level}`;
        else if (hasCursor) text = PLACEHOLDERS[node.type.name] ?? "Tippe „/“ für Befehle …";
        if (text) extra.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-empty", "data-placeholder": text }));
      });
      return extra.length ? base.add(doc, extra) : base;
    },
  },
});
