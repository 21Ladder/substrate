import { DOMParser as PMDOMParser } from "prosemirror-model";
import type { DocJSON } from "../api/types";
import { schema } from "../editor/schema";
import { flattenLists } from "../editor/Editor";

// HTML (z. B. Notion-HTML-Export) → Dokument-JSON über die Parse-Regeln des Schemas.

export interface HtmlContext {
  resolveLink: (href: string) => string | null;
  resolveAsset: (src: string) => string | null;
}

export function htmlTitle(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("h1.page-title")?.textContent?.trim() || doc.title?.trim() || null;
}

export function htmlToDoc(html: string, ctx: HtmlContext): DocJSON {
  // DOMParser erzeugt ein inertes Dokument: keine Skripte, keine Netzwerkzugriffe
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, link, meta, iframe, object, embed").forEach((e) => e.remove());
  const root = (doc.querySelector(".page-body") as HTMLElement | null) ?? doc.body;
  root.querySelector("h1.page-title")?.remove();

  // Notion-To-dos: <li><div class="checkbox checkbox-on"></div> Text</li>
  root.querySelectorAll("ul.to-do-list > li").forEach((li) => {
    const box = li.querySelector(".checkbox");
    if (!box) return;
    const input = doc.createElement("input");
    input.type = "checkbox";
    if (box.classList.contains("checkbox-on")) input.setAttribute("checked", "");
    box.replaceWith(input);
  });
  // Callouts
  root.querySelectorAll("figure.callout").forEach((fig) => {
    const div = doc.createElement("div");
    div.setAttribute("data-block", "callout");
    const icon = fig.querySelector(".icon")?.textContent?.trim();
    if (icon) div.setAttribute("data-icon", icon);
    const body = fig.querySelector("div:last-child") ?? fig;
    div.innerHTML = body.innerHTML;
    fig.replaceWith(div);
  });
  // Bilder → Bildblöcke mit lokalem Anhang
  root.querySelectorAll("img").forEach((img) => {
    const src = ctx.resolveAsset(img.getAttribute("src") ?? "");
    const block = doc.createElement("div");
    if (src) {
      block.setAttribute("data-block", "image");
      block.setAttribute("data-src", src);
    }
    (img.closest("figure") ?? img.closest("a") ?? img).replaceWith(block);
  });
  // Links auf andere exportierte Seiten → Erwähnungen
  root.querySelectorAll("a[href]").forEach((a) => {
    const id = ctx.resolveLink(a.getAttribute("href") ?? "");
    if (!id) return;
    const span = doc.createElement("span");
    span.setAttribute("data-mention", id);
    a.replaceWith(span);
  });
  const container = doc.createElement("div");
  container.innerHTML = flattenLists(root.innerHTML);
  const parsed = PMDOMParser.fromSchema(schema).parse(container);
  const json = parsed.toJSON() as DocJSON;
  if (!json.content?.length) json.content = [{ type: "paragraph" }];
  return json;
}
