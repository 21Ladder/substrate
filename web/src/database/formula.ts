import { dayDiff, median } from "../lib/util";

// Formel-Sprache nach dem Vorbild von Notion Formulas 2.0.
// Unterstützt: Zahlen, Text, Wahrheitswerte, Datum, Listen, Seiten; Operatoren; Methoden-Syntax
// (a.f(b) ≙ f(a, b)); prop("Name"); let/lets; map/filter/find/some/every mit current/index.

export type FValue = number | string | boolean | Date | FValue[] | FPage | null;

export interface FPage {
  __page: string;
  title: string;
  prop: (name: string) => FValue;
}

export class FormulaError extends Error {}

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "id"; name: string }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "tern"; c: Node; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "list"; items: Node[] };

// ---------- Tokenizer ----------

interface Tok {
  t: "num" | "str" | "id" | "op" | "eof";
  v: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "„") {
      const close = c === "“" || c === "„" ? "”“" : c;
      let s = "";
      let j = i + 1;
      while (j < src.length && !close.includes(src[j])) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError("Text nicht abgeschlossen");
      out.push({ t: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_À-ɏ]/.test(c)) {
      const m = /^[A-Za-z_À-ɏ][\wÀ-ɏ]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*/%^<>!?:(),.[]".includes(c)) {
      out.push({ t: "op", v: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unerwartetes Zeichen „${c}“`);
  }
  out.push({ t: "eof", v: "", pos: src.length });
  return out;
}

// ---------- Parser (Pratt) ----------

const BIN_PREC: Record<string, number> = {
  "||": 1,
  or: 1,
  "&&": 2,
  and: 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 7,
};

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  /** Nur echte Satzzeichen zählen – ein Text-Literal ")" ist kein Klammerzeichen. */
  const isOp = (v: string) => peek().t === "op" && peek().v === v;
  const expect = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new FormulaError(`„${v}“ erwartet bei Position ${t.pos + 1}`);
  };

  function primary(): Node {
    const t = next();
    if (t.t === "num") return { k: "num", v: Number(t.v) };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      const items: Node[] = [];
      if (!isOp("]")) {
        do items.push(expr(0));
        while (isOp(",") && next());
      }
      expect("]");
      return { k: "list", items };
    }
    if (t.t === "op" && (t.v === "-" || t.v === "!")) return { k: "un", op: t.v, a: unary() };
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
      if (t.v === "not") return { k: "un", op: "!", a: unary() };
      if (isOp("(")) {
        next();
        const args: Node[] = [];
        if (!isOp(")")) {
          do args.push(expr(0));
          while (isOp(",") && next());
        }
        expect(")");
        return { k: "call", name: t.v, args };
      }
      return { k: "id", name: t.v };
    }
    throw new FormulaError(t.t === "eof" ? "Formel unvollständig" : `Unerwartet: „${t.v}“`);
  }

  function postfix(n: Node): Node {
    while (isOp(".")) {
      next();
      const name = next();
      if (name.t !== "id") throw new FormulaError("Methodenname erwartet");
      const args: Node[] = [n];
      if (isOp("(")) {
        next();
        if (!isOp(")")) {
          do args.push(expr(0));
          while (isOp(",") && next());
        }
        expect(")");
      }
      n = { k: "call", name: name.v, args };
    }
    return n;
  }

  function unary(): Node {
    return postfix(primary());
  }

  function expr(minPrec: number): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t.t === "op" && t.v === "?" && minPrec === 0) {
        next();
        const a = expr(0);
        expect(":");
        const b = expr(0);
        left = { k: "tern", c: left, a, b };
        continue;
      }
      const op = t.v;
      const prec = Object.hasOwn(BIN_PREC, op) ? BIN_PREC[op] : undefined;
      if (prec === undefined || prec <= minPrec || (t.t !== "op" && t.t !== "id")) break;
      if (t.t === "id" && op !== "and" && op !== "or") break;
      next();
      // Linksassoziativ; Potenz rechtsassoziativ
      const right = expr(op === "^" ? prec - 1 : prec);
      left = { k: "bin", op: op === "and" ? "&&" : op === "or" ? "||" : op, a: left, b: right };
    }
    return left;
  }

  let result: Node;
  try {
    result = expr(0);
  } catch (e) {
    // Extrem tiefe Klammerung: kontrollierter Fehler statt Stack-Überlauf
    if (e instanceof RangeError) throw new FormulaError("Formel zu tief verschachtelt");
    throw e;
  }
  if (peek().t !== "eof") throw new FormulaError(`Unerwartet: „${peek().v}“`);
  return result;
}

// ---------- Auswertung ----------

export interface Env {
  prop: (name: string) => FValue;
  id: string;
  vars?: Record<string, FValue>;
  /** Rechenbudget einer Auswertung (gemeinsam für alle verschachtelten Aufrufe). */
  budget?: { steps: number };
}

/** Obergrenzen pro Auswertung: verhindern, dass eine Formel die Oberfläche einfriert. */
// Gemeinsam für verschachtelte Auswertungen (Rollups über verknüpfte Formeln brauchen Spielraum)
const MAX_STEPS = 200_000;
const MAX_TEXT = 1_000_000;
const MAX_LIST = 100_000;
const MAX_REGEX_INPUT = 2_000;

function guardSize<T extends FValue>(v: T): T {
  if (typeof v === "string" && v.length > MAX_TEXT) throw new FormulaError("Ergebnis zu lang");
  if (Array.isArray(v) && v.length > MAX_LIST) throw new FormulaError("Liste zu lang");
  return v;
}

const isDate = (v: FValue): v is Date => v instanceof Date;
const isPage = (v: FValue): v is FPage => !!v && typeof v === "object" && "__page" in (v as object);

export function toText(v: FValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isDate(v)) return v.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (isPage(v)) return v.title;
  return String(v);
}

function toNum(v: FValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isNaN(n) ? 0 : n;
  }
  if (isDate(v)) return v.getTime();
  return 0;
}

function truthy(v: FValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v && v !== "";
}

export function isEmptyValue(v: FValue): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "number" && Number.isNaN(v));
}

function equals(a: FValue, b: FValue): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  if (isPage(a) && isPage(b)) return a.__page === b.__page;
  return a === b;
}

const UNITS: Record<string, number> = { milliseconds: 1, seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };
const UNIT_ALIASES: Record<string, string> = {
  ms: "milliseconds",
  millisecond: "milliseconds",
  second: "seconds",
  sekunden: "seconds",
  minute: "minutes",
  minuten: "minutes",
  hour: "hours",
  stunden: "hours",
  day: "days",
  tage: "days",
  week: "weeks",
  wochen: "weeks",
  month: "months",
  monate: "months",
  quarter: "quarters",
  year: "years",
  jahre: "years",
};

function unit(u: FValue): string {
  const s = toText(u).toLowerCase();
  return Object.hasOwn(UNIT_ALIASES, s) ? UNIT_ALIASES[s] : s;
}

/** Monate addieren, am Monatsende begrenzt (31. Jan + 1 Monat = 28./29. Feb). */
function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, last));
  return r;
}

function dateAdd(d: Date, n: number, u: string): Date {
  if (u === "months") return addMonths(d, n);
  if (u === "quarters") return addMonths(d, n * 3);
  if (u === "years") return addMonths(d, n * 12);
  // Tage/Wochen als Kalendertage (sicher über die Zeitumstellung)
  if (u === "days" || u === "weeks") {
    const r = new Date(d.getTime());
    r.setDate(r.getDate() + n * (u === "weeks" ? 7 : 1));
    return r;
  }
  if (!Object.hasOwn(UNITS, u)) throw new FormulaError(`Unbekannte Einheit „${u}“`);
  return new Date(d.getTime() + n * UNITS[u]);
}

function dateBetween(a: Date, b: Date, u: string): number {
  if (u === "months" || u === "quarters" || u === "years") {
    // Ganze Monate zwischen b und a, symmetrisch: dateBetween(a, b) = −dateBetween(b, a)
    const sign = a.getTime() >= b.getTime() ? 1 : -1;
    const [hi, lo] = sign > 0 ? [a, b] : [b, a];
    let months = (hi.getFullYear() - lo.getFullYear()) * 12 + (hi.getMonth() - lo.getMonth());
    if (addMonths(lo, months).getTime() > hi.getTime()) months--;
    const n = u === "years" ? Math.trunc(months / 12) : u === "quarters" ? Math.trunc(months / 3) : months;
    return sign * n;
  }
  if (u === "days" || u === "weeks") {
    // Kalendertage (unabhängig von Zeitumstellung), angebrochene Tage zählen wie bei Notion nicht
    let days = dayDiff(a, b);
    const timeA = a.getHours() * 3600000 + a.getMinutes() * 60000 + a.getSeconds() * 1000;
    const timeB = b.getHours() * 3600000 + b.getMinutes() * 60000 + b.getSeconds() * 1000;
    if (days > 0 && timeA < timeB) days--;
    if (days < 0 && timeA > timeB) days++;
    return u === "weeks" ? Math.trunc(days / 7) : days;
  }
  if (!Object.hasOwn(UNITS, u)) throw new FormulaError(`Unbekannte Einheit „${u}“`);
  return Math.trunc((a.getTime() - b.getTime()) / UNITS[u]);
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  const months = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const days = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  // Längere Kürzel zuerst (Do vor D); Text in [eckigen Klammern] bleibt unverändert (wie bei moment.js)
  return fmt.replace(/\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|mm|ss|A|a/g, (t) => {
    if (t.startsWith("[")) return t.slice(1, -1);
    switch (t) {
      case "YYYY":
        return String(d.getFullYear());
      case "YY":
        return pad(d.getFullYear() % 100);
      case "MMMM":
        return months[d.getMonth()];
      case "MMM":
        return months[d.getMonth()].slice(0, 3);
      case "MM":
        return pad(d.getMonth() + 1);
      case "M":
        return String(d.getMonth() + 1);
      case "DD":
        return pad(d.getDate());
      case "D":
        return String(d.getDate());
      case "Do":
        return d.getDate() + ".";
      case "dddd":
        return days[d.getDay()];
      case "ddd":
        return days[d.getDay()].slice(0, 2);
      case "HH":
        return pad(d.getHours());
      case "H":
        return String(d.getHours());
      case "hh":
        return pad(((d.getHours() + 11) % 12) + 1);
      case "mm":
        return pad(d.getMinutes());
      case "ss":
        return pad(d.getSeconds());
      case "A":
        return d.getHours() < 12 ? "AM" : "PM";
      case "a":
        return d.getHours() < 12 ? "am" : "pm";
    }
    return t;
  });
}

/** Eindeutiger Schlüssel eines Werts für Mengen (gleich ⇔ equals()). */
function valueKey(v: FValue): string {
  if (v === null || v === undefined) return "n";
  if (v instanceof Date) return "d" + v.getTime();
  if (Array.isArray(v)) return "l" + JSON.stringify(v.map(valueKey));
  if (typeof v === "object" && "__page" in (v as object)) return "p" + (v as FPage).__page;
  return typeof v + ":" + String(v);
}

function asList(v: FValue): FValue[] {
  return Array.isArray(v) ? v : v === null ? [] : [v];
}

function toDate(v: FValue): Date {
  if (isDate(v)) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string" && v) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T00:00:00") : new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new FormulaError("Datum erwartet");
}

/**
 * Reguläre Ausdrücke laufen nativ und lassen sich nicht unterbrechen. Damit kein Muster exponentiell
 * (oder hochpolynomiell) lange läuft, gilt eine bewusst strenge, sichere Teilmenge:
 * - keine Wiederholung von Gruppen oder Rückverweisen: (…)+, (…)*, (…){n}, (…){n,}, \1+
 * - höchstens zwei unbegrenzte Wiederholungen (+, *, {n,}) im ganzen Muster
 * - Eingabetext höchstens 2.000 Zeichen
 * - Kostenabschätzung vor jedem Lauf (siehe regexCost): Textlänge × Produkt aller Wiederholungen
 *   (unbegrenzt = Textlänge, {m,n} = n−m+1, ? = 2, jede Alternative | = 2) muss unter REGEX_BUDGET bleiben.
 * Liefert die Wiederholungsfaktoren des Musters (Infinity = unbegrenzt).
 */
function checkRegexSafety(src: string): number[] {
  // Zeichenklassen, Escapes und Gruppen-Syntax ((?:, (?=, (?<name>) für die Analyse neutralisieren
  const plain = src
    .replace(/\\./g, "x")
    .replace(/\[(?:\\.|[^\]\\])*\]/g, "x")
    .replace(/\(\?(?:<?[=!]|<[^>]*>|:)?/g, "(")
    .replace(/([+*?}])\?/g, "$1"); // genügsame Varianten (+?, *?) zählen wie die normalen
  if (/\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(plain) || /\\\d+\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(src)) {
    throw new FormulaError("Regulärer Ausdruck zu komplex: wiederholte Gruppen werden nicht unterstützt");
  }
  const unbounded = (plain.match(/[+*]|\{\d+,\}/g) ?? []).length;
  if (unbounded > 2) throw new FormulaError("Regulärer Ausdruck zu komplex: höchstens zwei unbegrenzte Wiederholungen (+, *)");
  const factors: number[] = [];
  for (const m of plain.matchAll(/[+*?|]|\{(\d+)(,(\d*))?\}/g)) {
    if (m[0] === "+" || m[0] === "*") factors.push(Infinity);
    else if (m[0] === "?" || m[0] === "|") factors.push(2);
    else if (m[2] === undefined) factors.push(1);
    else factors.push(m[3] === "" ? Infinity : Math.max(1, Number(m[3]) - Number(m[1]) + 1));
  }
  return factors;
}

/** Obergrenze für die geschätzte Rückverfolgungs-Arbeit eines Regex-Laufs. */
const REGEX_BUDGET = 1e7;

/** Geschätzter Aufwand im ungünstigsten Fall: jede Startposition × alle Kombinationen der Wiederholungen. */
function regexCost(factors: number[], len: number): number {
  let cost = Math.max(1, len);
  for (const f of factors) cost *= Math.min(f, len + 1);
  return cost;
}

function regex(p: FValue, flags: string, input: string): RegExp {
  const src = toText(p);
  if (src.length > 200) throw new FormulaError("Regulärer Ausdruck zu lang");
  const factors = checkRegexSafety(src);
  if (regexCost(factors, input.length) > REGEX_BUDGET) throw new FormulaError("Text zu lang für diesen regulären Ausdruck");
  try {
    return new RegExp(src, flags);
  } catch {
    throw new FormulaError("Ungültiger regulärer Ausdruck");
  }
}

/** Text für reguläre Ausdrücke begrenzen (auch harmlose Muster sollen nicht ewig laufen). */
function regexInput(v: FValue): string {
  const t = toText(v);
  if (t.length > MAX_REGEX_INPUT) throw new FormulaError("Text zu lang für reguläre Ausdrücke");
  return t;
}

/** Ergebnislänge VOR dem Zusammenfügen prüfen. */
function joinChecked(parts: string[], sep: string): string {
  let total = Math.max(0, parts.length - 1) * sep.length;
  for (const p of parts) total += p.length;
  if (total > MAX_TEXT) throw new FormulaError("Ergebnis zu lang");
  return parts.join(sep);
}

/**
 * Ersetzen mit Größenprüfung vor dem Erzeugen: Treffer werden erst gezählt, dann wird die höchstmögliche
 * Länge berechnet ($-Platzhalter fügen höchstens den Treffer bzw. bei $` und $' den ganzen Text ein).
 */
function replaceChecked(t: FValue, p: FValue, r: FValue, flags: "" | "g"): string {
  const s = regexInput(t);
  const repl = toText(r ?? "");
  const re = regex(p, flags, s);
  // Genaue Länge jeder Ersetzung berechnen ($&, $1, $<name>, $` und $' können lang sein)
  const matches = flags === "g" ? [...s.matchAll(re)] : [s.match(re)].filter((m): m is RegExpMatchArray => !!m);
  let total = s.length;
  for (const m of matches) {
    total += replacementLength(repl, m, s) - m[0].length;
    if (total > MAX_TEXT) throw new FormulaError("Ergebnis zu lang");
  }
  re.lastIndex = 0;
  return s.replace(re, repl);
}

/** Länge, die String.replace für diesen Treffer einsetzt (gleiche Regeln wie die Ersetzungsmuster). */
function replacementLength(repl: string, m: RegExpMatchArray, s: string): number {
  let len = 0;
  for (let i = 0; i < repl.length; i++) {
    if (repl[i] !== "$" || i + 1 >= repl.length) {
      len++;
      continue;
    }
    const c = repl[i + 1];
    const idx = m.index ?? 0;
    if (c === "$") {
      len++;
      i++;
    } else if (c === "&") {
      len += m[0].length;
      i++;
    } else if (c === "`") {
      len += idx;
      i++;
    } else if (c === "'") {
      len += s.length - idx - m[0].length;
      i++;
    } else if (/\d/.test(c)) {
      const two = repl.slice(i + 1, i + 3);
      const n2 = /^\d\d$/.test(two) ? Number(two) : NaN;
      const n = !Number.isNaN(n2) && n2 > 0 && n2 < m.length ? n2 : Number(c);
      if (n > 0 && n < m.length) {
        len += m[n]?.length ?? 0;
        i += String(n).length === 2 && !Number.isNaN(n2) && n === n2 ? 2 : 1;
      } else len++;
    } else if (c === "<" && m.groups) {
      const end = repl.indexOf(">", i + 2);
      if (end < 0) {
        len++;
        continue;
      }
      len += m.groups[repl.slice(i + 2, end)]?.length ?? 0;
      i = end;
    } else len++;
  }
  return len;
}

function padLength(n: FValue): number {
  const l = toNum(n);
  if (l > MAX_TEXT) throw new FormulaError("Ergebnis zu lang");
  return l;
}

/** Funktionen, deren Argumente erst bei Bedarf ausgewertet werden. */
const LAZY = new Set(["if", "ifs", "map", "filter", "find", "findIndex", "some", "every", "let", "lets", "and", "or"]);

type Fn = (args: FValue[]) => FValue;

const flatNums = (args: FValue[]) => args.flatMap((a) => asList(a)).map(toNum);

const FUNCS: Record<string, Fn> = {
  // Text
  concat: (a) => (a.every(Array.isArray) ? (a as FValue[][]).flat() : joinChecked(a.map(toText), "")),
  join: ([l, sep]) => joinChecked(asList(l).map(toText), toText(sep ?? "")),
  format: ([v]) => toText(v),
  length: ([v]) => (Array.isArray(v) ? v.length : toText(v).length),
  contains: ([t, s]) => (Array.isArray(t) ? t.some((x) => equals(x, s)) : toText(t).includes(toText(s))),
  includes: ([t, s]) => (Array.isArray(t) ? t.some((x) => equals(x, s)) : toText(t).includes(toText(s))),
  substring: ([t, s, e]) => toText(t).substring(toNum(s), e === undefined ? undefined : toNum(e)),
  slice: ([t, s, e]) => (Array.isArray(t) ? t.slice(toNum(s), e === undefined ? undefined : toNum(e)) : toText(t).slice(toNum(s), e === undefined ? undefined : toNum(e))),
  replace: ([t, p, r]) => replaceChecked(t, p, r, ""),
  replaceAll: ([t, p, r]) => replaceChecked(t, p, r, "g"),
  test: ([t, p]) => {
    const s = regexInput(t);
    return regex(p, "", s).test(s);
  },
  match: ([t, p]) => {
    const s = regexInput(t);
    return s.match(regex(p, "g", s)) ?? [];
  },
  lower: ([t]) => toText(t).toLowerCase(),
  upper: ([t]) => toText(t).toUpperCase(),
  trim: ([t]) => toText(t).trim(),
  // Größe VOR dem Erzeugen prüfen – sonst entsteht erst ein riesiger Text und dann der Fehler
  repeat: ([t, n]) => {
    const s = toText(t);
    const k = Math.max(0, Math.min(1000, Math.floor(toNum(n)) || 0));
    if (s.length * k > MAX_TEXT) throw new FormulaError("Ergebnis zu lang");
    return s.repeat(k);
  },
  padStart: ([t, n, c]) => toText(t).padStart(padLength(n), toText(c ?? " ")),
  padEnd: ([t, n, c]) => toText(t).padEnd(padLength(n), toText(c ?? " ")),
  split: ([t, s]) => toText(t).split(toText(s ?? "")),
  link: ([label]) => toText(label),
  style: ([t]) => toText(t),
  unstyle: ([t]) => toText(t),
  // Zahlen
  add: ([a, b]) => (typeof a === "string" || typeof b === "string" ? toText(a) + toText(b) : toNum(a) + toNum(b)),
  subtract: ([a, b]) => toNum(a) - toNum(b),
  multiply: ([a, b]) => toNum(a) * toNum(b),
  divide: ([a, b]) => toNum(a) / toNum(b),
  mod: ([a, b]) => toNum(a) % toNum(b),
  pow: ([a, b]) => Math.pow(toNum(a), toNum(b)),
  abs: ([a]) => Math.abs(toNum(a)),
  sqrt: ([a]) => Math.sqrt(toNum(a)),
  cbrt: ([a]) => Math.cbrt(toNum(a)),
  exp: ([a]) => Math.exp(toNum(a)),
  ln: ([a]) => Math.log(toNum(a)),
  log10: ([a]) => Math.log10(toNum(a)),
  log2: ([a]) => Math.log2(toNum(a)),
  round: ([a, p]) => {
    const f = Math.pow(10, p === undefined ? 0 : toNum(p));
    return Math.round(toNum(a) * f) / f;
  },
  ceil: ([a]) => Math.ceil(toNum(a)),
  floor: ([a]) => Math.floor(toNum(a)),
  sign: ([a]) => Math.sign(toNum(a)),
  min: (a) => {
    const xs = flatNums(a);
    return xs.length ? xs.reduce((m, x) => (x < m ? x : m)) : null;
  },
  max: (a) => {
    const xs = flatNums(a);
    return xs.length ? xs.reduce((m, x) => (x > m ? x : m)) : null;
  },
  sum: (a) => flatNums(a).reduce((x, y) => x + y, 0),
  mean: (a) => {
    const xs = flatNums(a);
    return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
  },
  median: (a) => median(flatNums(a)),
  toNumber: ([a]) => (isDate(a) ? a.getTime() : typeof a === "string" ? (Number.isNaN(Number(a.replace(",", "."))) ? null : Number(a.replace(",", "."))) : toNum(a)),
  pi: () => Math.PI,
  e: () => Math.E,
  // Logik
  empty: ([a]) => isEmptyValue(a),
  not: ([a]) => !truthy(a),
  equal: ([a, b]) => equals(a, b),
  unequal: ([a, b]) => !equals(a, b),
  larger: ([a, b]) => toNum(a) > toNum(b),
  smaller: ([a, b]) => toNum(a) < toNum(b),
  // Datum
  now: () => new Date(),
  today: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },
  dateAdd: ([d, n, u]) => dateAdd(toDate(d), toNum(n), unit(u)),
  dateSubtract: ([d, n, u]) => dateAdd(toDate(d), -toNum(n), unit(u)),
  dateBetween: ([a, b, u]) => dateBetween(toDate(a), toDate(b), unit(u)),
  dateStart: ([d]) => toDate(d),
  dateEnd: ([d]) => toDate(d),
  formatDate: ([d, f]) => formatDate(toDate(d), toText(f ?? "D. MMMM YYYY")),
  parseDate: ([s]) => toDate(s),
  timestamp: ([d]) => toDate(d).getTime(),
  fromTimestamp: ([n]) => new Date(toNum(n)),
  year: ([d]) => toDate(d).getFullYear(),
  month: ([d]) => toDate(d).getMonth() + 1,
  date: ([d]) => toDate(d).getDate(),
  day: ([d]) => toDate(d).getDay(),
  hour: ([d]) => toDate(d).getHours(),
  minute: ([d]) => toDate(d).getMinutes(),
  week: ([d]) => {
    const x = toDate(d);
    const t = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  },
  // Listen
  at: ([l, i]) => {
    const xs = asList(l);
    const n = toNum(i);
    return xs[n < 0 ? xs.length + n : n] ?? null;
  },
  first: ([l]) => asList(l)[0] ?? null,
  last: ([l]) => {
    const xs = asList(l);
    return xs[xs.length - 1] ?? null;
  },
  sort: ([l]) => [...asList(l)].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : toText(a).localeCompare(toText(b), "de"))),
  reverse: ([l]) => [...asList(l)].reverse(),
  unique: ([l]) => {
    // Linear über einen Schlüssel je Wert (statt paarweisem Vergleich)
    const seen = new Set<string>();
    return asList(l).filter((x) => {
      const k = valueKey(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  flat: ([l]) => asList(l).flatMap((x) => asList(x)),
  count: ([l]) => asList(l).length,
  list: (a) => a,
  id: () => null,
};

function evalNode(n: Node, env: Env, depth = 0): FValue {
  if (depth > 200) throw new FormulaError("Formel zu tief verschachtelt");
  if (env.budget && ++env.budget.steps > MAX_STEPS) throw new FormulaError("Formel zu aufwendig");
  switch (n.k) {
    case "num":
      return n.v;
    case "str":
      return n.v;
    case "bool":
      return n.v;
    case "list":
      return n.items.map((x) => evalNode(x, env, depth + 1));
    case "id": {
      if (env.vars && Object.hasOwn(env.vars, n.name)) return env.vars[n.name];
      if (n.name === "pi") return Math.PI;
      if (n.name === "e") return Math.E;
      throw new FormulaError(`Unbekannter Name „${n.name}“`);
    }
    case "un": {
      const a = evalNode(n.a, env, depth + 1);
      return n.op === "-" ? -toNum(a) : !truthy(a);
    }
    case "tern":
      return truthy(evalNode(n.c, env, depth + 1)) ? evalNode(n.a, env, depth + 1) : evalNode(n.b, env, depth + 1);
    case "bin": {
      if (n.op === "&&") return truthy(evalNode(n.a, env, depth + 1)) && truthy(evalNode(n.b, env, depth + 1));
      if (n.op === "||") return truthy(evalNode(n.a, env, depth + 1)) || truthy(evalNode(n.b, env, depth + 1));
      const a = evalNode(n.a, env, depth + 1);
      const b = evalNode(n.b, env, depth + 1);
      switch (n.op) {
        case "+":
          if (Array.isArray(a) && Array.isArray(b)) return guardSize([...a, ...b]);
          return typeof a === "string" || typeof b === "string" ? guardSize(toText(a) + toText(b)) : toNum(a) + toNum(b);
        case "-":
          return toNum(a) - toNum(b);
        case "*":
          return toNum(a) * toNum(b);
        case "/":
          return toNum(a) / toNum(b);
        case "%":
          return toNum(a) % toNum(b);
        case "^":
          return Math.pow(toNum(a), toNum(b));
        case "==":
          return equals(a, b);
        case "!=":
          return !equals(a, b);
        case "<":
          return typeof a === "string" && typeof b === "string" ? a < b : toNum(a) < toNum(b);
        case ">":
          return typeof a === "string" && typeof b === "string" ? a > b : toNum(a) > toNum(b);
        case "<=":
          return typeof a === "string" && typeof b === "string" ? a <= b : toNum(a) <= toNum(b);
        case ">=":
          return typeof a === "string" && typeof b === "string" ? a >= b : toNum(a) >= toNum(b);
      }
      throw new FormulaError(`Operator ${n.op}`);
    }
    case "call":
      return guardSize(callFn(n, env, depth));
  }
}

function callFn(n: Extract<Node, { k: "call" }>, env: Env, depth: number): FValue {
  const name = n.name;
  const ev = (x: Node, e: Env = env) => evalNode(x, e, depth + 1);
  if (name === "prop") {
    // Methoden-Syntax auf einer Seite: page.prop("X")
    if (n.args.length === 2) {
      const page = ev(n.args[0]);
      if (!isPage(page)) throw new FormulaError("prop() erwartet eine Seite");
      return page.prop(toText(ev(n.args[1])));
    }
    return env.prop(toText(ev(n.args[0])));
  }
  if (LAZY.has(name)) {
    switch (name) {
      case "if":
        return truthy(ev(n.args[0])) ? ev(n.args[1]) : n.args[2] ? ev(n.args[2]) : null;
      case "ifs": {
        for (let i = 0; i + 1 < n.args.length; i += 2) if (truthy(ev(n.args[i]))) return ev(n.args[i + 1]);
        return n.args.length % 2 ? ev(n.args[n.args.length - 1]) : null;
      }
      case "and":
        return n.args.every((a) => truthy(ev(a)));
      case "or":
        return n.args.some((a) => truthy(ev(a)));
      case "let":
      case "lets": {
        const vars = { ...(env.vars ?? {}) };
        const e2: Env = { ...env, vars };
        for (let i = 0; i + 1 < n.args.length; i += 2) {
          const id = n.args[i];
          if (id.k !== "id") throw new FormulaError("let() erwartet einen Variablennamen");
          vars[id.name] = ev(n.args[i + 1], e2);
        }
        return ev(n.args[n.args.length - 1], e2);
      }
      default: {
        // map/filter/find/findIndex/some/every
        const list = asList(ev(n.args[0]));
        const body = n.args[1];
        if (!body) throw new FormulaError(`${name}() erwartet einen Ausdruck`);
        const run = (x: FValue, i: number) => ev(body, { ...env, vars: { ...(env.vars ?? {}), current: x, index: i } });
        switch (name) {
          case "map":
            return list.map(run);
          case "filter":
            return list.filter((x, i) => truthy(run(x, i)));
          case "find":
            return list.find((x, i) => truthy(run(x, i))) ?? null;
          case "findIndex":
            return list.findIndex((x, i) => truthy(run(x, i)));
          case "some":
            return list.some((x, i) => truthy(run(x, i)));
          case "every":
            return list.every((x, i) => truthy(run(x, i)));
        }
      }
    }
  }
  const fn = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
  if (!fn) throw new FormulaError(`Unbekannte Funktion „${name}“`);
  if (name === "id") return env.id;
  return fn(n.args.map((a) => ev(a)));
}

const parseCache = new Map<string, Node | FormulaError>();
/** Budget der gerade laufenden äußersten Auswertung. */
let activeBudget: { steps: number } | null = null;

export function evaluate(src: string, env: Env): FValue {
  let ast = parseCache.get(src);
  if (!ast) {
    try {
      ast = parse(src);
    } catch (e) {
      ast = e instanceof FormulaError ? e : new FormulaError(String(e));
    }
    if (parseCache.size > 500) parseCache.clear();
    parseCache.set(src, ast);
  }
  if (ast instanceof FormulaError) throw ast;
  // Verschachtelte Auswertungen (eine Formel liest eine andere) teilen sich das Budget der äußeren
  const outer = activeBudget;
  const budget = outer ?? env.budget ?? { steps: 0 };
  activeBudget = budget;
  try {
    return evalNode(ast, { ...env, budget });
  } finally {
    activeBudget = outer;
  }
}

export function checkFormula(src: string): string | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const FORMULA_FUNCTIONS = ["prop", "if", "ifs", "let", "lets", "map", "filter", "find", "some", "every", ...Object.keys(FUNCS).filter((f) => f !== "list")];
