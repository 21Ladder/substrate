import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { api, isNative, onPickErrors, onWriteState } from "../api/client";
import { childrenOf, createPage, flushAll, jsonSetting, loadWorkspace, navigation, nextSortKey, setSetting, ws, type Route } from "../state/workspace";
import { ui } from "../state/ui";
import { editorUI } from "../editor/ui";
import { BlockMenu, FormatToolbar, LinkEditor, SuggestMenu } from "../editor/menus";
import { GraphPage } from "../graph/GraphPage";
import { createWelcome } from "../lib/welcome";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { PageView, type PageHandle } from "./PageView";
import { openSettingsMenu } from "./SettingsMenu";
import { closeAllPopovers, hasPopover, PopoverLayer, toast } from "./popovers";
import { QuickFind } from "./QuickFind";
import { SidePeek } from "./SidePeek";
import { HistoryPanel } from "./HistoryPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { FindBar } from "./FindBar";
import { runMcpTool, setMcpStatus, type McpStatus } from "../lib/mcp";

onPickErrors((errors) => errors.forEach((e) => toast(e)));
// Fehlgeschlagene Schreibvorgänge melden (z. B. Festplatte voll). Den dauerhaften Hinweis „Nicht gespeichert“
// setzt nur der Editor, weil nur er es selbst erneut versucht; hier höchstens ein Hinweis alle 5 Sekunden.
let lastWriteToast = 0;
onWriteState((_method, ok, error) => {
  if (ok || Date.now() - lastWriteToast < 5000) return;
  lastWriteToast = Date.now();
  toast(`Änderung konnte nicht gespeichert werden${error instanceof Error && error.message ? `: ${error.message}` : ""}`);
});

export function App() {
  const [handle, setHandle] = createSignal<PageHandle | null>(null);

  onMount(async () => {
    await loadWorkspace();
    ui.restore();
    // Claude-Zugriff (MCP): Werkzeuge erst bereitstellen, wenn der Arbeitsbereich geladen ist
    (window as any).__substrat.mcp = runMcpTool;
    if (isNative) void api.mcpStatus().then(setMcpStatus, () => undefined);
    if (!Object.keys(ws.pages).length && !ws.settings.welcomed) {
      const id = await createWelcome();
      setSetting("welcomed", "1");
      navigation.replace({ kind: "page", id });
      return;
    }
    // Abgesicherter Modus nach wiederholten Abstürzen der Darstellung: nichts automatisch öffnen
    if (new URLSearchParams(location.search).get("safe") === "1") {
      toast("Abgesicherter Modus: Die zuletzt geöffnete Seite hat die Darstellung mehrfach abstürzen lassen und wurde nicht wieder geöffnet.");
      return;
    }
    const last = jsonSetting<Route | null>("lastRoute", null);
    if (last?.kind === "graph") navigation.replace(last);
    else if (last?.kind === "page" && ws.pages[last.id]) navigation.replace(last);
    else {
      const first = childrenOf(null)[0];
      if (first) navigation.replace({ kind: "page", id: first });
    }
  });

  // Brücke für die native App (Vollbild-Status, Speichern vor dem Beenden)
  (window as any).__substrat = {
    emit(event: string, value: unknown) {
      if (event === "fullscreen") ui.setFullscreen(!!value);
      if (event === "backup-error") toast(`Automatisches Backup fehlgeschlagen: ${String(value)}`);
      if (event === "mcp-status") setMcpStatus(value as McpStatus);
    },
    flush: () => flushAll(),
    // ⌘, aus dem App-Menü: Einstellungen am Arbeitsbereich-Knopf öffnen (ohne Seitenleiste oben links)
    openSettings: () => {
      closeAllPopovers();
      const anchor = document.querySelector(".sb-workspace")?.getBoundingClientRect() ?? new DOMRect(12, 8, 200, 32);
      openSettingsMenu(anchor);
    },
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const inEditor = !!(e.target as HTMLElement)?.closest?.(".ProseMirror");
    const hasSelection = inEditor && !(window.getSelection()?.isCollapsed ?? true);
    if (mod && !e.shiftKey && !e.altKey && (key === "p" || (key === "k" && !hasSelection))) {
      e.preventDefault();
      closeAllPopovers();
      ui.setQuickFind(!ui.quickFind());
    } else if (mod && !e.shiftKey && key === "n") {
      e.preventDefault();
      void createPage({ parentId: null, sortKey: nextSortKey(null) }).then((p) => navigation.open(p.id));
    } else if (mod && e.key === "\\") {
      e.preventDefault();
      ui.setSidebarOpen(!ui.sidebarOpen());
    } else if (mod && !e.shiftKey && e.key === "[") {
      e.preventDefault();
      navigation.back();
    } else if (mod && !e.shiftKey && e.key === "]") {
      e.preventDefault();
      navigation.forward();
    } else if (mod && e.shiftKey && key === "l") {
      e.preventDefault();
      ui.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    } else if (mod && e.shiftKey && key === "u") {
      e.preventDefault();
      const r = navigation.route();
      const parent = r.kind === "page" ? ws.pages[r.id]?.parentId : null;
      if (parent) navigation.open(parent);
    } else if (mod && e.shiftKey && key === "g") {
      e.preventDefault();
      navigation.go({ kind: "graph" });
    } else if (mod && !e.shiftKey && key === "f") {
      e.preventDefault();
      ui.setFindBar(true);
    } else if (e.key === "Escape" && !e.defaultPrevented && navigation.peek() && !hasPopover() && !editorUI.suggest()) {
      // Escape im Editor wählt zuerst den Block aus (preventDefault); danach schließt es die Vorschau
      navigation.setPeek(null);
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Ungespeichertes sichern, wenn das Fenster verborgen wird (Browser-Fallback)
  const onHide = () => {
    if (document.visibilityState === "hidden") void flushAll();
  };
  onMount(() => document.addEventListener("visibilitychange", onHide));
  onCleanup(() => document.removeEventListener("visibilitychange", onHide));

  const pageRoute = () => {
    const r = navigation.route();
    return r.kind === "page" && ws.pages[r.id] ? r.id : null;
  };

  return (
    <div class="app" classList={{ native: isNative, fullscreen: ui.fullscreen(), "sidebar-hidden": !ui.sidebarOpen() }}>
      <Show when={ws.loaded}>
        <Show when={ui.sidebarOpen()}>
          <Sidebar />
        </Show>
        <main class="main">
          <Topbar handle={handle} />
          <FindBar />
          <div class="main-body">
            <Switch fallback={<EmptyState />}>
              <Match when={navigation.route().kind === "graph"}>
                <GraphPage />
              </Match>
              <Match when={pageRoute()} keyed>
                {(id) => (
                  <>
                    <div class="page-scroller main-scroller" ref={(el) => restoreScroll(el, id)}>
                      <PageView id={id} onHandle={setHandle} />
                    </div>
                    <Show when={ui.graphPanel()}>
                      <ConnectionsPanel pageId={id} />
                    </Show>
                  </>
                )}
              </Match>
            </Switch>
          </div>
        </main>
        <SidePeek />
        <QuickFind />
        <HistoryPanel />
        <SuggestMenu />
        <FormatToolbar />
        <BlockMenu />
        <LinkEditor />
        <PopoverLayer />
      </Show>
    </div>
  );
}

// Scrollposition je Seite (nur für diese Sitzung, wie in Notion). Gesichert wird VOR dem Seitenwechsel –
// beim Abbauen schrumpft der Inhalt und der Browser setzt die Position auf 0.
const scrollPositions = new Map<string, number>();
navigation.onBeforeChange((current) => {
  if (current.kind !== "page") return;
  const el = document.querySelector(".main-scroller") as HTMLElement | null;
  if (el) scrollPositions.set(current.id, el.scrollTop);
});

/** Stellt die Scrollposition wieder her, sobald der Inhalt hoch genug ist (Seiten laden asynchron). */
function restoreScroll(el: HTMLElement, id: string) {
  const target = scrollPositions.get(id);
  if (!target) return;
  let tries = 0;
  const attempt = () => {
    if (!el.isConnected) {
      // Beim ersten Versuch hängt das Element evtl. noch nicht im Dokument
      if (tries++ < 60) setTimeout(attempt, 16);
      return;
    }
    if (el.scrollHeight - el.clientHeight >= target || tries > 60) {
      el.scrollTop = target;
      return;
    }
    tries++;
    setTimeout(attempt, 16);
  };
  setTimeout(attempt, 0);
}

function EmptyState() {
  return (
    <div class="empty-state">
      <div class="empty-title">Keine Seite geöffnet</div>
      <button
        class="btn-primary"
        onClick={() => void createPage({ parentId: null, sortKey: nextSortKey(null) }).then((p) => navigation.open(p.id))}
      >
        Neue Seite
      </button>
    </div>
  );
}
