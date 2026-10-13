import { createMemo, For, Show } from "solid-js";
import type { EditorView } from "prosemirror-view";
import type { ID } from "../api/types";
import { pageTitle } from "../lib/util";
import { navigation, ws } from "../state/workspace";
import { PageIcon } from "../components/PageIcon";
import { DatabaseView } from "../database/DatabaseView";
import { LocalGraph } from "../graph/LocalGraph";
import { schema } from "./schema";

/** Verweis auf eine Seite: als Block (Unterseite) oder inline (Erwähnung). */
export function PageRef(props: { id: ID; inline: boolean }) {
  const page = () => ws.pages[props.id];
  return (
    <Show
      when={page()}
      fallback={<span class={props.inline ? "page-ref inline missing" : "page-ref missing"}>Seite nicht gefunden</span>}
    >
      <span
        class={props.inline ? "page-ref inline" : "page-ref hover-bg"}
        onClick={(e) => {
          if (props.inline) return; // MentionView navigiert selbst
          e.preventDefault();
          navigation.open(props.id);
        }}
      >
        <PageIcon id={props.id} size={props.inline ? 16 : 20} />
        <span class="page-ref-title">{pageTitle(page()!.title)}</span>
      </span>
    </Show>
  );
}

export function BlockDatabase(props: { id: ID; readOnly: boolean }) {
  return (
    <Show when={props.id} fallback={<div class="muted">Datenbank fehlt</div>}>
      <div class="interactive db-inline-wrap">
        <DatabaseView id={props.id} inline readOnly={props.readOnly} />
      </div>
    </Show>
  );
}

export function BlockGraph(props: { pageId: ID; depth: number }) {
  return (
    <div class="interactive graph-block">
      <LocalGraph pageId={props.pageId} depth={props.depth} height={360} />
    </div>
  );
}

export function TocView(props: { view: EditorView; version: () => number }) {
  const headings = createMemo(() => {
    props.version();
    const out: { level: number; text: string; index: number }[] = [];
    props.view.state.doc.forEach((n, _pos, index) => {
      if (n.type === schema.nodes.heading && n.textContent.trim()) out.push({ level: n.attrs.level, text: n.textContent, index });
    });
    return out;
  });
  return (
    <div class="toc interactive">
      <For each={headings()} fallback={<div class="muted toc-empty">Füge Überschriften hinzu, um ein Inhaltsverzeichnis zu erstellen.</div>}>
        {(h) => (
          <div
            class="toc-item hover-bg"
            style={{ "padding-left": `${(h.level - 1) * 24 + 2}px` }}
            onClick={() => {
              const el = props.view.dom.children[h.index] as HTMLElement | undefined;
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {h.text}
          </div>
        )}
      </For>
    </div>
  );
}
