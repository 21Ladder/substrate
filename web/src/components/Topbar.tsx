import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api/client";
import type { ID } from "../api/types";
import { formatRelative, pageTitle } from "../lib/util";
import { ancestors, failingSaves, navigation, toggleFavorite, trashPage, ws } from "../state/workspace";
import { ui } from "../state/ui";
import { duplicatePage } from "../state/pageActions";
import { exportPage } from "../lib/transfer";
import { analyzeDoc } from "../editor/doc";
import { MenuDivider, MenuItem, MenuSection, openPagePicker, openPopover, toast } from "./popovers";
import { PageIcon } from "./PageIcon";
import type { PageHandle } from "./PageView";
import { openHistory } from "./HistoryPanel";
import {
  IconArrowLeft,
  IconArrowRight,
  IconClock,
  IconDoubleChevronRight,
  IconDuplicate,
  IconExport,
  IconGraph,
  IconLock,
  IconMore,
  IconMove,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "./Icons";
import { startWindowDrag } from "./windowDrag";
import { isDescendant, movePage, nextSortKey } from "../state/workspace";
import { openPageMenu } from "./Sidebar";

// Uhr für relative Zeitangaben (einmal pro Minute)
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 60_000);

export function Topbar(props: { handle: () => PageHandle | null }) {
  const route = navigation.route;
  // Nur für existierende Seiten (nicht z. B. für eine Erwähnung einer gelöschten Seite)
  const pageId = () => {
    const r = route();
    return r.kind === "page" && ws.pages[r.id] ? r.id : null;
  };
  const crumbs = createMemo(() => {
    const id = pageId();
    if (!id) return [];
    const chain = ancestors(id);
    return chain.length > 4 ? [chain[0], null, ...chain.slice(-2)] : chain;
  });
  return (
    <header class="topbar" classList={{ "no-sidebar": !ui.sidebarOpen(), fullscreen: ui.fullscreen() }} onMouseDown={startWindowDrag}>
      <Show when={!ui.sidebarOpen()}>
        <button class="icon-btn" title="Seitenleiste öffnen (⌘\)" onClick={() => ui.setSidebarOpen(true)}>
          <IconDoubleChevronRight />
        </button>
      </Show>
      <button class="icon-btn" title="Zurück (⌘[)" disabled={!navigation.canBack()} onClick={() => navigation.back()}>
        <IconArrowLeft />
      </button>
      <button class="icon-btn" title="Vor (⌘])" disabled={!navigation.canForward()} onClick={() => navigation.forward()}>
        <IconArrowRight />
      </button>
      <nav class="crumbs">
        <Show when={route().kind === "graph"}>
          <span class="crumb static">
            <IconGraph /> Graph
          </span>
        </Show>
        <For each={crumbs()}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <span class="crumb-sep">/</span>
              </Show>
              <Show when={c} fallback={<span class="crumb static">…</span>}>
                <button
                  class="crumb"
                  onClick={() => navigation.open(c!.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openPageMenu(e.currentTarget.getBoundingClientRect(), c!.id);
                  }}
                >
                  <Show when={c!.icon || c!.kind === "database"}>
                    <PageIcon id={c!.id} size={16} />
                  </Show>
                  <span class="ellipsis">{pageTitle(c!.title)}</span>
                </button>
              </Show>
            </>
          )}
        </For>
      </nav>
      <div class="topbar-right">
        <Show when={failingSaves().size > 0}>
          <span class="topbar-meta save-error" title="Änderungen konnten nicht gespeichert werden. Substrat versucht es automatisch erneut (z. B. wenn die Festplatte voll ist).">
            ⚠︎ Nicht gespeichert – neuer Versuch läuft
          </span>
        </Show>
        <Show when={pageId()}>
          {(id) => (
            <>
              <Show when={props.handle()?.settings().locked}>
                <span class="topbar-meta">
                  <IconLock /> Gesperrt
                </span>
              </Show>
              <span class="topbar-meta">Bearbeitet {formatRelative(ws.pages[id()]?.updatedAt ?? Date.now(), now())}</span>
              <button class="icon-btn" title={ws.pages[id()]?.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"} onClick={() => toggleFavorite(id())}>
                {ws.pages[id()]?.favorite ? <IconStarFilled /> : <IconStar />}
              </button>
              <button class="icon-btn" classList={{ active: ui.graphPanel() }} title="Verbindungen dieser Seite" onClick={() => ui.setGraphPanel(!ui.graphPanel())}>
                <IconGraph />
              </button>
              <button class="icon-btn" title="Stil, Export und mehr …" onClick={(e) => openPageOptions(e.currentTarget.getBoundingClientRect(), id(), props.handle())}>
                <IconMore />
              </button>
            </>
          )}
        </Show>
      </div>
    </header>
  );
}

function openPageOptions(anchor: DOMRect, id: ID, handle: PageHandle | null) {
  openPopover(
    anchor,
    (close) => {
      const s = () => handle?.settings() ?? {};
      const [stats] = createResource(() => api.getPage(id));
      const words = () => analyzeDoc(stats()?.content).text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      return (
        <div class="menu" style={{ width: "260px" }}>
          <Show when={ws.pages[id]?.kind !== "database"}>
            <MenuSection title="Stil" />
            <div class="font-picker">
              <For each={[["default", "Standard", "Ag"], ["serif", "Serif", "Ag"], ["mono", "Mono", "Ag"]] as const}>
                {([key, label, sample]) => (
                  <button class="font-option" classList={{ active: (s().font ?? "default") === key }} onClick={() => handle?.setSettings({ font: key })}>
                    <span class={`font-sample font-${key}`}>{sample}</span>
                    <span>{label}</span>
                  </button>
                )}
              </For>
            </div>
            <MenuItem label="Kleiner Text" checked={!!s().smallText} onClick={() => handle?.setSettings({ smallText: !s().smallText })} />
            <MenuItem label="Volle Breite" checked={!!s().fullWidth} onClick={() => handle?.setSettings({ fullWidth: !s().fullWidth })} />
            <MenuDivider />
          </Show>
          <MenuItem icon={<IconLock />} label="Seite sperren" checked={!!s().locked} onClick={() => handle?.setSettings({ locked: !s().locked })} />
          <MenuItem
            icon={<IconStar />}
            label={ws.pages[id]?.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
            onClick={() => {
              toggleFavorite(id);
              close();
            }}
          />
          <MenuItem
            icon={<IconDuplicate />}
            label="Duplizieren"
            onClick={async () => {
              close();
              const copy = await duplicatePage(id);
              if (copy) navigation.open(copy);
            }}
          />
          <MenuItem
            icon={<IconMove />}
            label="Verschieben nach"
            onClick={() => {
              close();
              openPagePicker(
                anchor,
                async (target) => {
                  if (target && (target === id || isDescendant(target, id))) return;
                  toast((await movePage(id, target, nextSortKey(target))) ? "Verschoben" : "Dorthin kann diese Seite nicht verschoben werden.");
                },
                { exclude: (x) => x === id || isDescendant(x, id) || !!ws.pages[x]?.databaseId, allowRoot: true },
              );
            }}
          />
          <MenuItem
            icon={<IconTrash />}
            label="Löschen"
            onClick={async () => {
              close();
              await trashPage(id);
              toast("In den Papierkorb verschoben");
            }}
          />
          <MenuDivider />
          <MenuItem
            icon={<IconClock />}
            label="Seitenverlauf"
            onClick={() => {
              close();
              openHistory(id, handle);
            }}
          />
          <MenuItem
            icon={<IconExport />}
            label={ws.pages[id]?.kind === "database" ? "Als CSV exportieren" : "Als Markdown exportieren"}
            onClick={() => {
              close();
              void exportPage(id);
            }}
          />
          <MenuDivider />
          <div class="menu-footer muted">
            <Show when={ws.pages[id]?.kind !== "database"}>
              <div>Wörter: {words()}</div>
            </Show>
            <div>Zuletzt bearbeitet: {new Date(ws.pages[id]?.updatedAt ?? 0).toLocaleString("de-DE")}</div>
            <div>Erstellt: {new Date(ws.pages[id]?.createdAt ?? 0).toLocaleString("de-DE")}</div>
          </div>
        </div>
      );
    },
    { placement: "bottom-end" },
  );
}
