import { createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../api/client";
import type { ID } from "../api/types";
import { formatDateTime, formatRelative } from "../lib/util";
import { flushAll, updatePage } from "../state/workspace";
import { analyzeDoc } from "../editor/doc";
import { saveContent } from "../state/pageSave";
import { Editor } from "../editor/Editor";
import { toast } from "./popovers";
import type { PageHandle } from "./PageView";

const [historyFor, setHistoryFor] = createSignal<{ id: ID; handle: PageHandle | null } | null>(null);

export function openHistory(id: ID, handle: PageHandle | null) {
  setHistoryFor({ id, handle });
}

/** Seitenverlauf: frühere Versionen ansehen und wiederherstellen. */
export function HistoryPanel() {
  return (
    <Show when={historyFor()} keyed>
      {(h) => (
        <Portal>
          <HistoryDialog id={h.id} handle={h.handle} />
        </Portal>
      )}
    </Show>
  );
}

function HistoryDialog(props: { id: ID; handle: PageHandle | null }) {
  const [items] = createResource(async () => {
    await flushAll();
    return api.history(props.id);
  });
  const [selected, setSelected] = createSignal<number | null>(null);
  const [entry] = createResource(selected, (id) => api.historyEntry(id));
  const close = () => setHistoryFor(null);

  const restore = async () => {
    const e = entry();
    if (!e) return;
    await props.handle?.flush();
    const current = await api.getPage(props.id);
    await saveContent(props.id, e.content ?? { type: "doc", content: [{ type: "paragraph" }] }, analyzeDoc(current?.content), { snapshot: true });
    if (e.title) await updatePage(props.id, { title: e.title });
    await props.handle?.reload();
    toast("Version wiederhergestellt");
    close();
  };

  return (
    <div class="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="history-dialog">
        <div class="history-preview">
          <Show when={entry()} keyed fallback={<div class="history-empty muted">Wähle rechts eine Version aus.</div>}>
            {(e) => (
              <div class="page">
                <div class="page-content">
                  <div class="page-title static">{e.title || "Unbenannt"}</div>
                  <Editor pageId={`history-${props.id}-${e.createdAt}`} content={e.content} readOnly />
                </div>
              </div>
            )}
          </Show>
        </div>
        <div class="history-list">
          <div class="history-head">Seitenverlauf</div>
          <For each={items() ?? []} fallback={<div class="muted small" style={{ padding: "12px" }}>Noch keine früheren Versionen. Versionen entstehen beim Bearbeiten (höchstens alle 10 Minuten).</div>}>
            {(it) => (
              <button class="history-item" classList={{ active: selected() === it.id }} onClick={() => setSelected(it.id)}>
                <span>{formatRelative(it.createdAt)}</span>
                <span class="muted small">{formatDateTime(it.createdAt)}</span>
              </button>
            )}
          </For>
          <div class="history-actions">
            <button class="btn-outline" onClick={close}>
              Abbrechen
            </button>
            <button class="btn-primary" disabled={!entry()} onClick={() => void restore()}>
              Wiederherstellen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
