import { baseKeymap, chainCommands, exitCode, selectAll, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { GapCursor } from "prosemirror-gapcursor";
import { keymap } from "prosemirror-keymap";
import { NodeSelection, TextSelection, type Command } from "prosemirror-state";
import {
  backspaceAtStart,
  blockAt,
  deleteBlocks,
  duplicateBlocks,
  indentCommand,
  moveBlocks,
  selectAllSmart,
  selectBlock,
  splitBlock,
  toggleAllToggles,
  toggleBlockState,
  turnInto,
} from "./blocks";
import { schema } from "./schema";
import { editorUI, type EditorContext } from "./ui";

const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};

/** Enter in Code-Blöcken fügt Zeilenumbruch mit Einrückung der Vorzeile ein. */
const codeNewline: Command = (state, dispatch) => {
  const { $head, $anchor } = state.selection;
  if (!$head.parent.type.spec.code || !$head.sameParent($anchor)) return false;
  const text = $head.parent.textContent.slice(0, $head.parentOffset);
  const line = text.slice(text.lastIndexOf("\n") + 1);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (dispatch) dispatch(state.tr.insertText("\n" + indent).scrollIntoView());
  return true;
};

/** Tab im Code-Block: zwei Leerzeichen. */
const codeTab: Command = (state, dispatch) => {
  if (!state.selection.$head.parent.type.spec.code) return false;
  if (dispatch) dispatch(state.tr.insertText("  ").scrollIntoView());
  return true;
};

/** Cmd+Enter im Code-Block: Code verlassen. */
const exitCodeBlock: Command = (state, dispatch) => {
  if (!state.selection.$head.parent.type.spec.code) return false;
  const { $head } = state.selection;
  const after = $head.after(1);
  if (dispatch) {
    const tr = state.tr.insert(after, schema.nodes.paragraph.create({ indent: $head.parent.attrs.indent }));
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Pfeil nach unten im letzten Block: bei Atom/Code einen Absatz anhängen. */
const arrowDownAtEnd: Command = (state, dispatch, view) => {
  const { selection, doc } = state;
  const last = doc.lastChild!;
  const lastStart = doc.content.size - last.nodeSize;
  const inLast =
    (selection instanceof NodeSelection && selection.from === lastStart) ||
    (selection.empty && selection.$head.depth === 1 && selection.$head.before(1) === lastStart && last.type.spec.code && view?.endOfTextblock("down"));
  if (!inLast) return false;
  if (dispatch) {
    const tr = state.tr.insert(doc.content.size, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace/Entf bei Blockauswahl: ganze Blöcke löschen. */
const deleteSelectedBlock: Command = (state, dispatch) => {
  if (!(state.selection instanceof NodeSelection) || state.selection.$from.depth !== 0) return false;
  return deleteBlocks(state, dispatch);
};

/** Enter bei Blockauswahl: Cursor ans Ende des Blocks. */
const editSelectedBlock: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || !sel.node.isTextblock) return false;
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.from + 1 + sel.node.content.size)));
  return true;
};

/** Pfeiltasten bei Blockauswahl: vorherigen/nächsten Block auswählen. */
function moveBlockSelection(dir: -1 | 1, extend = false): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof NodeSelection) || sel.$from.depth !== 0) return false;
    if (extend) return false;
    const index = sel.$from.index(0) + dir;
    if (index < 0) return false; // erster Block: weiter an „↑ → Titel“
    if (index >= state.doc.childCount) return true;
    let pos = 0;
    for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
    if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView());
    return true;
  };
}

/** Pfeil hoch im ersten Block (oberste Zeile) → Cursor in den Seitentitel. */
const focusTitleUp =
  (ctx: EditorContext): Command =>
  (state, _d, view) => {
    const sel = state.selection;
    if (!ctx.focusTitle || !view) return false;
    // Erster Block als Ganzes ausgewählt (z. B. Bild) oder Gap-Cursor ganz am Anfang
    const atStart = (sel instanceof NodeSelection && sel.$from.depth === 0 && sel.from === 0) || (sel instanceof GapCursor && sel.from === 0);
    if (!atStart) {
      if (!(sel instanceof TextSelection) || !sel.empty) return false;
      if (sel.$from.depth !== 1 || sel.$from.index(0) !== 0 || !view.endOfTextblock("up")) return false;
    }
    ctx.focusTitle();
    return true;
  };

/** Backspace in einer komplett leeren Seite → Cursor in den Seitentitel. */
const focusTitleBackspace =
  (ctx: EditorContext): Command =>
  (state) => {
    const { selection, doc } = state;
    if (!ctx.focusTitle || !selection.empty || selection.from > 1) return false;
    if (doc.childCount !== 1 || doc.firstChild!.content.size !== 0 || doc.firstChild!.type !== schema.nodes.paragraph) return false;
    if ((doc.firstChild!.attrs.indent as number) > 0) return false;
    ctx.focusTitle();
    return true;
  };

/** Link bearbeiten (Cmd+K bei markiertem Text). */
const editLink: Command = (state, _dispatch, view) => {
  const { from, to, empty } = state.selection;
  if (empty || !view || !(state.selection instanceof TextSelection)) return false;
  let href = "";
  state.doc.nodesBetween(from, to, (n) => {
    const m = n.marks.find((mk) => mk.type === schema.marks.link);
    if (m) href = m.attrs.href;
  });
  editorUI.setLinkEdit({ view, from, to, href });
  return true;
};

/** Cmd+/ : Blockmenü mit "Umwandeln in" öffnen. */
const openBlockMenu =
  (ctx: EditorContext): Command =>
  (state, _d, view) => {
    if (!view) return false;
    const { index } = blockAt(state.doc, state.selection.from);
    const el = view.dom.children[index] as HTMLElement | undefined;
    if (!el) return false;
    editorUI.setBlockMenu({ view, index, rect: el.getBoundingClientRect(), pageId: ctx.pageId });
    return true;
  };

export function buildKeymap(ctx: EditorContext) {
  const m = schema.marks;
  const keys: Record<string, Command> = {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    Backspace: chainCommands(undoInputRule, deleteSelectedBlock, backspaceAtStart, focusTitleBackspace(ctx)),
    Delete: deleteSelectedBlock,
    "Mod-b": toggleMark(m.bold),
    "Mod-i": toggleMark(m.italic),
    "Mod-u": toggleMark(m.underline),
    "Shift-Mod-s": toggleMark(m.strike),
    "Shift-Mod-x": toggleMark(m.strike),
    "Mod-e": toggleMark(m.code),
    "Mod-k": editLink,
    Enter: chainCommands(editSelectedBlock, codeNewline, splitBlock),
    "Shift-Enter": chainCommands(exitCode, insertHardBreak),
    "Mod-Enter": chainCommands(exitCodeBlock, toggleBlockState),
    Tab: chainCommands(codeTab, indentCommand(1)),
    "Shift-Tab": indentCommand(-1),
    Escape: selectBlock,
    ArrowUp: chainCommands(moveBlockSelection(-1), focusTitleUp(ctx)),
    ArrowDown: chainCommands(moveBlockSelection(1), arrowDownAtEnd),
    "Mod-a": chainCommands(selectAllSmart, selectAll),
    "Mod-d": duplicateBlocks,
    "Shift-Mod-ArrowUp": moveBlocks(-1),
    "Shift-Mod-ArrowDown": moveBlocks(1),
    "Alt-Mod-t": toggleAllToggles,
    "Mod-/": openBlockMenu(ctx),
    // Umwandeln in (Notion: Cmd+Alt+0…9)
    "Alt-Mod-0": turnInto("paragraph"),
    "Alt-Mod-1": turnInto("heading", { level: 1 }),
    "Alt-Mod-2": turnInto("heading", { level: 2 }),
    "Alt-Mod-3": turnInto("heading", { level: 3 }),
    "Alt-Mod-4": turnInto("todo", { checked: false }),
    "Alt-Mod-5": turnInto("bullet"),
    "Alt-Mod-6": turnInto("numbered"),
    "Alt-Mod-7": turnInto("toggle", { open: true }),
    "Alt-Mod-8": turnInto("code_block"),
    "Alt-Mod-9": (_s, _d, view) => {
      if (view) void ctx.createSubpage(view);
      return true;
    },
  };
  return [keymap(keys), keymap(baseKeymap)];
}

