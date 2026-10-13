import type { DocJSON } from "../api/types";
import { uuid } from "./id";
import { analyzeDoc, mentionLinks } from "../editor/doc";
import { api } from "../api/client";
import { loadWorkspace } from "../state/workspace";
import { keysBetween } from "./sortkey";

const t = (text: string, marks?: string[]): DocJSON => (marks ? { type: "text", text, marks: marks.map((m) => ({ type: m })) } : { type: "text", text });
const p = (...content: DocJSON[]): DocJSON => ({ type: "paragraph", attrs: { indent: 0 }, content });
const h = (level: number, text: string): DocJSON => ({ type: "heading", attrs: { indent: 0, level }, content: [t(text)] });
const todo = (text: string, checked = false, indent = 0): DocJSON => ({ type: "todo", attrs: { indent, checked }, content: [t(text)] });
const bullet = (indent: number, ...content: DocJSON[]): DocJSON => ({ type: "bullet", attrs: { indent }, content });
const mention = (pageId: string): DocJSON => ({ type: "mention", attrs: { pageId } });

/** Legt beim ersten Start eine Willkommensseite mit zwei verknüpften Beispielseiten an. */
export async function createWelcome(): Promise<string> {
  const welcome = uuid();
  const ideas = uuid();
  const graph = uuid();
  const [k1, k2, k3] = keysBetween(null, null, 3);

  const welcomeDoc: DocJSON = {
    type: "doc",
    content: [
      p(t("Substrat funktioniert wie Notion – nur lokal, schnell und mit einem Graph, der Zusammenhänge sichtbar macht.")),
      {
        type: "callout",
        attrs: { indent: 0, icon: "💡", color: "gray_bg" },
        content: [t("Tippe "), t("/", ["code"]), t(" für Blöcke, "), t("@", ["code"]), t(" um Seiten zu erwähnen, und markiere Text zum Formatieren.")],
      },
      h(2, "Erste Schritte"),
      todo("Klicke auf das Kästchen, um diese Aufgabe abzuhaken", true),
      todo("Ziehe Blöcke am Griff ⋮⋮ links, um sie zu verschieben"),
      todo("Drücke Tab, um einen Block einzurücken"),
      todo("Erstelle mit /tabelle eine Datenbank"),
      todo("Öffne den Graph mit ⌘⇧G"),
      { type: "toggle", attrs: { indent: 0, open: false }, content: [t("Toggle-Listen klappen Inhalte ein")] },
      { type: "paragraph", attrs: { indent: 1 }, content: [t("Dieser Text ist eingeklappt. Klicke auf den Pfeil, um ihn zu sehen.")] },
      h(2, "Verbindungen"),
      p(t("Erwähnungen verbinden Seiten: Diese Seite verweist auf "), mention(ideas), t(". Im Graph und im Bereich „Backlinks“ siehst du, was womit zusammenhängt.")),
      { type: "page", attrs: { indent: 0, pageId: ideas } },
      { type: "page", attrs: { indent: 0, pageId: graph } },
      h(2, "Markdown-Kürzel"),
      bullet(0, t("# ", ["code"]), t(" Überschrift, "), t("- ", ["code"]), t(" Liste, "), t("[] ", ["code"]), t(" To-do, "), t("> ", ["code"]), t(" Toggle")),
      bullet(0, t("**fett**", ["code"]), t(", "), t("*kursiv*", ["code"]), t(", "), t("`code`", ["code"]), t(", "), t("~durchgestrichen~", ["code"])),
      bullet(0, t("--- ", ["code"]), t(" Trennlinie, "), t('" ', ["code"]), t(" Zitat, "), t("``` ", ["code"]), t(" Code")),
    ],
  };
  const ideasDoc: DocJSON = {
    type: "doc",
    content: [
      p(t("Eine Beispielseite. Sie wird von "), mention(welcome), t(" erwähnt und erwähnt selbst "), mention(graph), t(".")),
      bullet(0, t("Ideen sammeln")),
      bullet(1, t("Unterpunkte entstehen mit Tab")),
      bullet(0, t("Mit "), t("[[", ["code"]), t(" auf andere Seiten verweisen")),
    ],
  };
  const graphDoc: DocJSON = {
    type: "doc",
    content: [
      p(t("Der Graph zeigt alle Seiten als Punkte und ihre Verbindungen als Linien.")),
      bullet(0, t("Klick auf einen Punkt öffnet die Vorschau, Doppelklick die Seite")),
      bullet(0, t("Unter „Zusammenhänge“ findest du Pfade zwischen zwei Seiten, Themen-Cluster und zentrale Seiten")),
      bullet(0, t("Rechts oben auf jeder Seite (✳-Symbol) zeigt die Verbindungen der aktuellen Seite")),
      { type: "graph", attrs: { indent: 0, depth: 2 } },
    ],
  };
  const make = (id: string, parentId: string | null, title: string, icon: string, sortKey: string, content: DocJSON) => {
    const info = analyzeDoc(content);
    return {
      method: "page.create",
      params: api.createParams({ id, parentId, title, icon, sortKey, content, text: info.text, links: { kinds: ["mention"], items: mentionLinks(info) } }),
    };
  };
  await api.batch([
    make(welcome, null, "Willkommen bei Substrat", "👋", k1, welcomeDoc),
    make(ideas, welcome, "Ideen", "💡", k2, ideasDoc),
    make(graph, welcome, "So funktioniert der Graph", "✳️", k3, graphDoc),
  ]);
  await loadWorkspace();
  return welcome;
}
