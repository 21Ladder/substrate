import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../api/client";
import type { ID } from "../api/types";
import { EMOJI_CATEGORIES, randomEmoji, searchEmoji } from "../lib/emoji";
import { pageTitle } from "../lib/util";
import { ancestors, jsonSetting, setSetting, ws } from "../state/workspace";
import { PageIcon } from "./PageIcon";

// Globale Ebene für schwebende Menüs, Dialoge und Hinweise.

export type Anchor = DOMRect | { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type Placement = "bottom-start" | "bottom-end" | "right-start" | "top-start" | "center";

interface Entry {
  id: number;
  anchor: Anchor;
  placement: Placement;
  render: (close: () => void) => JSX.Element;
  onClose?: () => void;
  modal?: boolean;
}

const [stack, setStack] = createSignal<Entry[]>([]);
let nextId = 1;

/** Fokus aus dem Popover nehmen, damit Eingabefelder ihren Wert per blur/change übernehmen. */
function commitFocus() {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.closest(".popover")) el.blur();
}

export function openPopover(
  anchor: Anchor,
  render: (close: () => void) => JSX.Element,
  opts: { placement?: Placement; onClose?: () => void; modal?: boolean } = {},
): () => void {
  const id = nextId++;
  const close = () => {
    const entry = stack().find((e) => e.id === id);
    if (!entry) return;
    commitFocus();
    setStack((s) => s.filter((e) => e.id !== id));
    entry.onClose?.();
  };
  setStack((s) => [...s, { id, anchor, render, placement: opts.placement ?? "bottom-start", onClose: opts.onClose, modal: opts.modal }]);
  return close;
}

export function closeAllPopovers() {
  commitFocus();
  const entries = stack();
  setStack([]);
  entries.forEach((e) => e.onClose?.());
}

export const hasPopover = () => stack().length > 0;

export function pointAnchor(x: number, y: number): Anchor {
  return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
}

function Positioned(props: { entry: Entry; close: () => void; z: number }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ left: -9999, top: -9999 });

  const place = () => {
    const a = props.entry.anchor;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = a.left;
    let top = a.bottom + 4;
    switch (props.entry.placement) {
      case "bottom-end":
        left = a.right - w;
        break;
      case "right-start":
        left = a.right + 4;
        top = a.top - 6;
        if (left + w > vw - 8) left = a.left - w - 4;
        break;
      case "top-start":
        top = a.top - h - 4;
        break;
      case "center":
        left = (vw - w) / 2;
        top = Math.max(60, vh * 0.18);
        break;
    }
    if (props.entry.placement !== "center" && top + h > vh - 8) {
      const above = a.top - h - 4;
      top = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, top);
    setPos({ left, top });
  };

  onMount(() => {
    place();
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  return (
    <>
      <div
        class={props.entry.modal ? "popover-overlay modal" : "popover-overlay"}
        style={{ "z-index": props.z }}
        onMouseDown={(e) => {
          e.preventDefault();
          props.close();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          props.close();
        }}
      />
      <div ref={el} class="popover" data-popover={props.entry.id} style={{ left: `${pos().left}px`, top: `${pos().top}px`, "z-index": props.z + 1 }}>
        {props.entry.render(props.close)}
      </div>
    </>
  );
}

/**
 * Tastaturbedienung für alle Menüs in Popovers: ↑/↓ wählt einen Eintrag, Enter führt ihn aus.
 * Eingabefelder mit eigener Listen-Navigation (data-own-nav), mehrzeilige Felder und Auswahllisten bleiben unberührt.
 */
function onMenuKey(e: KeyboardEvent) {
  const s = stack();
  if (!s.length || !["ArrowDown", "ArrowUp", "Enter"].includes(e.key) || e.isComposing) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest?.("[data-own-nav], textarea, select, [contenteditable]:not([contenteditable=false])")) return;
  // Zeit-, Datums- und Zahlenfelder nutzen ↑/↓ selbst (Wert ändern)
  if (target instanceof HTMLInputElement && !["text", "search", "email", "url"].includes(target.type)) return;
  const top = document.querySelector(`.popover[data-popover="${s[s.length - 1].id}"]`);
  if (!top) return;
  const visible = Array.from(top.querySelectorAll<HTMLElement>(".menu-item")).filter((el) => el.offsetParent !== null);
  // Nur innerhalb einer Ebene wählen: im offenen Untermenü dessen Einträge, sonst die des Hauptmenüs
  const level = visible.find((el) => el.classList.contains("kbd-active"))?.closest(".submenu") ?? null;
  const items = visible.filter((el) => el.closest(".submenu") === level);
  if (!items.length) return;
  const cur = items.findIndex((el) => el.classList.contains("kbd-active"));
  if (e.key === "Enter") {
    if (cur < 0) return; // ohne Tastatur-Auswahl gilt das Verhalten des Eingabefelds
    e.preventDefault();
    e.stopPropagation();
    const opensSub = !!items[cur].querySelector(".menu-arrow");
    items[cur].click();
    if (opensSub) {
      // Untermenü geöffnet: Auswahl auf dessen ersten Eintrag setzen
      setTimeout(() => {
        const first = top.querySelector<HTMLElement>(".submenu .menu-item");
        if (!first) return;
        visible.forEach((el) => el.classList.remove("kbd-active"));
        first.classList.add("kbd-active");
        first.scrollIntoView({ block: "nearest" });
      }, 0);
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const n = items.length;
  const next = cur < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (cur + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
  visible.forEach((el) => el.classList.remove("kbd-active"));
  items[next].classList.add("kbd-active");
  items[next].scrollIntoView({ block: "nearest" });
}

/** Tippen ins Suchfeld eines Menüs filtert die Liste neu – eine alte Pfeiltasten-Auswahl gilt dann nicht mehr. */
function clearMenuSelection(e: Event) {
  const pop = (e.target as HTMLElement | null)?.closest?.(".popover");
  pop?.querySelectorAll(".kbd-active").forEach((el) => el.classList.remove("kbd-active"));
}

export function PopoverLayer() {
  const onKey = (e: KeyboardEvent) => {
    const s = stack();
    if (e.key === "Escape" && s.length) {
      e.preventDefault();
      e.stopPropagation();
      const top = s[s.length - 1];
      commitFocus();
      setStack(s.slice(0, -1));
      top.onClose?.();
    }
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("input", clearMenuSelection, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("input", clearMenuSelection, true);
  });
  return (
    <Portal>
      <For each={stack()}>
        {(entry, i) => (
          <Positioned
            entry={entry}
            z={1000 + i() * 10}
            close={() => {
              commitFocus();
              setStack((s) => s.filter((e) => e.id !== entry.id));
              entry.onClose?.();
            }}
          />
        )}
      </For>
      <ToastLayer />
    </Portal>
  );
}

// ---------- Menü-Bausteine ----------

export function MenuItem(props: {
  icon?: JSX.Element;
  label: JSX.Element;
  hint?: JSX.Element;
  active?: boolean;
  danger?: boolean;
  checked?: boolean;
  onClick?: (e: MouseEvent) => void;
  onMouseEnter?: () => void;
  right?: JSX.Element;
}) {
  return (
    <div
      class="menu-item"
      classList={{ active: props.active, danger: props.danger }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => props.onClick?.(e)}
      onMouseEnter={() => props.onMouseEnter?.()}
    >
      <Show when={props.icon}>
        <span class="menu-icon">{props.icon}</span>
      </Show>
      <span class="menu-label ellipsis">{props.label}</span>
      <Show when={props.hint}>
        <span class="menu-hint">{props.hint}</span>
      </Show>
      <Show when={props.checked}>
        <span class="menu-check">✓</span>
      </Show>
      {props.right}
    </div>
  );
}

export function MenuSection(props: { title: string }) {
  return <div class="menu-section">{props.title}</div>;
}

export function MenuDivider() {
  return <div class="menu-divider" />;
}

// ---------- Emoji-Auswahl ----------

export function openEmojiPicker(anchor: Anchor, onPick: (icon: string | null) => void, allowRemove = true) {
  openPopover(anchor, (close) => <EmojiPicker onPick={(v) => (onPick(v), close())} allowRemove={allowRemove} />);
}

function EmojiPicker(props: { onPick: (icon: string | null) => void; allowRemove: boolean }) {
  const [q, setQ] = createSignal("");
  const [tab, setTab] = createSignal<"emoji" | "upload">("emoji");
  const recent = () => jsonSetting<string[]>("recentEmoji", []);
  const pick = (e: string) => {
    const r = [e, ...recent().filter((x) => x !== e)].slice(0, 24);
    setSetting("recentEmoji", JSON.stringify(r));
    props.onPick(e);
  };
  const results = createMemo(() => (q().trim() ? searchEmoji(q()) : null));
  let input!: HTMLInputElement;
  onMount(() => input?.focus());

  return (
    <div class="emoji-picker">
      <div class="emoji-tabs">
        <button classList={{ active: tab() === "emoji" }} onClick={() => setTab("emoji")}>
          Emoji
        </button>
        <button classList={{ active: tab() === "upload" }} onClick={() => setTab("upload")}>
          Hochladen
        </button>
        <span style={{ flex: 1 }} />
        <button class="btn" onClick={() => pick(randomEmoji())}>
          Zufällig
        </button>
        <Show when={props.allowRemove}>
          <button class="btn" onClick={() => props.onPick(null)}>
            Entfernen
          </button>
        </Show>
      </div>
      <Show
        when={tab() === "emoji"}
        fallback={
          <div class="emoji-upload">
            <button
              class="btn-outline"
              onClick={async () => {
                const [f] = await api.pickFiles({ kind: "image" });
                if (f) props.onPick(f.url);
              }}
            >
              Datei auswählen
            </button>
            <span class="muted">Empfohlen: quadratisch, mind. 280 × 280 px</span>
          </div>
        }
      >
        <div style={{ padding: "8px 8px 4px" }}>
          <input ref={input} class="text-input" placeholder="Filtern …" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <div class="emoji-scroll">
          <Show
            when={results()}
            fallback={
              <>
                <Show when={recent().length}>
                  <div class="emoji-cat">Zuletzt verwendet</div>
                  <div class="emoji-grid">
                    <For each={recent()}>{(e) => <button onClick={() => pick(e)}>{e}</button>}</For>
                  </div>
                </Show>
                <For each={EMOJI_CATEGORIES}>
                  {(cat) => (
                    <>
                      <div class="emoji-cat">{cat.name}</div>
                      <div class="emoji-grid">
                        <For each={cat.items}>
                          {(it) => (
                            <button title={it.k} onClick={() => pick(it.e)}>
                              {it.e}
                            </button>
                          )}
                        </For>
                      </div>
                    </>
                  )}
                </For>
              </>
            }
          >
            <div class="emoji-grid">
              <For each={results()!} fallback={<div class="muted" style={{ padding: "8px" }}>Keine Ergebnisse</div>}>
                {(it) => (
                  <button title={it.k} onClick={() => pick(it.e)}>
                    {it.e}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ---------- Seitenauswahl ----------

export function openPagePicker(
  anchor: Anchor,
  onPick: (id: ID | null) => void,
  opts: { exclude?: (id: ID) => boolean; placeholder?: string; allowRoot?: boolean; onlyDatabases?: boolean } = {},
) {
  openPopover(anchor, (close) => (
    <PagePicker
      placeholder={opts.placeholder}
      exclude={opts.exclude}
      allowRoot={opts.allowRoot}
      onlyDatabases={opts.onlyDatabases}
      onPick={(id) => {
        close();
        onPick(id);
      }}
    />
  ));
}

export function PagePicker(props: {
  onPick: (id: ID | null) => void;
  exclude?: (id: ID) => boolean;
  placeholder?: string;
  allowRoot?: boolean;
  onlyDatabases?: boolean;
}) {
  const [q, setQ] = createSignal("");
  const [active, setActive] = createSignal(0);
  const results = createMemo(() => {
    const s = q().trim().toLowerCase();
    const out: ID[] = [];
    const recent = jsonSetting<ID[]>("recent", []);
    const pool = s ? Object.keys(ws.pages) : [...recent.filter((id) => ws.pages[id]), ...Object.keys(ws.pages)];
    const seen = new Set<ID>();
    for (const id of pool) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = ws.pages[id];
      if (!p || props.exclude?.(id)) continue;
      if (props.onlyDatabases && p.kind !== "database") continue;
      if (s && !pageTitle(p.title).toLowerCase().includes(s)) continue;
      out.push(id);
      if (out.length >= 50) break;
    }
    return out;
  });
  const items = () => (props.allowRoot && !q().trim() ? [null, ...results()] : results());
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const onKey = (e: KeyboardEvent) => {
    const n = items().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + n) % Math.max(1, n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items()[active()];
      if (it !== undefined) props.onPick(it);
    }
  };
  return (
    <div class="menu" style={{ width: "320px" }}>
      <div style={{ padding: "6px 8px" }}>
        <input
          ref={input}
          data-own-nav
          class="text-input"
          placeholder={props.placeholder ?? "Seite suchen …"}
          value={q()}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div class="menu-scroll">
        <For each={items()} fallback={<div class="menu-empty">Keine Ergebnisse</div>}>
          {(id, i) => (
            <Show
              when={id}
              fallback={<MenuItem icon={<span>🏠</span>} label="Oberste Ebene (Privat)" active={active() === i()} onMouseEnter={() => setActive(i())} onClick={() => props.onPick(null)} />}
            >
              <MenuItem
                icon={<PageIcon id={id!} />}
                label={pageTitle(ws.pages[id!]?.title)}
                hint={<span class="ellipsis" style={{ "max-width": "120px", display: "inline-block" }}>{ancestors(id!).slice(0, -1).map((p) => pageTitle(p.title)).join(" / ")}</span>}
                active={active() === i()}
                onMouseEnter={() => setActive(i())}
                onClick={() => props.onPick(id)}
              />
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

// ---------- Bestätigungsdialog ----------

export function confirmDialog(opts: { title: string; message?: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const close = openPopover(
      pointAnchor(0, 0),
      (c) => (
        <div class="dialog">
          <div class="dialog-title">{opts.title}</div>
          <Show when={opts.message}>
            <div class="dialog-message">{opts.message}</div>
          </Show>
          <div class="dialog-actions">
            <button
              class={opts.danger ? "btn-primary danger" : "btn-primary"}
              ref={(el) => setTimeout(() => el.focus())}
              onClick={() => {
                finish(true);
                c();
              }}
            >
              {opts.confirm}
            </button>
            <button
              class="btn-outline"
              onClick={() => {
                finish(false);
                c();
              }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ),
      { placement: "center", modal: true, onClose: () => finish(false) },
    );
    void close;
  });
}

// ---------- Hinweise ----------

const [toasts, setToasts] = createSignal<{ id: number; text: string; action?: { label: string; run: () => void } }[]>([]);

export function toast(text: string, action?: { label: string; run: () => void }) {
  const id = nextId++;
  setToasts((t) => [...t, { id, text, action }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3000);
}

function ToastLayer() {
  return (
    <div class="toast-layer">
      <For each={toasts()}>
        {(t) => (
          <div class="toast">
            <span>{t.text}</span>
            <Show when={t.action}>
              <button
                class="toast-action"
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action!.label}
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
