import { Fragment, type Node as PMNode, type NodeType } from "prosemirror-model";
import { EditorState, NodeSelection, Selection, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { schema, TEXT_BLOCKS } from "./schema";

// Hilfsfunktionen für das flache Blockmodell.

export interface BlockInfo {
  node: PMNode;
  index: number;
  pos: number;
}

export function blockStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** Top-Level-Block, der die Position enthält. */
export function blockAt(doc: PMNode, pos: number): BlockInfo {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  let index = $pos.index(0);
  if (index >= doc.childCount) index = doc.childCount - 1;
  return { node: doc.child(index), index, pos: $pos.depth === 0 ? blockStart(doc, index) : $pos.before(1) };
}

/** Indizes des ersten und letzten von der Auswahl berührten Blocks. */
export function selectedRange(state: EditorState): [number, number] {
  const { doc, selection } = state;
  if (selection instanceof NodeSelection && selection.$from.depth === 0) {
    const i = selection.$from.index(0);
    return [i, i];
  }
  const from = blockAt(doc, selection.from).index;
  let to = blockAt(doc, selection.to).index;
  // Auswahl endet genau am Anfang eines Blocks → diesen nicht mitnehmen.
  if (to > from && selection.to === blockStart(doc, to) + 1 && !selection.empty) to--;
  return [from, to];
}

/** Letzter Index des Teilbaums (Block + eingerückte Nachfolger). */
export function subtreeEnd(doc: PMNode, index: number): number {
  const indent = doc.child(index).attrs.indent as number;
  let end = index;
  while (end + 1 < doc.childCount && (doc.child(end + 1).attrs.indent as number) > indent) end++;
  return end;
}

export function hasChildren(doc: PMNode, index: number): boolean {
  return index + 1 < doc.childCount && (doc.child(index + 1).attrs.indent as number) > (doc.child(index).attrs.indent as number);
}

/** Bereich inklusive aller Kinder des letzten Blocks. */
export function rangeWithChildren(doc: PMNode, from: number, to: number): [number, number] {
  let end = to;
  for (let i = from; i <= to; i++) end = Math.max(end, subtreeEnd(doc, i));
  return [from, end];
}

function setAttrs(tr: Transaction, index: number, attrs: Record<string, unknown>) {
  const pos = blockStart(tr.doc, index);
  const node = tr.doc.child(index);
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
}

/** Ein- bzw. ausrücken der ausgewählten Blöcke samt Kindern. */
export function indentCommand(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const [from, to] = selectedRange(state);
    const { doc } = state;
    const [, end] = rangeWithChildren(doc, from, to);
    const first = doc.child(from);
    if (delta > 0) {
      if (from === 0) return false;
      const prev = doc.child(from - 1);
      if ((first.attrs.indent as number) > (prev.attrs.indent as number)) return true; // schon maximal eingerückt
    } else {
      let anyIndented = false;
      for (let i = from; i <= to; i++) if ((doc.child(i).attrs.indent as number) > 0) anyIndented = true;
      if (!anyIndented) return false;
    }
    if (dispatch) {
      const tr = state.tr;
      for (let i = from; i <= end; i++) {
        const indent = doc.child(i).attrs.indent as number;
        // Beim Ausrücken bleiben Blöcke mit Einzug 0 stehen; ihre Kinder werden mitgenommen.
        if (delta < 0 && indent === 0) continue;
        setAttrs(tr, i, { indent: Math.max(0, Math.min(12, indent + delta)) });
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Wandelt die ausgewählten Blöcke in einen anderen Typ um (Notion "Umwandeln in"). */
export function turnInto(typeName: string, attrs: Record<string, unknown> = {}): Command {
  return (state, dispatch) => {
    const type = schema.nodes[typeName];
    if (!type) return false;
    const [from, to] = selectedRange(state);
    if (dispatch) {
      const tr = state.tr;
      for (let i = from; i <= to; i++) {
        const node = tr.doc.child(i);
        if (!node.isTextblock) continue;
        const pos = blockStart(tr.doc, i);
        const keep = { indent: node.attrs.indent, color: node.attrs.color };
        if (type === schema.nodes.code_block) {
          // Code-Blöcke enthalten nur reinen Text.
          const text = node.textContent;
          tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.code_block.create({ ...keep, ...attrs }, text ? schema.text(text) : null));
        } else if (node.type === schema.nodes.code_block) {
          const text = node.textContent;
          tr.replaceWith(pos, pos + node.nodeSize, type.create({ ...keep, ...attrs }, text ? schema.text(text) : null));
        } else {
          tr.setNodeMarkup(pos, type, { ...keep, ...attrs });
        }
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function setBlockColor(color: string | null): Command {
  return (state, dispatch) => {
    const [from, to] = selectedRange(state);
    if (dispatch) {
      const tr = state.tr;
      for (let i = from; i <= to; i++) setAttrs(tr, i, { color });
      dispatch(tr);
    }
    return true;
  };
}

/** Blöcke (mit Kindern) nach oben/unten verschieben – Cmd+Shift+Pfeil. */
export function moveBlocks(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { doc } = state;
    const [from0, to0] = selectedRange(state);
    const [from, to] = rangeWithChildren(doc, from0, to0);
    const indent = doc.child(from).attrs.indent as number;
    let target: number; // Index, vor dem eingefügt wird (im Dokument ohne den Bereich)
    if (dir < 0) {
      if (from === 0) return false;
      // vorheriges Geschwister (gleicher oder geringerer Einzug) finden
      let i = from - 1;
      while (i > 0 && (doc.child(i).attrs.indent as number) > indent) i--;
      target = i;
    } else {
      if (to + 1 >= doc.childCount) return false;
      const nextEnd = subtreeEnd(doc, to + 1);
      target = nextEnd + 1;
    }
    if (dispatch) {
      const start = blockStart(doc, from);
      const end = blockStart(doc, to) + doc.child(to).nodeSize;
      const slice = doc.slice(start, end);
      const selOffset = state.selection.from - start;
      const selOffsetTo = state.selection.to - start;
      const tr = state.tr.delete(start, end);
      const removed = to - from + 1;
      const insertIndex = dir < 0 ? target : target - removed;
      const insertPos = blockStart(tr.doc, insertIndex);
      tr.insert(insertPos, slice.content);
      // z. B. erstes Kind über seinen Elternblock geschoben → Einzug wieder gültig machen
      normalizeIndents(tr, 0);
      const isNodeSel = state.selection instanceof NodeSelection;
      if (isNodeSel) tr.setSelection(NodeSelection.create(tr.doc, insertPos + selOffset));
      else tr.setSelection(TextSelection.create(tr.doc, insertPos + selOffset, insertPos + selOffsetTo));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Dupliziert die ausgewählten Blöcke samt Kindern (Cmd+D). */
export const duplicateBlocks: Command = (state, dispatch) => {
  const { doc } = state;
  const [from0, to0] = selectedRange(state);
  const [from, to] = rangeWithChildren(doc, from0, to0);
  if (dispatch) {
    const start = blockStart(doc, from);
    const end = blockStart(doc, to) + doc.child(to).nodeSize;
    const content = duplicateFragment(doc.slice(start, end).content);
    const tr = state.tr.insert(end, content);
    const sel = Selection.near(tr.doc.resolve(end + 1));
    tr.setSelection(sel);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Unterseiten/Datenbanken dürfen nicht doppelt referenziert werden: beim Duplizieren als Link behalten. */
function duplicateFragment(f: Fragment): Fragment {
  const nodes: PMNode[] = [];
  f.forEach((n) => {
    if (n.type === schema.nodes.page || n.type === schema.nodes.database) {
      const title = schema.nodes.mention.create({ pageId: n.attrs.pageId || n.attrs.databaseId });
      nodes.push(schema.nodes.paragraph.create({ indent: n.attrs.indent }, title));
    } else nodes.push(n);
  });
  return Fragment.from(nodes);
}

export const deleteBlocks: Command = (state, dispatch) => {
  const { doc } = state;
  const [from, to] = selectedRange(state);
  if (dispatch) {
    const start = blockStart(doc, from);
    const end = blockStart(doc, to) + doc.child(to).nodeSize;
    const tr = state.tr;
    if (from === 0 && to === doc.childCount - 1) {
      tr.replaceWith(start, end, schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, 1));
    } else {
      tr.delete(start, end);
      // Kinder der gelöschten Blöcke rücken nach, damit die Struktur gültig bleibt.
      normalizeIndents(tr, from);
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), -1));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Stellt sicher, dass kein Block mehr als eine Stufe tiefer als sein Vorgänger eingerückt ist. */
export function normalizeIndents(tr: Transaction, fromIndex = 0) {
  const doc = tr.doc;
  let prevIndent = fromIndex > 0 && fromIndex - 1 < doc.childCount ? (doc.child(fromIndex - 1).attrs.indent as number) : -1;
  if (fromIndex === 0) prevIndent = -1;
  for (let i = fromIndex; i < tr.doc.childCount; i++) {
    const node = tr.doc.child(i);
    const indent = node.attrs.indent as number;
    const max = prevIndent + 1;
    if (indent > max) {
      tr.setNodeMarkup(blockStart(tr.doc, i), undefined, { ...node.attrs, indent: Math.max(0, max) });
      prevIndent = Math.max(0, max);
    } else {
      prevIndent = indent;
    }
  }
}

/** Cmd+Enter: To-do abhaken bzw. Toggle auf-/zuklappen. */
export const toggleBlockState: Command = (state, dispatch) => {
  const [from, to] = selectedRange(state);
  const tr = state.tr;
  let changed = false;
  for (let i = from; i <= to; i++) {
    const node = state.doc.child(i);
    if (node.type === schema.nodes.todo) {
      tr.setNodeMarkup(blockStart(tr.doc, i), undefined, { ...node.attrs, checked: !node.attrs.checked });
      changed = true;
    } else if (node.type === schema.nodes.toggle) {
      tr.setNodeMarkup(blockStart(tr.doc, i), undefined, { ...node.attrs, open: !node.attrs.open });
      changed = true;
    }
  }
  if (!changed) return false;
  if (dispatch) dispatch(tr);
  return true;
};

/** Cmd+Alt+T: alle Toggles auf- oder zuklappen. */
export const toggleAllToggles: Command = (state, dispatch) => {
  let anyOpen = false;
  state.doc.forEach((n) => {
    if (n.type === schema.nodes.toggle && n.attrs.open) anyOpen = true;
  });
  const tr = state.tr;
  state.doc.forEach((n, pos) => {
    if (n.type === schema.nodes.toggle) tr.setNodeMarkup(pos, undefined, { ...n.attrs, open: !anyOpen });
  });
  if (dispatch) dispatch(tr);
  return true;
};

/** Enter: Block teilen mit Notion-Verhalten. */
export const splitBlock: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to } = selection;
  if ($from.depth !== 1) return false;
  if ($from.parent !== $to.parent) {
    // Auswahl über mehrere Blöcke: nur löschen.
    if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView());
    return true;
  }
  const block = $from.parent;
  const name = block.type.name;
  if (!TEXT_BLOCKS.has(name)) return false;
  const index = $from.index(0);
  const indent = block.attrs.indent as number;
  const listLike = ["bullet", "numbered", "todo", "toggle", "quote", "callout"].includes(name);

  // Leerer Listenpunkt + Enter: erst ausrücken, dann in Text umwandeln.
  if (block.content.size === 0 && listLike) {
    if (indent > 0) return indentCommand(-1)(state, dispatch);
    return turnInto("paragraph")(state, dispatch);
  }
  if (!dispatch) return true;
  const tr = state.tr;

  // Cursor am Anfang eines nicht-leeren Blocks: leeren Block davor einfügen.
  if (selection.empty && $from.parentOffset === 0 && block.content.size > 0) {
    const pos = $from.before(1);
    const empty =
      name === "heading" ? schema.nodes.paragraph.create({ indent }) : block.type.create({ ...block.attrs, color: null, ...(name === "todo" ? { checked: false } : {}) });
    tr.insert(pos, empty);
    tr.setSelection(TextSelection.create(tr.doc, pos + empty.nodeSize + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  tr.deleteSelection();
  const $pos = tr.selection.$from;
  const atEnd = $pos.parentOffset === $pos.parent.content.size;
  const children = hasChildren(tr.doc, index);

  let type: NodeType = block.type;
  let attrs: Record<string, unknown> = { ...block.attrs, color: null };
  if (name === "todo") attrs.checked = false;
  if (name === "toggle") attrs.open = true;

  if (atEnd) {
    if (name === "heading" || name === "quote" || name === "callout") {
      type = schema.nodes.paragraph;
      attrs = { indent };
    }
    if (name === "toggle") {
      if (block.attrs.open) {
        // Offener Toggle: neuer Block wird erstes Kind.
        type = schema.nodes.paragraph;
        attrs = { indent: indent + 1 };
      } else if (children) {
        // Geschlossener Toggle: neuer Toggle hinter allen Kindern.
        const end = subtreeEnd(tr.doc, index);
        const pos = blockStart(tr.doc, end) + tr.doc.child(end).nodeSize;
        tr.insert(pos, schema.nodes.toggle.create({ indent, open: true }));
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        dispatch(tr.scrollIntoView());
        return true;
      }
    } else if (children) {
      attrs.indent = indent + 1;
    }
  }
  tr.split($pos.pos, 1, [{ type, attrs }]);
  dispatch(tr.scrollIntoView());
  return true;
};

/** Backspace am Blockanfang: Typ zurücksetzen, ausrücken, dann zusammenführen. */
export const backspaceAtStart: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.depth !== 1 || $from.parentOffset !== 0) return false;
  const block = $from.parent;
  if (block.type === schema.nodes.code_block && block.content.size > 0) return false;
  if (block.type !== schema.nodes.paragraph) {
    return turnInto("paragraph")(state, dispatch);
  }
  if ((block.attrs.indent as number) > 0) {
    if (dispatch) {
      const tr = state.tr.setNodeMarkup($from.before(1), undefined, { ...block.attrs, indent: (block.attrs.indent as number) - 1 });
      dispatch(tr);
    }
    return true;
  }
  return false;
};

/** Escape: aktuellen Block als Ganzes auswählen (Notion-Blockauswahl). */
export const selectBlock: Command = (state, dispatch) => {
  if (state.selection instanceof NodeSelection) return false;
  const { index } = blockAt(state.doc, state.selection.from);
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, blockStart(state.doc, index))));
  return true;
};

/** Cmd+A: erst Text des Blocks, dann alles. */
export const selectAllSmart: Command = (state, dispatch) => {
  const { selection } = state;
  const { $from, $to } = selection;
  if (selection instanceof TextSelection && $from.depth === 1 && $from.parent === $to.parent && $from.parent.content.size > 0) {
    const start = $from.start(1);
    const end = $from.end(1);
    if (selection.from !== start || selection.to !== end) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
      return true;
    }
  }
  return false; // weiter mit selectAll
};

/** Fügt einen Block nach dem aktuellen ein bzw. ersetzt einen leeren Absatz. */
export function insertBlock(state: EditorState, node: PMNode, opts: { replaceEmpty?: boolean; trailingParagraph?: boolean } = {}): Transaction {
  const { index, node: current, pos } = blockAt(state.doc, state.selection.from);
  const tr = state.tr;
  const indent = current.attrs.indent as number;
  const withIndent = node.type.spec.attrs?.indent ? node.type.create({ ...node.attrs, indent }, node.content, node.marks) : node;
  let insertPos: number;
  if (opts.replaceEmpty !== false && current.type === schema.nodes.paragraph && current.content.size === 0) {
    tr.replaceWith(pos, pos + current.nodeSize, withIndent);
    insertPos = pos;
  } else {
    insertPos = blockStart(state.doc, index) + current.nodeSize;
    tr.insert(insertPos, withIndent);
  }
  const after = insertPos + withIndent.nodeSize;
  if (withIndent.isAtom && opts.trailingParagraph !== false) {
    const next = tr.doc.resolve(after).nodeAfter;
    if (!next || !next.isTextblock) tr.insert(after, schema.nodes.paragraph.create({ indent }));
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  } else if (withIndent.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1 + withIndent.content.size));
  } else {
    tr.setSelection(NodeSelection.create(tr.doc, insertPos));
  }
  return tr.scrollIntoView();
}
