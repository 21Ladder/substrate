import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api/client";
import type { TrashItem } from "../api/types";
import { formatRelative, pageTitle } from "../lib/util";
import { navigation, restorePage } from "../state/workspace";
import { confirmDialog, openPopover, toast } from "./popovers";
import { IconView } from "./PageIcon";
import { IconRestore, IconTrash } from "./Icons";

export function openTrash(anchor: DOMRect) {
  openPopover(anchor, (close) => <TrashPanel close={close} />, { placement: "right-start" });
}

function TrashPanel(props: { close: () => void }) {
  const [items, { refetch }] = createResource(() => api.listTrash());
  const [q, setQ] = createSignal("");
  const filtered = createMemo(() => (items() ?? []).filter((i: TrashItem) => !q() || pageTitle(i.title).toLowerCase().includes(q().toLowerCase())));
  return (
    <div class="menu trash" style={{ width: "400px" }}>
      <div style={{ padding: "8px" }}>
        <input class="text-input" placeholder="Seiten im Papierkorb filtern …" value={q()} onInput={(e) => setQ(e.currentTarget.value)} ref={(el) => setTimeout(() => el.focus())} />
      </div>
      <div class="menu-scroll" style={{ "max-height": "50vh" }}>
        <For each={filtered()} fallback={<div class="menu-empty">Der Papierkorb ist leer</div>}>
          {(it) => (
            <div class="trash-item hover-bg">
              <IconView icon={it.icon} kind={it.kind} size={18} />
              <span class="trash-title ellipsis">{pageTitle(it.title)}</span>
              <span class="muted small">{formatRelative(it.deletedAt)}</span>
              <button
                class="icon-btn small"
                title="Wiederherstellen"
                onClick={async () => {
                  await restorePage(it.id);
                  await refetch();
                  toast("Wiederhergestellt");
                  navigation.open(it.id);
                  props.close();
                }}
              >
                <IconRestore />
              </button>
              <button
                class="icon-btn small"
                title="Endgültig löschen"
                onClick={async () => {
                  if (!(await confirmDialog({ title: "Endgültig löschen?", message: `„${pageTitle(it.title)}“ und alle Unterseiten werden unwiderruflich gelöscht.`, confirm: "Endgültig löschen", danger: true }))) return;
                  await api.purgePage(it.id);
                  await refetch();
                }}
              >
                <IconTrash />
              </button>
            </div>
          )}
        </For>
      </div>
      <Show when={(items() ?? []).length}>
        <div class="menu-footer muted">Seiten im Papierkorb werden nach 30 Tagen automatisch gelöscht.</div>
      </Show>
    </div>
  );
}
