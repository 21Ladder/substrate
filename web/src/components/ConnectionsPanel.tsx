import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../api/client";
import type { DocJSON, ID } from "../api/types";
import { debounce, pageTitle } from "../lib/util";
import { navigation, on, ws } from "../state/workspace";
import { saveContent } from "../state/pageSave";
import { analyzeDoc } from "../editor/doc";
import { openEditors } from "../editor/ui";
import { schema } from "../editor/schema";
import { LocalGraph } from "../graph/LocalGraph";
import { IconView } from "./PageIcon";
import { IconClose } from "./Icons";
import { ui } from "../state/ui";
import { toast } from "./popovers";

/**
 * Seitenleiste rechts: lokaler Graph, Backlinks und unverlinkte Erwähnungen
 * (Seiten, die den Titel nennen, aber nicht verlinken).
 */
export function ConnectionsPanel(props: { pageId: ID }) {
  const [depth, setDepth] = createSignal(1);
  const [backlinks, { refetch: refetchBacklinks }] = createResource(() => props.pageId, (id) => api.backlinks(id));
  // Titel entprellt: keine Suche bei jedem Tastendruck
  const [title, setTitle] = createSignal(ws.pages[props.pageId]?.title ?? "");
  const updateTitle = debounce((t: string) => setTitle(t), 600);
  createEffect(() => updateTitle(ws.pages[props.pageId]?.title ?? ""));
  onCleanup(() => updateTitle.cancel());
  const [unlinked, { refetch: refetchUnlinked }] = createResource(
    () => [props.pageId, title()] as const,
    async ([id, title]) => findUnlinked(id, title ?? ""),
  );
  const off = on("links-changed", () => {
    void refetchBacklinks();
    void refetchUnlinked();
  });
  onCleanup(off);

  return (
    <aside class="connections">
      <div class="connections-head">
        <span>Verbindungen</span>
        <span style={{ flex: 1 }} />
        <button class="icon-btn small" onClick={() => ui.setGraphPanel(false)}>
          <IconClose />
        </button>
      </div>
      <div class="connections-graph">
        <LocalGraph pageId={props.pageId} depth={depth()} height={300} />
        <div class="depth-picker">
          <span class="muted small">Tiefe</span>
          <For each={[1, 2, 3]}>
            {(d) => (
              <button classList={{ active: depth() === d }} onClick={() => setDepth(d)}>
                {d}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="connections-section">
        <div class="connections-title">Backlinks ({backlinks()?.length ?? 0})</div>
        <For each={backlinks() ?? []} fallback={<div class="muted small">Keine Seite verweist hierher.</div>}>
          {(b) => (
            <button class="backlink hover-bg" onClick={() => navigation.open(b.id)}>
              <IconView icon={ws.pages[b.id]?.icon ?? b.icon} kind={b.kind} size={16} />
              <span class="ellipsis">{pageTitle(ws.pages[b.id]?.title ?? b.title)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="connections-section">
        <div class="connections-title" title="Seiten, die den Titel dieser Seite erwähnen, ohne darauf zu verlinken">
          Unverlinkte Erwähnungen ({unlinked()?.length ?? 0})
        </div>
        <For each={unlinked() ?? []} fallback={<div class="muted small">Keine gefunden.</div>}>
          {(u) => (
            <div class="unlinked">
              <button class="backlink hover-bg" onClick={() => navigation.open(u.id)}>
                <IconView icon={ws.pages[u.id]?.icon} kind={ws.pages[u.id]?.kind} size={16} />
                <span class="ellipsis">{pageTitle(ws.pages[u.id]?.title)}</span>
              </button>
              <Show when={u.snippet}>
                <div class="unlinked-snippet">{u.snippet.replace(/[\u0001\u0002]/g, "")}</div>
              </Show>
              <button
                class="btn-outline small"
                onClick={async () => {
                  const ok = await linkMention(u.id, props.pageId);
                  toast(ok ? "Verlinkt" : "Text nicht gefunden");
                  void refetchUnlinked();
                  void refetchBacklinks();
                }}
              >
                Verlinken
              </button>
            </div>
          )}
        </For>
      </div>
    </aside>
  );
}

async function findUnlinked(id: ID, title: string): Promise<{ id: ID; snippet: string }[]> {
  const t = title.trim();
  if (t.length < 3) return [];
  const [results, backlinks] = await Promise.all([api.search(`"${t.replace(/"/g, "")}"`, 50), api.backlinks(id)]);
  const linked = new Set(backlinks.map((b) => b.id));
  const lower = t.toLowerCase();
  return results
    .filter((r) => r.id !== id && !linked.has(r.id) && r.snippet && r.snippet.replace(/[\u0001\u0002]/g, "").toLowerCase().includes(lower))
    .map((r) => ({ id: r.id, snippet: r.snippet }));
}

/** Ersetzt das erste Vorkommen des Titels in `srcId` durch eine Erwähnung von `targetId`. */
export async function linkMention(srcId: ID, targetId: ID): Promise<boolean> {
  const title = (ws.pages[targetId]?.title ?? "").trim();
  if (!title) return false;
  const lower = title.toLowerCase();
  const view = openEditors.get(srcId);
  if (view && !view.isDestroyed) {
    let found: { from: number; to: number } | null = null;
    view.state.doc.descendants((n, pos, parent) => {
      if (found) return false;
      if (n.type.spec.code) return false; // nicht in Code-Blöcken verlinken
      if (!n.isText || !n.text || parent?.type.spec.code) return true;
      const i = n.text.toLowerCase().indexOf(lower);
      if (i >= 0 && !n.marks.some((m) => m.type === schema.marks.code || m.type === schema.marks.link)) found = { from: pos + i, to: pos + i + title.length };
      return !found;
    });
    if (!found) return false;
    const f = found as { from: number; to: number };
    view.dispatch(view.state.tr.replaceWith(f.from, f.to, schema.nodes.mention.create({ pageId: targetId })));
    return true;
  }
  const page = await api.getPage(srcId);
  if (!page?.content) return false;
  const prev = page.content;
  const next: DocJSON = JSON.parse(JSON.stringify(prev));
  let done = false;
  for (const block of next.content ?? []) {
    if (done || !block.content || block.type === "code_block") continue;
    const out: DocJSON[] = [];
    for (const n of block.content) {
      if (!done && n.type === "text" && n.text && !(n.marks ?? []).some((m) => m.type === "code" || m.type === "link")) {
        const i = n.text.toLowerCase().indexOf(lower);
        if (i >= 0) {
          if (i > 0) out.push({ ...n, text: n.text.slice(0, i) });
          out.push({ type: "mention", attrs: { pageId: targetId } });
          const rest = n.text.slice(i + title.length);
          if (rest) out.push({ ...n, text: rest });
          done = true;
          continue;
        }
      }
      out.push(n);
    }
    block.content = out;
  }
  if (!done) return false;
  await saveContent(srcId, next, analyzeDoc(prev));
  return true;
}
