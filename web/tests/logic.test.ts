// Tests der reinen Logik (ohne DOM): node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, toText, checkFormula } from "../src/database/formula";
import { keyBetween, keysBetween } from "../src/lib/sortkey";
import { docToMarkdown, markdownToDoc, looksLikeMarkdown, parseInline } from "../src/editor/markdown";
import { parseCSV, toCSV, inferSchema, parseLooseDate } from "../src/lib/csv";

const props: Record<string, unknown> = { Preis: 10, Menge: 3, Name: "Apfel", Tags: ["a", "b"], Fertig: true, Datum: new Date(2026, 9, 7) };
const env = { id: "x", prop: (n: string) => (props[n] ?? null) as any };
const f = (src: string) => toText(evaluate(src, env));

test("Formeln: Operatoren und Vorrang", () => {
  assert.equal(f("1 + 2 * 3"), "7");
  assert.equal(f("(1 + 2) * 3"), "9");
  assert.equal(f("2 ^ 3 ^ 2"), "512");
  assert.equal(f("10 - 2 - 3"), "5");
  assert.equal(f("-2 + 5"), "3");
  assert.equal(f("not true or false"), "false");
  assert.equal(f("1 == 1 and 2 != 3"), "true");
  assert.equal(f('"a" + 1'), "a1");
});

test("Formeln: Eigenschaften, Methoden, Listen", () => {
  assert.equal(f('prop("Preis") * prop("Menge")'), "30");
  assert.equal(f('prop("Name").upper()'), "APFEL");
  assert.equal(f('prop("Tags").map(current + "!").join(", ")'), "a!, b!");
  assert.equal(f('prop("Tags").length()'), "2");
  assert.equal(f("[3,1,2].sort().reverse()"), "3, 2, 1");
  assert.equal(f("sum(1, 2, [3, 4])"), "10");
  assert.equal(f('[1,2,3].filter(current > 1).length()'), "2");
});

test("Formeln: Logik, Variablen, Datum, Text", () => {
  assert.equal(f('if(prop("Fertig"), "ja", "nein")'), "ja");
  assert.equal(f('prop("Fertig") ? "✓" : "✗"'), "✓");
  assert.equal(f('ifs(1 > 2, "a", 2 > 1, "b", "c")'), "b");
  assert.equal(f("let(x, 5, x * 2)"), "10");
  assert.equal(f("lets(a, 1, b, a + 1, a + b)"), "3");
  assert.equal(f('dateBetween(dateAdd(prop("Datum"), 3, "days"), prop("Datum"), "days")'), "3");
  assert.equal(f('formatDate(prop("Datum"), "DD.MM.YYYY")'), "07.10.2026");
  assert.equal(f("round(10 / 3, 2)"), "3.33");
  assert.equal(f('test("abc", "b")'), "true");
  assert.equal(f('empty("")'), "true");
});

test("Formeln: Fehler werden gemeldet", () => {
  for (const bad of ["1 +", "foo(", '"abc', "unknownFn(1)"]) assert.throws(() => evaluate(bad, env));
  assert.equal(checkFormula("1 +"), "Formel unvollständig");
  assert.equal(checkFormula('prop("A") + 1'), null);
});

test("Sortierschlüssel: immer strikt dazwischen", () => {
  const keys = keysBetween(null, null, 50);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  // Wiederholt vorne, hinten und in der Mitte einfügen
  let list = [keyBetween(null, null)];
  for (let i = 0; i < 2000; i++) {
    const pos = i % 3 === 0 ? 0 : i % 3 === 1 ? list.length : Math.floor(list.length / 2);
    const k = keyBetween(list[pos - 1] ?? null, list[pos] ?? null);
    list.splice(pos, 0, k);
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1] < list[i], `${list[i - 1]} < ${list[i]}`);
  assert.ok(list.every((k) => !k.endsWith("0")), "kein Schlüssel endet auf 0");
  assert.throws(() => keyBetween("b", "a"));
});

test("Markdown: Import erkennt Blöcke", () => {
  const doc = markdownToDoc("# Titel\n\nText mit **fett** und [Link](https://x.de)\n\n- a\n    - b\n- [x] erledigt\n1. eins\n> Zitat\n\n```js\nconst a = 1;\n```\n\n---\n![Bild](https://x.de/b.png)");
  const types = doc.content!.map((b) => b.type);
  assert.deepEqual(types, ["heading", "paragraph", "bullet", "bullet", "todo", "numbered", "quote", "code_block", "divider", "image"]);
  assert.equal(doc.content![3].attrs!.indent, 1);
  assert.equal(doc.content![4].attrs!.checked, true);
  assert.equal(doc.content![7].attrs!.language, "js");
  const para = doc.content![1].content!;
  assert.ok(para.some((n) => n.marks?.some((m) => m.type === "bold")));
  assert.ok(para.some((n) => n.marks?.some((m) => m.type === "link")));
});

test("Markdown: Export und Rundreise", () => {
  const md = "# Titel\n\nText mit **fett** und *kursiv*\n\n- a\n    - b\n- [ ] offen\n";
  const out = docToMarkdown(markdownToDoc(md), { titleOf: (id) => id });
  assert.equal(docToMarkdown(markdownToDoc(out), { titleOf: (id) => id }), out, "Export ist stabil");
  assert.ok(out.includes("**fett**") && out.includes("*kursiv*") && out.includes("    - b") && out.includes("- [ ] offen"));
  assert.ok(looksLikeMarkdown("- Punkt\n- Punkt"));
  assert.ok(!looksLikeMarkdown("Ganz normaler Satz."));
});

test("Markdown: Notion-Links werden zu Erwähnungen", () => {
  const doc = markdownToDoc("Siehe [Ideen](Ideen%20abc.md) und [[Wiki]]", {
    resolveLink: (h) => (h.startsWith("Ideen") ? "id-1" : null),
    resolveWiki: (t) => (t === "Wiki" ? "id-2" : null),
  });
  const mentions = doc.content![0].content!.filter((n) => n.type === "mention").map((n) => n.attrs!.pageId);
  assert.deepEqual(mentions, ["id-1", "id-2"]);
});

test("CSV: Parsen, Schreiben, Typen erkennen", () => {
  const rows = parseCSV('﻿Name,Status,Preis,Fällig,Tags,Fertig\n"Apfel, rot",Done,"1,50",October 7 2026,"a, b",Yes\nBirne,In progress,2,2026-10-08,a,No\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], "Apfel, rot");
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
  const schema = inferSchema(rows[0], rows.slice(1));
  assert.deepEqual(schema.map((p) => p.type), ["title", "status", "number", "date", "multi_select", "checkbox"]);
  assert.equal(schema[1].options!.find((o) => o.name === "Done")!.group, "done");
  assert.equal(parseLooseDate("07.10.2026"), "2026-10-07");
  assert.equal(parseLooseDate("2026-10-07T10:00"), "2026-10-07");
  assert.equal(parseLooseDate("kein Datum"), null);
});

test("Formeln: Satzzeichen in Texten und Variablennamen", () => {
  assert.equal(f('concat(")", "a")'), ")a");
  assert.equal(f('["]", "x"].length()'), "2");
  assert.equal(f('test(")", "\\\\)")'), "true");
  assert.throws(() => evaluate("let(x, 1, toString)", env));
});

test("Markdown: Unterstriche in Wörtern, fett+kursiv, Listenzählung", () => {
  const p = markdownToDoc("- my_var_name und _kursiv_").content![0].content!;
  assert.equal(p.map((n) => n.text ?? "").join(""), "my_var_name und kursiv");
  assert.ok(p.some((n) => n.text === "kursiv" && n.marks?.[0].type === "italic"));
  const both = { type: "doc", content: [{ type: "paragraph", attrs: { indent: 0 }, content: [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "italic" }] }] }] };
  const md = docToMarkdown(both, { titleOf: (id) => id });
  const back = markdownToDoc(md).content![0].content![0];
  assert.equal(back.text, "x");
  assert.deepEqual(back.marks!.map((m) => m.type).sort(), ["bold", "italic"]);
  const lists = markdownToDoc("1. a\n2. b\n\n## Zwischen\n\n1. c");
  assert.ok(docToMarkdown(lists, { titleOf: (id) => id }).includes("1. c"));
});

test("Zahlen: deutsches und englisches Format", async () => {
  const { parseLocaleNumber, minMax } = await import("../src/lib/util");
  assert.equal(parseLocaleNumber("1.234,50"), 1234.5);
  assert.equal(parseLocaleNumber("1,234.50"), 1234.5);
  assert.equal(parseLocaleNumber("1,5"), 1.5);
  assert.equal(parseLocaleNumber("12 %"), 12);
  assert.equal(parseLocaleNumber("1.234.567"), 1234567);
  assert.equal(parseLocaleNumber("abc"), null);
  const big = Array.from({ length: 200000 }, (_, i) => i);
  assert.deepEqual(minMax(big), { min: 0, max: 199999 });
});

test("Datum: Zeitumstellung und Monatsenden (Europe/Berlin)", () => {
  const d = (s: string) => `parseDate("${s}")`;
  assert.equal(f(`dateBetween(${d("2026-03-30")}, ${d("2026-03-29")}, "days")`), "1");
  assert.equal(f(`formatDate(dateAdd(${d("2026-10-25")}, 1, "days"), "YYYY-MM-DD")`), "2026-10-26");
  assert.equal(f(`formatDate(dateAdd(${d("2026-01-31")}, 1, "months"), "YYYY-MM-DD")`), "2026-02-28");
  assert.equal(f(`dateBetween(${d("2026-01-31")}, ${d("2026-03-01")}, "months")`), "-1");
  assert.equal(f(`dateBetween(${d("2026-03-01")}, ${d("2026-01-31")}, "months")`), "1");
  assert.throws(() => evaluate("toString()", env));
  assert.throws(() => evaluate('dateAdd(now(), 1, "toString")', env));
});

test("Sortierschlüssel: viele Geschwister bleiben kurz (Import)", () => {
  const ks = keysBetween(null, null, 5000);
  assert.equal(ks.length, 5000);
  assert.ok(Math.max(...ks.map((k) => k.length)) <= 3, String(Math.max(...ks.map((k) => k.length))));
  for (let i = 1; i < ks.length; i++) {
    assert.ok(ks[i - 1] < ks[i], `${ks[i - 1]} < ${ks[i]}`);
    const mid = keyBetween(ks[i - 1], ks[i]);
    assert.ok(ks[i - 1] < mid && mid < ks[i]);
  }
  assert.ok(keyBetween(null, ks[0]) < ks[0]);
  for (const n of [1, 2, 61, 62, 63, 3843, 3844]) {
    const k = keysBetween(null, null, n);
    assert.ok(k.every((x, i) => i === 0 || k[i - 1] < x), String(n));
  }
});

test("Sortierschlüssel: robuste Variante wirft nie und bleibt dazwischen", async () => {
  const { newSortKey } = await import("../src/lib/sortkey");
  assert.ok(newSortKey("k", "k") > "k");
  let a = newSortKey(null, null);
  let b = newSortKey(a, null);
  for (let i = 0; i < 500; i++) {
    const m = newSortKey(a, b);
    assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
    if (i % 2) a = m;
    else b = m;
  }
});

test("Robustheit: präparierte Eingaben bleiben schnell und werfen kontrolliert", () => {
  const time = (fn: () => unknown) => {
    const s = performance.now();
    fn();
    return performance.now() - s;
  };
  const n = 20000;
  const cases: [string, string][] = [
    ["*a", "*a ".repeat(n)],
    ["**", "**".repeat(n) + "x"],
    ["[[", "[[".repeat(n)],
    ["[x](", "[x](".repeat(n)],
    ["~~", "~~a ".repeat(n)],
    ["_", "a_b ".repeat(n)],
  ];
  for (const [name, input] of cases) {
    const ms = time(() => markdownToDoc(input));
    assert.ok(ms < 1500, name + ": " + Math.round(ms) + " ms");
  }
  // Formeln: Budget, Größen, gefährliche reguläre Ausdrücke
  const env0 = { id: "x", prop: () => null };
  assert.throws(() => evaluate("(".repeat(50000) + "1" + ")".repeat(50000), env0), /verschachtelt/);
  assert.throws(() => evaluate('"x".repeat(1000).repeat(1000).repeat(1000)', env0));
  const ten = "[1,2,3,4,5,6,7,8,9,10]";
  assert.throws(() => evaluate(`${ten}.map(${ten}.map(${ten}.map(${ten}.map(${ten}.map(current)))))`, env0), /aufwendig/);
  assert.throws(() => evaluate('test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$")', env0), /komplex/);
  assert.throws(() => evaluate('test("x", "(.*)*")', env0), /komplex/);
  assert.equal(toText(evaluate('test("abc", "b+")', env0)), "true");
  assert.equal(toText(evaluate('replace("a-b-c", "-", "+")', env0)), "a+b-c");
});

test("Markdown: Review-Fälle (linear ohne Schlusszeichen, ***, leerer Linktext, lange Hervorhebung)", () => {
  const time = (fn: () => unknown) => {
    const s = performance.now();
    fn();
    return performance.now() - s;
  };
  for (const [name, input] of [
    ["<u> ohne Ende", "<u>".repeat(80000)],
    ["[ ohne Ende", "[".repeat(200000)],
    ["` ohne Ende", "`a".repeat(100000)],
    ["** ohne Ende", "**a".repeat(80000)],
    ["*a wiederholt", "*a ".repeat(80000)],
  ] as [string, string][]) {
    const ms = time(() => markdownToDoc(input));
    assert.ok(ms < 1500, name + ": " + Math.round(ms) + " ms");
  }
  const bi = markdownToDoc("***fett kursiv***").content![0].content![0];
  assert.equal(bi.text, "fett kursiv");
  assert.deepEqual(bi.marks!.map((m) => m.type).sort(), ["bold", "italic"]);
  const empty = markdownToDoc("[](https://x.com)").content![0].content![0];
  assert.equal(empty.text, "https://x.com");
  assert.equal(empty.marks![0].type, "link");
  const long = "**" + "x".repeat(5000) + "**";
  const lb = markdownToDoc(long).content![0].content![0];
  assert.equal(lb.marks?.[0].type, "bold");
});

test("CSV und Markdown-Export: Review-Fälle", () => {
  // Anführungszeichen mitten im Feld beginnt kein Zitat
  assert.deepEqual(parseCSV('Name,Ort\nMonitor 27" ,Office\nB,C\n'), [["Name", "Ort"], ['Monitor 27" ', "Office"], ["B", "C"]]);
  assert.deepEqual(parseCSV('a, "b,c",d\n'), [["a", "b,c", "d"]]);
  // Inline-Code mit Backtick übersteht die Rundreise
  const doc = { type: "doc", content: [{ type: "paragraph", attrs: { indent: 0 }, content: [{ type: "text", text: "a`b", marks: [{ type: "code" }] }] }] };
  const md = docToMarkdown(doc as never);
  const back = markdownToDoc(md);
  assert.equal(back.content?.[0].content?.[0].text, "a`b", md);
  const spaced = { type: "doc", content: [{ type: "paragraph", attrs: { indent: 0 }, content: [{ type: "text", text: " a ", marks: [{ type: "code" }] }] }] };
  assert.equal(markdownToDoc(docToMarkdown(spaced as never)).content?.[0].content?.[0].text, " a ");
  // Maskierte Backticks blockieren keine Hervorhebung
  const it = parseInline("a \\` b *c* \\` d");
  assert.ok(it.some((n) => n.text === "c" && n.marks?.some((m) => m.type === "italic")), JSON.stringify(it));
  // Mehrzeiliger Callout bleibt vollständig im Zitat
  const callout = { type: "doc", content: [{ type: "callout", attrs: { indent: 0, icon: "💡" }, content: [{ type: "text", text: "eins" }, { type: "hard_break" }, { type: "text", text: "zwei" }] }] };
  const cmd = docToMarkdown(callout as never);
  assert.ok(cmd.split("\n").filter((l) => l.trim()).every((l) => l.startsWith(">")), cmd);
});

test("Markdown: keine doppelten Markierungen, Escapes und Code in Hervorhebungen", () => {
  const marksOf = (md: string) => parseInline(md).map((n) => (n.marks ?? []).map((m) => m.type).join("+"));
  for (const md of ["[https://x.com](https://x.com)", "**a __b__ c**", "*a _b_ c*"]) {
    for (const n of parseInline(md)) {
      const types = (n.marks ?? []).map((m) => m.type);
      assert.equal(new Set(types).size, types.length, `${md}: ${types.join(",")}`);
    }
  }
  assert.deepEqual(parseInline("*a \\* b*").map((n) => n.text), ["a * b"]);
  assert.deepEqual(marksOf("*a \\* b*"), ["italic"]);
  const code = parseInline("*x `*` y*");
  assert.ok(code.some((n) => n.text === "*" && n.marks?.some((m) => m.type === "code")), JSON.stringify(code));
  // Viele „[x](“ ohne nahe „)“ bleiben schnell
  const t0 = performance.now();
  parseInline("[x](a ".repeat(50000) + ")");
  assert.ok(performance.now() - t0 < 1500);
});

test("Formeln: Review-Fälle (Regex-Teilmenge, geteiltes Budget, lineares unique)", () => {
  const env0 = { id: "x", prop: () => null };
  const a24 = "a".repeat(24) + "!";
  for (const pat of ["((a+))+$", "(a|a)+$", "(?:a|a)*$", "(a+)+$", "(.*)*", "a*a*a*b", "(x)\\\\1+"]) {
    assert.throws(() => evaluate(`test("${a24}", "${pat}")`, env0), /komplex/, pat);
  }
  // Erlaubte, übliche Muster
  assert.equal(toText(evaluate('test("Rechnung 2026-10", "[0-9]{4}-[0-9]+")', env0)), "true");
  assert.equal(toText(evaluate('replaceAll("a  b   c", " +", " ")', env0)), "a b c");
  assert.equal(toText(evaluate('test("(x)", "\\\\(x\\\\)")', env0)), "true");
  // Budget gilt auch für verschachtelte Formeln (prop() liest eine teure Formel)
  const heavy = "[" + "1,".repeat(999) + "1].map(current + 1).length()";
  const envNested = { id: "x", prop: () => evaluate(heavy, env0) };
  assert.throws(() => evaluate("[" + "1,".repeat(199) + '1].map(prop("B")).length()', envNested), /aufwendig/);
  // Kosten hängen von der Textlänge ab: beschränkte Wiederholungen und zwei unbegrenzte auf langem Text
  const long = "a".repeat(2000);
  for (const pat of ["a{0,2000}a{0,2000}a{0,2000}b", "a*a*b"]) {
    const t0 = performance.now();
    assert.throws(() => evaluate(`test("${long}", "${pat}")`, env0), /zu lang/, pat);
    assert.ok(performance.now() - t0 < 200, pat);
  }
  assert.equal(toText(evaluate(`test("${long}", "a+b")`, env0)), "false"); // eine unbegrenzte: erlaubt
  assert.equal(toText(evaluate('test("12-34", "[0-9]+-[0-9]+")', env0)), "true"); // kurzer Text: zwei erlaubt
  // Wiederholte Gruppen auch mit fester Anzahl gesperrt; Alternativen zählen in die Kosten
  for (const pat of ["(a|a){30}b", "(a*){20}", "(a?){30}a{30}"]) {
    assert.throws(() => evaluate(`test("${"a".repeat(22)}!", "${pat}")`, env0), /komplex/, pat);
  }
  // Riesige Texte werden gar nicht erst erzeugt
  for (const f of [
    'padStart("a", 1000000000)',
    'padEnd("a", 1e9, "x")',
    'repeat(repeat(repeat("x", 1000), 1000), 1000)',
    'replaceAll(repeat("a", 1000), "", repeat(repeat("x", 1000), 1000))',
    'join(split(repeat("ab", 1000), ""), repeat(repeat("x", 1000), 10))',
  ]) {
    assert.throws(() => evaluate(f, env0), /zu lang/, f);
  }
  assert.equal(toText(evaluate('replaceAll("a b c", " ", "_")', env0)), "a_b_c");
  assert.throws(() => evaluate(`replaceAll(repeat("ab", 999), "(?=(.*))", "${"$1".repeat(20)}")`, env0), /zu lang/);
  assert.equal(toText(evaluate('replaceAll("a-b", "(?<x>[a-z])", "[$<x>$&]")', env0)), "[aa]-[bb]");
  assert.equal(toText(evaluate('replace("Hallo Welt", "(W)elt", "$1orld")', env0)), "Hallo World");
  // Datumsformate: „Do“ und Text in Klammern
  assert.equal(toText(evaluate('formatDate(parseDate("2026-10-07"), "Do MMMM")', env0)), "7. Oktober");
  assert.equal(toText(evaluate('formatDate(parseDate("2026-10-07"), "[Tag] D")', env0)), "Tag 7");
  // Mengen-Schlüssel: unterschiedliche Listen bleiben unterschiedlich
  assert.equal(toText(evaluate('length(unique([["a", "b"], ["a,string:b"]]))', env0)), "2");
  // unique() ist linear
  const s = performance.now();
  assert.equal(toText(evaluate('length(unique(split("x".repeat(1000).repeat(40), "").map(index)))', env0)), "40000");
  assert.ok(performance.now() - s < 1500);
});

test("Markdown: maskierte Klammern im Linktext, Code nur aus Leerzeichen", () => {
  const link = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a[1]", marks: [{ type: "link", attrs: { href: "https://x.de" } }] }] }] };
  const back = markdownToDoc(docToMarkdown(link as never)).content![0].content!;
  assert.equal(back.length, 1);
  assert.equal(back[0].text, "a[1]");
  assert.equal(back[0].marks?.[0].type, "link");
  const spaces = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x " }, { type: "text", text: "  ", marks: [{ type: "code" }] }] }] };
  const code = markdownToDoc(docToMarkdown(spaces as never)).content![0].content!;
  assert.equal(code.find((n) => n.marks?.some((m) => m.type === "code"))?.text, "  ");
  assert.equal(markdownToDoc("`` ` ``").content![0].content![0].text, "`");
});
