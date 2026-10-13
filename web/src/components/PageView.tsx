import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { api } from "../api/client";
import type { ID, PageSettings } from "../api/types";
import { coverBackground, GRADIENTS, randomCover, SOLIDS } from "../lib/covers";
import { randomEmoji } from "../lib/emoji";
import { debounce, pageTitle } from "../lib/util";
import { TextSelection } from "prosemirror-state";
import { emit, navigation, on as onEvent, registerPending, setPageMeta, settleWrites, unregisterPending, updatePage, ws } from "../state/workspace";
import { schema } from "../editor/schema";
import { Editor, type EditorHandle } from "../editor/Editor";
import { DatabaseView } from "../database/DatabaseView";
import { RowProperties } from "../database/RowProperties";
import { openEmojiPicker, openPopover, toast } from "./popovers";
import { IconBacklink, IconEmoji, IconImage, IconLock } from "./Icons";
import { IconView, isImageIcon } from "./PageIcon";

/** Eine Seite: Titelbild, Icon, Titel, Eigenschaften (bei Datenbankeinträgen) und Inhalt. */
export function PageView(props: { id: ID; peek?: boolean; onHandle?: (h: PageHandle | null) => void }) {
  // Erst laden, wenn alle laufenden Speichervorgänge (z. B. der gerade geschlossenen Vorschau) durch sind
  const [page, { mutate, refetch }] = createResource(
    () => props.id,
    async (id) => {
      await settleWrites();
      return api.getPage(id);
    },
  );
  const [editor, setEditor] = createSignal<EditorHandle | null>(null);
  const [reloadKey, setReloadKey] = createSignal(0);

  const meta = () => ws.pages[props.id];
  const settings = (): PageSettings => page()?.settings ?? {};
  const locked = () => !!settings().locked;

  const setSettings = (patch: Partial<PageSettings>) => {
    const p = page();
    if (!p) return;
    const next = { ...p.settings, ...patch };
    mutate({ ...p, settings: next });
    void api.updatePage(props.id, { settings: next });
  };

  const setCover = (cover: string | null) => {
    const p = page();
    if (!p) return;
    mutate({ ...p, cover });
    void updatePage(props.id, { cover });
    emit("page-props", { id: props.id, cover });
  };

  const setIcon = (icon: string | null) => {
    void updatePage(props.id, { icon });
    emit("page-props", { id: props.id, icon });
  };

  onCleanup(() => props.onHandle?.(null));
  props.onHandle?.({
    setSettings,
    settings,
    reload: async () => {
      await refetch();
      setReloadKey((k) => k + 1);
    },
    flush: async () => {
      await editor()?.flush();
    },
  });

  return (
    <Show when={page()} fallback={<div class="page-loading" />}>
      {(p) => (
        <div
          class="page"
          classList={{
            "full-width": !!settings().fullWidth || p().kind === "database",
            "small-text": !!settings().smallText,
            [`font-${settings().font ?? "default"}`]: true,
            peek: !!props.peek,
            "has-cover": !!p().cover,
          }}
        >
          <Show when={p().cover}>
            <Cover cover={p().cover!} pos={settings().coverPos ?? 50} locked={locked()} onChange={setCover} onPos={(v) => setSettings({ coverPos: v })} />
          </Show>
          <div class="page-content">
            <div class="page-header" classList={{ "has-icon": !!meta()?.icon }}>
              <Show when={meta()?.icon}>
                <button class="page-icon-big" disabled={locked()} onClick={(e) => openEmojiPicker(e.currentTarget.getBoundingClientRect(), setIcon)}>
                  <IconView icon={meta()!.icon} size={isImageIcon(meta()!.icon) ? 72 : 78} />
                </button>
              </Show>
              <Show when={!locked()}>
                <div class="page-controls">
                  <Show when={!meta()?.icon}>
                    <button class="btn" onClick={() => setIcon(randomEmoji())}>
                      <IconEmoji /> Icon hinzufügen
                    </button>
                  </Show>
                  <Show when={!p().cover}>
                    <button class="btn" onClick={() => setCover(randomCover())}>
                      <IconImage /> Titelbild hinzufügen
                    </button>
                  </Show>
                </div>
              </Show>
              <Title id={props.id} readOnly={locked()} onEnter={() => editor()?.focusStart()} />
              <Show when={locked()}>
                <div class="locked-hint">
                  <IconLock /> Gesperrt
                  <button class="btn" onClick={() => setSettings({ locked: false })}>
                    Entsperren
                  </button>
                </div>
              </Show>
              <Show when={meta()?.databaseId}>
                <RowProperties dbId={meta()!.databaseId!} rowId={props.id} readOnly={locked()} />
              </Show>
              <Backlinks id={props.id} />
            </div>
            <Show
              when={p().kind !== "database"}
              fallback={<DatabaseView id={props.id} readOnly={locked()} />}
            >
              <Show when={reloadKey() + 1} keyed>
                {(_k) => (
                  <Editor
                    pageId={props.id}
                    content={p().content}
                    readOnly={locked()}
                    onReady={setEditor}
                    onFocusTitle={() => focusTitle(props.id)}
                  />
                )}
              </Show>
              <div class="page-bottom-space" onClick={() => appendEmptyBlock(editor(), locked())} />
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

/** Klick unter den Inhalt: Cursor in einen leeren Absatz am Ende setzen (wie Notion). */
function appendEmptyBlock(h: EditorHandle | null, locked: boolean) {
  if (!h || locked) return;
  const { view } = h;
  const last = view.state.doc.lastChild;
  const tr = view.state.tr;
  if (!last || !last.isTextblock || last.content.size > 0 || last.type !== schema.nodes.paragraph) {
    tr.insert(view.state.doc.content.size, schema.nodes.paragraph.create());
  }
  tr.setSelection(TextSelection.atEnd(tr.doc));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export interface PageHandle {
  setSettings: (p: Partial<PageSettings>) => void;
  settings: () => PageSettings;
  reload: () => Promise<void>;
  flush: () => Promise<void>;
}

export function focusTitle(id: ID) {
  const el = document.querySelector(`.page-title[data-page="${id}"]`) as HTMLElement | null;
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function Title(props: { id: ID; readOnly: boolean; onEnter: () => void }) {
  let el!: HTMLDivElement;
  // Zuletzt an die Datenbank gesendeter Titel (ws.pages wird schon beim Tippen aktualisiert)
  let saved = ws.pages[props.id]?.title ?? "";
  const persist = (title: string) => {
    if (title === saved) return Promise.resolve();
    saved = title;
    return updatePage(props.id, { title }).then(() => undefined);
  };
  const save = debounce((title: string) => void persist(title), 300);
  const flushTitle = () => {
    save.cancel();
    return el ? persist(el.textContent ?? "") : Promise.resolve();
  };
  registerPending(`title:${props.id}`, flushTitle);
  onCleanup(() => {
    void flushTitle();
    unregisterPending(`title:${props.id}`);
  });
  // Titel von außen (Sidebar-Umbenennung) übernehmen, solange nicht fokussiert
  createEffect(
    on(
      () => ws.pages[props.id]?.title,
      (t) => {
        if (el && document.activeElement !== el && el.textContent !== (t ?? "")) {
          el.textContent = t ?? "";
          saved = t ?? "";
        }
      },
    ),
  );
  return (
    <div
      ref={(e) => {
        el = e;
        e.textContent = ws.pages[props.id]?.title ?? "";
        // Neue, leere Seiten: direkt im Titel schreiben (auch nach Klick auf „+“ in der Sidebar oder „Neu“)
        const meta = ws.pages[props.id];
        const fresh = !!meta && Date.now() - meta.createdAt < 5000;
        // Gerade angelegte Seiten immer; ältere leere nur, wenn nichts anderes den Fokus hat.
        // preventScroll: Fokus darf die wiederhergestellte Scrollposition nicht zurücksetzen.
        if (!e.textContent && !props.readOnly) {
          setTimeout(() => {
            if (e.isConnected && (fresh || document.activeElement === document.body)) e.focus({ preventScroll: true });
          }, 30);
        }
      }}
      class="page-title"
      data-page={props.id}
      contentEditable={props.readOnly ? false : ("plaintext-only" as any)}
      spellcheck={true}
      data-placeholder="Unbenannt"
      onInput={() => {
        const t = el.textContent ?? "";
        // Sidebar sofort aktualisieren, speichern verzögert
        setPageMeta(props.id, { title: t });
        save(t);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          props.onEnter();
        } else if (e.key === "ArrowDown") {
          const sel = window.getSelection();
          if (sel && sel.focusOffset === (el.textContent?.length ?? 0)) {
            e.preventDefault();
            props.onEnter();
          }
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, text);
      }}
    />
  );
}

function Backlinks(props: { id: ID }) {
  const [open, setOpen] = createSignal(false);
  const [links, { refetch }] = createResource(() => props.id, (id) => api.backlinks(id));
  const off = [onEvent("links-changed", () => void refetch())];
  onCleanup(() => off.forEach((f) => f()));
  return (
    <Show when={links()?.length}>
      <div class="backlinks">
        <button class="btn backlinks-toggle" onClick={() => setOpen(!open())}>
          <IconBacklink /> {links()!.length} {links()!.length === 1 ? "Backlink" : "Backlinks"}
        </button>
        <Show when={open()}>
          <div class="backlinks-list">
            <For each={links()}>
              {(l) => (
                <button class="backlink hover-bg" onClick={() => navigation.open(l.id)}>
                  <IconView icon={ws.pages[l.id]?.icon ?? l.icon} kind={l.kind} size={16} />
                  <span>{pageTitle(ws.pages[l.id]?.title ?? l.title)}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function Cover(props: { cover: string; pos: number; locked: boolean; onChange: (c: string | null) => void; onPos: (v: number) => void }) {
  const [repos, setRepos] = createSignal(false);
  const [pos, setPos] = createSignal(props.pos);
  createEffect(() => setPos(props.pos));
  const bg = () => coverBackground(props.cover);
  const isImage = () => !props.cover.startsWith("gradient:") && !props.cover.startsWith("color:");
  const startDrag = (e: MouseEvent) => {
    if (!repos()) return;
    e.preventDefault();
    const startY = e.clientY;
    const start = pos();
    const move = (ev: MouseEvent) => setPos(Math.max(0, Math.min(100, start - (ev.clientY - startY) / 3)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div class="cover" classList={{ repositioning: repos() }} style={{ background: bg() ?? undefined, "background-size": "cover", "background-position": `center ${pos()}%` }} onMouseDown={startDrag}>
      <Show when={!props.locked}>
        <div class="cover-actions">
          <Show
            when={!repos()}
            fallback={
              <>
                <button
                  class="cover-btn"
                  onClick={() => {
                    props.onPos(Math.round(pos()));
                    setRepos(false);
                  }}
                >
                  Position speichern
                </button>
                <button
                  class="cover-btn"
                  onClick={() => {
                    setPos(props.pos);
                    setRepos(false);
                  }}
                >
                  Abbrechen
                </button>
              </>
            }
          >
            <button class="cover-btn" onClick={(e) => openCoverPicker(e.currentTarget.getBoundingClientRect(), props.onChange)}>
              Titelbild ändern
            </button>
            <Show when={isImage()}>
              <button class="cover-btn" onClick={() => setRepos(true)}>
                Neu positionieren
              </button>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function openCoverPicker(anchor: DOMRect, onChange: (c: string | null) => void) {
  openPopover(
    anchor,
    (close) => {
      const [tab, setTab] = createSignal<"gallery" | "upload" | "link">("gallery");
      let link!: HTMLInputElement;
      return (
        <div class="cover-picker">
          <div class="emoji-tabs">
            <button classList={{ active: tab() === "gallery" }} onClick={() => setTab("gallery")}>
              Galerie
            </button>
            <button classList={{ active: tab() === "upload" }} onClick={() => setTab("upload")}>
              Hochladen
            </button>
            <button classList={{ active: tab() === "link" }} onClick={() => setTab("link")}>
              Link
            </button>
            <span style={{ flex: 1 }} />
            <button
              class="btn"
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              Entfernen
            </button>
          </div>
          <Show when={tab() === "gallery"}>
            <div class="cover-section">Farbverläufe</div>
            <div class="cover-grid">
              <For each={GRADIENTS}>
                {(g, i) => (
                  <button
                    style={{ background: g }}
                    onClick={() => {
                      onChange(`gradient:${i()}`);
                      close();
                    }}
                  />
                )}
              </For>
            </div>
            <div class="cover-section">Farben</div>
            <div class="cover-grid">
              <For each={SOLIDS}>
                {(c) => (
                  <button
                    style={{ background: c }}
                    onClick={() => {
                      onChange(`color:${c}`);
                      close();
                    }}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={tab() === "upload"}>
            <div class="emoji-upload">
              <button
                class="btn-outline"
                onClick={async () => {
                  const [f] = await api.pickFiles({ kind: "image" });
                  if (!f) return;
                  onChange(f.url);
                  close();
                }}
              >
                Bild auswählen
              </button>
              <span class="muted">Bilder breiter als 1500 px eignen sich am besten.</span>
            </div>
          </Show>
          <Show when={tab() === "link"}>
            <div style={{ padding: "12px" }}>
              <input ref={link} class="text-input" placeholder="https://… Bildlink einfügen" />
              <button
                class="btn-primary"
                style={{ "margin-top": "8px", width: "100%" }}
                onClick={async () => {
                  const v = link.value.trim();
                  if (!/^https:\/\//.test(v)) return toast("Bitte eine https-Adresse angeben.");
                  // Einmalig herunterladen und lokal speichern – danach kein Netzwerkzugriff mehr
                  try {
                    const { url } = await api.fetchAsset(v);
                    onChange(url);
                    close();
                  } catch (e) {
                    toast(`Laden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
              >
                Herunterladen & übernehmen
              </button>
            </div>
          </Show>
        </div>
      );
    },
    { placement: "bottom-end" },
  );
}

