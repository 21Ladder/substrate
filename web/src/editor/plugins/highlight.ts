import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "../schema";

// Leichtgewichtiges Syntax-Highlighting ohne externe Bibliothek: Kommentare, Strings,
// Zahlen und Schlüsselwörter für gängige Sprachen.

const KEYWORDS: Record<string, string> = {
  javascript:
    "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
  python:
    "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
  swift:
    "actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws true try typealias var where while",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false",
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws try void volatile while true false var",
  sql: "select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct union all case when then else end null is in like between exists primary key foreign references default with returning",
  bash: "if then else elif fi for while do done case esac function in return export local echo exit set unset source",
  ruby: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
  php: "abstract and array as break case catch class clone const continue declare default do echo else elseif empty endif extends final for foreach function global if implements include instanceof interface isset list namespace new null or print private protected public require return static switch this throw trait try unset use var while",
  kotlin: "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while",
  css: "important media import from to",
};
KEYWORDS.typescript = KEYWORDS.javascript + " interface type enum implements private public protected readonly abstract declare namespace keyof infer is satisfies";
KEYWORDS.cpp = KEYWORDS.c + " class namespace template typename public private protected virtual override new delete this using nullptr bool";
KEYWORDS.csharp = KEYWORDS.java + " namespace using var async await readonly override virtual internal string bool object base";

const HASH_COMMENT = new Set(["python", "bash", "ruby", "yaml"]);
const keywordSets = new Map<string, Set<string>>();
function keywords(lang: string): Set<string> {
  let set = keywordSets.get(lang);
  if (!set) {
    const words = KEYWORDS[lang] ?? "";
    set = new Set(lang === "sql" ? words.split(" ").flatMap((w) => [w, w.toUpperCase()]) : words.split(" "));
    keywordSets.set(lang, set);
  }
  return set;
}

interface Token {
  from: number;
  to: number;
  cls: string;
}

export function tokenize(code: string, lang: string): Token[] {
  if (lang === "plain" || lang === "markdown" || lang === "mermaid") return [];
  const tokens: Token[] = [];
  const kw = keywords(lang);
  const hash = HASH_COMMENT.has(lang);
  const isJsonLike = lang === "json";
  const isMarkup = lang === "html" || lang === "xml";
  if (isMarkup) {
    const re = /<!--[\s\S]*?-->|<\/?[\w:-]+|"[^"]*"|'[^']*'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const t = m[0];
      tokens.push({ from: m.index, to: m.index + t.length, cls: t.startsWith("<!--") ? "tok-comment" : t.startsWith("<") ? "tok-tag" : "tok-string" });
    }
    return tokens;
  }
  const re = hash
    ? /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b\d[\d_.]*(?:e[+-]?\d+)?\b|[A-Za-z_][\w]*/g
    : lang === "sql"
      ? /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:[^"])*"|\b\d[\d.]*\b|[A-Za-z_][\w]*/g
      : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b0x[\da-fA-F]+\b|\b\d[\d_.]*(?:e[+-]?\d+)?\b|[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const t = m[0];
    const c = t[0];
    let cls: string | null = null;
    if (t.startsWith("//") || t.startsWith("/*") || (hash && c === "#") || t.startsWith("--")) cls = "tok-comment";
    else if (c === '"' || c === "'" || c === "`") cls = isJsonLike && code[m.index + t.length] === ":" ? "tok-property" : "tok-string";
    else if (/\d/.test(c)) cls = "tok-number";
    else if (kw.has(t)) cls = "tok-keyword";
    else if (isJsonLike && (t === "true" || t === "false" || t === "null")) cls = "tok-keyword";
    else if (code[m.index + t.length] === "(") cls = "tok-function";
    else if (/^[A-Z]/.test(t) && lang !== "sql") cls = "tok-type";
    if (cls) tokens.push({ from: m.index, to: m.index + t.length, cls });
  }
  return tokens;
}

const cache = new WeakMap<PMNode, Token[]>();

function decorationsFor(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, pos) => {
    if (node.type !== schema.nodes.code_block || !node.content.size) return;
    let tokens = cache.get(node);
    if (!tokens) {
      tokens = tokenize(node.textContent, String(node.attrs.language));
      cache.set(node, tokens);
    }
    for (const t of tokens) decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: t.cls }));
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>("codeHighlight");

export const codeHighlightPlugin = new Plugin<DecorationSet>({
  key,
  state: {
    init: (_, s) => decorationsFor(s.doc),
    apply: (tr, old, _o, s) => (tr.docChanged ? decorationsFor(s.doc) : old),
  },
  props: {
    decorations: (s) => key.getState(s),
  },
});
