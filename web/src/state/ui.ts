import { createRoot, createSignal } from "solid-js";
import { setSetting, ws } from "./workspace";

// Zustand der Oberfläche (Sidebar, Dialoge, Theme).

export type Theme = "system" | "light" | "dark";

export const ui = createRoot(() => {
  const [sidebarOpen, setSidebarOpenRaw] = createSignal(true);
  const [sidebarWidth, setSidebarWidthRaw] = createSignal(240);
  const [quickFind, setQuickFind] = createSignal(false);
  const [graphPanel, setGraphPanelRaw] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [findBar, setFindBar] = createSignal(false);
  const [theme, setThemeRaw] = createSignal<Theme>("system");

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    const t = theme();
    const dark = t === "dark" || (t === "system" && media.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };
  media.addEventListener("change", applyTheme);

  return {
    sidebarOpen,
    setSidebarOpen(v: boolean) {
      setSidebarOpenRaw(v);
      setSetting("sidebarOpen", v ? "1" : "0");
    },
    sidebarWidth,
    setSidebarWidth(w: number) {
      setSidebarWidthRaw(w);
      setSetting("sidebarWidth", String(w));
    },
    startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      const startX = e.clientX;
      const start = sidebarWidth();
      document.body.classList.add("resizing");
      const move = (ev: MouseEvent) => setSidebarWidthRaw(Math.max(200, Math.min(480, start + ev.clientX - startX)));
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
        setSetting("sidebarWidth", String(sidebarWidth()));
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    quickFind,
    setQuickFind,
    graphPanel,
    setGraphPanel(v: boolean) {
      setGraphPanelRaw(v);
      setSetting("graphPanel", v ? "1" : "0");
    },
    fullscreen,
    setFullscreen,
    findBar,
    setFindBar,
    theme,
    setTheme(t: Theme) {
      setThemeRaw(t);
      setSetting("theme", t);
      applyTheme();
    },
    /** Gespeicherte Einstellungen nach dem Laden übernehmen. */
    restore() {
      const s = ws.settings;
      setSidebarOpenRaw(s.sidebarOpen !== "0");
      if (s.sidebarWidth) setSidebarWidthRaw(Math.max(200, Math.min(480, Number(s.sidebarWidth) || 240)));
      setGraphPanelRaw(s.graphPanel === "1");
      const t = s.theme as Theme;
      setThemeRaw(t === "light" || t === "dark" ? t : "system");
      applyTheme();
    },
    applyTheme,
  };
});
