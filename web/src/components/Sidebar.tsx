import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ID } from "../api/types";
import { newSortKey } from "../lib/sortkey";
import { pageTitle } from "../lib/util";
import {
  ancestors,
  childrenOf,
  createPage,
  isDescendant,
  jsonSetting,
  movePage,
  navigation,
  nextSortKey,
  restorePage,
  setSetting,
  toggleFavorite,
  trashPage,
  updatePage,
  ws,
} from "../state/workspace";
import { ui } from "../state/ui";
import { duplicatePage } from "../state/pageActions";
import { MenuDivider, MenuItem, openPagePicker, openPopover, toast } from "./popovers";
import { PageIcon } from "./PageIcon";
import {
  IconChevronRight,
  IconDoubleChevronLeft,
  IconDuplicate,
  IconGraph,
  IconImport,
  IconMore,
  IconMove,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStar,
  IconTrash,
  IconTurnInto,
} from "./Icons";
import { openTrash } from "./TrashPanel";
import { openSettingsMenu } from "./SettingsMenu";
import { importFromDisk } from "../lib/transfer";
import { startWindowDrag } from "./windowDrag";
import { appendPageBlock } from "../editor/actions";
import { mcpStatus } from "../lib/mcp";
import { addRow } from "../database/store";

const DRAG_MIME = "application/x-substrat-page";
const MAX_ROWS = 30;

export function Sidebar() {
  const [dropTarget, setDropTarget] = createSignal<{ id: ID; where: "before" | "after" | "inside" } | null>(null);
  const expanded = createMemo(() => new Set(jsonSetting<ID[]>("expanded", [])));
  const toggleExpanded = (id: ID, open?: boolean) => {
    const s = new Set(expanded());
    const want = open ?? !s.has(id);
    if (want) s.add(id);
    else s.delete(id);
    setSetting("expanded", JSON.stringify([...s]));
  };
  // Aktuelle Seite in der Sidebar sichtbar machen: alle Vorfahren aufklappen und hinscrollen
  createEffect(
    on(
      () => {
        const r = navigation.route();
        // Auch die Seite selbst verfolgen: beim Start steht die Route schon fest, bevor die Seiten geladen sind
        return r.kind === "page" && ws.pages[r.id] ? r.id : null;
      },
      (id) => {
        if (!id || !ws.pages[id]) return;
        const chain = ancestors(id).slice(0, -1).map((p) => p.id);
        const missing = chain.filter((x) => !expanded().has(x));
        if (missing.length) setSetting("expanded", JSON.stringify([...expanded(), ...missing]));
        requestAnimationFrame(() => document.querySelector(".sb-row.active")?.scrollIntoView({ block: "nearest" }));
      },
    ),
  );
  const favorites = createMemo(() =>
    Object.values(ws.pages)
      .filter((p) => p.favorite)
      .sort((a, b) => pageTitle(a.title).localeCompare(pageTitle(b.title), "de"))
      .map((p) => p.id),
  );
  const roots = () => childrenOf(null);

  const newPage = async (parentId: ID | null) => {
    const parent = parentId ? ws.pages[parentId] : undefined;
    if (parent?.kind === "database") {
      const row = await addRow(parent.id);
      if (row) navigation.open(row.id);
      return;
    }
    const p = await createPage({ parentId, sortKey: nextSortKey(parentId) });
    if (parentId) {
      toggleExpanded(parentId, true);
      await appendPageBlock(parentId, p.id);
    }
    navigation.open(p.id);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData(DRAG_MIME);
    const t = dropTarget();
    setDropTarget(null);
    if (!id || !t || id === t.id) return;
    if (isDescendant(t.id, id)) return toast("Eine Seite kann nicht in sich selbst verschoben werden.");
    const target = ws.pages[t.id];
    if (!target) return;
    if (t.where === "inside") {
      // Auf einer Datenbank abgelegte Seiten werden zu Einträgen (movePage setzt databaseId)
      if (!(await movePage(id, t.id, nextSortKey(t.id)))) return toast("Dorthin kann diese Seite nicht verschoben werden.");
      toggleExpanded(t.id, true);
    } else {
      const siblings = childrenOf(target.parentId).filter((x) => x !== id);
      const i = siblings.indexOf(t.id);
      const before = t.where === "before" ? siblings[i - 1] : t.id;
      const after = t.where === "before" ? t.id : siblings[i + 1];
      const key = newSortKey(before ? ws.pages[before].sortKey : null, after ? ws.pages[after].sortKey : null);
      if (!(await movePage(id, target.parentId, key))) toast("Dorthin kann diese Seite nicht verschoben werden.");
    }
  };

  const Row = (rp: { id: ID; depth: number }) => {
    const page = () => ws.pages[rp.id];
    const kids = () => childrenOf(rp.id);
    const open = () => expanded().has(rp.id);
    const active = () => {
      const r = navigation.route();
      return r.kind === "page" && r.id === rp.id;
    };
    const showKids = () => kids().slice(0, page()?.kind === "database" ? MAX_ROWS : 10000);
    return (
      <Show when={page()}>
        <div
          class="sb-row"
          classList={{
            active: active(),
            "drop-before": dropTarget()?.id === rp.id && dropTarget()!.where === "before",
            "drop-after": dropTarget()?.id === rp.id && dropTarget()!.where === "after",
            "drop-inside": dropTarget()?.id === rp.id && dropTarget()!.where === "inside",
          }}
          style={{ "padding-left": `${8 + rp.depth * 12}px` }}
          draggable={true}
          onDragStart={(e) => {
            e.dataTransfer!.setData(DRAG_MIME, rp.id);
            e.dataTransfer!.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - r.top;
            setDropTarget({ id: rp.id, where: y < r.height * 0.28 ? "before" : y > r.height * 0.72 ? "after" : "inside" });
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={onDrop}
          onClick={() => navigation.open(rp.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            openPageMenu(e.currentTarget.getBoundingClientRect(), rp.id);
          }}
        >
          <button
            class="sb-toggle"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(rp.id);
            }}
          >
            <span class="sb-icon">
              <PageIcon id={rp.id} size={18} />
            </span>
            <span class="sb-chevron" classList={{ open: open() }}>
              <IconChevronRight />
            </span>
          </button>
          <span class="sb-title ellipsis">{pageTitle(page()!.title)}</span>
          <span class="sb-actions">
            <button
              class="icon-btn small"
              title="Löschen, duplizieren und mehr …"
              onClick={(e) => {
                e.stopPropagation();
                openPageMenu(e.currentTarget.getBoundingClientRect(), rp.id);
              }}
            >
              <IconMore />
            </button>
            <button
              class="icon-btn small"
              title="Seite darin hinzufügen"
              onClick={(e) => {
                e.stopPropagation();
                void newPage(rp.id);
              }}
            >
              <IconPlus />
            </button>
          </span>
        </div>
        <Show when={open()}>
          <For each={showKids()} fallback={<div class="sb-empty" style={{ "padding-left": `${30 + rp.depth * 12}px` }}>Keine Seiten darin</div>}>
            {(id) => <Row id={id} depth={rp.depth + 1} />}
          </For>
          <Show when={kids().length > showKids().length}>
            <div class="sb-empty" style={{ "padding-left": `${30 + rp.depth * 12}px` }} onClick={() => navigation.open(rp.id)}>
              {kids().length - showKids().length} weitere …
            </div>
          </Show>
        </Show>
      </Show>
    );
  };

  return (
    <aside class="sidebar" classList={{ collapsed: !ui.sidebarOpen() }} style={{ width: `${ui.sidebarWidth()}px` }}>
      <div class="sb-top" onMouseDown={startWindowDrag}>
        <div class="sb-workspace" onClick={(e) => openSettingsMenu(e.currentTarget.getBoundingClientRect())}>
          <span class="sb-avatar">S</span>
          <span class="sb-ws-name">Substrat</span>
          <Show when={mcpStatus()?.state === "running"}>
            <span class="sb-mcp-dot" title="Claude Code hat Zugriff (MCP) – ausschalten in den Einstellungen" />
          </Show>
        </div>
        <button class="icon-btn small sb-collapse" title="Seitenleiste schließen (⌘\)" onClick={() => ui.setSidebarOpen(false)}>
          <IconDoubleChevronLeft />
        </button>
      </div>
      <div class="sb-nav">
        <button class="sb-item" onClick={() => ui.setQuickFind(true)}>
          <IconSearch /> <span>Suchen</span> <span class="kbd">⌘P</span>
        </button>
        <button class="sb-item" classList={{ active: navigation.route().kind === "graph" }} onClick={() => navigation.go({ kind: "graph" })}>
          <IconGraph /> <span>Graph</span> <span class="kbd">⌘⇧G</span>
        </button>
        <button class="sb-item" onClick={(e) => openSettingsMenu(e.currentTarget.getBoundingClientRect())}>
          <IconSettings /> <span>Einstellungen</span>
        </button>
      </div>
      <div class="sb-scroll">
        <Show when={favorites().length}>
          <div class="sb-section">Favoriten</div>
          <For each={favorites()}>{(id) => <Row id={id} depth={0} />}</For>
        </Show>
        <div class="sb-section sb-section-row">
          <span>Privat</span>
          <button class="icon-btn small" title="Seite hinzufügen" onClick={() => void newPage(null)}>
            <IconPlus />
          </button>
        </div>
        <For each={roots()} fallback={<div class="sb-empty">Noch keine Seiten</div>}>
          {(id) => <Row id={id} depth={0} />}
        </For>
        <div
          class="sb-root-drop"
          onDragOver={(e) => e.dataTransfer?.types.includes(DRAG_MIME) && e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const id = e.dataTransfer?.getData(DRAG_MIME);
            if (id) await movePage(id, null, nextSortKey(null));
          }}
        />
      </div>
      <div class="sb-bottom">
        <button class="sb-item" onClick={() => void importFromDisk()}>
          <IconImport /> <span>Importieren</span>
        </button>
        <button class="sb-item" onClick={(e) => openTrash(e.currentTarget.getBoundingClientRect())}>
          <IconTrash /> <span>Papierkorb</span>
        </button>
        <button class="sb-item sb-new" onClick={() => void newPage(null)}>
          <IconPlus /> <span>Neue Seite</span>
        </button>
      </div>
      <div class="sb-resize" onMouseDown={(e) => ui.startSidebarResize(e)} onDblClick={() => ui.setSidebarWidth(240)} />
    </aside>
  );
}

/** Kontextmenü einer Seite (Sidebar, Breadcrumb, Topbar). */
export function openPageMenu(anchor: DOMRect, id: ID) {
  openPopover(anchor, (close) => {
    const p = () => ws.pages[id];
    return (
      <div class="menu" style={{ width: "250px" }}>
        <MenuItem
          icon={<IconStar />}
          label={p()?.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
          onClick={() => {
            toggleFavorite(id);
            close();
          }}
        />
        <MenuDivider />
        <MenuItem
          icon={<IconTrash />}
          label="Löschen"
          onClick={async () => {
            close();
            await trashPage(id);
            toast("In den Papierkorb verschoben", { label: "Rückgängig", run: () => void restorePage(id) });
          }}
        />
        <MenuItem
          icon={<IconDuplicate />}
          label="Duplizieren"
          hint="⌘D"
          onClick={async () => {
            close();
            const copy = await duplicatePage(id);
            if (copy) navigation.open(copy);
          }}
        />
        <MenuItem
          icon={<IconTurnInto />}
          label="Umbenennen"
          onClick={() => {
            close();
            openRename(anchor, id);
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
                if (target === id || (target && isDescendant(target, id))) return toast("Ziel liegt innerhalb der Seite.");
                if (!(await movePage(id, target, nextSortKey(target)))) return toast("Dorthin kann diese Seite nicht verschoben werden.");
                toast(`Verschoben nach „${target ? pageTitle(ws.pages[target]?.title) : "Privat"}“`);
              },
              { exclude: (x) => x === id || isDescendant(x, id) || !!ws.pages[x]?.databaseId, allowRoot: true, placeholder: "Seite verschieben nach …" },
            );
          }}
        />
        <MenuDivider />
        <div class="menu-footer muted">Zuletzt bearbeitet: {new Date(p()?.updatedAt ?? 0).toLocaleString("de-DE")}</div>
      </div>
    );
  });
}

function openRename(anchor: DOMRect, id: ID) {
  openPopover(anchor, (close) => (
    <div class="menu" style={{ width: "300px", padding: "6px" }}>
      <input
        class="text-input"
        value={ws.pages[id]?.title ?? ""}
        ref={(el) => setTimeout(() => (el.focus(), el.select()))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void updatePage(id, { title: e.currentTarget.value });
            close();
          }
        }}
        onBlur={(e) => void updatePage(id, { title: e.currentTarget.value })}
      />
    </div>
  ));
}
