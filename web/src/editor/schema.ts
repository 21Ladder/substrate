import { safeHref } from "../lib/util";
import { Schema, type DOMOutputSpec, type Node as PMNode, type NodeSpec, type MarkSpec } from "prosemirror-model";

// Flaches Blockmodell: Jeder Block liegt direkt im Dokument und trägt einen Einzug (`indent`).
// Die "Kinder" eines Blocks sind die direkt folgenden Blöcke mit größerem Einzug.

/** Erlaubte Bildquellen: lokale Anhänge, eingebettete Daten und https (https wird erst nach Klick lokal geladen). */
export function safeSrc(src: string): string {
  return /^(app:\/\/asset\/|data:image\/|https:\/\/)/i.test(src) ? src : "";
}

/** Externe Quelle, die ohne Zustimmung nicht geladen wird (Substrat bleibt offline). */
export function isRemote(src: string): boolean {
  return /^https:\/\//i.test(src);
}

/** Erlaubte Dateiquellen: lokale Anhänge, eingebettete Daten und https (kein javascript: o. Ä.). */
export function safeFileSrc(src: string): string {
  return /^(app:\/\/asset\/|data:[\w.+-]+\/[\w.+-]+[;,]|https:\/\/)/i.test(src) ? src : "";
}

const commonAttrs = {
  indent: { default: 0 },
  color: { default: null as string | null },
};

function readCommon(dom: HTMLElement) {
  const indent = Number(dom.getAttribute("data-indent") || 0);
  return {
    indent: Number.isFinite(indent) ? Math.max(0, Math.min(indent, 12)) : 0,
    color: dom.getAttribute("data-color") || null,
  };
}

function blockAttrs(node: PMNode, type: string, extra: Record<string, string | null> = {}): Record<string, string> {
  const attrs: Record<string, string> = {
    class: `block block-${type}` + (node.attrs.color ? ` block-color-${node.attrs.color}` : ""),
    "data-block": type,
    "data-indent": String(node.attrs.indent),
    style: `--indent:${node.attrs.indent}`,
  };
  if (node.attrs.color) attrs["data-color"] = node.attrs.color;
  for (const [k, v] of Object.entries(extra)) if (v !== null) attrs[k] = v;
  return attrs;
}

function textBlock(type: string, extraAttrs: NodeSpec["attrs"] = {}, extra: Partial<NodeSpec> = {}): NodeSpec {
  return {
    group: "block",
    content: "inline*",
    attrs: { ...commonAttrs, ...extraAttrs },
    defining: true,
    parseDOM: [{ tag: `div[data-block="${type}"]`, getAttrs: (dom) => readCommon(dom as HTMLElement) }],
    toDOM: (node): DOMOutputSpec => ["div", blockAttrs(node, type), 0],
    ...extra,
  };
}

function atomBlock(type: string, attrs: NodeSpec["attrs"], toExtra: (node: PMNode) => Record<string, string | null>, parse: (dom: HTMLElement) => Record<string, unknown>): NodeSpec {
  return {
    group: "block",
    atom: true,
    selectable: true,
    draggable: false,
    attrs: { ...commonAttrs, ...attrs },
    parseDOM: [{ tag: `div[data-block="${type}"]`, getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), ...parse(dom as HTMLElement) }) }],
    toDOM: (node): DOMOutputSpec => ["div", blockAttrs(node, type, toExtra(node))],
  };
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  paragraph: textBlock("paragraph", {}, {
    parseDOM: [
      { tag: 'div[data-block="paragraph"]', getAttrs: (dom) => readCommon(dom as HTMLElement) },
      { tag: "p", getAttrs: (dom) => readCommon(dom as HTMLElement) },
    ],
  }),

  heading: {
    group: "block",
    content: "inline*",
    attrs: { ...commonAttrs, level: { default: 1 } },
    defining: true,
    parseDOM: [
      { tag: 'div[data-block="heading"]', getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: Number((dom as HTMLElement).getAttribute("data-level")) || 1 }) },
      { tag: "h1", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 1 }) },
      { tag: "h2", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 2 }) },
      { tag: "h3", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 3 }) },
      { tag: "h4", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 4 }) },
      { tag: "h5", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 4 }) },
      { tag: "h6", getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), level: 4 }) },
    ],
    toDOM: (node) => ["div", blockAttrs(node, "heading", { "data-level": String(node.attrs.level), role: "heading", "aria-level": String(node.attrs.level) }), 0],
  },

  bullet: textBlock("bullet"),
  numbered: textBlock("numbered"),

  todo: {
    ...textBlock("todo", { checked: { default: false } }),
    parseDOM: [
      {
        tag: 'div[data-block="todo"]',
        getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), checked: (dom as HTMLElement).getAttribute("data-checked") === "true" }),
      },
    ],
    toDOM: (node) => ["div", blockAttrs(node, "todo", { "data-checked": String(node.attrs.checked) }), 0],
  },

  toggle: {
    ...textBlock("toggle", { open: { default: true } }),
    parseDOM: [
      {
        tag: 'div[data-block="toggle"]',
        getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), open: (dom as HTMLElement).getAttribute("data-open") !== "false" }),
      },
      { tag: "summary", getAttrs: (dom) => readCommon(dom as HTMLElement) },
    ],
    toDOM: (node) => ["div", blockAttrs(node, "toggle", { "data-open": String(node.attrs.open) }), 0],
  },

  quote: textBlock("quote", {}, {
    parseDOM: [
      { tag: 'div[data-block="quote"]', getAttrs: (dom) => readCommon(dom as HTMLElement) },
      { tag: "blockquote", getAttrs: (dom) => readCommon(dom as HTMLElement) },
    ],
  }),

  callout: {
    ...textBlock("callout", { icon: { default: "💡" } }),
    parseDOM: [
      {
        tag: 'div[data-block="callout"]',
        getAttrs: (dom) => ({ ...readCommon(dom as HTMLElement), icon: (dom as HTMLElement).getAttribute("data-icon") || "💡" }),
      },
      { tag: "aside", getAttrs: (dom) => readCommon(dom as HTMLElement) },
    ],
    toDOM: (node) => ["div", blockAttrs(node, "callout", { "data-icon": node.attrs.icon }), 0],
  },

  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { ...commonAttrs, language: { default: "plain" }, wrap: { default: false } },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const cls = el.querySelector("code")?.className ?? "";
          const m = /language-([\w+#-]+)/.exec(cls);
          return { ...readCommon(el), language: (el.getAttribute("data-language") || (m ? m[1] : "plain")).toLowerCase(), wrap: el.getAttribute("data-wrap") === "true" };
        },
      },
    ],
    toDOM: (node) => ["pre", blockAttrs(node, "code", { "data-language": node.attrs.language, "data-wrap": node.attrs.wrap ? "true" : null }), ["code", 0]],
  },

  divider: atomBlock("divider", {}, () => ({}), () => ({})),

  image: atomBlock(
    "image",
    { src: { default: "" }, width: { default: null as number | null }, caption: { default: "" }, align: { default: "center" } },
    (n) => ({
      "data-src": n.attrs.src,
      "data-width": n.attrs.width ? String(n.attrs.width) : null,
      "data-caption": n.attrs.caption || null,
      "data-align": n.attrs.align,
    }),
    (dom) => ({
      src: safeSrc(dom.getAttribute("data-src") || ""),
      width: Number(dom.getAttribute("data-width")) || null,
      caption: dom.getAttribute("data-caption") || "",
      align: dom.getAttribute("data-align") || "center",
    }),
  ),

  /** Unterseite (Notion "Page"-Block). */
  page: atomBlock(
    "page",
    { pageId: { default: "" } },
    (n) => ({ "data-page-id": n.attrs.pageId }),
    (dom) => ({ pageId: dom.getAttribute("data-page-id") || "" }),
  ),

  /** Inline-Datenbank. */
  database: atomBlock(
    "database",
    { databaseId: { default: "" } },
    (n) => ({ "data-database-id": n.attrs.databaseId }),
    (dom) => ({ databaseId: dom.getAttribute("data-database-id") || "" }),
  ),

  bookmark: atomBlock(
    "bookmark",
    { url: { default: "" }, title: { default: "" } },
    (n) => ({ "data-url": n.attrs.url, "data-title": n.attrs.title || null }),
    (dom) => ({ url: safeHref(dom.getAttribute("data-url") || "") ?? "", title: dom.getAttribute("data-title") || "" }),
  ),

  file: atomBlock(
    "file",
    { src: { default: "" }, name: { default: "" }, kind: { default: "file" } },
    (n) => ({ "data-src": n.attrs.src, "data-name": n.attrs.name, "data-kind": n.attrs.kind }),
    (dom) => ({
      src: safeFileSrc(dom.getAttribute("data-src") || ""),
      name: dom.getAttribute("data-name") || "",
      kind: ["video", "audio", "file"].includes(dom.getAttribute("data-kind") ?? "") ? dom.getAttribute("data-kind") : "file",
    }),
  ),

  toc: atomBlock("toc", {}, () => ({}), () => ({})),

  /** Lokaler Graph als Block (zeigt die Verbindungen dieser Seite). */
  graph: atomBlock("graph", { depth: { default: 1 } }, (n) => ({ "data-depth": String(n.attrs.depth) }), (dom) => ({ depth: Number(dom.getAttribute("data-depth")) || 1 })),

  text: { group: "inline" },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  mention: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    attrs: { pageId: { default: "" } },
    parseDOM: [{ tag: "span[data-mention]", getAttrs: (dom) => ({ pageId: (dom as HTMLElement).getAttribute("data-mention") }) }],
    toDOM: (node) => ["span", { class: "mention", "data-mention": node.attrs.pageId }],
  },

  date: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    attrs: { value: { default: "" } },
    parseDOM: [{ tag: "span[data-date]", getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute("data-date") }) }],
    toDOM: (node) => ["span", { class: "date-mention", "data-date": node.attrs.value }],
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => {
          const href = safeHref((dom as HTMLElement).getAttribute("href") ?? "");
          return href ? { href } : false;
        },
      },
    ],
    toDOM: (mark) => ["a", { href: mark.attrs.href, class: "link", rel: "noopener noreferrer" }, 0],
  },
  bold: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b", getAttrs: (node) => (node as HTMLElement).style.fontWeight !== "normal" && null },
      { style: "font-weight", getAttrs: (value) => /^(bold(er)?|[6-9]\d{2,})$/.test(value as string) && null },
    ],
    toDOM: () => ["strong", 0],
  },
  italic: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: () => ["em", 0],
  },
  underline: {
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    toDOM: () => ["u", 0],
  },
  strike: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
    toDOM: () => ["s", 0],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", { class: "inline-code" }, 0],
  },
  /** Text- oder Hintergrundfarbe: "red" bzw. "red_bg". */
  color: {
    attrs: { value: {} },
    parseDOM: [{ tag: "span[data-color]", getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute("data-color") }) }],
    toDOM: (mark) => {
      const v = String(mark.attrs.value);
      const cls = v.endsWith("_bg") ? `bg-${v.slice(0, -3)}` : `color-${v}`;
      return ["span", { "data-color": v, class: cls }, 0];
    },
  },
};

export const schema = new Schema({ nodes, marks });

export const TEXT_BLOCKS = new Set(["paragraph", "heading", "bullet", "numbered", "todo", "toggle", "quote", "callout"]);
export const ATOM_BLOCKS = new Set(["divider", "image", "page", "database", "bookmark", "file", "toc", "graph"]);

export function emptyDoc() {
  return schema.node("doc", null, [schema.node("paragraph")]);
}
