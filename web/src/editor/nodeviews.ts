import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { render } from "solid-js/web";
import { createComponent, createEffect, createSignal, type Accessor, type JSX, type Setter } from "solid-js";
import { api } from "../api/client";
import { formatDateValue, safeHref } from "../lib/util";
import { navigation } from "../state/workspace";
import { PageRef, BlockDatabase, BlockGraph, TocView } from "./BlockViews";
import { isRemote, safeFileSrc, safeSrc } from "./schema";
import { openEmojiPicker } from "../components/popovers";
import type { EditorContext } from "./ui";

type GetPos = () => number | undefined;

function applyBlockAttrs(dom: HTMLElement, node: PMNode, type: string) {
  dom.className = `block block-${type}` + (node.attrs.color ? ` block-color-${node.attrs.color}` : "");
  dom.setAttribute("data-block", type);
  dom.setAttribute("data-indent", String(node.attrs.indent));
  dom.style.setProperty("--indent", String(node.attrs.indent));
  if (node.attrs.color) dom.setAttribute("data-color", node.attrs.color);
  else dom.removeAttribute("data-color");
}

/** Textblock mit nicht editierbarem Präfix (Checkbox, Pfeil, Icon). */
abstract class PrefixedBlock implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  prefix: HTMLElement;

  constructor(
    public node: PMNode,
    public view: EditorView,
    public getPos: GetPos,
    public type: string,
  ) {
    this.dom = document.createElement("div");
    this.prefix = document.createElement("div");
    this.prefix.className = "block-prefix";
    this.prefix.contentEditable = "false";
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "block-text";
    this.dom.append(this.prefix, this.contentDOM);
    this.prefix.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (this.view.editable) this.onPrefixClick(e);
    });
    this.render();
  }

  abstract onPrefixClick(e: MouseEvent): void;
  abstract renderPrefix(): void;

  render() {
    applyBlockAttrs(this.dom, this.node, this.type);
    this.renderPrefix();
  }

  setAttr(attrs: Record<string, unknown>) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs }));
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(m: ViewMutationRecord) {
    return m.type === "attributes" || this.prefix.contains(m.target as Node);
  }
}

class TodoView extends PrefixedBlock {
  constructor(node: PMNode, view: EditorView, getPos: GetPos) {
    super(node, view, getPos, "todo");
  }
  renderPrefix() {
    const checked = !!this.node.attrs.checked;
    this.dom.setAttribute("data-checked", String(checked));
    if (this.prefix.dataset.checked !== String(checked)) {
      this.prefix.dataset.checked = String(checked);
      this.prefix.innerHTML = `<span class="checkbox${checked ? " checked" : ""}" role="checkbox" aria-checked="${checked}">${
        checked ? '<svg viewBox="0 0 14 14"><path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z" fill="currentColor"/></svg>' : ""
      }</span>`;
    }
  }
  onPrefixClick() {
    this.setAttr({ checked: !this.node.attrs.checked });
  }
}

class ToggleView extends PrefixedBlock {
  constructor(node: PMNode, view: EditorView, getPos: GetPos) {
    super(node, view, getPos, "toggle");
  }
  renderPrefix() {
    const open = !!this.node.attrs.open;
    this.dom.setAttribute("data-open", String(open));
    if (!this.prefix.firstChild) {
      this.prefix.innerHTML = `<span class="toggle-arrow" role="button" aria-label="Auf-/Zuklappen"><svg viewBox="0 0 100 100"><polygon points="5.9,88.2 50,11.8 94.1,88.2" fill="currentColor"/></svg></span>`;
    }
    this.prefix.classList.toggle("open", open);
  }
  onPrefixClick() {
    this.setAttr({ open: !this.node.attrs.open });
  }
}

class CalloutView extends PrefixedBlock {
  constructor(node: PMNode, view: EditorView, getPos: GetPos) {
    super(node, view, getPos, "callout");
  }
  renderPrefix() {
    const icon = String(this.node.attrs.icon || "💡");
    if (this.prefix.dataset.icon !== icon) {
      this.prefix.dataset.icon = icon;
      this.prefix.innerHTML = "";
      const span = document.createElement("span");
      span.className = "callout-icon hover-bg";
      if (icon.startsWith("app://") || icon.startsWith("data:")) {
        const img = document.createElement("img");
        img.src = icon;
        span.append(img);
      } else span.textContent = icon;
      this.prefix.append(span);
    }
  }
  onPrefixClick() {
    openEmojiPicker(this.prefix.getBoundingClientRect(), (icon) => this.setAttr({ icon: icon ?? "💡" }), false);
  }
}

const LANGUAGES = [
  "plain",
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "markdown",
  "mermaid",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
];

const LANGUAGE_LABELS: Record<string, string> = {
  plain: "Plain Text",
  cpp: "C++",
  csharp: "C#",
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  php: "PHP",
  xml: "XML",
  yaml: "YAML",
};

class CodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  header: HTMLElement;
  select: HTMLSelectElement;

  constructor(
    public node: PMNode,
    public view: EditorView,
    public getPos: GetPos,
  ) {
    this.dom = document.createElement("div");
    this.header = document.createElement("div");
    this.header.className = "code-header";
    this.header.contentEditable = "false";
    this.select = document.createElement("select");
    this.select.className = "code-lang";
    for (const l of LANGUAGES) {
      const o = document.createElement("option");
      o.value = l;
      o.textContent = LANGUAGE_LABELS[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
      this.select.append(o);
    }
    this.select.addEventListener("change", () => {
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language: this.select.value }));
    });
    const copy = document.createElement("button");
    copy.className = "code-copy";
    copy.textContent = "Kopieren";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(this.node.textContent);
      copy.textContent = "Kopiert";
      setTimeout(() => (copy.textContent = "Kopieren"), 1200);
    });
    this.header.append(this.select, copy);
    const pre = document.createElement("pre");
    pre.spellcheck = false;
    this.contentDOM = document.createElement("code");
    this.contentDOM.spellcheck = false;
    pre.append(this.contentDOM);
    this.dom.append(this.header, pre);
    this.render();
  }

  render() {
    applyBlockAttrs(this.dom, this.node, "code");
    this.dom.setAttribute("data-language", this.node.attrs.language);
    this.select.value = LANGUAGES.includes(this.node.attrs.language) ? this.node.attrs.language : "plain";
    this.select.disabled = !this.view.editable;
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(e: Event) {
    return this.header.contains(e.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord) {
    return m.type === "attributes" || this.header.contains(m.target as Node);
  }
}

/** Atom-Block, dessen Inhalt mit Solid gerendert wird. */
class SolidAtomView implements NodeView {
  dom: HTMLElement;
  private dispose: () => void;
  private setNode: Setter<PMNode>;

  constructor(
    public node: PMNode,
    public view: EditorView,
    public getPos: GetPos,
    private type: string,
    component: (props: { node: Accessor<PMNode>; view: EditorView; getPos: GetPos }) => JSX.Element,
  ) {
    this.dom = document.createElement("div");
    applyBlockAttrs(this.dom, node, type);
    this.dom.contentEditable = "false";
    const [nodeSig, setNode] = createSignal(node, { equals: false });
    this.setNode = setNode;
    this.dispose = render(() => createComponent(component, { node: nodeSig, view, getPos }), this.dom);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    applyBlockAttrs(this.dom, node, this.type);
    this.setNode(node);
    return true;
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(e: Event) {
    // Interaktive Inhalte (Datenbank, Graph, Eingabefelder) selbst behandeln
    const t = e.target as HTMLElement;
    if (e.type === "dragstart" || e.type === "dragover" || e.type === "drop") return false;
    return !!t.closest?.("input, textarea, select, button, [contenteditable=true], .interactive");
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.dispose();
  }
}

function ImageBlock(props: { node: () => PMNode; view: EditorView; getPos: GetPos }) {
  const wrap = document.createElement("div");
  wrap.className = "image-block";
  let img: HTMLImageElement | null = null;

  const update = () => {
    const node = props.node();
    const src = String(node.attrs.src || "");
    wrap.innerHTML = "";
    if (!src) {
      const empty = document.createElement("div");
      empty.className = "media-empty interactive";
      empty.innerHTML = `<span class="media-empty-icon">🖼️</span><span>Bild hinzufügen</span>`;
      empty.addEventListener("click", async () => {
        if (!props.view.editable) return;
        const [f] = await api.pickFiles({ kind: "image" });
        if (f) setAttrs({ src: f.url });
      });
      wrap.append(empty);
      return;
    }
    if (isRemote(src)) {
      // Offline-Prinzip: externe Bilder werden nicht automatisch geladen (kein Tracking, keine IP-Weitergabe)
      const remote = document.createElement("div");
      remote.className = "media-empty interactive";
      let host = src;
      try {
        host = new URL(src).host;
      } catch {
        /* ungültige URL */
      }
      const label = document.createElement("span");
      label.textContent = `Externes Bild von ${host} – klicken, um es einmalig herunterzuladen und lokal zu speichern`;
      remote.append(label);
      remote.addEventListener("click", async () => {
        if (!props.view.editable) return;
        label.textContent = "Wird geladen …";
        try {
          const { url } = await api.fetchAsset(src);
          setAttrs({ src: url });
        } catch (e) {
          label.textContent = `Laden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
        }
      });
      wrap.append(remote);
      return;
    }
    const frame = document.createElement("div");
    frame.className = "image-frame";
    img = document.createElement("img");
    img.src = safeSrc(src);
    img.draggable = false;
    img.loading = "lazy";
    img.alt = String(node.attrs.caption || "");
    if (node.attrs.width) frame.style.width = `${node.attrs.width}px`;
    frame.append(img);
    for (const side of ["left", "right"] as const) {
      const h = document.createElement("div");
      h.className = `image-resize ${side} interactive`;
      h.addEventListener("mousedown", (e) => startResize(e, side, frame));
      frame.append(h);
    }
    wrap.append(frame);
  };

  const setAttrs = (attrs: Record<string, unknown>) => {
    const pos = props.getPos();
    if (pos === undefined) return;
    const node = props.view.state.doc.nodeAt(pos);
    if (!node) return;
    props.view.dispatch(props.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
  };

  const startResize = (e: MouseEvent, side: "left" | "right", frame: HTMLElement) => {
    if (!props.view.editable) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const maxW = wrap.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) * (side === "left" ? -2 : 2);
      frame.style.width = `${Math.max(80, Math.min(maxW, startW + dx))}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setAttrs({ width: Math.round(frame.getBoundingClientRect().width) });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Reagiert auf Knotenänderungen
  let lastSrc = "";
  let lastWidth: unknown = undefined;
  const check = () => {
    const n = props.node();
    if (n.attrs.src !== lastSrc || n.attrs.width !== lastWidth) {
      lastSrc = n.attrs.src;
      lastWidth = n.attrs.width;
      update();
    }
  };
  createEffect(check);
  return wrap;
}

function BookmarkBlock(props: { node: () => PMNode; view: EditorView; getPos: GetPos }) {
  const a = document.createElement("div");
  a.className = "bookmark-card interactive";
  createEffect(() => {
    const url = String(props.node().attrs.url || "");
    const safe = safeHref(url);
    let host = url;
    try {
      host = new URL(safe ?? url).host;
    } catch {
      /* ungültige URL */
    }
    a.innerHTML = "";
    const title = document.createElement("div");
    title.className = "bookmark-title";
    title.textContent = String(props.node().attrs.title || host || url);
    const link = document.createElement("div");
    link.className = "bookmark-url";
    link.textContent = url;
    a.append(title, link);
    a.onclick = () => safe && void api.openURL(safe);
  });
  return a;
}

function FileBlock(props: { node: () => PMNode; view: EditorView; getPos: GetPos }) {
  const el = document.createElement("div");
  el.className = "file-block";
  createEffect(() => {
    const { src: rawSrc, name, kind } = props.node().attrs as { src: string; name: string; kind: string };
    // Auch Inhalte aus älteren Versionen/Importen erneut prüfen
    const src = safeFileSrc(rawSrc);
    el.innerHTML = "";
    if (isRemote(src)) {
      const link = document.createElement("button");
      link.className = "file-link interactive";
      link.textContent = `🔗 ${name || src} (extern, im Browser öffnen)`;
      link.addEventListener("click", () => void api.openURL(src));
      el.append(link);
      return;
    }
    if (kind === "video") {
      const v = document.createElement("video");
      v.src = src;
      v.controls = true;
      v.preload = "metadata";
      el.append(v);
    } else if (kind === "audio") {
      const a = document.createElement("audio");
      a.src = src;
      a.controls = true;
      a.preload = "metadata";
      el.append(a);
    } else {
      const a = document.createElement("a");
      a.className = "file-link interactive";
      a.href = src;
      a.download = name || "Datei";
      a.innerHTML = `<span>📎</span>`;
      const span = document.createElement("span");
      span.textContent = name || "Datei";
      a.append(span);
      el.append(a);
    }
  });
  return el;
}

/** Inline-Erwähnung einer Seite. */
class MentionView implements NodeView {
  dom: HTMLElement;
  private dispose: () => void;
  constructor(
    public node: PMNode,
    public view: EditorView,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "mention";
    this.dom.setAttribute("data-mention", node.attrs.pageId);
    this.dispose = render(() => createComponent(PageRef, { id: node.attrs.pageId, inline: true }), this.dom);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      navigation.open(this.node.attrs.pageId);
    });
  }
  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.pageId !== this.node.attrs.pageId) return false;
    this.node = node;
    return true;
  }
  ignoreMutation() {
    return true;
  }
  destroy() {
    this.dispose();
  }
}

class DateView implements NodeView {
  dom: HTMLElement;
  constructor(public node: PMNode) {
    this.dom = document.createElement("span");
    this.dom.className = "date-mention";
    this.dom.textContent = "@" + formatDateValue(String(node.attrs.value), "relative");
  }
  ignoreMutation() {
    return true;
  }
}

function PageBlock(props: { node: () => PMNode; view: EditorView; getPos: GetPos }) {
  return createComponent(PageRef, {
    get id() {
      return String(props.node().attrs.pageId);
    },
    inline: false,
  });
}

export function buildNodeViews(ctx: EditorContext) {
  return {
    todo: (n: PMNode, v: EditorView, g: GetPos) => new TodoView(n, v, g),
    toggle: (n: PMNode, v: EditorView, g: GetPos) => new ToggleView(n, v, g),
    callout: (n: PMNode, v: EditorView, g: GetPos) => new CalloutView(n, v, g),
    code_block: (n: PMNode, v: EditorView, g: GetPos) => new CodeView(n, v, g),
    image: (n: PMNode, v: EditorView, g: GetPos) => new SolidAtomView(n, v, g, "image", ImageBlock),
    bookmark: (n: PMNode, v: EditorView, g: GetPos) => new SolidAtomView(n, v, g, "bookmark", BookmarkBlock),
    file: (n: PMNode, v: EditorView, g: GetPos) => new SolidAtomView(n, v, g, "file", FileBlock),
    page: (n: PMNode, v: EditorView, g: GetPos) => new SolidAtomView(n, v, g, "page", PageBlock),
    database: (n: PMNode, v: EditorView, g: GetPos) =>
      new SolidAtomView(n, v, g, "database", (p) =>
        createComponent(BlockDatabase, {
          get id() {
            return String(p.node().attrs.databaseId);
          },
          readOnly: ctx.readOnly,
        }),
      ),
    graph: (n: PMNode, v: EditorView, g: GetPos) =>
      new SolidAtomView(n, v, g, "graph", (p) =>
        createComponent(BlockGraph, {
          pageId: ctx.pageId,
          get depth() {
            return Number(p.node().attrs.depth) || 1;
          },
        }),
      ),
    toc: (n: PMNode, v: EditorView, g: GetPos) => new SolidAtomView(n, v, g, "toc", (p) => createComponent(TocView, { view: p.view, version: ctx.docVersion })),
    mention: (n: PMNode, v: EditorView) => new MentionView(n, v),
    date: (n: PMNode) => new DateView(n),
  };
}
