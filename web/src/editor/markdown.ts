import type { DocJSON } from "../api/types";

// Markdown ⇄ Dokument-JSON (für Export, Import und Einfügen von Markdown-Text).

type Mark = { type: string; attrs?: Record<string, unknown> };

// ---------- Export ----------

function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]~])/g, "\\$1");
}

/** Längste Folge eines Zeichens im Text. */
function longestRun(text: string, ch: string): number {
  let max = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > max) max = cur;
  }
  return max;
}

/** Inline-Code mit passend langen Backticks (Backslash-Escapes gelten in Code nicht). */
function codeSpan(raw: string): string {
  const ticks = "`".repeat(longestRun(raw, "`") + 1);
  // Rand-Backticks oder Leerzeichen an BEIDEN Rändern: zusätzlich auffüllen (der Import entfernt je eins)
  const spaced = raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "";
  const pad = raw.startsWith("`") || raw.endsWith("`") || spaced ? " " : "";
  return `${ticks}${pad}${raw}${pad}${ticks}`;
}

function inlineToMd(nodes: DocJSON[] | undefined, titleOf: (id: string) => string, linkOf?: (id: string) => string): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "hard_break") {
      out += "  \n";
      continue;
    }
    if (n.type === "mention") {
      const id = String(n.attrs?.pageId ?? "");
      const title = titleOf(id);
      out += linkOf ? `[${escapeMd(title)}](${linkOf(id)})` : `@${title}`;
      continue;
    }
    if (n.type === "date") {
      out += `@${String(n.attrs?.value ?? "")}`;
      continue;
    }
    if (n.type !== "text") continue;
    const marks = n.marks ?? [];
    const has = (t: string) => marks.some((m) => m.type === t);
    const raw = n.text ?? "";
    let t = has("code") ? codeSpan(raw) : escapeMd(raw);
    if (!has("code")) {
      // Leerzeichen am Rand außerhalb der Markierung halten (sonst ungültiges Markdown)
      const lead = /^\s*/.exec(t)![0];
      const trail = /\s*$/.exec(t)![0];
      let core = t.slice(lead.length, t.length - trail.length);
      if (core) {
        // Bei fett+kursiv "_" verwenden, damit "***x***" nicht mehrdeutig wird
        if (has("italic")) core = has("bold") ? `_${core}_` : `*${core}*`;
        if (has("bold")) core = `**${core}**`;
        if (has("strike")) core = `~~${core}~~`;
        if (has("underline")) core = `<u>${core}</u>`;
      }
      t = lead + core + trail;
    }
    const link = marks.find((m) => m.type === "link");
    if (link) t = `[${t}](${String(link.attrs?.href ?? "")})`;
    out += t;
  }
  return out;
}

export function docToMarkdown(
  doc: DocJSON | null | undefined,
  opts: { titleOf: (id: string) => string; linkOf?: (id: string) => string; assetOf?: (src: string) => string } = { titleOf: (id) => id },
): string {
  const lines: string[] = [];
  const counters: number[] = [];
  let prevType = "";
  for (const b of doc?.content ?? []) {
    const indent = Number(b.attrs?.indent ?? 0);
    const pad = "    ".repeat(indent);
    const text = inlineToMd(b.content, opts.titleOf, opts.linkOf);
    counters.length = indent + 1;
    // Ein anderer Block auf gleicher Ebene beendet die nummerierte Liste
    if (b.type !== "numbered") counters[indent] = 0;
    const isListType = ["bullet", "numbered", "todo", "toggle"].includes(b.type);
    // Leerzeile zwischen Absätzen, aber nicht innerhalb von Listen
    if (lines.length && !(isListType && ["bullet", "numbered", "todo", "toggle"].includes(prevType)) && !(indent > 0)) lines.push("");
    switch (b.type) {
      case "heading":
        lines.push(`${"#".repeat(Number(b.attrs?.level ?? 1))} ${text}`);
        break;
      case "bullet":
        lines.push(`${pad}- ${text}`);
        break;
      case "numbered":
        counters[indent] = (counters[indent] ?? 0) + 1;
        lines.push(`${pad}${counters[indent]}. ${text}`);
        break;
      case "todo":
        lines.push(`${pad}- [${b.attrs?.checked ? "x" : " "}] ${text}`);
        break;
      case "toggle":
        lines.push(`${pad}- ${text}`);
        break;
      case "quote":
        lines.push(text.split("\n").map((l) => `${pad}> ${l}`).join("\n"));
        break;
      case "callout":
        // Jede Zeile mit „>“, sonst fällt eine zweite Zeile aus dem Zitat heraus
        lines.push(`${b.attrs?.icon ?? "💡"} ${text}`.split("\n").map((l) => `${pad}> ${l}`).join("\n"));
        break;
      case "code_block": {
        const code = (b.content ?? []).map((n) => n.text ?? "").join("");
        const lang = b.attrs?.language && b.attrs.language !== "plain" ? String(b.attrs.language) : "";
        // Zaun länger als jede Backtick-Folge im Code
        const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
        lines.push(`${pad}${fence}${lang}\n${code}\n${pad}${fence}`);
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "image": {
        const src = String(b.attrs?.src ?? "");
        lines.push(`${pad}![${String(b.attrs?.caption ?? "")}](${opts.assetOf ? opts.assetOf(src) : src})`);
        break;
      }
      case "file": {
        const src = String(b.attrs?.src ?? "");
        lines.push(`${pad}[${escapeMd(String(b.attrs?.name || "Datei"))}](${opts.assetOf ? opts.assetOf(src) : src})`);
        break;
      }
      case "bookmark":
        lines.push(`${pad}[${escapeMd(String(b.attrs?.title || b.attrs?.url || ""))}](${String(b.attrs?.url ?? "")})`);
        break;
      case "page":
      case "database": {
        const id = String(b.attrs?.pageId ?? b.attrs?.databaseId ?? "");
        const title = opts.titleOf(id);
        lines.push(opts.linkOf ? `${pad}[${escapeMd(title)}](${opts.linkOf(id)})` : `${pad}${title}`);
        break;
      }
      case "toc":
      case "graph":
        break;
      default:
        lines.push(pad + text);
    }
    prevType = b.type;
  }
  return lines.join("\n") + "\n";
}

// ---------- Import ----------

export interface InlineContext {
  /** Löst Link-Ziele zu Seiten-IDs auf (für Notion-Exporte und Wikilinks). */
  resolveLink?: (href: string) => string | null;
  resolveWiki?: (title: string) => string | null;
  resolveAsset?: (src: string) => string | null;
}

// Inline-Parser als Scanner. Schließende Zeichen werden pro Text EINMAL indiziert (gültige Positionen
// je Muster, aufsteigend) und dann per Binärsuche gefunden. Dadurch bleibt die Laufzeit auch bei
// präparierten oder sehr langen Texten linear, und die Verschachtelung ist gedeckelt.
const WINDOW = 100_000;
const MAX_DEPTH = 8;
const PUNCT = /[\\`*_[\]#<>~|!()\-.{}+]/;
const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(c: string | undefined): boolean {
  return !!c && WORD.test(c);
}

function isSpace(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c);
}

/** Gültige Positionen eines Schlusszeichens im Text; die Gültigkeit hängt nur vom Umfeld des Kandidaten ab. */
class Closers {
  private cache = new Map<string, number[]>();
  private text: string;
  constructor(text: string) {
    this.text = text;
  }

  private positions(key: string, needle: string, ok: (at: number) => boolean): number[] {
    let list = this.cache.get(key);
    if (!list) {
      list = [];
      for (let at = this.text.indexOf(needle); at >= 0; at = this.text.indexOf(needle, at + 1)) if (ok(at)) list.push(at);
      this.cache.set(key, list);
    }
    return list;
  }

  /** Erste gültige Position ≥ from innerhalb des Fensters, sonst -1. */
  find(key: string, needle: string, from: number, ok: (at: number) => boolean = () => true): number {
    const list = this.positions(key, needle, ok);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    const at = lo < list.length ? list[lo] : -1;
    return at >= 0 && at - from <= WINDOW ? at : -1;
  }
}

const MARK_ORDER = ["link", "bold", "italic", "underline", "strike", "code", "color"];

export function parseInline(text: string, ctx: InlineContext = {}, marks: Mark[] = [], depth = 0): DocJSON[] {
  const out: DocJSON[] = [];
  const closers = new Closers(text);
  let buf = "";
  const sorted = (m: Mark[]) => [...m].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  const sameMarks = (a?: Mark[], b?: Mark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const push = (t: string, m: Mark[]) => {
    if (!t) return;
    const ms = m.length ? sorted(m) : undefined;
    const last = out[out.length - 1];
    if (last && last.type === "text" && sameMarks(last.marks, ms)) last.text += t;
    else out.push(ms ? { type: "text", text: t, marks: ms } : { type: "text", text: t });
  };
  const flush = () => {
    push(buf, marks);
    buf = "";
  };
  // Gleiche Markierung nie doppelt (sonst ist der Absatz ungültig und wird zu reinem Text);
  // ein innerer Link ersetzt den äußeren
  const withMarks = (extra: Mark[]) => [...marks.filter((m) => !extra.some((e) => e.type === m.type)), ...extra];
  const hasLink = marks.some((m) => m.type === "link");
  const nested = (inner: string, extra: Mark[]) => {
    flush();
    if (depth >= MAX_DEPTH) push(inner, withMarks(extra));
    else for (const n of parseInline(inner, ctx, withMarks(extra), depth + 1)) out.push(n);
  };
  /** Steht vor `at` eine ungerade Zahl Backslashes (Zeichen ist maskiert)? */
  const escaped = (at: number) => {
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes++;
    return slashes % 2 === 1;
  };
  // Bereiche von Code-Spans: darin schließt keine Hervorhebung
  let codeSpans: number[] | null = null;
  const inCodeSpan = (at: number) => {
    if (!codeSpans) {
      codeSpans = [];
      for (let k = text.indexOf("`"); k >= 0; ) {
        // \` ist ein maskierter Backtick, kein Code-Anfang
        if (escaped(k)) {
          k = text.indexOf("`", k + 1);
          continue;
        }
        let n = 1;
        while (text[k + n] === "`") n++;
        const end = closers.find(`code${n}`, "`".repeat(n), k + n, (a) => text[a + n] !== "`" && text[a - 1] !== "`");
        if (end > k + n) {
          codeSpans.push(k, end + n);
          k = text.indexOf("`", end + n);
        } else k = text.indexOf("`", k + n);
      }
    }
    const spans = codeSpans;
    let lo = 0;
    let hi = spans.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid * 2 + 1] <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo < spans.length / 2 && spans[lo * 2] <= at;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Escape
    if (c === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    // Code: gleich lange Backtick-Folge schließt
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const ticks = "`".repeat(n);
      const end = closers.find(`code${n}`, ticks, i + n, (at) => text[at + n] !== "`" && text[at - 1] !== "`");
      if (end > i + n) {
        flush();
        // Je ein Rand-Leerzeichen entfernen – außer der Inhalt besteht nur aus Leerzeichen (CommonMark)
        const raw = text.slice(i + n, end);
        push(/[^ ]/.test(raw) ? raw.replace(/^ (.*) $/s, "$1") : raw, [...marks, { type: "code" }]);
        i = end + n;
      } else {
        buf += ticks;
        i += n;
      }
      continue;
    }
    // Wikilink [[Titel]], Bild ![alt](src) und Link [text](href)
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const isImg = c === "!";
      const open = isImg ? i + 1 : i;
      if (!isImg && text[i + 1] === "[") {
        const end = closers.find("wiki", "]]", i + 2);
        if (end > i + 2 && end - i < 500 && !text.slice(i + 2, end).includes("\n")) {
          const target = text.slice(i + 2, end);
          const pageId = ctx.resolveWiki?.(target.split("|")[0]);
          flush();
          if (pageId) out.push({ type: "mention", attrs: { pageId } });
          else push(target, marks);
          i = end + 2;
          continue;
        }
      }
      // \] (so exportiert escapeMd eckige Klammern im Linktext) und ] in Code schließen nicht
      const close = closers.find("]", "]", open + 1, (at) => !escaped(at) && !inCodeSpan(at));
      if (close > open && text[close + 1] === "(") {
        // Adressen sind kurz: nur bis 2.048 Zeichen nach „(“ suchen (sonst wird bei vielen „[x](“ quadratisch kopiert)
        const found = closers.find(")", ")", close + 2);
        const paren = found > 0 && found - close <= 2050 ? found : -1;
        const inside = paren > 0 ? text.slice(close + 2, paren) : "";
        const m = /^(\S+)(?:\s+"[^"]*")?$/.exec(inside);
        if (paren > 0 && m) {
          const label = text.slice(open + 1, close);
          const href = m[1];
          flush();
          if (isImg) {
            // Inline-Bild: als Text-Link übernehmen (Bilder sind Blöcke)
            const src = ctx.resolveAsset?.(href) ?? href;
            push(label || src, withMarks([{ type: "link", attrs: { href: src } }]));
          } else {
            const pageId = ctx.resolveLink?.(href);
            if (pageId) out.push({ type: "mention", attrs: { pageId } });
            // Leerer Linktext: die Adresse selbst anzeigen (nichts geht verloren)
            else nested(label || href, [{ type: "link", attrs: { href } }]);
          }
          i = paren + 1;
          continue;
        }
      }
      buf += c;
      i += 1;
      continue;
    }
    // Hervorhebungen: ***x*** **x** __x__ *x* _x_ ~~x~~
    if (c === "*" || c === "_" || (c === "~" && text[i + 1] === "~")) {
      let run = 1;
      while (text[i + run] === c && run < 3) run++;
      const len = c === "~" ? 2 : run;
      const delim = c.repeat(len);
      const prev = text[i - 1];
      const next = text[i + len];
      // Öffner: nicht vor Leerzeichen; "_" nicht innerhalb von Wörtern
      const canOpen = !isSpace(next) && next !== c && !(c === "_" && isWordChar(prev));
      if (canOpen) {
        const end = closers.find(`em${c}${len}`, delim, i + len + 1, (at) => {
          if (isSpace(text[at - 1]) || text[at - 1] === c) return false;
          if (escaped(at) || inCodeSpan(at)) return false; // \* und `*` schließen nicht
          if (text[at + len] === c) return false;
          if (c === "_" && isWordChar(text[at + len])) return false;
          return true;
        });
        if (end > 0) {
          const inner = text.slice(i + len, end);
          const extra: Mark[] = c === "~" ? [{ type: "strike" }] : len === 3 ? [{ type: "bold" }, { type: "italic" }] : len === 2 ? [{ type: "bold" }] : [{ type: "italic" }];
          nested(inner, extra);
          i = end + len;
          continue;
        }
      }
      buf += delim;
      i += len;
      continue;
    }
    // <u>x</u>
    if (c === "<" && text.startsWith("<u>", i)) {
      const end = closers.find("u", "</u>", i + 3);
      if (end > i + 3) {
        nested(text.slice(i + 3, end), [{ type: "underline" }]);
        i = end + 4;
        continue;
      }
    }
    // Nackte URL
    if (!hasLink && (c === "h" || c === "H") && /^https?:\/\//i.test(text.slice(i, i + 8)) && !isWordChar(text[i - 1])) {
      let j = i;
      while (j < text.length && j - i < 4096 && !/[\s<>()]/.test(text[j])) j++;
      while (j > i && /[.,;:!?"']/.test(text[j - 1])) j--;
      const url = text.slice(i, j);
      if (url.length > 8) {
        flush();
        push(url, [...marks, { type: "link", attrs: { href: url } }]);
        i = j;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

function block(type: string, indent: number, content: DocJSON[], attrs: Record<string, unknown> = {}): DocJSON {
  return { type, attrs: { indent, ...attrs }, content: content.length ? content : undefined };
}

/** Parst Markdown in ein flaches Blockdokument. */
export function markdownToDoc(md: string, ctx: InlineContext & { pageBlockFor?: (href: string) => string | null } = {}): DocJSON {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocJSON[] = [];
  const indentStack: number[] = []; // Spaltenpositionen für Listen-Einzüge
  const indentFor = (spaces: number) => {
    while (indentStack.length && indentStack[indentStack.length - 1] > spaces) indentStack.pop();
    if (!indentStack.length || indentStack[indentStack.length - 1] < spaces) indentStack.push(spaces);
    return indentStack.length - 1;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(block("paragraph", 0, parseInline(para.join("\n").replace(/ {2,}\n/g, "\n"), ctx).flatMap(splitBreaks)));
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.replace(/\t/g, "    ");
    const spaces = /^ */.exec(raw)![0].length;
    const t = raw.trim();
    if (!t) {
      flushPara();
      continue;
    }
    // Code-Block
    const fence = /^(`{3,}|~{3,})\s*([\w+#-]*)/.exec(t);
    if (fence) {
      flushPara();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) code.push(lines[j].slice(Math.min(spaces, /^ */.exec(lines[j])![0].length))), j++;
      i = j;
      const text = code.join("\n");
      blocks.push({ type: "code_block", attrs: { indent: 0, language: fence[2] ? fence[2].toLowerCase() : "plain" }, content: text ? [{ type: "text", text }] : undefined });
      continue;
    }
    // Schließende "#" nur mit Leerzeichen davor entfernen ("# Learn C#" bleibt erhalten)
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(t);
    if (heading && spaces < 4) {
      flushPara();
      indentStack.length = 0;
      blocks.push(block("heading", 0, parseInline(heading[2], ctx), { level: Math.min(4, heading[1].length) }));
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(t)) {
      flushPara();
      indentStack.length = 0;
      blocks.push({ type: "divider", attrs: { indent: 0 } });
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(t);
    if (img) {
      flushPara();
      const src = ctx.resolveAsset?.(img[2]) ?? img[2];
      blocks.push({ type: "image", attrs: { indent: spaces ? indentFor(spaces) : 0, src, caption: img[1] } });
      continue;
    }
    // Zeile, die nur aus einem Link auf eine Unterseite besteht → Seitenblock
    const onlyLink = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
    if (onlyLink && ctx.pageBlockFor) {
      const pid = ctx.pageBlockFor(onlyLink[2]);
      if (pid) {
        flushPara();
        blocks.push({ type: "page", attrs: { indent: 0, pageId: pid } });
        continue;
      }
    }
    const todo = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(t);
    if (todo) {
      flushPara();
      blocks.push(block("todo", indentFor(spaces), parseInline(todo[2], ctx), { checked: todo[1] !== " " }));
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    if (bullet) {
      flushPara();
      blocks.push(block("bullet", indentFor(spaces), parseInline(bullet[1], ctx)));
      continue;
    }
    const num = /^\d+[.)]\s+(.*)$/.exec(t);
    if (num) {
      flushPara();
      blocks.push(block("numbered", indentFor(spaces), parseInline(num[1], ctx)));
      continue;
    }
    if (t.startsWith(">")) {
      flushPara();
      const q: string[] = [t.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith(">")) q.push(lines[++i].trim().replace(/^>\s?/, ""));
      blocks.push(block("quote", 0, parseInline(q.join("\n"), ctx).flatMap(splitBreaks)));
      continue;
    }
    // Notion exportiert Callouts als <aside>
    if (/^<aside>/i.test(t)) {
      flushPara();
      const body: string[] = [t.replace(/^<aside>/i, "")];
      while (i + 1 < lines.length && !/<\/aside>/i.test(body[body.length - 1])) body.push(lines[++i]);
      const text = body.join("\n").replace(/<\/aside>/i, "").trim();
      const em = /^(\p{Extended_Pictographic}️?)\s*/u.exec(text);
      blocks.push(block("callout", 0, parseInline(em ? text.slice(em[0].length) : text, ctx).flatMap(splitBreaks), { icon: em ? em[1] : "💡" }));
      continue;
    }
    // Tabellen werden zeilenweise als Text übernommen
    if (/^\|.*\|$/.test(t)) {
      flushPara();
      if (/^\|[\s:|-]+\|$/.test(t)) continue;
      const cells = t.slice(1, -1).split("|").map((c) => c.trim());
      blocks.push(block("paragraph", 0, parseInline(cells.join("  ·  "), ctx)));
      continue;
    }
    if (spaces >= 2 && indentStack.length && blocks.length && para.length === 0) {
      // Fortsetzungszeile eines Listenpunkts
      const last = blocks[blocks.length - 1];
      if (["bullet", "numbered", "todo"].includes(last.type)) {
        last.content = [...(last.content ?? []), { type: "hard_break" }, ...parseInline(t, ctx)];
        continue;
      }
    }
    indentStack.length = 0;
    para.push(t);
  }
  flushPara();
  if (!blocks.length) blocks.push({ type: "paragraph", attrs: { indent: 0 } });
  return { type: "doc", content: blocks };
}

/** Zerlegt "\n" in Textknoten in hard_break-Knoten. */
function splitBreaks(n: DocJSON): DocJSON[] {
  if (n.type !== "text" || !n.text?.includes("\n")) return [n];
  const parts = n.text.split("\n");
  const out: DocJSON[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push({ type: "hard_break" });
    if (p) out.push({ ...n, text: p });
  });
  return out;
}

/** Heuristik: sieht der eingefügte Text nach Markdown aus? */
export function looksLikeMarkdown(text: string): boolean {
  return /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|- \[[ xX]\])/m.test(text) || /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text);
}
