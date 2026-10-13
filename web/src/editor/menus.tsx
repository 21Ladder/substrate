import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Node as PMNode, type MarkType } from "prosemirror-model";
import { TextSelection, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { api } from "../api/client";
import type { DocJSON, ID } from "../api/types";
import { addDays, COLORS, COLOR_LABELS, pageTitle, safeHref, toDateValue } from "../lib/util";
import { createPage, jsonSetting, nextSortKey, ws } from "../state/workspace";
import { saveContent } from "../state/pageSave";
import { analyzeDoc } from "./doc";
import { blockStart, deleteBlocks, duplicateBlocks, insertBlock, rangeWithChildren, selectedRange, setBlockColor, turnInto } from "./blocks";
import { schema } from "./schema";
import { editorContexts, editorUI, openEditors } from "./ui";
import { consumeSuggest, closeSuggest, setSuggestKeyHandler, suggestKey } from "./plugins/suggest";
import { MenuDivider, MenuItem, MenuSection, openPagePicker, openPopover, toast } from "../components/popovers";
import { PageIcon } from "../components/PageIcon";
import { IconDuplicate, IconMove, IconPalette, IconTrash, IconTurnInto, IconChevronRight, IconLink } from "../components/Icons";

// ---------- Blocktypen ----------

interface BlockType {
  id: string;
  label: string;
  desc: string;
  aliases: string;
  glyph: string;
  type: string;
  attrs?: Record<string, unknown>;
}

export const TEXT_TYPES: BlockType[] = [
  { id: "text", label: "Text", desc: "Einfach mit Schreiben beginnen.", aliases: "text paragraph absatz plain", glyph: "Aa", type: "paragraph" },
  { id: "h1", label: "Überschrift 1", desc: "Große Abschnittsüberschrift.", aliases: "heading h1 titel #", glyph: "H1", type: "heading", attrs: { level: 1 } },
  { id: "h2", label: "Überschrift 2", desc: "Mittlere Abschnittsüberschrift.", aliases: "heading h2 ##", glyph: "H2", type: "heading", attrs: { level: 2 } },
  { id: "h3", label: "Überschrift 3", desc: "Kleine Abschnittsüberschrift.", aliases: "heading h3 ###", glyph: "H3", type: "heading", attrs: { level: 3 } },
  { id: "h4", label: "Überschrift 4", desc: "Kleinste Überschrift.", aliases: "heading h4 ####", glyph: "H4", type: "heading", attrs: { level: 4 } },
  { id: "bullet", label: "Aufzählungsliste", desc: "Einfache Aufzählung.", aliases: "bullet list liste ul -", glyph: "•", type: "bullet" },
  { id: "numbered", label: "Nummerierte Liste", desc: "Liste mit Nummerierung.", aliases: "numbered list nummer ol 1.", glyph: "1.", type: "numbered" },
  { id: "todo", label: "To-do-Liste", desc: "Aufgaben abhaken.", aliases: "todo task checkbox aufgabe []", glyph: "☑", type: "todo", attrs: { checked: false } },
  { id: "toggle", label: "Toggle-Liste", desc: "Inhalte ein- und ausklappen.", aliases: "toggle collapse aufklappen >", glyph: "▸", type: "toggle", attrs: { open: true } },
  { id: "quote", label: "Zitat", desc: "Ein Zitat festhalten.", aliases: "quote zitat blockquote \"", glyph: "❝", type: "quote" },
  { id: "callout", label: "Callout", desc: "Text hervorheben.", aliases: "callout hinweis info box", glyph: "💡", type: "callout" },
  { id: "code", label: "Code", desc: "Code-Snippet mit Hervorhebung.", aliases: "code snippet ```", glyph: "</>", type: "code_block" },
];

interface SlashItem {
  id: string;
  label: string;
  desc?: string;
  aliases: string;
  glyph: string;
  section: string;
  run: (view: EditorView) => void | Promise<void>;
}

/** Wendet einen Textblock-Typ an: leerer Block wird umgewandelt, sonst neuer Block darunter. */
function applyTextType(view: EditorView, t: BlockType) {
  const { $from } = view.state.selection;
  if ($from.depth === 1 && $from.parent.content.size === 0) {
    turnInto(t.type, t.attrs)(view.state, view.dispatch);
  } else {
    const node = schema.nodes[t.type].create(t.attrs ?? {});
    view.dispatch(insertBlock(view.state, node, { replaceEmpty: false }));
  }
}

function slashItems(): SlashItem[] {
  const items: SlashItem[] = TEXT_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    desc: t.desc,
    aliases: t.aliases,
    glyph: t.glyph,
    section: "Grundblöcke",
    run: (v) => applyTextType(v, t),
  }));
  const atom = (type: string, attrs: Record<string, unknown> = {}) => (v: EditorView) => v.dispatch(insertBlock(v.state, schema.nodes[type].create(attrs)));
  items.push(
    { id: "page", label: "Seite", desc: "Unterseite in dieser Seite.", aliases: "page seite unterseite subpage", glyph: "📄", section: "Grundblöcke", run: (v) => editorContexts.get(v)?.createSubpage(v) },
    { id: "divider", label: "Trennlinie", desc: "Blöcke optisch trennen.", aliases: "divider trenner linie hr ---", glyph: "—", section: "Grundblöcke", run: atom("divider") },
    { id: "link-page", label: "Link zu Seite", desc: "Auf eine bestehende Seite verweisen.", aliases: "link page verweis mention", glyph: "↗", section: "Grundblöcke", run: (v) => openMentionAt(v, "[[") },
    { id: "db-table", label: "Tabelle – Inline", desc: "Datenbank als Tabelle.", aliases: "table tabelle datenbank database inline", glyph: "▦", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "table", true) },
    { id: "db-board", label: "Board – Inline", desc: "Kanban-Board.", aliases: "board kanban datenbank database", glyph: "▥", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "board", true) },
    { id: "db-list", label: "Liste – Inline", desc: "Datenbank als Liste.", aliases: "list liste datenbank database", glyph: "☰", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "list", true) },
    { id: "db-gallery", label: "Galerie – Inline", desc: "Karten mit Vorschau.", aliases: "gallery galerie karten datenbank", glyph: "▤", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "gallery", true) },
    { id: "db-calendar", label: "Kalender – Inline", desc: "Einträge im Kalender.", aliases: "calendar kalender datenbank", glyph: "📅", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "calendar", true) },
    { id: "db-full", label: "Datenbank – Ganze Seite", desc: "Datenbank als eigene Seite.", aliases: "database datenbank full page ganze seite", glyph: "🗃", section: "Datenbanken", run: (v) => editorContexts.get(v)?.createDatabase(v, "table", false) },
    { id: "image", label: "Bild", desc: "Bild hochladen.", aliases: "image bild foto picture", glyph: "🖼", section: "Medien", run: atom("image") },
    { id: "bookmark", label: "Web-Lesezeichen", desc: "Link als Karte.", aliases: "bookmark lesezeichen link url web", glyph: "🔖", section: "Medien", run: (v) => askBookmark(v) },
    { id: "file", label: "Datei", desc: "Datei, Video oder Audio hochladen.", aliases: "file datei upload video audio", glyph: "📎", section: "Medien", run: (v) => void pickFileBlock(v) },
    { id: "toc", label: "Inhaltsverzeichnis", desc: "Überblick über die Überschriften.", aliases: "toc inhaltsverzeichnis table of contents", glyph: "≡", section: "Erweitert", run: atom("toc") },
    { id: "graph", label: "Graph der Seite", desc: "Verbindungen dieser Seite anzeigen.", aliases: "graph netz verbindungen zusammenhänge links", glyph: "✳", section: "Erweitert", run: atom("graph", { depth: 1 }) },
    { id: "mention", label: "Seite erwähnen", desc: "Inline auf eine Seite verweisen.", aliases: "mention erwähnen @", glyph: "@", section: "Inline", run: (v) => openMentionAt(v, "@") },
    {
      id: "today",
      label: "Datum oder Erinnerung",
      desc: "Heutiges Datum einfügen.",
      aliases: "date datum heute today",
      glyph: "📆",
      section: "Inline",
      run: (v) => v.dispatch(v.state.tr.replaceSelectionWith(schema.nodes.date.create({ value: toDateValue(new Date()) }), false)),
    },
  );
  for (const c of COLORS) {
    if (c === "default") continue;
    items.push({
      id: `color-${c}`,
      label: COLOR_LABELS[c],
      aliases: `${c} farbe color ${COLOR_LABELS[c].toLowerCase()}`,
      glyph: "A",
      section: "Farben",
      run: (v) => void setBlockColor(c)(v.state, v.dispatch),
    });
    items.push({
      id: `bg-${c}`,
      label: `${COLOR_LABELS[c]} (Hintergrund)`,
      aliases: `${c} background hintergrund ${COLOR_LABELS[c].toLowerCase()}`,
      glyph: "A",
      section: "Farben",
      run: (v) => void setBlockColor(`${c}_bg`)(v.state, v.dispatch),
    });
  }
  return items;
}

function openMentionAt(view: EditorView, trigger: "@" | "[[") {
  const from = view.state.selection.from;
  const tr = view.state.tr.insertText(trigger, from).setMeta(suggestKey, { open: true, from, trigger });
  view.dispatch(tr);
  view.focus();
}

function askBookmark(view: EditorView) {
  const coords = view.coordsAtPos(view.state.selection.from);
  openPopover(DOMRect.fromRect({ x: coords.left, y: coords.top, width: 0, height: coords.bottom - coords.top }), (close) => (
    <UrlInput
      placeholder="Link einfügen …"
      button="Lesezeichen erstellen"
      onSubmit={(url) => {
        close();
        const href = safeHref(url);
        if (!href) return toast("Ungültiger Link");
        view.dispatch(insertBlock(view.state, schema.nodes.bookmark.create({ url: href })));
        view.focus();
      }}
    />
  ));
}

async function pickFileBlock(view: EditorView) {
  const [f] = await api.pickFiles();
  if (!f || view.isDestroyed) return;
  const kind = f.mime.startsWith("video/") ? "video" : f.mime.startsWith("audio/") ? "audio" : f.mime.startsWith("image/") ? "image" : "file";
  const node = kind === "image" ? schema.nodes.image.create({ src: f.url }) : schema.nodes.file.create({ src: f.url, name: f.name, kind });
  view.dispatch(insertBlock(view.state, node));
}

function UrlInput(props: { placeholder: string; button: string; initial?: string; onSubmit: (url: string) => void; onRemove?: () => void }) {
  const [v, setV] = createSignal(props.initial ?? "");
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  return (
    <div class="menu url-input">
      <input
        ref={input}
        class="text-input"
        placeholder={props.placeholder}
        value={v()}
        onInput={(e) => setV(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onSubmit(v());
          }
        }}
      />
      <div style={{ display: "flex", gap: "6px", "margin-top": "8px" }}>
        <button class="btn-primary" style={{ flex: 1, height: "28px" }} onClick={() => props.onSubmit(v())}>
          {props.button}
        </button>
        <Show when={props.onRemove}>
          <button class="btn-outline danger" onClick={() => props.onRemove!()}>
            Entfernen
          </button>
        </Show>
      </div>
    </div>
  );
}

// ---------- Positionierung relativ zur Auswahl ----------

function rectAt(view: EditorView, pos: number): DOMRect {
  try {
    const c = view.coordsAtPos(pos);
    return DOMRect.fromRect({ x: c.left, y: c.top, width: 0, height: c.bottom - c.top });
  } catch {
    return view.dom.getBoundingClientRect();
  }
}

function useFloating(anchor: () => DOMRect | null, placement: "below" | "above" = "below") {
  const [style, setStyle] = createSignal<JSX.CSSProperties>({ left: "-9999px", top: "-9999px" });
  let el: HTMLElement | undefined;
  const place = () => {
    const a = anchor();
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
    let top = placement === "below" ? a.bottom + 6 : a.top - h - 8;
    if (placement === "below" && top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    if (placement === "above" && top < 8) top = a.bottom + 8;
    setStyle({ left: `${left}px`, top: `${top}px` });
  };
  return {
    ref: (e: HTMLElement) => {
      el = e;
      const ro = new ResizeObserver(() => place());
      ro.observe(e);
      onCleanup(() => ro.disconnect());
      queueMicrotask(place);
    },
    style,
    place,
  };
}

// ---------- Vorschlagsmenü (/ @ [[) ----------

interface Option {
  key: string;
  section: string;
  render: (active: boolean) => JSX.Element;
  run: () => void;
}

export function SuggestMenu() {
  const st = editorUI.suggest;
  const [active, setActive] = createSignal(0);
  const allSlash = slashItems();

  const options = createMemo<Option[]>(() => {
    const s = st();
    if (!s) return [];
    const q = s.query.trim().toLowerCase();
    if (s.trigger === "/") {
      const matches = allSlash.filter((it) => !q || it.label.toLowerCase().includes(q) || it.aliases.includes(q));
      matches.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
      const list = q ? matches : matches.filter((m) => m.section !== "Farben");
      return list.map((it) => ({
        key: it.id,
        section: q ? "" : it.section,
        render: (act) => (
          <div class="slash-item" classList={{ active: act }}>
            <span class="slash-glyph">{it.glyph}</span>
            <span class="slash-text">
              <span class="slash-label">{it.label}</span>
              <Show when={it.desc}>
                <span class="slash-desc">{it.desc}</span>
              </Show>
            </span>
          </div>
        ),
        run: () => {
          const view = s.view;
          consumeSuggest(view);
          void it.run(view);
          view.focus();
        },
      }));
    }
    // Erwähnungen
    const out: Option[] = [];
    const recent = jsonSetting<ID[]>("recent", []);
    const ids = q ? Object.keys(ws.pages) : [...new Set([...recent, ...Object.keys(ws.pages)])];
    const pages: ID[] = [];
    for (const id of ids) {
      const p = ws.pages[id];
      if (!p || id === s.pageId) continue;
      if (q && !pageTitle(p.title).toLowerCase().includes(q)) continue;
      pages.push(id);
      if (pages.length >= (q ? 12 : 6)) break;
    }
    for (const id of pages) {
      out.push({
        key: id,
        section: "Seiten",
        render: (act) => <MenuItem active={act} icon={<PageIcon id={id} />} label={pageTitle(ws.pages[id]?.title)} />,
        run: () => insertMention(s.view, id),
      });
    }
    if (s.trigger === "@") {
      const today = new Date();
      const dates: [string, Date][] = [
        ["Heute", today],
        ["Morgen", addDays(today, 1)],
        ["Gestern", addDays(today, -1)],
      ];
      for (const [label, d] of dates) {
        if (q && !label.toLowerCase().includes(q) && !"datum date".includes(q)) continue;
        out.push({
          key: label,
          section: "Datum",
          render: (act) => <MenuItem active={act} icon={<span>📆</span>} label={label} hint={d.toLocaleDateString("de-DE")} />,
          run: () => {
            consumeSuggest(s.view);
            s.view.dispatch(s.view.state.tr.replaceSelectionWith(schema.nodes.date.create({ value: toDateValue(d) }), false));
            s.view.focus();
          },
        });
      }
    }
    out.push({
      key: "new",
      section: "",
      render: (act) => <MenuItem active={act} icon={<span>＋</span>} label={q ? `Neue Seite „${s.query.trim()}“` : "Neue Unterseite"} />,
      run: async () => {
        const view = s.view;
        const title = s.query.trim();
        consumeSuggest(view);
        const page = await createPage({ parentId: s.pageId, title, sortKey: nextSortKey(s.pageId) });
        view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.mention.create({ pageId: page.id }), false).insertText(" "));
        view.focus();
      },
    });
    return out;
  });

  createEffect(() => {
    options();
    setActive(0);
  });

  // Ohne Treffer nach längerer Eingabe schließen (wie Notion)
  createEffect(() => {
    const s = st();
    if (s && s.trigger === "/" && options().length === 0 && s.query.length >= 4) closeSuggest(s.view);
  });

  const handler = (e: KeyboardEvent) => {
    const n = options().length;
    if (!n) return false;
    if (e.key === "ArrowDown") setActive((a) => (a + 1) % n);
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + n) % n);
    else if (e.key === "Enter" || e.key === "Tab") options()[active()]?.run();
    else return false;
    e.preventDefault();
    return true;
  };
  createEffect(() => setSuggestKeyHandler(st() ? handler : null));

  const anchor = () => {
    editorUI.tick();
    const s = st();
    return s ? rectAt(s.view, s.from) : null;
  };
  const floating = useFloating(anchor);
  createEffect(() => {
    anchor();
    floating.place();
  });

  let list!: HTMLDivElement;
  createEffect(() => {
    const i = active();
    const el = list?.querySelectorAll("[data-opt]")[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  return (
    <Show when={st() && options().length > 0}>
      <Portal>
        <div ref={floating.ref} class="popover suggest-menu" style={floating.style()} onMouseDown={(e) => e.preventDefault()}>
          <div class="menu menu-scroll" ref={list} style={{ width: st()?.trigger === "/" ? "324px" : "300px", "max-height": "min(40vh, 380px)" }}>
            <For each={options()}>
              {(opt, i) => (
                <>
                  <Show when={opt.section && (i() === 0 || options()[i() - 1].section !== opt.section)}>
                    <MenuSection title={opt.section} />
                  </Show>
                  <div data-opt onMouseEnter={() => setActive(i())} onClick={() => opt.run()}>
                    {opt.render(active() === i())}
                  </div>
                </>
              )}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function insertMention(view: EditorView, id: ID) {
  consumeSuggest(view);
  const tr = view.state.tr.replaceSelectionWith(schema.nodes.mention.create({ pageId: id }), false);
  tr.insertText(" ");
  view.dispatch(tr);
  view.focus();
}

// ---------- Formatierungsleiste ----------

function markActive(view: EditorView, type: MarkType): boolean {
  const { from, to, empty, $from } = view.state.selection;
  if (empty) return !!type.isInSet(view.state.storedMarks || $from.marks());
  return view.state.doc.rangeHasMark(from, to, type);
}

function toggleMarkCmd(type: MarkType): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const has = state.doc.rangeHasMark(from, to, type);
    if (dispatch) dispatch(has ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create()));
    return true;
  };
}

export function setColorMark(view: EditorView, value: string | null) {
  const { from, to } = view.state.selection;
  const tr = view.state.tr.removeMark(from, to, schema.marks.color);
  if (value && value !== "default") tr.addMark(from, to, schema.marks.color.create({ value }));
  view.dispatch(tr);
}

function currentTypeLabel(view: EditorView): string {
  const node = view.state.selection.$from.parent;
  const t = TEXT_TYPES.find((t) => t.type === node.type.name && (!t.attrs?.level || t.attrs.level === node.attrs.level));
  return t?.label ?? "Text";
}

export function FormatToolbar() {
  const tb = editorUI.toolbar;
  const anchor = () => {
    editorUI.tick();
    const t = tb();
    if (!t) return null;
    const { from, to } = t.view.state.selection;
    const a = rectAt(t.view, from);
    const b = rectAt(t.view, to);
    const top = Math.min(a.top, b.top);
    return DOMRect.fromRect({ x: a.top === b.top ? a.left : t.view.dom.getBoundingClientRect().left, y: top, width: Math.abs(b.left - a.left), height: 20 });
  };
  const floating = useFloating(anchor, "above");
  createEffect(() => {
    anchor();
    floating.place();
  });
  const btn = (label: JSX.Element, title: string, run: (v: EditorView) => void, active?: (v: EditorView) => boolean) => (
    <button
      class="tb-btn"
      classList={{ active: !!(tb() && active?.(tb()!.view)) }}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const t = tb();
        if (t) run(t.view);
      }}
    >
      {label}
    </button>
  );
  return (
    <Show when={tb() && !editorUI.suggest()}>
      <Portal>
        <div ref={floating.ref} class="popover format-toolbar" style={floating.style()} onMouseDown={(e) => e.preventDefault()}>
          <button
            class="tb-btn tb-wide"
            onClick={(e) => {
              const view = tb()!.view;
              openPopover(e.currentTarget.getBoundingClientRect(), (close) => <TurnIntoMenu view={view} onDone={close} />);
            }}
          >
            {(editorUI.tick(), tb() ? currentTypeLabel(tb()!.view) : "Text")} <span class="caret">▾</span>
          </button>
          <span class="tb-sep" />
          {btn(
            <span class="tb-link"><IconLink /> Link</span>,
            "Link (⌘K)",
            (v) => {
              const { from, to } = v.state.selection;
              let href = "";
              v.state.doc.nodesBetween(from, to, (n) => {
                const m = schema.marks.link.isInSet(n.marks);
                if (m) href = m.attrs.href;
              });
              editorUI.setLinkEdit({ view: v, from, to, href });
            },
            (v) => markActive(v, schema.marks.link),
          )}
          <span class="tb-sep" />
          {btn(<b>B</b>, "Fett (⌘B)", (v) => toggleMarkCmd(schema.marks.bold)(v.state, v.dispatch), (v) => markActive(v, schema.marks.bold))}
          {btn(<i style={{ "font-family": "Georgia, serif" }}>i</i>, "Kursiv (⌘I)", (v) => toggleMarkCmd(schema.marks.italic)(v.state, v.dispatch), (v) => markActive(v, schema.marks.italic))}
          {btn(<u>U</u>, "Unterstrichen (⌘U)", (v) => toggleMarkCmd(schema.marks.underline)(v.state, v.dispatch), (v) => markActive(v, schema.marks.underline))}
          {btn(<s>S</s>, "Durchgestrichen (⌘⇧S)", (v) => toggleMarkCmd(schema.marks.strike)(v.state, v.dispatch), (v) => markActive(v, schema.marks.strike))}
          {btn(<span class="tb-code">{"</>"}</span>, "Code (⌘E)", (v) => toggleMarkCmd(schema.marks.code)(v.state, v.dispatch), (v) => markActive(v, schema.marks.code))}
          <span class="tb-sep" />
          <button
            class="tb-btn"
            title="Farbe"
            onClick={(e) => {
              const view = tb()!.view;
              openPopover(e.currentTarget.getBoundingClientRect(), (close) => (
                <ColorMenu
                  onPick={(v) => {
                    setColorMark(view, v);
                    close();
                  }}
                />
              ));
            }}
          >
            <span class="tb-color">A</span> <span class="caret">▾</span>
          </button>
        </div>
      </Portal>
    </Show>
  );
}

export function TurnIntoMenu(props: { view: EditorView; onDone: () => void }) {
  return (
    <div class="menu" style={{ width: "240px" }}>
      <MenuSection title="Umwandeln in" />
      <For each={TEXT_TYPES}>
        {(t) => (
          <MenuItem
            icon={<span class="slash-glyph small">{t.glyph}</span>}
            label={t.label}
            onClick={() => {
              turnInto(t.type, t.attrs)(props.view.state, props.view.dispatch);
              props.onDone();
              props.view.focus();
            }}
          />
        )}
      </For>
      <MenuItem
        icon={<span class="slash-glyph small">📄</span>}
        label="Seite"
        onClick={() => {
          props.onDone();
          void turnIntoPage(props.view);
        }}
      />
    </div>
  );
}

/** Findet einen zuvor gemerkten Blockbereich nach asynchronen Schritten wieder (oder null, wenn verändert). */
function findBlocks(doc: PMNode, nodes: PMNode[]): [number, number] | null {
  for (let i = 0; i + nodes.length <= doc.childCount; i++) {
    if (doc.child(i) !== nodes[0]) continue;
    for (let k = 1; k < nodes.length; k++) if (doc.child(i + k) !== nodes[k]) return null;
    return [i, i + nodes.length - 1];
  }
  return null;
}

/** Block(e) in eine neue Unterseite verschieben (Notion: "Umwandeln in Seite"). */
async function turnIntoPage(view: EditorView) {
  const ctx = editorContexts.get(view);
  if (!ctx) return;
  const { doc } = view.state;
  const [from0, to0] = selectedRange(view.state);
  const [from, to] = rangeWithChildren(doc, from0, to0);
  const first = doc.child(from);
  const title = first.textContent;
  const rest: DocJSON[] = [];
  for (let i = from + 1; i <= to; i++) {
    const n = doc.child(i).toJSON() as DocJSON;
    n.attrs = { ...n.attrs, indent: Math.max(0, Number(n.attrs?.indent ?? 0) - (first.attrs.indent as number) - 1) };
    rest.push(n);
  }
  const content: DocJSON = { type: "doc", content: rest.length ? rest : [{ type: "paragraph" }] };
  const info = analyzeDoc(content);
  const captured: PMNode[] = [];
  for (let i = from; i <= to; i++) captured.push(doc.child(i));
  const page = await createPage({ parentId: ctx.pageId, title, sortKey: nextSortKey(ctx.pageId), content, text: info.text, links: { kinds: ["mention"], items: info.mentions.map((dst) => ({ dst, kind: "mention" })) } });
  // Mitverschobene Unterseiten gehören jetzt zur neuen Seite
  await saveContent(page.id, content, null);
  if (view.isDestroyed) return;
  const range = findBlocks(view.state.doc, captured);
  if (!range) return toast("Die Blöcke wurden inzwischen geändert – bitte erneut versuchen.");
  const start = blockStart(view.state.doc, range[0]);
  const end = blockStart(view.state.doc, range[1]) + view.state.doc.child(range[1]).nodeSize;
  view.dispatch(view.state.tr.replaceWith(start, end, schema.nodes.page.create({ pageId: page.id, indent: first.attrs.indent })));
}

export function ColorMenu(props: { onPick: (value: string | null) => void }) {
  return (
    <div class="menu" style={{ width: "220px" }}>
      <MenuSection title="Textfarbe" />
      <For each={COLORS}>
        {(c) => (
          <MenuItem
            icon={<span class={`color-swatch color-${c}`}>A</span>}
            label={COLOR_LABELS[c]}
            onClick={() => props.onPick(c === "default" ? null : c)}
          />
        )}
      </For>
      <MenuSection title="Hintergrundfarbe" />
      <For each={COLORS}>
        {(c) => (
          <MenuItem
            icon={<span class={`color-swatch bg-${c}`}>A</span>}
            label={c === "default" ? "Standard-Hintergrund" : `${COLOR_LABELS[c]} (Hintergrund)`}
            onClick={() => props.onPick(c === "default" ? null : `${c}_bg`)}
          />
        )}
      </For>
    </div>
  );
}

// ---------- Link-Editor ----------

export function LinkEditor() {
  const le = editorUI.linkEdit;
  return (
    <Show when={le()} keyed>
      {(s0) => {
        const state = () => s0;
        const close = openPopover(
          rectAt(s0.view, s0.from),
          (c) => (
            <UrlInput
              placeholder="Link einfügen oder suchen …"
              button="Verlinken"
              initial={state().href}
              onSubmit={(url) => {
                const s = state();
                const href = safeHref(url);
                if (!href) return toast("Ungültiger Link");
                const tr = s.view.state.tr.removeMark(s.from, s.to, schema.marks.link).addMark(s.from, s.to, schema.marks.link.create({ href }));
                tr.setSelection(TextSelection.create(tr.doc, s.to));
                s.view.dispatch(tr);
                c();
                s.view.focus();
              }}
              onRemove={
                state().href
                  ? () => {
                      const s = state();
                      s.view.dispatch(s.view.state.tr.removeMark(s.from, s.to, schema.marks.link));
                      c();
                      s.view.focus();
                    }
                  : undefined
              }
            />
          ),
          { onClose: () => editorUI.setLinkEdit(null) },
        );
        onCleanup(() => close());
        return null;
      }}
    </Show>
  );
}

// ---------- Blockmenü (⋮⋮) ----------

export function BlockMenu() {
  const bm = editorUI.blockMenu;
  return (
    <Show when={bm()} keyed>
      {(state) => {
        const close = openPopover(
          state.rect,
          (c) => <BlockMenuContent view={state.view} pageId={state.pageId} close={c} />,
          { placement: "bottom-start", onClose: () => editorUI.setBlockMenu(null) },
        );
        onCleanup(() => close());
        return null;
      }}
    </Show>
  );
}

function BlockMenuContent(props: { view: EditorView; pageId: ID; close: () => void }) {
  const [q, setQ] = createSignal("");
  const [sub, setSub] = createSignal<"turn" | "color" | null>(null);
  let subAnchor: DOMRect | null = null;
  const run = (cmd: Command) => {
    cmd(props.view.state, props.view.dispatch);
    props.close();
    props.view.focus();
  };
  const actions = [
    { id: "delete", label: "Löschen", icon: <IconTrash />, hint: "Entf", run: () => run(deleteBlocks) },
    { id: "duplicate", label: "Duplizieren", icon: <IconDuplicate />, hint: "⌘D", run: () => run(duplicateBlocks) },
    { id: "turn", label: "Umwandeln in", icon: <IconTurnInto />, sub: "turn" as const },
    { id: "move", label: "Verschieben nach", icon: <IconMove />, run: () => moveToPage(props.view, props.pageId, props.close) },
    { id: "color", label: "Farbe", icon: <IconPalette />, sub: "color" as const },
  ];
  const filtered = () => actions.filter((a) => !q() || a.label.toLowerCase().includes(q().toLowerCase()));
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <div class="menu" style={{ width: "260px" }} onMouseLeave={() => setSub(null)}>
      <div style={{ padding: "6px 8px 4px" }}>
        <input
          ref={input}
          class="text-input"
          placeholder="Aktionen suchen …"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const a = filtered()[0];
              if (a?.run) a.run();
            }
          }}
        />
      </div>
      <For each={filtered()}>
        {(a) => (
          <div
            onMouseEnter={(e) => {
              if (a.sub) {
                subAnchor = e.currentTarget.getBoundingClientRect();
                setSub(a.sub);
              } else setSub(null);
            }}
          >
            <MenuItem
              icon={a.icon}
              label={a.label}
              hint={a.hint}
              active={sub() === a.sub && !!a.sub}
              onClick={(e) => {
                if (a.sub) {
                  // Klick oder Enter öffnet das Untermenü (Tastaturbedienung)
                  subAnchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  // Öffnen, nicht umschalten: Beim Hovern ist es schon offen, ein Klick darf es nicht schließen
                  setSub(a.sub);
                } else a.run?.();
              }}
              right={a.sub ? <span class="menu-arrow"><IconChevronRight /></span> : undefined}
            />
          </div>
        )}
      </For>
      <Show when={sub()}>
        <SubMenu anchor={subAnchor!}>
          <Show when={sub() === "turn"} fallback={<ColorMenu onPick={(v) => run(setBlockColor(v))} />}>
            <TurnIntoMenu view={props.view} onDone={props.close} />
          </Show>
        </SubMenu>
      </Show>
      <MenuDivider />
      <div class="menu-footer muted">Zuletzt bearbeitet: {new Date(ws.pages[props.pageId]?.updatedAt ?? Date.now()).toLocaleString("de-DE")}</div>
    </div>
  );
}

/** Untermenü rechts neben einem Eintrag. */
function SubMenu(props: { anchor: DOMRect; children: JSX.Element }) {
  const [pos, setPos] = createSignal({ left: props.anchor.right + 4, top: props.anchor.top - 6 });
  let el!: HTMLDivElement;
  onMount(() => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = props.anchor.right + 2;
    if (left + w > window.innerWidth - 8) left = props.anchor.left - w - 2;
    const top = Math.max(8, Math.min(props.anchor.top - 6, window.innerHeight - h - 8));
    setPos({ left, top });
  });
  return (
    <div ref={el} class="popover submenu" style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px` }}>
      {props.children}
    </div>
  );
}

function moveToPage(view: EditorView, pageId: ID, closeMenu: () => void) {
  const rect = view.dom.getBoundingClientRect();
  const [from0, to0] = selectedRange(view.state);
  closeMenu();
  openPagePicker(
    DOMRect.fromRect({ x: rect.left + 40, y: rect.top + 40, width: 0, height: 0 }),
    async (target) => {
      if (!target || target === pageId) return;
      const { doc } = view.state;
      const [from, to] = rangeWithChildren(doc, from0, to0);
      const captured: PMNode[] = [];
      for (let i = from; i <= to; i++) captured.push(doc.child(i));
      const moved: DocJSON[] = [];
      const baseIndent = doc.child(from).attrs.indent as number;
      for (let i = from; i <= to; i++) {
        const n = doc.child(i).toJSON() as DocJSON;
        n.attrs = { ...n.attrs, indent: Math.max(0, Number(n.attrs?.indent ?? 0) - baseIndent) };
        moved.push(n);
      }
      const targetView = openEditors.get(target);
      if (targetView && !targetView.isDestroyed) {
        // Zielseite ist offen: direkt in deren Editor einfügen, sonst überschreibt dessen nächstes Speichern die Blöcke
        const nodes = moved.map((j) => PMNode.fromJSON(schema, j));
        const tdoc = targetView.state.doc;
        const onlyEmpty = tdoc.childCount === 1 && tdoc.firstChild!.type === schema.nodes.paragraph && tdoc.firstChild!.content.size === 0;
        const ttr = onlyEmpty ? targetView.state.tr.replaceWith(0, tdoc.content.size, nodes) : targetView.state.tr.insert(tdoc.content.size, nodes);
        targetView.dispatch(ttr);
      } else {
        const targetPage = await api.getPage(target);
        if (!targetPage) return;
        const prevContent = targetPage.content ?? { type: "doc", content: [] };
        const existing = (prevContent.content ?? []).filter((b, _i, arr) => !(arr.length === 1 && b.type === "paragraph" && !b.content?.length));
        const content: DocJSON = { type: "doc", content: [...existing, ...moved] };
        await saveContent(target, content, analyzeDoc(prevContent));
      }
      if (view.isDestroyed) return;
      const range = findBlocks(view.state.doc, captured);
      if (!range) return toast("Die Blöcke wurden inzwischen geändert – Kopie liegt in der Zielseite.");
      const start = blockStart(view.state.doc, range[0]);
      const end = blockStart(view.state.doc, range[1]) + view.state.doc.child(range[1]).nodeSize;
      const tr = view.state.tr.delete(start, end);
      if (tr.doc.childCount === 0) tr.insert(0, schema.nodes.paragraph.create());
      view.dispatch(tr);
      toast(`Verschoben nach „${pageTitle(ws.pages[target]?.title)}“`);
    },
    { exclude: (id) => id === pageId || ws.pages[id]?.kind === "database", placeholder: "Verschieben nach …" },
  );
}
