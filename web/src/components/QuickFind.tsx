import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../api/client";
import type { ID, SearchResult } from "../api/types";
import { formatRelative, pageTitle } from "../lib/util";
import { ancestors, createPage, jsonSetting, navigation, nextSortKey, ws } from "../state/workspace";
import { ui } from "../state/ui";
import { PageIcon } from "./PageIcon";
import { IconPlus, IconSearch } from "./Icons";

/** Schnellsuche (⌘P / ⌘K): zuletzt besuchte Seiten oder Volltextsuche. */
export function QuickFind() {
  return (
    <Show when={ui.quickFind()}>
      <Portal>
        <QuickFindDialog />
      </Portal>
    </Show>
  );
}

function Snippet(props: { text: string }) {
  // \u0001 … \u0002 markiert Treffer (sicher, ohne HTML)
  const parts = () => props.text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span class="qf-snippet">
      <For each={parts()}>{(p) => (p.startsWith("\u0001") ? <mark>{p.slice(1, -1)}</mark> : <>{p}</>)}</For>
    </span>
  );
}

function QuickFindDialog() {
  const [q, setQ] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [active, setActive] = createSignal(0);
  let timer: number | undefined;
  createEffect(
    on(q, (v) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setDebounced(v), 60);
    }),
  );
  const [results] = createResource(debounced, async (s) => (s.trim() ? api.search(s.trim(), 40) : []));
  const recent = createMemo(() =>
    jsonSetting<ID[]>("recent", [])
      .filter((id) => ws.pages[id])
      .slice(0, 12),
  );
  type Item = { kind: "page"; id: ID; snippet?: string } | { kind: "new" };
  const items = createMemo<Item[]>(() => {
    if (!q().trim()) return recent().map((id) => ({ kind: "page" as const, id }));
    const list: Item[] = (results() ?? []).filter((r: SearchResult) => ws.pages[r.id]).map((r: SearchResult) => ({ kind: "page" as const, id: r.id, snippet: r.snippet }));
    list.push({ kind: "new" });
    return list;
  });
  createEffect(on(items, () => setActive(0)));

  const close = () => ui.setQuickFind(false);
  const choose = async (it: Item | undefined, peek = false) => {
    if (!it) return;
    close();
    if (it.kind === "new") {
      const p = await createPage({ parentId: null, title: q().trim(), sortKey: nextSortKey(null) });
      navigation.open(p.id);
    } else if (peek) navigation.setPeek(it.id);
    else navigation.open(it.id);
  };

  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  onMount(() => input.focus());
  createEffect(() => {
    const el = list?.children[active()] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  return (
    <div class="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="quickfind">
        <div class="qf-input">
          <IconSearch />
          <input
            ref={input}
            placeholder="Durchsuchen oder Seite öffnen …"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              const n = items().length;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % Math.max(1, n));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a - 1 + n) % Math.max(1, n));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void choose(items()[active()], e.metaKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
        </div>
        <div class="qf-section">{q().trim() ? "Ergebnisse" : "Zuletzt besucht"}</div>
        <div class="qf-list" ref={list}>
          <For each={items()} fallback={<div class="qf-empty">{q().trim() ? "Keine Ergebnisse" : "Noch nichts besucht"}</div>}>
            {(it, i) => (
              <Show
                when={it.kind === "page"}
                fallback={
                  <div class="qf-item" classList={{ active: active() === i() }} onMouseEnter={() => setActive(i())} onClick={() => void choose(it)}>
                    <span class="qf-icon">
                      <IconPlus />
                    </span>
                    <span class="qf-title">Neue Seite „{q().trim()}“</span>
                  </div>
                }
              >
                {(() => {
                  const id = (it as { id: ID }).id;
                  const path = () =>
                    ancestors(id)
                      .slice(0, -1)
                      .map((p) => pageTitle(p.title))
                      .join(" / ");
                  return (
                    <div class="qf-item" classList={{ active: active() === i() }} onMouseEnter={() => setActive(i())} onClick={(e) => void choose(it, e.metaKey)}>
                      <span class="qf-icon">
                        <PageIcon id={id} size={20} />
                      </span>
                      <span class="qf-main">
                        <span class="qf-title-row">
                          <span class="qf-title ellipsis">{pageTitle(ws.pages[id]?.title)}</span>
                          <Show when={path()}>
                            <span class="qf-path ellipsis">— {path()}</span>
                          </Show>
                        </span>
                        <Show when={(it as { snippet?: string }).snippet}>
                          <Snippet text={(it as { snippet: string }).snippet} />
                        </Show>
                      </span>
                      <span class="qf-time">{formatRelative(ws.pages[id]?.updatedAt ?? 0)}</span>
                    </div>
                  );
                })()}
              </Show>
            )}
          </For>
        </div>
        <div class="qf-footer">
          <span>↑↓ Auswählen</span>
          <span>↵ Öffnen</span>
          <span>⌘↵ In Seitenvorschau öffnen</span>
          <span>esc Schließen</span>
        </div>
      </div>
    </div>
  );
}
