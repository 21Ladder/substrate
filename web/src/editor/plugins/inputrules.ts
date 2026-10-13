import { InputRule, inputRules } from "prosemirror-inputrules";
import type { MarkType, NodeType } from "prosemirror-model";
import { TextSelection, type EditorState } from "prosemirror-state";
import { schema } from "../schema";

// Markdown-Kürzel wie in Notion.

/** Wandelt den aktuellen Block um, wenn das Muster am Blockanfang getippt wird. */
function blockRule(re: RegExp, type: NodeType, attrs?: (m: RegExpMatchArray) => Record<string, unknown>) {
  return new InputRule(re, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.depth !== 1 || $start.parentOffset !== 0) return null;
    const block = $start.parent;
    if (block.type === schema.nodes.code_block) return null;
    if (block.type !== schema.nodes.paragraph && block.type !== type) return null;
    const keep = { indent: block.attrs.indent, color: block.attrs.color };
    const tr = state.tr.delete(start, end);
    tr.setNodeMarkup($start.before(1), type, { ...keep, ...(attrs ? attrs(match) : {}) });
    return tr;
  });
}

/** Ersetzt einen sonst leeren Absatz durch einen Atom-Block (z. B. Trennlinie). */
function atomRule(re: RegExp, type: NodeType) {
  return new InputRule(re, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    const block = $start.parent;
    if ($start.depth !== 1 || $start.parentOffset !== 0 || block.type !== schema.nodes.paragraph) return null;
    if (block.content.size !== end - start) return null;
    const pos = $start.before(1);
    const indent = block.attrs.indent;
    const tr = state.tr.replaceWith(pos, pos + block.nodeSize, [type.create({ indent }), schema.nodes.paragraph.create({ indent })]);
    tr.setSelection(TextSelection.create(tr.doc, pos + 2));
    return tr;
  });
}

/** Inline-Markierung wie **fett** oder `code`. Gruppe 1 = Zeichen davor, Gruppe 2 = Inhalt. */
function markRule(re: RegExp, type: MarkType) {
  return new InputRule(re, (state, match, start, end) => {
    const prefix = match[1] ?? "";
    const inner = match[2];
    const textStart = start + prefix.length;
    const $s = state.doc.resolve(textStart);
    if ($s.parent.type.spec.code) return null;
    if (type !== schema.marks.code && inCode(state, textStart, end)) return null;
    const tr = state.tr.delete(textStart, end);
    tr.insertText(inner, textStart);
    tr.addMark(textStart, textStart + inner.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

/**
 * Steht die Eingabe in Inline-Code? Geprüft werden der getippte Text selbst und die Markierungen, die das
 * nächste Zeichen bekäme (vorgemerkt oder vom Text davor) – nicht das Zeichen VOR dem Muster: Code ist
 * „inclusive“, sonst zählte ein Code-Span direkt davor schon als „in Code“.
 */
function inCode(state: EditorState, from: number, end: number): boolean {
  const code = schema.marks.code;
  if (from < end && state.doc.rangeHasMark(from, end, code)) return true;
  return !!code.isInSet(state.storedMarks ?? state.doc.resolve(end).marks());
}

function replaceRule(re: RegExp, text: string) {
  return new InputRule(re, (state, _m, start, end) => {
    const $s = state.doc.resolve(start);
    if ($s.parent.type === schema.nodes.code_block) return null;
    // Nicht in Inline-Code (z. B. `a->b`)
    if (inCode(state, start, end)) return null;
    return state.tr.insertText(text, start, end);
  });
}

export function buildInputRules() {
  const n = schema.nodes;
  const m = schema.marks;
  return inputRules({
    rules: [
      blockRule(/^(#{1,4})\s$/, n.heading, (match) => ({ level: match[1].length })),
      blockRule(/^[-*+]\s$/, n.bullet),
      blockRule(/^(\d+)[.)]\s$/, n.numbered),
      blockRule(/^\[\s?\]\s$/, n.todo, () => ({ checked: false })),
      blockRule(/^\[[xX]\]\s$/, n.todo, () => ({ checked: true })),
      blockRule(/^>\s$/, n.toggle, () => ({ open: true })),
      blockRule(/^["“„]\s$/, n.quote),
      blockRule(/^```$/, n.code_block),
      atomRule(/^(---|___|\*\*\*)$/, n.divider),
      // Inhalt beginnt und endet ohne Leerzeichen: „ca. ~5 bis ~10“ oder „2 * 3 * 4“ bleiben, wie getippt
      markRule(/(^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, m.bold),
      markRule(/(^|[^_\w])__([^_\s](?:[^_]*[^_\s])?)__$/, m.bold),
      markRule(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, m.italic),
      markRule(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, m.italic),
      markRule(/(^|[^`])`([^`]+)`$/, m.code),
      markRule(/(^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, m.strike),
      markRule(/(^|[^~\w])~([^~\s](?:[^~]*[^~\s])?)~$/, m.strike),
      replaceRule(/->$/, "→"),
      replaceRule(/<-$/, "←"),
    ],
  });
}
