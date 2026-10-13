import type { DocJSON, ID, LinkItem } from "../api/types";

// Analyse von Dokument-JSON ohne ProseMirror-Instanz (für Speichern, Suche, Export).

export interface DocInfo {
  text: string;
  mentions: ID[];
  subpages: ID[];
  databases: ID[];
}

export function analyzeDoc(doc: DocJSON | null | undefined): DocInfo {
  const lines: string[] = [];
  const mentions = new Set<ID>();
  const subpages: ID[] = [];
  const databases: ID[] = [];
  for (const block of doc?.content ?? []) {
    let line = "";
    for (const inl of block.content ?? []) {
      if (inl.type === "text") line += inl.text ?? "";
      else if (inl.type === "mention" && inl.attrs?.pageId) mentions.add(String(inl.attrs.pageId));
      else if (inl.type === "hard_break") line += "\n";
    }
    if (block.type === "page" && block.attrs?.pageId) subpages.push(String(block.attrs.pageId));
    if (block.type === "database" && block.attrs?.databaseId) databases.push(String(block.attrs.databaseId));
    if (block.type === "image" && block.attrs?.caption) line += String(block.attrs.caption);
    if (block.type === "bookmark") line += `${block.attrs?.title ?? ""} ${block.attrs?.url ?? ""}`;
    if (line) lines.push(line);
  }
  return { text: lines.join("\n"), mentions: [...mentions], subpages, databases };
}

export function mentionLinks(info: DocInfo): LinkItem[] {
  return info.mentions.map((dst) => ({ dst, kind: "mention" as const }));
}

/** Text der ersten Zeilen (für Galerie-Vorschauen). */
export function previewText(doc: DocJSON | null | undefined, max = 200): string {
  return analyzeDoc(doc).text.slice(0, max);
}
