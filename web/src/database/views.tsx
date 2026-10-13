import { createMemo, createSignal, For, Show } from "solid-js";
import type { CalcFn, DatabaseData, DatabaseRow, ID, PropertyDef, ViewDef } from "../api/types";
import { newSortKey } from "../lib/sortkey";
import { coverBackground } from "../lib/covers";
import { pageTitle, parseDateValue, toDateValue } from "../lib/util";
import { navigation, ws } from "../state/workspace";
import { confirmDialog, MenuItem, openPopover } from "../components/popovers";
import { IconChevronRight, IconDrag, IconOpen, IconPlus, IconTrash } from "../components/Icons";
import { PageIcon } from "../components/PageIcon";
import { addRow, deleteRows, setRowProps, setRowSortKey, setRowTitle, updateView } from "./store";
import { calcOptions, calculate, CALC_LABELS, groupRows, NO_VALUE, type Group } from "./query";
import { getValue, isEmpty, propIcon, READONLY_TYPES, rowTitle } from "./properties";
import { CellValue, editCell, OptionTag } from "./cells";
import { openAddProperty, openPropertyMenu } from "./propertyMenu";
import { visibleProps } from "./DatabaseView";

const ROW_MIME = "application/x-substrat-row";

/** Neuer Sortierschlüssel, um `rowId` vor/nach `targetId` in der manuellen Reihenfolge einzusortieren. */
function sortKeyNear(db: DatabaseData, rowId: ID, targetId: ID | null, after: boolean): string | null {
  const ordered = [...db.rows].filter((r) => r.id !== rowId).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1));
  if (!targetId) return newSortKey(ordered[ordered.length - 1]?.sortKey, null);
  const i = ordered.findIndex((r) => r.id === targetId);
  if (i < 0) return null;
  const lo = after ? ordered[i] : ordered[i - 1];
  const hi = after ? ordered[i + 1] : ordered[i];
  return newSortKey(lo?.sortKey, hi?.sortKey);
}

/** Wert für die Gruppen-Eigenschaft, wenn ein Eintrag in eine andere Gruppe verschoben wird. */
function groupValue(prop: PropertyDef, row: DatabaseRow, fromKey: string, toKey: string): unknown {
  if (prop.type === "checkbox") return toKey === "true";
  if (prop.type === "multi_select") {
    const cur = ((row.props[prop.id] as string[]) ?? []).filter((x) => x !== fromKey);
    return toKey === NO_VALUE ? (cur.length ? cur : null) : [...new Set([...cur, toKey])];
  }
  return toKey === NO_VALUE ? null : toKey;
}

function canSetGroup(prop: PropertyDef | undefined): boolean {
  return !!prop && ["select", "status", "multi_select", "checkbox"].includes(prop.type);
}

// ---------- Tabelle ----------

export function TableView(props: { db: DatabaseData; view: ViewDef; rows: DatabaseRow[]; inline: boolean; readOnly: boolean; onNew: () => Promise<DatabaseRow | undefined | null> }) {
  const cols = () => visibleProps(props.db, props.view);
  const [liveWidths, setLiveWidths] = createSignal<Record<string, number>>({});
  const width = (p: PropertyDef) => liveWidths()[p.id] ?? props.view.widths[p.id] ?? (p.type === "title" ? 280 : 200);
  const groupProp = () => (props.view.groupBy ? props.db.schema.find((p) => p.id === props.view.groupBy) : undefined);
  const groups = createMemo(() => groupRows(props.db, props.rows, groupProp()).filter((g) => groupProp() === undefined || g.rows.length || g.key !== NO_VALUE));
  const [limit, setLimit] = createSignal(props.inline ? 50 : 100);
  const [editing, setEditing] = createSignal<ID | null>(null);
  const [selected, setSelected] = createSignal<Set<ID>>(new Set());
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set(props.view.collapsedGroups ?? []));
  const [dragCol, setDragCol] = createSignal<string | null>(null);
  const [dropRow, setDropRow] = createSignal<{ id: ID; after: boolean } | null>(null);

  const totalWidth = () => cols().reduce((s, p) => s + width(p), 0);

  const startResize = (e: MouseEvent, p: PropertyDef) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = width(p);
    const move = (ev: MouseEvent) => setLiveWidths({ ...liveWidths(), [p.id]: Math.max(80, start + ev.clientX - startX) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const w = liveWidths()[p.id];
      if (w) updateView(props.db.id, props.view.id, { widths: { ...props.view.widths, [p.id]: Math.round(w) } });
      setLiveWidths({});
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dropColumn = (target: string) => {
    const from = dragCol();
    setDragCol(null);
    if (!from || from === target) return;
    const ids = cols().map((c) => c.id);
    const all = props.view.order.filter((id) => !ids.includes(id));
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(target);
    ids.splice(fromIdx, 1);
    // Nach rechts gezogen → hinter das Ziel, nach links → davor; Titel bleibt vorne
    ids.splice(Math.max(1, toIdx), 0, from);
    updateView(props.db.id, props.view.id, { order: [...ids, ...all] });
  };

  const newRowIn = async (g: Group | null) => {
    const gp = groupProp();
    let row: DatabaseRow | null | undefined;
    if (g && gp && canSetGroup(gp) && g.key !== NO_VALUE) {
      row = await addRow(props.db.id, { props: { [gp.id]: gp.type === "multi_select" ? [g.key] : gp.type === "checkbox" ? g.key === "true" : g.key } });
    } else row = await props.onNew();
    if (row) setEditing(row.id);
  };

  const onRowDrop = async (e: DragEvent, target: DatabaseRow, g: Group) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData(ROW_MIME);
    const pos = dropRow();
    setDropRow(null);
    if (!id || id === target.id) return;
    const row = props.db.rows.find((r) => r.id === id);
    if (!row) return;
    const gp = groupProp();
    if (gp && canSetGroup(gp)) {
      const fromGroup = groups().find((x) => x.rows.some((r) => r.id === id));
      if (fromGroup && fromGroup.key !== g.key) await setRowProps(props.db.id, id, { [gp.id]: groupValue(gp, row, fromGroup.key, g.key) });
    }
    if (!props.view.sorts.length) {
      const k = sortKeyNear(props.db, id, target.id, pos?.after ?? false);
      if (k) await setRowSortKey(props.db.id, id, k);
    }
  };

  const toggleSelect = (id: ID) => {
    const s = new Set(selected());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };

  const Row = (rp: { row: DatabaseRow; group: Group }) => (
    <div
      class="tr"
      classList={{
        selected: selected().has(rp.row.id),
        "drop-before": dropRow()?.id === rp.row.id && !dropRow()!.after,
        "drop-after": dropRow()?.id === rp.row.id && dropRow()!.after,
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes(ROW_MIME)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropRow({ id: rp.row.id, after: e.clientY > r.top + r.height / 2 });
      }}
      onDragLeave={() => setDropRow(null)}
      onDrop={(e) => void onRowDrop(e, rp.row, rp.group)}
    >
      <div class="td-gutter">
        <Show when={!props.readOnly}>
          <span
            class="row-drag"
            draggable={true}
            title="Ziehen zum Verschieben"
            onDragStart={(e) => {
              e.dataTransfer!.setData(ROW_MIME, rp.row.id);
              e.dataTransfer!.effectAllowed = "move";
              const tr = (e.currentTarget as HTMLElement).closest(".tr") as HTMLElement;
              e.dataTransfer!.setDragImage(tr, 20, 16);
            }}
          >
            <IconDrag />
          </span>
          <input type="checkbox" class="row-check" checked={selected().has(rp.row.id)} onChange={() => toggleSelect(rp.row.id)} />
        </Show>
      </div>
      <For each={cols()}>
        {(p) => (
          <div
            class="td"
            classList={{ title: p.type === "title", readonly: READONLY_TYPES.has(p.type), wrap: !!props.view.wrap }}
            style={{ width: `${width(p)}px` }}
            onClick={(e) => {
              if (props.readOnly) return;
              if (p.type === "title") setEditing(rp.row.id);
              else editCell(e.currentTarget.getBoundingClientRect(), props.db.id, rp.row, p);
            }}
          >
            <Show when={p.type === "title" && editing() === rp.row.id} fallback={<CellValue db={props.db} row={rp.row} prop={p} wrap={props.view.wrap} />}>
              <TitleInput
                dbId={props.db.id}
                row={rp.row}
                onDone={(next) => {
                  setEditing(null);
                  if (next) void newRowIn(rp.group);
                }}
              />
            </Show>
            <Show when={p.type === "title" && editing() !== rp.row.id}>
              <button
                class="open-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  navigation.setPeek(rp.row.id);
                }}
              >
                <IconOpen /> Öffnen
              </button>
            </Show>
          </div>
        )}
      </For>
      <div class="td filler" />
    </div>
  );

  return (
    <div class="table-wrap">
      <Show when={selected().size > 0}>
        <div class="selection-bar">
          <span>{selected().size} ausgewählt</span>
          <button
            class="btn"
            onClick={async () => {
              const ids = [...selected()];
              if (!(await confirmDialog({ title: `${ids.length} Einträge löschen?`, message: "Sie werden in den Papierkorb verschoben.", confirm: "Löschen", danger: true }))) return;
              await deleteRows(ids);
              setSelected(new Set<ID>());
            }}
          >
            <IconTrash /> Löschen
          </button>
          <button class="btn" onClick={() => setSelected(new Set<ID>())}>
            Auswahl aufheben
          </button>
        </div>
      </Show>
      <div class="tbl" style={{ "min-width": `${totalWidth() + 120}px` }}>
        <div class="tr th-row">
          <div class="td-gutter" />
          <For each={cols()}>
            {(p) => {
              const Icon = propIcon(p.type);
              return (
                <div
                  class="th"
                  style={{ width: `${width(p)}px` }}
                  draggable={p.type !== "title" && !props.readOnly}
                  onDragStart={(e) => {
                    setDragCol(p.id);
                    e.dataTransfer!.effectAllowed = "move";
                  }}
                  onDragOver={(e) => dragCol() && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropColumn(p.id);
                  }}
                  onClick={(e) => !props.readOnly && openPropertyMenu(e.currentTarget.getBoundingClientRect(), props.db.id, p.id, props.view.id)}
                >
                  <Icon />
                  <span class="ellipsis">{p.name}</span>
                  <span class="col-resize" onMouseDown={(e) => startResize(e, p)} onClick={(e) => e.stopPropagation()} />
                </div>
              );
            }}
          </For>
          <Show when={!props.readOnly}>
            <button class="th th-add" title="Eigenschaft hinzufügen" onClick={(e) => openAddProperty(e.currentTarget.getBoundingClientRect(), props.db.id, props.view.id)}>
              <IconPlus />
            </button>
          </Show>
          <div class="td filler" />
        </div>
        <For each={groups()}>
          {(g) => (
            <>
              <Show when={groupProp()}>
                <div class="group-head" onClick={() => {
                  const s = new Set(collapsed());
                  if (s.has(g.key)) s.delete(g.key);
                  else s.add(g.key);
                  setCollapsed(s);
                  updateView(props.db.id, props.view.id, { collapsedGroups: [...s] });
                }}>
                  <span class="group-caret" classList={{ open: !collapsed().has(g.key) }}>
                    <IconChevronRight />
                  </span>
                  <GroupLabel prop={groupProp()!} group={g} />
                  <span class="group-count">{g.rows.length}</span>
                </div>
              </Show>
              <Show when={!collapsed().has(g.key)}>
                <For each={g.rows.slice(0, limit())}>{(row) => <Row row={row} group={g} />}</For>
                <Show when={!props.readOnly}>
                  <div class="tr new-row" onClick={() => void newRowIn(groupProp() ? g : null)}>
                    <div class="td-gutter" />
                    <span class="new-row-label">
                      <IconPlus /> Neu
                    </span>
                  </div>
                </Show>
              </Show>
            </>
          )}
        </For>
        <Show when={props.rows.length > limit()}>
          <button class="load-more" onClick={() => setLimit(limit() + (props.inline ? 50 : 100))}>
            Mehr laden ({props.rows.length - limit()} weitere)
          </button>
        </Show>
        <div class="tr calc-row">
          <div class="td-gutter" />
          <For each={cols()}>
            {(p) => {
              const fn = (): CalcFn => props.view.calcs[p.id] ?? "none";
              return (
                <div
                  class="td calc"
                  style={{ width: `${width(p)}px` }}
                  onClick={(e) =>
                    openPopover(e.currentTarget.getBoundingClientRect(), (close) => (
                      <div class="menu" style={{ width: "200px" }}>
                        <For each={calcOptions(p.type)}>
                          {(c) => (
                            <MenuItem
                              label={CALC_LABELS[c]}
                              checked={fn() === c}
                              onClick={() => {
                                updateView(props.db.id, props.view.id, { calcs: { ...props.view.calcs, [p.id]: c } });
                                close();
                              }}
                            />
                          )}
                        </For>
                      </div>
                    ), { placement: "top-start" })
                  }
                >
                  <Show when={fn() !== "none"} fallback={<span class="calc-hint">Berechnen ▾</span>}>
                    <span class="calc-label">{CALC_LABELS[fn()]}</span> <span class="calc-value">{calculate(props.db, props.rows, p, fn())}</span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

function TitleInput(props: { dbId: ID; row: DatabaseRow; onDone: (createNext: boolean) => void }) {
  // Hinweis: Enter übernimmt den Titel (wie Notion), neue Zeilen entstehen über „+ Neu“.
  let done = false;
  const commit = (el: HTMLInputElement, next: boolean) => {
    if (done) return;
    done = true;
    if (el.value !== rowTitle(props.row)) void setRowTitle(props.dbId, props.row.id, el.value);
    props.onDone(next);
  };
  return (
    <input
      class="title-input"
      value={rowTitle(props.row)}
      placeholder="Unbenannt"
      ref={(el) => setTimeout(() => el.focus())}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => commit(e.currentTarget, false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!e.isComposing) commit(e.currentTarget, false);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          commit(e.currentTarget, false);
        }
      }}
    />
  );
}

function GroupLabel(props: { prop: PropertyDef; group: Group }) {
  const option = () => props.prop.options?.find((o) => o.id === props.group.key);
  return (
    <Show when={option()} fallback={<span class="group-label">{props.group.label}</span>}>
      <OptionTag option={option()} />
    </Show>
  );
}

// ---------- Karten (Board, Galerie) ----------

function cardCoverOf(view: ViewDef, row: DatabaseRow): string | null {
  const cc = view.cardCover ?? "none";
  if (cc === "none") return null;
  if (cc === "cover") return coverBackground(row.cover);
  const files = row.props[cc] as { name: string; url: string }[] | undefined;
  const img = files?.find((f) => /\.(png|jpe?g|gif|webp|svg|heic)$/i.test(f.name) || f.url.startsWith("data:image"));
  return img ? coverBackground(img.url) : null;
}

function Card(props: { db: DatabaseData; view: ViewDef; row: DatabaseRow; draggable?: boolean; hideProp?: string; cover?: boolean }) {
  const cover = () => (props.cover ? cardCoverOf(props.view, props.row) : null);
  const shown = () => visibleProps(props.db, props.view).filter((p) => p.type !== "title" && p.id !== props.hideProp && !isEmpty(props.db, props.row, p));
  return (
    <div
      class="card"
      draggable={props.draggable}
      onDragStart={(e) => {
        e.dataTransfer!.setData(ROW_MIME, props.row.id);
        e.dataTransfer!.effectAllowed = "move";
        (e.currentTarget as HTMLElement).classList.add("dragging");
      }}
      onDragEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("dragging")}
      onClick={() => navigation.setPeek(props.row.id)}
    >
      <Show when={props.cover}>
        <div class="card-cover" style={{ background: cover() ?? undefined, "background-size": "cover", "background-position": "center" }}>
          <Show when={!cover()}>
            <span class="card-cover-icon">
              <PageIcon id={props.row.id} size={32} />
            </span>
          </Show>
        </div>
      </Show>
      <div class="card-body">
        <div class="card-title">
          <Show when={ws.pages[props.row.id]?.icon}>
            <PageIcon id={props.row.id} size={16} />
          </Show>
          <span>{pageTitle(rowTitle(props.row))}</span>
        </div>
        <For each={shown()}>
          {(p) => (
            <div class="card-prop">
              <CellValue db={props.db} row={props.row} prop={p} wrap />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function BoardView(props: { db: DatabaseData; view: ViewDef; rows: DatabaseRow[]; readOnly: boolean }) {
  const groupProp = () => (props.view.groupBy ? props.db.schema.find((p) => p.id === props.view.groupBy) : undefined);
  const groups = createMemo(() => groupRows(props.db, props.rows, groupProp()).filter((g) => g.key !== NO_VALUE || g.rows.length));
  const [over, setOver] = createSignal<{ group: string; index: number } | null>(null);

  const drop = async (e: DragEvent, g: Group) => {
    e.preventDefault();
    const id = e.dataTransfer?.getData(ROW_MIME);
    const target = over();
    setOver(null);
    const gp = groupProp();
    const row = props.db.rows.find((r) => r.id === id);
    if (!id || !row || !gp) return;
    const from = groups().find((x) => x.rows.some((r) => r.id === id));
    if (from && from.key !== g.key && canSetGroup(gp)) await setRowProps(props.db.id, id, { [gp.id]: groupValue(gp, row, from.key, g.key) });
    if (!props.view.sorts.length && target) {
      const list = g.rows.filter((r) => r.id !== id);
      const before = list[target.index];
      const k = before ? sortKeyNear(props.db, id, before.id, false) : list.length ? sortKeyNear(props.db, id, list[list.length - 1].id, true) : null;
      if (k) await setRowSortKey(props.db.id, id, k);
    }
  };

  const indexAt = (e: DragEvent, col: HTMLElement) => {
    const cards = Array.from(col.querySelectorAll(".card:not(.dragging)")) as HTMLElement[];
    let i = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) i++;
    }
    return i;
  };

  return (
    <Show
      when={groupProp()}
      fallback={
        <div class="db-empty">
          Für das Board wird eine Gruppierung benötigt.{" "}
          <select class="menu-select inline" onChange={(e) => updateView(props.db.id, props.view.id, { groupBy: e.currentTarget.value || null })}>
            <option value="">Gruppieren nach …</option>
            <For each={props.db.schema.filter((p) => canSetGroup(p))}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </div>
      }
    >
      <div class="board">
        <For each={groups()}>
          {(g) => (
            <div
              class="board-col"
              classList={{ over: over()?.group === g.key }}
              onDragOver={(e) => {
                if (!e.dataTransfer?.types.includes(ROW_MIME)) return;
                e.preventDefault();
                setOver({ group: g.key, index: indexAt(e, e.currentTarget) });
              }}
              onDrop={(e) => void drop(e, g)}
            >
              <div class="board-head">
                <GroupLabel prop={groupProp()!} group={g} />
                <span class="group-count">{g.rows.length}</span>
                <Show when={!props.readOnly}>
                  <button
                    class="icon-btn small"
                    title="Neu"
                    onClick={async () => {
                      const gp = groupProp()!;
                      const row = await addRow(props.db.id, { atStart: true, props: g.key === NO_VALUE ? {} : { [gp.id]: groupValue(gp, { props: {} } as DatabaseRow, NO_VALUE, g.key) } });
                      if (row) navigation.setPeek(row.id);
                    }}
                  >
                    <IconPlus />
                  </button>
                </Show>
              </div>
              <div class="board-cards">
                <For each={g.rows}>
                  {(row, i) => (
                    <>
                      <Show when={over()?.group === g.key && over()?.index === i()}>
                        <div class="card-drop" />
                      </Show>
                      <Card db={props.db} view={props.view} row={row} draggable={!props.readOnly} hideProp={groupProp()!.id} cover={props.view.cardCover !== "none"} />
                    </>
                  )}
                </For>
                <Show when={over()?.group === g.key && over()?.index === g.rows.length}>
                  <div class="card-drop" />
                </Show>
              </div>
              <Show when={!props.readOnly}>
                <button
                  class="board-new"
                  onClick={async () => {
                    const gp = groupProp()!;
                    const row = await addRow(props.db.id, { props: g.key === NO_VALUE ? {} : { [gp.id]: groupValue(gp, { props: {} } as DatabaseRow, NO_VALUE, g.key) } });
                    if (row) navigation.setPeek(row.id);
                  }}
                >
                  <IconPlus /> Neu
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

export function GalleryView(props: { db: DatabaseData; view: ViewDef; rows: DatabaseRow[]; readOnly: boolean; onNew: () => void }) {
  const min = () => ({ small: 180, medium: 240, large: 320 })[props.view.cardSize ?? "medium"];
  return (
    <div class="gallery" style={{ "grid-template-columns": `repeat(auto-fill, minmax(${min()}px, 1fr))` }}>
      <For each={props.rows}>{(row) => <Card db={props.db} view={props.view} row={row} cover={props.view.cardCover !== "none"} />}</For>
      <Show when={!props.readOnly}>
        <button class="card gallery-new" onClick={() => props.onNew()}>
          <IconPlus /> Neu
        </button>
      </Show>
    </div>
  );
}

// ---------- Liste ----------

export function ListView(props: { db: DatabaseData; view: ViewDef; rows: DatabaseRow[]; readOnly: boolean; onNew: () => void }) {
  const props2 = () => visibleProps(props.db, props.view).filter((p) => p.type !== "title");
  return (
    <div class="list-view">
      <For each={props.rows}>
        {(row) => (
          <div class="list-row" onClick={() => navigation.setPeek(row.id)}>
            <PageIcon id={row.id} size={18} />
            <span class="list-title">{pageTitle(rowTitle(row))}</span>
            <span class="list-props">
              <For each={props2().filter((p) => !isEmpty(props.db, row, p))}>
                {(p) => (
                  <span class="list-prop">
                    <CellValue db={props.db} row={row} prop={p} />
                  </span>
                )}
              </For>
            </span>
          </div>
        )}
      </For>
      <Show when={!props.readOnly}>
        <div class="list-row new-row" onClick={() => props.onNew()}>
          <IconPlus /> Neu
        </div>
      </Show>
    </div>
  );
}

// ---------- Kalender ----------

const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export function CalendarView(props: { db: DatabaseData; view: ViewDef; rows: DatabaseRow[]; readOnly: boolean }) {
  const [month, setMonth] = createSignal((() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  })());
  const dateProp = () => props.db.schema.find((p) => p.id === props.view.dateProp && p.type === "date");
  const days = createMemo(() => {
    const m = month();
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((offset + last) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => new Date(m.getFullYear(), m.getMonth(), 1 - offset + i));
  });
  const byDay = createMemo(() => {
    const map = new Map<string, DatabaseRow[]>();
    const p = dateProp();
    if (!p) return map;
    const visibleStart = toDateValue(days()[0]);
    const visibleEnd = toDateValue(days()[days().length - 1]);
    const from = parseDateValue(visibleStart);
    for (const r of props.rows) {
      const v = getValue(props.db, r, p) as { start?: string; end?: string } | null;
      if (!v?.start) continue;
      const s = parseDateValue(v.start);
      const e = v.end ? parseDateValue(v.end) : s;
      s.setHours(0, 0, 0, 0);
      // Erst ab dem sichtbaren Bereich zählen: lange Termine (z. B. Jan–Jun) erscheinen auch in späteren Monaten
      const begin = s < from ? from : s;
      for (let d = new Date(begin), n = 0; d <= e && n < 62; d.setDate(d.getDate() + 1), n++) {
        const key = toDateValue(d);
        if (key < visibleStart || key > visibleEnd) continue;
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        list.push(r);
      }
    }
    return map;
  });
  const [over, setOver] = createSignal<string | null>(null);

  const moveTo = async (rowId: ID, day: string) => {
    const p = dateProp();
    const row = props.db.rows.find((r) => r.id === rowId);
    if (!p || !row) return;
    const v = row.props[p.id] as { start?: string; end?: string } | undefined;
    if (!v?.start) return void setRowProps(props.db.id, rowId, { [p.id]: { start: day } });
    const oldStart = parseDateValue(v.start);
    const target = parseDateValue(day);
    const shiftDays = Math.round((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() - new Date(oldStart.getFullYear(), oldStart.getMonth(), oldStart.getDate()).getTime()) / 86400000);
    const shift = (s: string) => {
      const d = parseDateValue(s);
      d.setDate(d.getDate() + shiftDays);
      return s.includes("T") ? d.toISOString() : toDateValue(d);
    };
    await setRowProps(props.db.id, rowId, { [p.id]: { start: shift(v.start), ...(v.end ? { end: shift(v.end) } : {}) } });
  };

  const today = toDateValue(new Date());
  return (
    <Show
      when={dateProp()}
      fallback={
        <div class="db-empty">
          Wähle eine Datumseigenschaft für den Kalender.{" "}
          <select class="menu-select inline" onChange={(e) => updateView(props.db.id, props.view.id, { dateProp: e.currentTarget.value || null })}>
            <option value="">Datum wählen …</option>
            <For each={props.db.schema.filter((p) => p.type === "date")}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </div>
      }
    >
      <div class="calendar">
        <div class="calendar-head">
          <span class="calendar-title">{month().toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</span>
          <span style={{ flex: 1 }} />
          <button class="icon-btn small" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
            ‹
          </button>
          <button
            class="btn"
            onClick={() => {
              const d = new Date();
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
          >
            Heute
          </button>
          <button class="icon-btn small" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
            ›
          </button>
        </div>
        <div class="calendar-grid">
          <For each={WD}>{(d) => <div class="calendar-wd">{d}</div>}</For>
          <For each={days()}>
            {(d) => {
              const key = toDateValue(d);
              return (
                <div
                  class="calendar-day"
                  classList={{ other: d.getMonth() !== month().getMonth(), over: over() === key, weekend: d.getDay() === 0 || d.getDay() === 6 }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer?.types.includes(ROW_MIME)) return;
                    e.preventDefault();
                    setOver(key);
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    const id = e.dataTransfer?.getData(ROW_MIME);
                    if (id) void moveTo(id, key);
                  }}
                >
                  <div class="calendar-daynum">
                    <Show when={!props.readOnly}>
                      <button
                        class="calendar-add"
                        title="Neu"
                        onClick={async () => {
                          const row = await addRow(props.db.id, { props: { [dateProp()!.id]: { start: key } } });
                          if (row) navigation.setPeek(row.id);
                        }}
                      >
                        <IconPlus />
                      </button>
                    </Show>
                    <span classList={{ today: key === today }}>{d.getDate() === 1 ? d.toLocaleDateString("de-DE", { day: "numeric", month: "short" }) : d.getDate()}</span>
                  </div>
                  <For each={byDay().get(key) ?? []}>
                    {(row) => (
                      <div
                        class="calendar-item"
                        draggable={!props.readOnly}
                        onDragStart={(e) => {
                          e.dataTransfer!.setData(ROW_MIME, row.id);
                          e.dataTransfer!.effectAllowed = "move";
                        }}
                        onClick={() => navigation.setPeek(row.id)}
                      >
                        <PageIcon id={row.id} size={14} />
                        <span class="ellipsis">{pageTitle(rowTitle(row))}</span>
                      </div>
                    )}
                  </For>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}

