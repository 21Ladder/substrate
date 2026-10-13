import { For, Show } from "solid-js";
import { exportWorkspace, importFromDisk } from "../lib/transfer";
import { ui, type Theme } from "../state/ui";
import { api } from "../api/client";
import { flushAll } from "../state/workspace";
import { MenuDivider, MenuItem, MenuSection, openPopover, toast } from "./popovers";
import { IconExport, IconImport, IconLink, IconLock, IconMoon, IconRestore } from "./Icons";
import { mcpStatus, setMcpStatus, setupCommand, type McpStatus } from "../lib/mcp";

const THEMES: [Theme, string][] = [
  ["system", "Systemeinstellung"],
  ["light", "Hell"],
  ["dark", "Dunkel"],
];

const SHORTCUTS: [string, string][] = [
  ["⌘P / ⌘K", "Suchen"],
  ["⌘N", "Neue Seite"],
  ["⌘⇧G", "Graph öffnen"],
  ["⌘\\", "Seitenleiste ein/aus"],
  ["⌘[ / ⌘]", "Zurück / Vor"],
  ["⌘⇧U", "Zur übergeordneten Seite"],
  ["⌘⇧L", "Dunkelmodus umschalten"],
  ["/", "Blöcke einfügen"],
  ["@ / [[", "Seite erwähnen"],
  ["⌘⌥0–9", "Block umwandeln"],
  ["⌘D", "Block duplizieren"],
  ["⌘⇧↑/↓", "Block verschieben"],
  ["⌘↵", "To-do abhaken / Toggle öffnen"],
  ["⌘⌥T", "Alle Toggles auf/zu"],
  ["Tab / ⇧Tab", "Einrücken / Ausrücken"],
  ["esc", "Block auswählen"],
];

export function openSettingsMenu(anchor: DOMRect) {
  openPopover(anchor, (close) => (
    <div class="menu" style={{ width: "300px" }}>
      <MenuSection title="Darstellung" />
      <For each={THEMES}>{([t, label]) => <MenuItem icon={<IconMoon />} label={label} checked={ui.theme() === t} onClick={() => ui.setTheme(t)} />}</For>
      <MenuDivider />
      <MenuItem
        icon={<IconImport />}
        label="Importieren (Notion, Markdown, CSV)"
        onClick={() => {
          close();
          void importFromDisk();
        }}
      />
      <MenuItem
        icon={<IconExport />}
        label="Alles als Markdown exportieren"
        onClick={() => {
          close();
          void exportWorkspace();
        }}
      />
      <MenuItem
        icon={<IconExport />}
        label="Backup jetzt erstellen"
        onClick={async () => {
          close();
          try {
            await flushAll();
            const r = await api.backupNow();
            toast(r.file ? `Backup erstellt: ${r.file}` : "Backup ist bereits aktuell");
          } catch (e) {
            toast(`Backup fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
          }
        }}
      />
      <MenuItem
        icon={<IconImport />}
        label="Backups im Finder zeigen"
        onClick={() => {
          close();
          void api.revealBackups();
        }}
      />
      <MenuDivider />
      <MenuSection title="Claude (MCP)" />
      <McpSettings />
      <MenuDivider />
      <MenuSection title="Tastenkürzel" />
      <div class="shortcut-list">
        <For each={SHORTCUTS}>
          {([k, l]) => (
            <div class="shortcut">
              <span>{l}</span>
              <span class="kbd">{k}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  ));
}

/** Zugriff für Claude Code: Schalter, Status, Port, Einrichtungsbefehl. Standardmäßig aus. */
function McpSettings() {
  const s = () => mcpStatus();
  const change = async (f: () => Promise<McpStatus>, done?: string) => {
    try {
      setMcpStatus(await f());
      if (done) toast(done);
    } catch (e) {
      toast(`Claude-Zugriff: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const statusText = () => {
    const st = s();
    if (!st || !st.enabled) return "Aus – Claude hat keinen Zugriff";
    if (st.state === "running") return `Aktiv auf 127.0.0.1:${st.port}`;
    if (st.state === "failed") return st.error ?? "Fehler";
    return "Startet …";
  };
  return (
    <>
      <MenuItem
        icon={<IconLock />}
        label="Zugriff für Claude Code"
        checked={!!s()?.enabled}
        onClick={() => void change(() => api.mcpSetEnabled(!s()?.enabled))}
      />
      <div class="mcp-status" classList={{ error: s()?.state === "failed", active: s()?.state === "running" }}>
        {statusText()}
      </div>
      <Show when={s()?.enabled && s()?.token}>
        <MenuItem
          icon={<IconLink />}
          label="Einrichtungsbefehl kopieren"
          onClick={async () => {
            const ok = await copyText(setupCommand(s()!));
            toast(ok ? "Befehl kopiert – im Terminal ausführen, dann Claude Code neu starten" : "Kopieren nicht möglich");
          }}
        />
        <label class="mcp-port">
          <span>Port</span>
          <input
            type="number"
            min="1024"
            max="65535"
            value={s()!.port}
            onChange={(e) => {
              const port = Number(e.currentTarget.value);
              if (port !== s()?.port) void change(() => api.mcpSetPort(port), "Port geändert – Einrichtungsbefehl neu kopieren");
            }}
          />
        </label>
        <MenuItem
          icon={<IconRestore />}
          label="Neuen Zugangsschlüssel erzeugen"
          onClick={() => void change(() => api.mcpRotateToken(), "Neuer Schlüssel – der alte gilt nicht mehr. Befehl neu kopieren.")}
        />
      </Show>
    </>
  );
}

/** In die Zwischenablage kopieren (Fallback, falls die Clipboard-API im App-Kontext fehlt). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
