import { NodeSelection, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { ID } from "../../api/types";
import { blockStart, normalizeIndents, subtreeEnd } from "../blocks";
import { schema } from "../schema";
import { editorUI } from "../ui";
import { suggestKey } from "./suggest";

// Griff links neben jedem Block: "+" fügt einen Block ein, "⋮⋮" öffnet das Blockmenü
// bzw. verschiebt den Block (mit Kindern) per Drag & Drop.

const INDENT_PX = 24;
const DRAG_MIME = "application/x-substrat-blocks";

export const blockHandleKey = new PluginKey("blockHandle");

interface DragState {
  from: number;
  to: number;
}

function blockElements(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.children) as HTMLElement[];
}

/** Index des Blocks auf Höhe y (Binärsuche über die sichtbaren Blöcke). */
function blockIndexAtY(view: EditorView, y: number): number {
  const els = blockElements(view);
  let lo = 0;
  let hi = els.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = els[mid].getBoundingClientRect();
    if (r.height === 0) {
      // verborgener Block: linear nach oben ausweichen
      let k = mid - 1;
      while (k >= lo && els[k].getBoundingClientRect().height === 0) k--;
      if (k < lo) {
        lo = mid + 1;
        continue;
      }
      const rk = els[k].getBoundingClientRect();
      if (y < rk.top) hi = k - 1;
      else if (y > rk.bottom) lo = mid + 1;
      else return k;
      continue;
    }
    if (y < r.top) hi = mid - 1;
    else if (y > r.bottom) {
      best = mid;
      lo = mid + 1;
    } else return mid;
  }
  return best;
}

/** Höhe der ersten Zeile (nicht zwischengespeichert: Schriftgröße/Zoom können sich ändern). */
function firstLineHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return (parseFloat(cs.lineHeight) || 24) + (parseFloat(cs.paddingTop) || 0);
}

export function blockHandlePlugin(pageId: ID, readOnly: boolean) {
  return new Plugin({
    key: blockHandleKey,
    view(view) {
      if (readOnly) return {};
      const container = view.dom.parentElement as HTMLElement;
      const scroller = (view.dom.closest(".page-scroller") as HTMLElement) ?? container;

      const handle = document.createElement("div");
      handle.className = "block-handle";
      handle.innerHTML = `
        <button class="bh-btn bh-plus" title="Klicken, um darunter einen Block einzufügen&#10;Wahltaste-Klick für darüber"><svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
        <div class="bh-btn bh-drag" draggable="true" title="Ziehen zum Verschieben&#10;Klicken für Optionen"><svg viewBox="0 0 10 16"><g fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></g></svg></div>`;
      container.appendChild(handle);

      const indicator = document.createElement("div");
      indicator.className = "drop-indicator";
      container.appendChild(indicator);

      let current = -1;
      let hiddenByTyping = false;
      let drag: DragState | null = null;
      let dropTarget: { index: number; indent: number } | null = null;

      const hide = () => {
        handle.classList.remove("visible");
        current = -1;
      };

      const showFor = (index: number) => {
        const el = blockElements(view)[index];
        if (!el) return hide();
        current = index;
        const cr = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const indent = (view.state.doc.child(index).attrs.indent as number) || 0;
        const line = firstLineHeight(el);
        const top = r.top - cr.top + Math.max(0, line / 2 - 12);
        handle.style.transform = `translate(${indent * INDENT_PX - 50}px, ${top}px)`;
        handle.classList.add("visible");
      };

      const onMove = (e: MouseEvent) => {
        if (drag) return;
        hiddenByTyping = false;
        if (!view.editable) return hide();
        const cr = container.getBoundingClientRect();
        if (e.clientX < cr.left - 80 || e.clientX > cr.right + 20) return hide();
        if (handle.contains(e.target as Node)) return;
        const i = blockIndexAtY(view, e.clientY);
        if (i < 0) return hide();
        const el = blockElements(view)[i];
        const r = el.getBoundingClientRect();
        if (e.clientY > r.bottom + 4) return hide();
        if (i !== current || !handle.classList.contains("visible")) showFor(i);
      };

      const onLeave = (e: MouseEvent) => {
        if (!scroller.contains(e.relatedTarget as Node)) hide();
      };

      scroller.addEventListener("mousemove", onMove);
      scroller.addEventListener("mouseleave", onLeave);

      // "+" : neuen Block darunter (Alt: darüber) einfügen und Slash-Menü öffnen
      handle.querySelector(".bh-plus")!.addEventListener("mousedown", (e) => e.preventDefault());
      handle.querySelector(".bh-plus")!.addEventListener("click", (e) => {
        const ev = e as MouseEvent;
        if (current < 0) return;
        const { doc } = view.state;
        const node = doc.child(current);
        const indent = node.attrs.indent as number;
        const tr = view.state.tr;
        let pos: number;
        if (ev.altKey) {
          pos = blockStart(doc, current);
        } else if (node.type === schema.nodes.paragraph && node.content.size === 0) {
          // Leerer Absatz: direkt darin das Menü öffnen
          pos = -1;
        } else {
          pos = blockStart(doc, current) + node.nodeSize;
        }
        let from: number;
        if (pos === -1) {
          from = blockStart(doc, current) + 1;
          tr.setSelection(TextSelection.create(tr.doc, from));
        } else {
          tr.insert(pos, schema.nodes.paragraph.create({ indent }));
          from = pos + 1;
          tr.setSelection(TextSelection.create(tr.doc, from));
        }
        tr.insertText("/", from);
        tr.setMeta(suggestKey, { open: true, from, trigger: "/" });
        view.dispatch(tr.scrollIntoView());
        view.focus();
      });

      // "⋮⋮" : Klick öffnet Blockmenü
      const dragEl = handle.querySelector(".bh-drag") as HTMLElement;
      dragEl.addEventListener("mousedown", (e) => {
        if (current < 0) return;
        // Block auswählen, damit sichtbar ist, worauf sich das Menü bezieht
        const pos = blockStart(view.state.doc, current);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        e.stopPropagation();
      });
      dragEl.addEventListener("click", () => {
        if (current < 0) return;
        editorUI.setBlockMenu({ view, index: current, rect: dragEl.getBoundingClientRect(), pageId });
      });

      dragEl.addEventListener("dragstart", (e) => {
        if (current < 0) return;
        const { doc } = view.state;
        const from = current;
        const to = subtreeEnd(doc, current);
        drag = { from, to };
        editorUI.setBlockMenu(null);
        const els = blockElements(view);
        e.dataTransfer!.effectAllowed = "move";
        const text = doc.textBetween(blockStart(doc, from), blockStart(doc, to) + doc.child(to).nodeSize, "\n");
        e.dataTransfer!.setData("text/plain", text);
        e.dataTransfer!.setData(DRAG_MIME, pageId);
        // Vorschau: der Block selbst (halbtransparent)
        const preview = els[from];
        e.dataTransfer!.setDragImage(preview, 0, 0);
        for (let i = from; i <= to; i++) els[i]?.classList.add("dragging-source");
        handle.classList.remove("visible");
      });

      const clearDrag = () => {
        for (const el of blockElements(view)) el.classList.remove("dragging-source");
        indicator.classList.remove("visible");
        drag = null;
        dropTarget = null;
      };
      dragEl.addEventListener("dragend", clearDrag);

      const onDragOver = (e: DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        const { doc } = view.state;
        const els = blockElements(view);
        let i = blockIndexAtY(view, e.clientY);
        let before: number; // Ziel: vor diesem Index einfügen
        if (i < 0) before = 0;
        else {
          const r = els[i].getBoundingClientRect();
          before = e.clientY < r.top + r.height / 2 ? i : i + 1;
          // Nicht zwischen verborgene Kinder eines eingeklappten Toggles
          while (before < doc.childCount && before > 0 && els[before].getBoundingClientRect().height === 0) before++;
        }
        // Nicht in den eigenen Teilbaum
        if (before > drag.from && before <= drag.to + 1) {
          indicator.classList.remove("visible");
          dropTarget = null;
          return;
        }
        // Vorheriger Block außerhalb des gezogenen Bereichs
        let prevIndex = before - 1;
        if (prevIndex >= drag.from && prevIndex <= drag.to) prevIndex = drag.from - 1;
        const prevIndent = prevIndex >= 0 ? (doc.child(prevIndex).attrs.indent as number) : -1;
        const cr = container.getBoundingClientRect();
        const rel = e.clientX - cr.left;
        let indent: number;
        if (rel < 0) indent = Math.max(0, prevIndent);
        else indent = Math.max(0, Math.min(prevIndent + 1, Math.floor(rel / INDENT_PX)));
        dropTarget = { index: before, indent };
        // Linie zeichnen
        let y: number;
        if (before < els.length) y = els[before].getBoundingClientRect().top;
        else y = els[els.length - 1].getBoundingClientRect().bottom;
        if (before > 0 && before < els.length) {
          const prevEl = els[before - 1];
          y = (prevEl.getBoundingClientRect().bottom + els[before].getBoundingClientRect().top) / 2;
        }
        indicator.style.transform = `translate(${indent * INDENT_PX}px, ${y - cr.top - 2}px)`;
        indicator.style.width = `${cr.width - indent * INDENT_PX}px`;
        indicator.classList.add("visible");
      };

      const onDrop = (e: DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const target = dropTarget;
        const { from, to } = drag;
        clearDrag();
        if (!target) return;
        const { doc } = view.state;
        const start = blockStart(doc, from);
        const end = blockStart(doc, to) + doc.child(to).nodeSize;
        const delta = target.indent - (doc.child(from).attrs.indent as number);
        const nodes = [];
        for (let i = from; i <= to; i++) {
          const n = doc.child(i);
          nodes.push(n.type.create({ ...n.attrs, indent: Math.max(0, (n.attrs.indent as number) + delta) }, n.content, n.marks));
        }
        const tr = view.state.tr.delete(start, end);
        const removed = to - from + 1;
        const insertIndex = target.index > to ? target.index - removed : target.index;
        const insertPos = blockStart(tr.doc, insertIndex);
        tr.insert(insertPos, nodes);
        normalizeIndents(tr, 0);
        tr.setSelection(NodeSelection.create(tr.doc, insertPos));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      };

      container.addEventListener("dragover", onDragOver);
      container.addEventListener("drop", onDrop, true);

      const onKey = () => {
        if (!hiddenByTyping) {
          hiddenByTyping = true;
          hide();
        }
      };
      view.dom.addEventListener("keydown", onKey);

      return {
        update(v, prev) {
          if (current >= 0 && (v.state.doc !== prev.doc || current >= v.state.doc.childCount)) {
            if (current >= v.state.doc.childCount) hide();
            else showFor(current);
          }
        },
        destroy() {
          scroller.removeEventListener("mousemove", onMove);
          scroller.removeEventListener("mouseleave", onLeave);
          container.removeEventListener("dragover", onDragOver);
          container.removeEventListener("drop", onDrop, true);
          view.dom.removeEventListener("keydown", onKey);
          handle.remove();
          indicator.remove();
        },
      };
    },
  });
}
