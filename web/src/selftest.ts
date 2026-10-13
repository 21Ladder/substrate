// Automatischer Oberflächentest in der echten App (WKWebView).
// Nur aktiv, wenn die native App mit SUBSTRAT_SELFTEST_DIR gestartet wurde.

import type { EditorView } from "prosemirror-view";
import { api } from "./api/client";
import type { ID } from "./api/types";
import { openEditors, editorUI } from "./editor/ui";
import { flushAll, navigation, restorePage, trashPage, ws, createPage, nextSortKey } from "./state/workspace";
import { ui } from "./state/ui";
import { addRow, dbs, loadDatabase, updateSchema, updateView } from "./database/store";
import { displayText } from "./database/properties";

const bridge = (window as any).webkit?.messageHandlers?.bridge;
const debug = (method: string, params: Record<string, unknown> = {}) => bridge?.postMessage({ method, params });
const log = (line: string) => debug("debug.log", { line });
const snap = (name: string) => debug("debug.snapshot", { name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  void log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " – " + detail : ""}`);
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 4000): Promise<T | null> {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* weiter warten */
    }
    await sleep(40);
  }
  return null;
}

function typeText(view: EditorView, text: string) {
  for (const ch of text) {
    if (ch === "\n") {
      key(view, "Enter");
      continue;
    }
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** Echtes Tastatur-Ereignis am Editor-DOM: durchläuft alle Ebenen (DOM-Handler, Plugins, App) wie beim Tippen. */
function key(view: EditorView, k: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean } = {}) {
  const ev = new KeyboardEvent("keydown", { key: k, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, bubbles: true, cancelable: true });
  view.dom.dispatchEvent(ev);
}

function globalKey(k: string, mods: { meta?: boolean; shift?: boolean } = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: !!mods.meta, shiftKey: !!mods.shift, bubbles: true, cancelable: true }));
}

function blocks(view: EditorView) {
  const out: { type: string; text: string; attrs: Record<string, unknown> }[] = [];
  view.state.doc.forEach((n) => out.push({ type: n.type.name, text: n.textContent, attrs: n.attrs }));
  return out;
}

function lastBlock(view: EditorView) {
  const b = blocks(view);
  return b[b.length - 1];
}

async function phase1() {
  const t0 = performance.now();
  await waitFor(() => ws.loaded && navigation.route().kind === "page", 8000);
  check("App lädt und öffnet eine Seite", navigation.route().kind === "page");
  await log(`INFO visibility=${document.visibilityState} hasFocus=${document.hasFocus()}`);
  const rafOk = await new Promise<boolean>((r) => {
    requestAnimationFrame(() => r(true));
    setTimeout(() => r(false), 500);
  });
  await log(`INFO requestAnimationFrame aktiv: ${rafOk}`);
  const route = navigation.route();
  const welcomeId = route.kind === "page" ? route.id : "";
  check("Willkommensseite angelegt", ws.pages[welcomeId]?.title === "Willkommen bei Substrat", ws.pages[welcomeId]?.title);
  const wv = await waitFor(() => openEditors.get(welcomeId));
  check("Editor der Willkommensseite bereit", !!wv);
  if (wv) {
    check("Eingeklappter Toggle verbirgt Kinder", wv.dom.querySelectorAll(".hidden-block").length >= 1);
    check("Unterseiten-Blöcke gerendert", wv.dom.querySelectorAll(".block-page .page-ref").length === 2);
    check("Erwähnung gerendert", !!wv.dom.querySelector(".mention .page-ref-title"));
  }
  check("Sidebar zeigt Seite", !!document.querySelector(".sb-row .sb-title"));
  await log(`INFO Startzeit bis bedienbar: ${Math.round(t0)} ms nach Navigation, ${Math.round(performance.now())} ms gesamt`);
  await sleep(300);
  await snap("01-welcome");

  // Neue Seite per ⌘N
  globalKey("n", { meta: true });
  const newId = await waitFor(() => {
    const r = navigation.route();
    return r.kind === "page" && r.id !== welcomeId ? r.id : null;
  });
  check("⌘N legt neue Seite an", !!newId);
  if (!newId) return;
  const title = (await waitFor(() => document.querySelector(`.page-title[data-page="${newId}"]`))) as HTMLElement | null;
  check("Titel-Feld vorhanden", !!title);
  if (title) {
    title.textContent = "Testseite";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
  await sleep(450);
  check("Titel gespeichert", ws.pages[newId]?.title === "Testseite", ws.pages[newId]?.title);
  if (title) {
    // Regression: Titeländerung innerhalb der Entprellzeit darf beim Flush nicht verloren gehen
    title.textContent = "Schnell";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushAll();
    check("Titel wird sofort beim Flush gespeichert", (await api.getPage(newId))?.title === "Schnell");
    title.textContent = "Testseite";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushAll();
  }

  const v = await waitFor(() => openEditors.get(newId));
  check("Editor der neuen Seite bereit", !!v);
  if (!v) return;
  v.focus();

  // Regression: Pfeiltasten im Slash-/@-Menü in der ERSTEN Zeile (früher sprang ↑ in den Titel)
  {
    typeText(v, "/");
    await waitFor(() => document.querySelector(".suggest-menu"));
    const activeLabel = () => (document.querySelector(".suggest-menu .slash-item.active .slash-label")?.textContent ?? "");
    const first = activeLabel();
    key(v, "ArrowDown");
    key(v, "ArrowDown");
    await sleep(30);
    const third = activeLabel();
    key(v, "ArrowUp");
    await sleep(30);
    const second = activeLabel();
    const titleFocused = document.activeElement?.classList.contains("page-title") ?? false;
    check("Slash-Menü: ↓↓↑ wandert in der Liste (erste Zeile)", !!editorUI.suggest() && first !== third && second !== third && second !== first && !titleFocused, `${first} → ${third} → ${second}, Titel fokussiert: ${titleFocused}`);
    key(v, "ArrowUp");
    key(v, "ArrowUp");
    await sleep(30);
    check("Slash-Menü: ↑ am Anfang springt ans Listenende statt in den Titel", !!editorUI.suggest() && !(document.activeElement?.classList.contains("page-title") ?? false), activeLabel());
    key(v, "Escape");
    await sleep(30);
    check("Escape schließt das Slash-Menü", !editorUI.suggest());
    v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
    typeText(v, "@");
    await waitFor(() => document.querySelector(".suggest-menu"));
    key(v, "ArrowDown");
    key(v, "ArrowUp");
    await sleep(30);
    check("@-Menü: ↑ bleibt in der Liste (erste Zeile)", !!editorUI.suggest() && !(document.activeElement?.classList.contains("page-title") ?? false));
    key(v, "Escape");
    v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
    // Ohne Menü springt ↑ in der ersten Zeile weiterhin in den Titel (gewolltes Notion-Verhalten)
    key(v, "ArrowUp");
    await sleep(30);
    check("↑ in der ersten Zeile ohne Menü springt in den Titel", document.activeElement?.classList.contains("page-title") ?? false);
    v.focus();
  }

  // ---------- UX-Regressionen (Bug-Hunt) ----------
  {
    // "/" mitten im Wort öffnet kein Menü
    typeText(v, "und/oder");
    await sleep(30);
    check("„/“ mitten im Wort öffnet kein Menü", !editorUI.suggest() && !document.querySelector(".suggest-menu"));
    // Tilden und Sternchen mit Leerzeichen bleiben Text
    typeText(v, " ca. ~5 bis ~10 und 2 * 3 * 4");
    let marked = false;
    v.state.doc.firstChild!.forEach((n) => {
      if (n.marks.length) marked = true;
    });
    check("„~5 bis ~10“ und „2 * 3 * 4“ werden nicht formatiert", !marked, v.state.doc.firstChild!.textContent);
    // -> in Inline-Code bleibt ->
    v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
    v.dispatch(v.state.tr.insert(1, v.state.schema.text("ab", [v.state.schema.marks.code.create()])));
    v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 2)));
    typeText(v, "->");
    check("„->“ in Inline-Code bleibt erhalten", v.state.doc.firstChild!.textContent.includes("->"), v.state.doc.firstChild!.textContent);
    v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
    // Direkt NACH Inline-Code wirken die Kürzel wieder (Code-Markierung ist „inclusive“)
    {
      const sch = v.state.schema;
      v.dispatch(v.state.tr.insert(1, [sch.text("npm", [sch.marks.code.create()]), sch.text(" ")]));
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 5)).setStoredMarks([]));
      typeText(v, "**wichtig**");
      let bold = false;
      v.state.doc.firstChild!.forEach((n) => {
        if (n.text === "wichtig" && n.marks.some((m) => m.type.name === "bold")) bold = true;
      });
      check("**fett** direkt nach Inline-Code wird fett", bold, v.state.doc.firstChild!.textContent);
      v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
      v.dispatch(v.state.tr.insert(1, [sch.text("a", [sch.marks.code.create()]), sch.text("-")]));
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 3)).setStoredMarks([]));
      typeText(v, ">");
      check("„->“ direkt nach Inline-Code wird zum Pfeil", v.state.doc.firstChild!.textContent === "a→", v.state.doc.firstChild!.textContent);
      v.dispatch(v.state.tr.delete(1, v.state.doc.firstChild!.content.size + 1));
    }
    // Gap-Cursor: zwischen zwei Bildern lässt sich schreiben
    {
      const sch = v.state.schema;
      const tr = v.state.tr.insert(v.state.doc.content.size, [sch.nodes.image.create({ src: "" }), sch.nodes.image.create({ src: "" })]);
      v.dispatch(tr);
      const { GapCursor } = await import("prosemirror-gapcursor");
      let between = -1;
      v.state.doc.forEach((n, pos, i) => {
        if (n.type.name === "image" && between < 0 && v.state.doc.maybeChild(i + 1)?.type.name === "image") between = pos + n.nodeSize;
      });
      const count = v.state.doc.childCount;
      const $p = v.state.doc.resolve(between);
      const valid = (GapCursor as unknown as { valid($p: unknown): boolean }).valid($p);
      if (valid) {
        v.dispatch(v.state.tr.setSelection(new GapCursor($p)));
        // So verarbeitet ProseMirror getippten Text an einem Gap-Cursor (ersetzt die Auswahl, verpackt in Absatz)
        v.dispatch(v.state.tr.insertText("Z"));
        await sleep(20);
      }
      const types = blocks(v).map((b) => b.type);
      check("Gap-Cursor zwischen zwei Bildern: Absatz entsteht beim Tippen", valid && v.state.doc.childCount === count + 1 && types.join(",").includes("image,paragraph,image"), types.join(","));
      // aufräumen: alles außer dem ersten Absatz entfernen
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, sch.nodes.paragraph.create()));
    }
    // Formatierungsleiste erst nach dem Loslassen der Maus
    {
      typeText(v, "Markieren mit der Maus");
      v.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 1, 10)));
      await sleep(30);
      const during = !!editorUI.toolbar();
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      await sleep(30);
      const after = !!editorUI.toolbar();
      check("Formatierungsleiste erscheint erst nach dem Markieren", !during && after, `während: ${during}, danach: ${after}`);
      // Ziehen statt Loslassen (danach kommt kein mouseup): Leiste darf nicht dauerhaft verschwinden
      v.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      v.dom.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 2, 8)));
      await sleep(30);
      check("Formatierungsleiste nach Ziehen wieder verfügbar", !!editorUI.toolbar());
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, v.state.schema.nodes.paragraph.create()));
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 1)));
    }
    // ↑ bei ausgewähltem erstem Block (Bild) springt in den Titel
    {
      const sch = v.state.schema;
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, [sch.nodes.image.create({ src: "" }), sch.nodes.paragraph.create()]));
      const { NodeSelection } = await import("prosemirror-state");
      v.focus();
      v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, 0)));
      key(v, "ArrowUp");
      await sleep(30);
      check("↑ bei ausgewähltem erstem Block springt in den Titel", document.activeElement?.classList.contains("page-title") ?? false);
      v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, sch.nodes.paragraph.create()));
      v.focus();
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 1)));
    }
    // Blockmenü: Klick auf „Umwandeln in“ öffnet das Untermenü (auch wenn Hover es schon geöffnet hat)
    {
      key(v, "/", { meta: true });
      await sleep(150);
      const pops = document.querySelectorAll(".popover");
      const pop = pops[pops.length - 1] as HTMLElement | undefined;
      const turn = Array.from(pop?.querySelectorAll(".menu-item") ?? []).find((el) => el.textContent?.includes("Umwandeln")) as HTMLElement | undefined;
      turn?.parentElement?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await sleep(30);
      turn?.click();
      await sleep(60);
      check("Blockmenü: Klick auf Untermenü-Eintrag lässt es offen", !!pop?.querySelector(".submenu"));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(80);
      v.focus();
    }
    // Menü: Pfeiltasten-Auswahl gilt nach dem Filtern nicht mehr
    {
      v.focus();
      key(v, "/", { meta: true });
      await sleep(150);
      const pops = document.querySelectorAll(".popover");
      const pop = (pops[pops.length - 1] as HTMLElement | undefined) ?? null;
      const input = pop?.querySelector("input") as HTMLInputElement | null;
      input?.focus();
      for (let k = 0; k < 2; k++) (input ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      const hadSelection = !!pop?.querySelector(".kbd-active");
      if (input) {
        input.value = "lö";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ö", inputType: "insertText" }));
      }
      await sleep(50);
      check("Menü: Filtern setzt Pfeiltasten-Auswahl zurück", hadSelection && !pop?.querySelector(".kbd-active"), `Popover: ${!!pop}, Feld: ${!!input}, Auswahl vorher: ${hadSelection}`);
      if (input) {
        input.value = "";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await sleep(80);
      v.focus();
    }
    // Code-Block ohne Rechtschreibprüfung
    typeText(v, "```");
    const pre = v.dom.querySelector(".block-code pre") as HTMLElement | null;
    check("Code-Block ohne Rechtschreibprüfung", !!pre && pre.spellcheck === false);
    v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, v.state.schema.nodes.paragraph.create()));
    v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).create(v.state.doc, 1)));
  }

  typeText(v, "# Überschrift");
  check("Markdown # → Überschrift 1", blocks(v)[0].type === "heading" && blocks(v)[0].attrs.level === 1 && blocks(v)[0].text === "Überschrift", JSON.stringify(blocks(v)[0]));
  typeText(v, "\n");
  check("Enter nach Überschrift → Absatz", lastBlock(v).type === "paragraph");

  typeText(v, "- Punkt eins\nPunkt zwei");
  const b1 = blocks(v);
  check("Markdown - → Aufzählung, Enter setzt Liste fort", b1[b1.length - 2].type === "bullet" && b1[b1.length - 1].type === "bullet", b1.map((b) => b.type).join(","));
  key(v, "Tab");
  check("Tab rückt ein", lastBlock(v).attrs.indent === 1, String(lastBlock(v).attrs.indent));
  key(v, "Tab", { shift: true });
  check("Shift+Tab rückt aus", lastBlock(v).attrs.indent === 0);
  typeText(v, "\n\n");
  check("Enter auf leerem Listenpunkt → Text", lastBlock(v).type === "paragraph", lastBlock(v).type);

  typeText(v, "[] Aufgabe");
  check("Markdown [] → To-do", lastBlock(v).type === "todo");
  key(v, "Enter", { meta: true });
  check("⌘↵ hakt To-do ab", lastBlock(v).attrs.checked === true);
  typeText(v, "\n\n1. Erstens\nZweitens");
  const nums = Array.from(v.dom.querySelectorAll(".block-numbered")).map((e) => e.getAttribute("data-num"));
  check("Nummerierte Liste zählt 1., 2.", nums.join(" ") === "1. 2.", nums.join(" "));
  typeText(v, "\n\n> Toggle");
  check("Markdown > → Toggle", lastBlock(v).type === "toggle");
  typeText(v, "\nKind im Toggle");
  check("Enter in offenem Toggle erzeugt eingerücktes Kind", lastBlock(v).attrs.indent === 1, JSON.stringify(lastBlock(v)));
  key(v, "Tab", { shift: true });
  typeText(v, "\nText mit **fett** und `code`");
  let hasBold = false;
  let hasCode = false;
  v.state.doc.lastChild!.forEach((n) => {
    if (n.marks.some((m) => m.type.name === "bold")) hasBold = true;
    if (n.marks.some((m) => m.type.name === "code")) hasCode = true;
  });
  check("Inline-Markdown **fett** und `code`", hasBold && hasCode);
  typeText(v, "\n---");
  check("--- → Trennlinie", blocks(v).some((b) => b.type === "divider"));
  typeText(v, "Pfeil -> rechts");
  check("-> wird zu →", lastBlock(v).text.includes("→"), lastBlock(v).text);

  // Blockmenü per Tastatur: ⌘/ öffnen, ↓↓ Enter = „Duplizieren“, Untermenü „Umwandeln in“ per Enter
  {
    const count = blocks(v).length;
    key(v, "/", { meta: true });
    await waitFor(() => document.querySelector(".popover .menu-item"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    const sel = document.querySelector(".popover .menu-item.kbd-active")?.textContent ?? "";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(80);
    check("Blockmenü per Tastatur: ↓↓ Enter dupliziert", blocks(v).length === count + 1 && sel.includes("Duplizieren"), `${sel}, ${count} → ${blocks(v).length}`);
    key(v, "z", { meta: true });
    key(v, "/", { meta: true });
    await waitFor(() => document.querySelector(".popover .menu-item"));
    for (let k = 0; k < 3; k++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(60);
    const inSub = document.querySelector(".popover .submenu .menu-item.kbd-active")?.textContent ?? "";
    check("Blockmenü: Enter öffnet Untermenü und wählt dessen ersten Eintrag", inSub.includes("Text"), inSub);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(30);
    v.focus();
  }

  // Block-Befehle
  const before = blocks(v).length;
  key(v, "d", { meta: true });
  check("⌘D dupliziert Block", blocks(v).length === before + 1);
  key(v, "z", { meta: true });
  check("⌘Z macht rückgängig", blocks(v).length === before, `${blocks(v).length} vs ${before}`);
  typeText(v, "\n");

  // Slash-Menü → Inline-Datenbank
  typeText(v, "/tab");
  const menu = await waitFor(() => document.querySelector(".suggest-menu"));
  check("Slash-Menü öffnet sich", !!menu && !!editorUI.suggest());
  check("Slash-Menü filtert („Tabelle – Inline“)", !!menu && (menu as HTMLElement).innerText.includes("Tabelle – Inline"), (menu as HTMLElement | null)?.innerText.slice(0, 80));
  await snap("02-slash");
  key(v, "Enter");
  const dbBlock = await waitFor(() => blocks(v).find((b) => b.type === "database"));
  check("Inline-Datenbank eingefügt", !!dbBlock);
  const dbId = String(dbBlock?.attrs.databaseId ?? "");
  await loadDatabase(dbId);
  check("Datenbank geladen", !!dbs[dbId]);
  if (dbs[dbId]) {
    const r1 = await addRow(dbId, { title: "Zeile Eins" });
    await addRow(dbId, { title: "Zeile Zwei" });
    check("Zeilen angelegt", dbs[dbId].rows.length === 2);
    const rows = await waitFor(() => (v.dom.querySelectorAll(".db-view .tr:not(.th-row):not(.new-row):not(.calc-row)").length >= 2 ? 1 : 0));
    check("Tabelle zeigt Zeilen", !!rows);
    // Formel
    await updateSchema(dbId, [...dbs[dbId].schema, { id: "f1", name: "Länge", type: "formula", formula: 'prop("Name").length() * 2' }]);
    const row = dbs[dbId].rows.find((r) => r.id === r1?.id)!;
    check("Formel berechnet", displayText(dbs[dbId], row, dbs[dbId].schema.find((p) => p.id === "f1")!) === "20", displayText(dbs[dbId], row, dbs[dbId].schema.find((p) => p.id === "f1")!));
    await sleep(200);
    await snap("03-database-table");
    // Popover-Eingabe wird beim Schließen (Klick daneben/Escape) übernommen
    {
      const { editCell } = await import("./database/cells");
      const { closeAllPopovers } = await import("./components/popovers");
      await updateSchema(dbId, [...dbs[dbId].schema, { id: "t1", name: "Notiz", type: "text" }]);
      const row0 = dbs[dbId].rows[0];
      editCell(new DOMRect(200, 200, 200, 30), dbId, row0, dbs[dbId].schema.find((p) => p.id === "t1")!);
      const ta = (await waitFor(() => document.querySelector(".cell-editor textarea"))) as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = "Gemerkt";
        closeAllPopovers();
        await sleep(100);
      }
      check("Zellen-Editor speichert beim Schließen", dbs[dbId].rows.find((r) => r.id === row0.id)?.props.t1 === "Gemerkt");
    }
    const view = dbs[dbId].views[0];
    updateView(dbId, view.id, { type: "board", groupBy: dbs[dbId].schema.find((p) => p.type === "multi_select")?.id ?? null });
    await sleep(300);
    check("Board-Ansicht rendert", !!v.dom.querySelector(".board"));
    updateView(dbId, view.id, { type: "table" });
  }

  // Kopierter Seitenblock wird als Erwähnung eingefügt (Seite bleibt bei ihrer Elternseite)
  {
    const graphPage = Object.values(ws.pages).find((p) => p.title === "So funktioniert der Graph");
    if (graphPage) {
      const parentBefore = graphPage.parentId;
      v.focus();
      v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).atEnd(v.state.doc)));
      v.pasteHTML(`<div data-block="page" data-page-id="${graphPage.id}"></div>`);
      let asMention = false;
      let asBlock = false;
      v.state.doc.forEach((n) => {
        if (n.type.name === "page" && n.attrs.pageId === graphPage.id) asBlock = true;
        n.forEach((c) => {
          if (c.type.name === "mention" && c.attrs.pageId === graphPage.id) asMention = true;
        });
      });
      await flushAll();
      check("Kopierter Seitenblock wird Erwähnung", asMention && !asBlock);
      check("Kopieren verschiebt die Seite nicht", ws.pages[graphPage.id]?.parentId === parentBefore);
    }
  }

  // Erwähnung per @
  const vEnd = v.state.doc.content.size;
  v.dispatch(v.state.tr.insert(vEnd, v.state.schema.nodes.paragraph.create()));
  v.dispatch(v.state.tr.setSelection((v.state.selection.constructor as any).atEnd(v.state.doc)));
  typeText(v, "Siehe @Willk");
  const mentionMenu = await waitFor(() => document.querySelector(".suggest-menu"));
  check("@-Menü zeigt Seiten", !!mentionMenu && (mentionMenu as HTMLElement).innerText.includes("Willkommen"), (mentionMenu as HTMLElement | null)?.innerText.slice(0, 80));
  key(v, "Enter");
  let mentionFound = false;
  v.state.doc.lastChild!.forEach((n) => {
    if (n.type.name === "mention" && n.attrs.pageId === welcomeId) mentionFound = true;
  });
  check("Erwähnung eingefügt", mentionFound);
  await flushAll();
  await sleep(100);
  const backlinks = await api.backlinks(welcomeId);
  check("Backlink wird erkannt", backlinks.some((b) => b.id === newId));
  const results = await api.search("Überschrift");
  check("Volltextsuche findet neuen Inhalt", results.some((r) => r.id === newId));
  await snap("04-editor");

  // Offline: externe Bilder werden nicht geladen, sondern als Platzhalter gezeigt
  {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    check("CSP erlaubt keine Netzwerkziele", !/https:|http:|ws:/.test(csp), csp);
    v.dispatch(v.state.tr.insert(v.state.doc.content.size, v.state.schema.nodes.image.create({ src: "https://example.com/tracking.png" })));
    await sleep(100);
    const remoteImg = v.dom.querySelector('img[src^="https:"]');
    const placeholder = Array.from(v.dom.querySelectorAll(".media-empty")).some((e) => e.textContent?.includes("Externes Bild"));
    check("Externes Bild wird nicht geladen, nur Platzhalter", !remoteImg && placeholder);
    key(v, "z", { meta: true });
  }

  // Schnellsuche
  globalKey("p", { meta: true });
  const qf = await waitFor(() => document.querySelector(".quickfind input") as HTMLInputElement | null);
  check("⌘P öffnet Schnellsuche", !!qf);
  if (qf) {
    qf.value = "Willkommen";
    qf.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const hit = await waitFor(() => document.querySelectorAll(".qf-item").length > 1);
    check("Schnellsuche liefert Treffer", !!hit);
    await snap("05-quickfind");
    ui.setQuickFind(false);
  }

  // Papierkorb
  const tmp = await createPage({ parentId: null, title: "Wegwerfseite", sortKey: nextSortKey(null) });
  await trashPage(tmp.id);
  check("Papierkorb entfernt Seite", !ws.pages[tmp.id]);
  const trash = await api.listTrash();
  check("Seite im Papierkorb gelistet", trash.some((t) => t.id === tmp.id));
  await restorePage(tmp.id);
  check("Wiederherstellen funktioniert", !!ws.pages[tmp.id]);

  // Löschen über die Sidebar entfernt den Seitenblock aus der Elternseite
  const ideas = Object.values(ws.pages).find((p) => p.title === "Ideen")?.id;
  if (ideas) {
    navigation.open(welcomeId);
    const wv2 = await waitFor(() => openEditors.get(welcomeId));
    await trashPage(ideas);
    await sleep(100);
    let stillThere = false;
    wv2?.state.doc.forEach((n) => {
      if (n.type.name === "page" && n.attrs.pageId === ideas) stillThere = true;
    });
    check("Gelöschte Unterseite verschwindet aus der Elternseite", !stillThere);
    // Bearbeiten der Elternseite darf die Seite nicht wiederherstellen
    if (wv2) typeText(wv2, "x");
    await flushAll();
    await sleep(100);
    check("Bearbeiten stellt gelöschte Unterseite nicht wieder her", !ws.pages[ideas]);
  }

  // Import (Notion-Export-Struktur mit Markdown, CSV und HTML)
  {
    const { importFiles } = await import("./lib/transfer");
    const id1 = "1".repeat(32);
    const id2 = "2".repeat(32);
    const id3 = "3".repeat(32);
    const id4 = "4".repeat(32);
    const root = await importFiles(
      [
        { path: `Projekt ${id1}.md`, text: `# Projekt\n\nSiehe [Aufgaben](Aufgaben%20${id2}.csv)\n\n[Unterseite](Projekt%20${id1}/Unterseite%20${id3}.md)\n` },
        { path: `Projekt ${id1}/Unterseite ${id3}.md`, text: "# Unterseite\n\nText der Unterseite" },
        { path: `Aufgaben ${id2}.csv`, text: "Name,Status,Punkte\nA,Done,3\nB,Todo,\"1,5\"\n" },
        { path: `Aufgaben ${id2}/A ${id4}.md`, text: "# A\n\nStatus: Done\nPunkte: 3\n\nInhalt von A" },
        {
          path: "Notiz.html",
          text: `<html><head><title>Notiz</title></head><body><article><div class="page-body"><ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> Erledigt</li></ul><p>Hallo <a href="Projekt%20${id1}.md">Projekt</a></p><script>window.__pwned = 1</script></div></article></body></html>`,
        },
      ],
      "Import-Test",
    );
    const { loadWorkspace } = await import("./state/workspace");
    await loadWorkspace();
    check("Import legt Wurzelseite an", !!root && ws.pages[root!]?.title === "Import-Test");
    const projekt = Object.values(ws.pages).find((p) => p.title === "Projekt");
    const unter = Object.values(ws.pages).find((p) => p.title === "Unterseite");
    const aufgaben = Object.values(ws.pages).find((p) => p.title === "Aufgaben" && p.kind === "database");
    check("Import: Seitenhierarchie", !!projekt && unter?.parentId === projekt.id);
    check("Import: CSV wird Datenbank", !!aufgaben);
    if (aufgaben) {
      const d = await api.getDatabase(aufgaben.id);
      check("Import: Datenbankzeilen und Typen", d?.rows.length === 2 && d.schema.some((p) => p.type === "status") && d.schema.some((p) => p.type === "number"), JSON.stringify(d?.schema.map((p) => p.type)));
      const punkte = d?.schema.find((p) => p.name === "Punkte");
      check("Import: deutsches Dezimalkomma", d?.rows.some((r) => r.props[punkte?.id ?? ""] === 1.5) ?? false);
      const rowA = d?.rows.find((r) => r.title === "A");
      const contentA = rowA ? (await api.getPage(rowA.id))?.content : null;
      check("Import: Zeilenseite übernimmt Inhalt ohne Eigenschaftszeilen", JSON.stringify(contentA).includes("Inhalt von A") && !JSON.stringify(contentA).includes("Status: Done"));
    }
    const projektContent = projekt ? (await api.getPage(projekt.id))?.content : null;
    check("Import: Links werden Erwähnung/Unterseitenblock", JSON.stringify(projektContent).includes('"mention"') && JSON.stringify(projektContent).includes('"type":"page"'));
    const notiz = Object.values(ws.pages).find((p) => p.title === "Notiz");
    const notizContent = notiz ? (await api.getPage(notiz.id))?.content : null;
    const nc = JSON.stringify(notizContent);
    check("Import: HTML mit To-do und Erwähnung", nc.includes('"todo"') && nc.includes('"checked":true') && nc.includes(projekt?.id ?? "--"), nc.slice(0, 200));
    check("Import: Skripte im HTML werden nicht ausgeführt", !(window as any).__pwned);
  }

  // Sandbox: ZIP-Import mit zipinfo/ditto als Unterprozesse, Backup, Schutz vor endgültigem Löschen
  {
    const r = (await debug("debug.importZip")) as { files?: { path: string; text?: string }[]; warnings?: string[] } | undefined;
    check("ZIP-Import funktioniert in der Sandbox", !!r?.files?.some((f) => f.path.endsWith("Seite.md") && f.text?.includes("Hallo")), JSON.stringify(r).slice(0, 160));
    const b = await api.backupNow();
    check("Backup lässt sich erstellen", !!b.file, b.file);
    let rejected = false;
    try {
      await api.purgePage(newId);
    } catch {
      rejected = true;
    }
    check("Lebende Seite kann nicht endgültig gelöscht werden", rejected && !!(await api.getPage(newId)));
  }

  // Graph
  navigation.go({ kind: "graph" });
  const canvas = await waitFor(() => document.querySelector(".graph-page canvas"));
  check("Graph-Ansicht öffnet", !!canvas);
  await sleep(1500);
  const stats = document.querySelector(".graph-stats")?.textContent ?? "";
  check("Graph enthält Knoten und Kanten", /\d+ Knoten/.test(stats) && !/^0 Knoten/.test(stats), stats);
  {
    const c = document.querySelector(".graph-page canvas") as HTMLCanvasElement | null;
    const wrap = c?.parentElement as HTMLElement | null;
    let painted = 0;
    (wrap as any)?.__drawNow?.();
    if (c) {
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 16) if (data[i] > 0) painted++;
    }
    check("Graph zeichnet Knoten", painted > 50, `ticks=${wrap?.dataset.ticks ?? 0} canvas=${c?.width}x${c?.height} painted=${painted}`);
  }
  await snap("06-graph");

  // Zeitreise: ruhige Ansicht, keine springenden Knoten, stabile Farben
  {
    type St = { view: { k: number; x: number; y: number }; pos: Record<string, [number, number]>; color: Record<string, string> };
    const wrapEl = document.querySelector(".graph-page .graph-canvas") as (HTMLElement & { __state?: () => St }) | null;
    const before = wrapEl?.__state?.();
    const playBtn = Array.from(document.querySelectorAll(".graph-panel button")).find((b) => b.textContent?.includes("Wachstum")) as HTMLButtonElement | undefined;
    playBtn?.click();
    let maxJump = 0;
    let viewChanged = false;
    let colorChanged = false;
    let frames = 0;
    let prev = wrapEl?.__state?.();
    for (let k = 0; k < 40; k++) {
      await sleep(100);
      const cur = wrapEl?.__state?.();
      if (!cur || !prev || !before) break;
      frames++;
      if (cur.view.k !== before.view.k || cur.view.x !== before.view.x || cur.view.y !== before.view.y) viewChanged = true;
      for (const [id, p] of Object.entries(cur.pos)) {
        const q = prev.pos[id];
        if (q) maxJump = Math.max(maxJump, Math.hypot(p[0] - q[0], p[1] - q[1]));
        if (before.color[id] && cur.color[id] !== before.color[id]) colorChanged = true;
      }
      prev = cur;
      if (!document.querySelector(".graph-panel")?.textContent?.includes("Anhalten")) break;
    }
    check("Zeitreise: Ansicht springt nicht", frames > 3 && !viewChanged, `Frames ${frames}`);
    check("Zeitreise: Knoten springen nicht (max. Bewegung pro 100 ms < 40)", maxJump < 40, `max ${Math.round(maxJump)}`);
    check("Zeitreise: Farben bleiben stabil", !colorChanged);
    await sleep(3000);
    check("Zeitreise endet mit vollständigem Graph", (document.querySelector(".graph-panel")?.textContent ?? "").includes("Heute"));
    // Nur Farben ändern (gleiche Struktur) – danach muss die Simulation weiter auf Änderungen reagieren
    const sel = Array.from(document.querySelectorAll(".graph-panel select")).find((s) => (s as HTMLSelectElement).querySelector('option[value="type"]')) as HTMLSelectElement | undefined;
    if (sel) {
      sel.value = sel.value === "type" ? "cluster" : "type";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(400);
    const wrapT = document.querySelector(".graph-page .graph-canvas") as HTMLElement | null;
    const ticksBefore = Number(wrapT?.dataset.ticks ?? 0);
    const dist = Array.from(document.querySelectorAll(".graph-panel .slider")).find((l) => l.textContent?.includes("Abstand"))?.querySelector("input") as HTMLInputElement | undefined;
    if (dist) {
      dist.value = String(Number(dist.value) === 150 ? 100 : Number(dist.value) + 20);
      dist.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(800);
    check("Graph reagiert nach Farbwechsel weiter (Simulation nicht eingefroren)", !!sel && !!dist && Number(wrapT?.dataset.ticks ?? 0) > ticksBefore, `ticks ${ticksBefore} → ${wrapT?.dataset.ticks}`);
  }
  ui.setTheme("dark");
  await sleep(300);
  await snap("07-graph-dark");
  navigation.open(newId);
  await sleep(500);
  await snap("08-editor-dark");
  ui.setTheme("system");

  // Verbindungen-Panel
  navigation.open(welcomeId);
  ui.setGraphPanel(true);
  await sleep(1200);
  check("Verbindungs-Panel zeigt Backlinks", (document.querySelector(".connections")?.textContent ?? "").includes("Testseite"));
  await snap("09-connections");
  ui.setGraphPanel(false);

  // Neue Unterseite über „+“ in der Sidebar: Cursor steht im Titel; Sidebar zeigt aktuelle Seite
  {
    const row = Array.from(document.querySelectorAll(".sb-row")).find((r) => r.querySelector(".sb-title")?.textContent === "Testseite") as HTMLElement | undefined;
    const plus = row?.querySelectorAll(".sb-actions .icon-btn")[1] as HTMLElement | undefined;
    plus?.click();
    const childId = await waitFor(() => {
      const r = navigation.route();
      return r.kind === "page" && r.id !== newId && ws.pages[r.id]?.parentId === newId ? r.id : null;
    });
    await sleep(150);
    check("Neue Unterseite per „+“: Cursor im Titel", !!childId && (document.activeElement as HTMLElement | null)?.getAttribute("data-page") === childId);
    // Sidebar-Zustand zurücksetzen und erneut per Navigation öffnen → Vorfahren werden aufgeklappt
    const { setSetting } = await import("./state/workspace");
    setSetting("expanded", "[]");
    navigation.open(welcomeId);
    await sleep(100);
    if (childId) navigation.open(childId);
    await sleep(200);
    check("Sidebar klappt Vorfahren der aktuellen Seite auf", !!document.querySelector(".sb-row.active"));
    // Scrollposition beim Zurückkehren
    if (childId) {
      const cv = await waitFor(() => openEditors.get(childId));
      if (cv) {
        const sch = cv.state.schema;
        cv.dispatch(cv.state.tr.replaceWith(0, cv.state.doc.content.size, Array.from({ length: 120 }, (_, k) => sch.nodes.paragraph.create(null, sch.text(`Zeile ${k}`)))));
        await sleep(100);
        const scroller = document.querySelector(".main-scroller") as HTMLElement;
        scroller.scrollTop = 900;
        await flushAll();
        navigation.open(welcomeId);
        await sleep(300);
        navigation.back();
        await sleep(600);
        const sc2 = document.querySelector(".main-scroller") as HTMLElement;
        const top = sc2.scrollTop;
        check("Scrollposition bleibt beim Zurückkehren erhalten", Math.abs(top - 900) < 5, String(top));
      }
    }
    navigation.open(newId);
    await waitFor(() => openEditors.get(newId));
  }

  // Verschieben über die Seitenleiste nimmt den Seitenblock mit; Wiederherstellen bringt ihn zurück
  {
    const { movePage } = await import("./state/workspace");
    const child = await createPage({ parentId: welcomeId, sortKey: nextSortKey(welcomeId), title: "Wanderseite" });
    const { appendPageBlock } = await import("./editor/actions");
    await appendPageBlock(welcomeId, child.id);
    await flushAll();
    const hasBlock = async (pageId: string) => {
      await flushAll();
      const pg = await (await import("./api/client")).api.getPage(pageId);
      return JSON.stringify(pg?.content ?? {}).includes(child.id);
    };
    const before = await hasBlock(welcomeId);
    await movePage(child.id, newId, nextSortKey(newId));
    await sleep(300);
    const oldHas = await hasBlock(welcomeId);
    const newHas = await hasBlock(newId);
    check("Verschieben: Block wandert in die neue Elternseite", before && !oldHas && newHas, `vorher ${before}, alt ${oldHas}, neu ${newHas}`);
    // ⌘Z im offenen Editor der Zielseite darf den mitgewanderten Block nicht wieder entfernen
    {
      const { undo } = await import("prosemirror-history");
      const tv = openEditors.get(newId);
      let after = tv?.state;
      if (tv) undo(tv.state, (tr) => (after = tv.state.apply(tr)));
      check("⌘Z nimmt die Verschiebung über die Seitenleiste nicht halb zurück", !!tv && JSON.stringify(after!.doc.toJSON()).includes(child.id));
    }
    await trashPage(child.id);
    await sleep(300);
    const goneAfterTrash = !(await hasBlock(newId));
    await restorePage(child.id);
    await sleep(300);
    check("Wiederherstellen: Block kommt in die Elternseite zurück", goneAfterTrash && (await hasBlock(newId)));
    await trashPage(child.id);
    await sleep(200);
    // Ganzseitige Datenbank bleibt beim Verschieben ein Seitenlink (keine eingebettete Tabelle)
    const fullDb = await createPage({ parentId: welcomeId, kind: "database", inline: false, title: "Ganzseitige DB", schema: [{ id: "title", name: "Name", type: "title" }], views: [] } as never);
    await movePage(fullDb.id, newId, nextSortKey(newId));
    await sleep(300);
    await flushAll();
    const target = await (await import("./api/client")).api.getPage(newId);
    const blocksOf = (target?.content?.content ?? []).filter((b) => b.attrs?.pageId === fullDb.id || b.attrs?.databaseId === fullDb.id);
    check("Ganzseitige Datenbank wird als Seitenlink verschoben", blocksOf.length === 1 && blocksOf[0].type === "page", JSON.stringify(blocksOf));
    await trashPage(fullDb.id);
    await sleep(200);
  }

  // ---------- Claude-Zugriff (MCP) ----------
  {
    type R = { ok: boolean; data?: any; error?: string };
    const mcp = (name: string, args: Record<string, unknown> = {}) => (window as any).__substrat.mcp(name, args) as Promise<R>;
    const probe = (params: Record<string, unknown> = {}) => debug("debug.mcpProbe", params) as Promise<{ status: number; body: string }>;
    const stateIs = async (want: string) => {
      for (let i = 0; i < 50; i++) {
        if ((await api.mcpStatus()).state === want) return true;
        await sleep(60);
      }
      return false;
    };
    // Eigener Port, damit eine parallel laufende echte App nicht stört
    await api.mcpSetPort(47399);
    const st0 = await api.mcpStatus();
    check("MCP ist standardmäßig aus", !st0.enabled && st0.state === "off" && !st0.token, JSON.stringify({ ...st0, token: st0.token ? "…" : "" }));
    check("MCP aus: Port nicht erreichbar", (await probe()).status === -1);
    await api.mcpSetEnabled(true);
    check("MCP einschalten startet den Server", await stateIs("running"));
    const st1 = await api.mcpStatus();
    check("MCP: Schlüssel wird beim ersten Einschalten erzeugt", /^[0-9a-f]{64}$/.test(st1.token));
    const ping = await probe();
    check("MCP: ping mit Schlüssel → 200", ping.status === 200 && ping.body.includes('"result"'), JSON.stringify(ping));
    check("MCP: ohne Schlüssel → 401", (await probe({ auth: false })).status === 401);
    check("MCP: Anfrage mit Origin (Browser) → 403", (await probe({ origin: true })).status === 403);
    const viaHttp = await probe({ body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_pages", arguments: {} } } });
    check("MCP: Werkzeugaufruf über HTTP erreicht die App", viaHttp.status === 200 && viaHttp.body.includes('"isError":false') && viaHttp.body.includes(welcomeId), viaHttp.body.slice(0, 200));
    await waitFor(() => document.querySelector(".sb-mcp-dot"), 2000);
    check("MCP: Hinweis in der Seitenleiste, solange aktiv", !!document.querySelector(".sb-mcp-dot"));

    // Seite ohne Ziel → „Eingang“
    const c1 = await mcp("create_page", { title: "Von Claude", markdown: "# Überschrift\n\n- [ ] Aufgabe eins\n\nSiehe [[Testseite]] und [böse](javascript:alert(1))" });
    const inboxId = ws.settings.mcpInbox;
    check("MCP create_page legt „Eingang“ an", c1.ok && !!inboxId && ws.pages[inboxId]?.title === "Eingang" && ws.pages[c1.data.id]?.parentId === inboxId, JSON.stringify(c1).slice(0, 200));
    const c1Page = c1.ok ? await api.getPage(c1.data.id) : null;
    const c1Json = JSON.stringify(c1Page?.content ?? {});
    check("MCP: Markdown wird zu Blöcken, [[Titel]] zur Erwähnung", c1Json.includes('"heading"') && c1Json.includes('"todo"') && c1Json.includes(`"pageId":"${newId}"`), c1Json.slice(0, 300));
    check("MCP: unsichere Links werden entfernt", !c1Json.includes("javascript:"));
    await flushAll();
    check("MCP: neue Seite steht als Block im Eingang", JSON.stringify((await api.getPage(inboxId))?.content ?? {}).includes(c1.data?.id));
    const c2 = await mcp("create_page", { title: "Eingang gibt es schon" });
    check("MCP: zweite Seite nutzt denselben Eingang", c2.ok && ws.pages[c2.data.id]?.parentId === inboxId);

    // Anhängen an eine OFFENE Seite läuft durch deren Editor
    const ov = openEditors.get(newId);
    const ap = await mcp("append_to_page", { id: newId, markdown: "Von Claude angehängt" });
    check("MCP append_to_page landet im offenen Editor", ap.ok && !!ov && lastBlock(ov).text === "Von Claude angehängt", ap.error ?? (ov ? lastBlock(ov).text : "kein Editor"));
    await flushAll();
    check("MCP: angehängter Text wird gespeichert", JSON.stringify((await api.getPage(newId))?.content ?? {}).includes("Von Claude angehängt"));

    // Ersetzen: Version im Verlauf, Unterseiten bleiben
    const child = await mcp("create_page", { title: "Kind von Claude", parent_id: c1.data.id });
    await flushAll();
    const rp = await mcp("replace_page_content", { id: c1.data.id, markdown: "Ganz neuer Inhalt" });
    await flushAll();
    const afterReplace = await api.getPage(c1.data.id);
    const hist = await api.history(c1.data.id);
    check("MCP replace_page_content ersetzt den Inhalt", rp.ok && JSON.stringify(afterReplace?.content).includes("Ganz neuer Inhalt") && !JSON.stringify(afterReplace?.content).includes("Aufgabe eins"));
    check("MCP: Ersetzen legt eine Version an", hist.length >= 1);
    check("MCP: Ersetzen behält Unterseiten", child.ok && !!ws.pages[child.data.id] && JSON.stringify(afterReplace?.content).includes(child.data.id) && rp.data?.kept_subpages === 1);

    // Lesen und Suchen
    const rd = await mcp("read_page", { id: c1.data.id });
    check("MCP read_page liefert Markdown und Unterseiten", rd.ok && rd.data.markdown.includes("Ganz neuer Inhalt") && rd.data.children?.[0]?.id === child.data.id && rd.data.path === "Eingang / Von Claude", JSON.stringify(rd).slice(0, 300));
    const sr = await mcp("search", { query: "Von Claude" });
    check("MCP search findet die Seite", sr.ok && sr.data.some((r: any) => r.id === c1.data.id));
    const lp = await mcp("list_pages", { parent_id: inboxId });
    check("MCP list_pages listet Unterseiten", lp.ok && lp.data.length === 2 && lp.data.some((x: any) => x.id === c1.data.id && x.has_children));

    // Datenbank
    const dbPage = await createPage({
      parentId: newId,
      kind: "database",
      inline: false,
      title: "Aufgaben",
      schema: [
        { id: "title", name: "Name", type: "title" },
        { id: "st", name: "Status", type: "status", options: [{ id: "o1", name: "Offen", color: "default", group: "todo" }, { id: "o2", name: "Fertig", color: "green", group: "done" }] },
        { id: "dt", name: "Fällig", type: "date" },
        { id: "nr", name: "Aufwand", type: "number" },
        { id: "tg", name: "Tags", type: "multi_select", options: [] },
        { id: "ok", name: "Wichtig", type: "checkbox" },
      ],
      views: [],
    } as never);
    const row = await mcp("add_database_row", { database_id: dbPage.id, title: "Steuer machen", properties: { Status: "offen", Fällig: "13.10.2026", Aufwand: "3,5", Tags: ["Finanzen", "Privat"], Wichtig: true }, markdown: "Belege sammeln" });
    check("MCP add_database_row setzt Eigenschaften", row.ok && row.data.properties.Status === "Offen" && row.data.properties.Aufwand === 3.5 && row.data.properties.Tags?.includes("Finanzen") && row.data.properties["Fällig"] === "2026-10-13" && row.data.properties.Wichtig === true, JSON.stringify(row).slice(0, 300));
    check("MCP: neue Auswahl-Optionen werden angelegt", (dbs[dbPage.id]?.schema.find((p) => p.id === "tg")?.options ?? []).length === 2);
    check("MCP: Zeilen-Inhalt aus Markdown", JSON.stringify((await api.getPage(row.data?.id))?.content ?? {}).includes("Belege sammeln"));
    const bad = await mcp("add_database_row", { database_id: dbPage.id, title: "x", properties: { Priorität: "hoch" } });
    check("MCP: unbekannte Eigenschaft → verständlicher Fehler", !bad.ok && /Unbekannte Eigenschaft „Priorität“.*„Status“/.test(bad.error ?? ""), bad.error);
    const badStatus = await mcp("add_database_row", { database_id: dbPage.id, title: "x", properties: { Status: "Irgendwas" } });
    check("MCP: unbekannter Status wird nicht angelegt", !badStatus.ok && (badStatus.error ?? "").includes("„Offen“") && dbs[dbPage.id]?.rows.length === 1, badStatus.error);
    const up = await mcp("update_database_row", { row_id: row.data.id, properties: { Status: "Fertig", Aufwand: null } });
    check("MCP update_database_row ändert und leert Werte", up.ok && up.data.properties.Status === "Fertig" && !("Aufwand" in up.data.properties), JSON.stringify(up).slice(0, 200));
    // Gelesene Werte lassen sich unverändert zurückschreiben (auch Tausender und Prozent)
    await updateSchema(dbPage.id, dbs[dbPage.id]!.schema.map((p) => (p.id === "nr" ? { ...p, format: "comma" as const } : p)));
    await mcp("update_database_row", { row_id: row.data.id, properties: { Aufwand: 1234 } });
    const back = (await mcp("query_database", { database_id: dbPage.id })).data.rows[0].properties;
    const again = await mcp("update_database_row", { row_id: row.data.id, properties: back });
    check("MCP: Werte überstehen Lesen → Schreiben unverändert", back.Aufwand === 1234 && again.ok && again.data.properties.Aufwand === 1234 && again.data.properties["Fällig"] === "2026-10-13", JSON.stringify(again).slice(0, 200));
    await mcp("update_database_row", { row_id: row.data.id, properties: { Aufwand: null } });
    const q = await mcp("query_database", { database_id: dbPage.id, text: "Steuer" });
    check("MCP query_database mit Textfilter", q.ok && q.data.total === 1 && q.data.schema.some((p: any) => p.name === "Status" && p.options.includes("Fertig")));

    // Ändern, Verschieben, Papierkorb, Fehlerfälle
    const ren = await mcp("update_page", { id: c2.data.id, title: "Umbenannt", icon: "🧪" });
    check("MCP update_page benennt um", ren.ok && ws.pages[c2.data.id]?.title === "Umbenannt" && ws.pages[c2.data.id]?.icon === "🧪");
    const mv = await mcp("move_page", { id: c2.data.id, parent_id: c1.data.id });
    check("MCP move_page verschiebt", mv.ok && ws.pages[c2.data.id]?.parentId === c1.data.id);
    const tr = await mcp("trash_page", { id: c2.data.id });
    check("MCP trash_page legt in den Papierkorb", tr.ok && !ws.pages[c2.data.id]);
    const missing = await mcp("read_page", { id: "gibt-es-nicht" });
    check("MCP: unbekannte ID → Fehler", !missing.ok && (missing.error ?? "").includes("nicht gefunden"));
    await api.updatePage(c1.data.id, { settings: { locked: true } });
    const locked = await mcp("append_to_page", { id: c1.data.id, markdown: "x" });
    check("MCP: gesperrte Seite wird nicht geändert", !locked.ok && (locked.error ?? "").includes("gesperrt"));
    const dbAppend = await mcp("append_to_page", { id: dbPage.id, markdown: "x" });
    check("MCP: an Datenbank anhängen → Hinweis auf add_database_row", !dbAppend.ok && (dbAppend.error ?? "").includes("add_database_row"));

    // Ausschalten schließt den Port sofort
    await api.mcpSetEnabled(false);
    check("MCP ausschalten stoppt den Server", await stateIs("off"));
    check("MCP aus: Port wieder geschlossen", (await probe()).status === -1);
    await sleep(100);
    check("MCP aus: kein Hinweis in der Seitenleiste", !document.querySelector(".sb-mcp-dot"));
    await trashPage(dbPage.id);
    await trashPage(inboxId);
    await sleep(200);
  }

  // ⌘, aus dem App-Menü öffnet die Einstellungen
  (window as any).__substrat?.openSettings?.();
  await sleep(150);
  check("⌘, öffnet die Einstellungen", (document.querySelector(".popover")?.textContent ?? "").includes("Darstellung"));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(80);

  // Leistung: lange Seite (5.000 Blöcke) – Tippen muss flüssig bleiben (< 16 ms pro Taste)
  {
    const big = await createPage({ parentId: null, sortKey: nextSortKey(null), title: "Lange Seite" });
    navigation.open(big.id);
    const bv = await waitFor(() => openEditors.get(big.id));
    if (bv) {
      const sch = bv.state.schema;
      const kinds = ["paragraph", "bullet", "todo", "heading"];
      const measure = async (count: number) => {
        const nodes = Array.from({ length: count }, (_, k) => {
          const t = kinds[k % 4];
          const attrs = t === "heading" ? { level: 2 } : t === "todo" ? { checked: false } : null;
          return sch.nodes[t].create(attrs, sch.text(`Block ${k} mit etwas Text`));
        });
        bv.dispatch(bv.state.tr.replaceWith(0, bv.state.doc.content.size, nodes));
        bv.focus();
        bv.dispatch(bv.state.tr.setSelection((bv.state.selection.constructor as any).create(bv.state.doc, bv.state.doc.content.size - 2)));
        await sleep(200);
        const times: number[] = [];
        for (let k = 0; k < 30; k++) {
          const t0 = performance.now();
          typeText(bv, "x");
          times.push(performance.now() - t0);
        }
        times.sort((x, y) => x - y);
        return { median: times[15], max: times[29] };
      };
      const m2 = await measure(2000);
      check("Lange Seite (2.000 Blöcke): Tippen flüssig (< 16 ms)", m2.median < 16, `Median ${m2.median.toFixed(1)} ms, max ${m2.max.toFixed(1)} ms`);
      const bullets = bv.dom.querySelectorAll(".block-bullet").length;
      check("Lange Seite: Aufzählungszeichen bleiben beim Tippen erhalten", bullets === 500, String(bullets));
      const m5 = await measure(5000);
      await log(`INFO Lange Seite (5.000 Blöcke): Median ${m5.median.toFixed(1)} ms, max ${m5.max.toFixed(1)} ms`);
      await flushAll();
    }
    await trashPage(big.id);
    navigation.open(newId);
    await waitFor(() => openEditors.get(newId));
  }

  // Bildschirm-Tour im Hellmodus (für die visuelle Prüfung)
  {
    ui.setTheme("light");
    navigation.open(newId);
    await sleep(600);
    await snap("L1-seite-hell");
    const th = document.querySelectorAll(".db-view .th")[1] as HTMLElement | undefined;
    th?.click();
    await sleep(250);
    await snap("L2-eigenschaftsmenue");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const vv = openEditors.get(newId);
    if (vv) {
      vv.focus();
      key(vv, "/", { meta: true });
      await sleep(250);
      await snap("L3-blockmenue");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }
    const dbIdTour = Object.values(ws.pages).find((p) => p.kind === "database" && p.parentId === newId)?.id;
    const rowTour = dbIdTour ? dbs[dbIdTour]?.rows[0]?.id : undefined;
    if (rowTour) {
      navigation.setPeek(rowTour);
      await sleep(600);
      await snap("L4-vorschau");
      navigation.setPeek(null);
    }
    (document.querySelector(".sb-workspace") as HTMLElement | null)?.click();
    await sleep(250);
    await snap("L5-einstellungen");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const trashBtn = Array.from(document.querySelectorAll(".sb-item")).find((b) => b.textContent?.includes("Papierkorb")) as HTMLElement | undefined;
    trashBtn?.click();
    await sleep(300);
    await snap("L6-papierkorb");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    navigation.go({ kind: "graph" });
    await sleep(1200);
    (document.querySelector(".graph-page .graph-canvas") as any)?.__drawNow?.();
    await snap("L7-graph-hell");
    ui.setTheme("system");
  }

  await flushAll();
  sessionStorage.setItem("selftest", JSON.stringify({ newId, welcomeId, passed, failed }));
  location.reload();
}

async function phase2(state: { newId: ID; welcomeId: ID; passed: number; failed: number; phase?: number }) {
  passed = state.passed;
  failed = state.failed;
  await waitFor(() => ws.loaded, 5000);
  const page = await api.getPage(state.newId);
  const types = (page?.content?.content ?? []).map((b) => b.type);
  check("Nach Neuladen: Inhalt gespeichert", types.includes("heading") && types.includes("todo") && types.includes("database"), types.join(","));
  check("Nach Neuladen: Titel gespeichert", page?.title === "Testseite");
  const dbId = String((page?.content?.content ?? []).find((b) => b.type === "database")?.attrs?.databaseId ?? "");
  const db = await api.getDatabase(dbId);
  check("Nach Neuladen: Datenbankzeilen gespeichert", (db?.rows.length ?? 0) === 2);
  const net = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /^(https?|wss?):/.test(n));
  check("Keine Netzwerkanfragen während des gesamten Tests", net.length === 0, net.slice(0, 3).join(", "));
  // Abgesicherter Modus (wie nach wiederholten Abstürzen der Darstellung)
  sessionStorage.setItem("selftest", JSON.stringify({ ...state, passed, failed, phase: 3 }));
  location.href = location.pathname + "?safe=1";
}

async function phase3(state: { passed: number; failed: number }) {
  passed = state.passed;
  failed = state.failed;
  await waitFor(() => ws.loaded, 5000);
  await sleep(300);
  check("Abgesicherter Modus öffnet keine Seite automatisch", navigation.route().kind === "none", navigation.route().kind);
  check("Abgesicherter Modus zeigt einen Hinweis", (document.querySelector(".toast-layer")?.textContent ?? "").includes("Abgesicherter Modus"));
  await log(`RESULT ${passed} bestanden, ${failed} fehlgeschlagen`);
  sessionStorage.removeItem("selftest");
  await debug("debug.quit");
}

export async function runSelftest() {
  window.addEventListener("error", (e) => void log(`FAIL Unbehandelter Fehler: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => void log(`FAIL Unbehandelte Promise-Ablehnung: ${String(e.reason)}`));
  try {
    const saved = sessionStorage.getItem("selftest");
    const st = saved ? JSON.parse(saved) : null;
    if (st?.phase === 3) await phase3(st);
    else if (st) await phase2(st);
    else await phase1();
  } catch (e) {
    await log(`FAIL Selbsttest abgebrochen: ${e instanceof Error ? e.stack : String(e)}`);
    await debug("debug.quit");
  }
}
