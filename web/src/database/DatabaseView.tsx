import { createMemo, createSignal, For, Index, Match, onMount, Show, Switch } from "solid-js";
import type { DatabaseData, FilterCond, FilterGroup, FilterRule, ID, PropertyDef, SortRule, ViewDef, ViewType } from "../api/types";
import { navigation, setSetting, updatePage, ws } from "../state/workspace";
import { confirmDialog, MenuDivider, MenuItem, MenuSection, openPopover, type Anchor } from "../components/popovers";
import { IconBoard, IconCalendar, IconDuplicate, IconEye, IconEyeOff, IconFilter, IconGallery, IconGraph, IconList, IconMore, IconOpen, IconPlus, IconSearch, IconSort, IconTable, IconTrash } from "../components/Icons";
import { PageIcon } from "../components/PageIcon";
import { shortId } from "../lib/id";
import { addRow, getDatabase, updateView, updateViews } from "./store";
import { condGroup, FILTER_CONDS, visibleRows } from "./query";
import { propIcon } from "./properties";
import { newView, VIEW_LABELS } from "./defaults";
import { defaultCond } from "./propertyMenu";
import { BoardView, CalendarView, GalleryView, ListView, TableView } from "./views";
import { DbGraph } from "../graph/DbGraph";

export const VIEW_ICONS: Record<ViewType, typeof IconTable> = {
  table: IconTable,
  board: IconBoard,
  list: IconList,
  gallery: IconGallery,
  calendar: IconCalendar,
  graph: IconGraph,
};

/** Spalten-/Eigenschaftsreihenfolge einer Ansicht (fehlende Eigenschaften werden angehängt). */
export function orderedProps(db: DatabaseData, view: ViewDef): PropertyDef[] {
  const byId = new Map(db.schema.map((p) => [p.id, p]));
  const out: PropertyDef[] = [];
  const title = db.schema.find((p) => p.type === "title");
  if (title) out.push(title);
  for (const id of view.order) {
    const p = byId.get(id);
    if (p && p.type !== "title" && !out.includes(p)) out.push(p);
  }
  for (const p of db.schema) if (!out.includes(p)) out.push(p);
  return out;
}

export function visibleProps(db: DatabaseData, view: ViewDef): PropertyDef[] {
  return orderedProps(db, view).filter((p) => p.type === "title" || !view.hidden.includes(p.id));
}

export function DatabaseView(props: { id: ID; inline?: boolean; readOnly?: boolean }) {
  const db = () => getDatabase(props.id);
  const [search, setSearch] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const viewKey = () => `dbview:${props.id}`;
  const view = createMemo(() => {
    const d = db();
    if (!d) return undefined;
    const id = ws.settings[viewKey()];
    return d.views.find((v) => v.id === id) ?? d.views[0];
  });
  const setActiveView = (id: string) => setSetting(viewKey(), id);
  const rows = createMemo(() => {
    const d = db();
    const v = view();
    return d && v ? visibleRows(d, v, search()) : [];
  });

  const newRow = async (e?: MouseEvent) => {
    const v = view();
    const d = db();
    if (!d || !v) return;
    // Neue Einträge erfüllen die aktiven Filter, soweit eindeutig möglich (wie Notion)
    const presets: Record<string, unknown> = {};
    if (v.filter.op === "and") {
      for (const r of v.filter.rules) {
        if ("rules" in r) continue;
        const p = d.schema.find((x) => x.id === r.prop);
        if (!p) continue;
        if (p.type === "checkbox") {
          if (r.cond === "checked") presets[p.id] = true;
          continue;
        }
        if (r.value === undefined || r.value === "") continue;
        if ((p.type === "select" || p.type === "status") && r.cond === "is") presets[p.id] = r.value;
        if (p.type === "multi_select" && r.cond === "contains") presets[p.id] = [r.value];
      }
    }
    const row = await addRow(props.id, { props: presets });
    if (row && e) navigation.setPeek(row.id);
    return row;
  };

  return (
    <Show when={db() && view()} fallback={<div class="db-loading" />}>
      <div class="db-view" classList={{ inline: props.inline }}>
        <Show when={props.inline}>
          <div class="db-inline-title">
            <span class="db-title-icon">
              <PageIcon id={props.id} size={20} />
            </span>
            <input
              class="db-title-input"
              placeholder="Unbenannt"
              value={ws.pages[props.id]?.title ?? ""}
              readOnly={props.readOnly}
              onChange={(e) => void updatePage(props.id, { title: e.currentTarget.value })}
            />
            <button class="icon-btn small db-open" title="Als ganze Seite öffnen" onClick={() => navigation.open(props.id)}>
              <IconOpen />
            </button>
          </div>
        </Show>
        <div class="db-toolbar">
          <div class="db-tabs">
            <For each={db()!.views}>
              {(v) => (
                <button
                  class="db-tab"
                  classList={{ active: v.id === view()!.id }}
                  onClick={(e) => (v.id === view()!.id && !props.readOnly ? openViewMenu(e.currentTarget.getBoundingClientRect(), props.id, v.id, setActiveView) : setActiveView(v.id))}
                >
                  {(() => {
                    const I = VIEW_ICONS[v.type];
                    return <I />;
                  })()}
                  <span>{v.name}</span>
                </button>
              )}
            </For>
            <Show when={!props.readOnly}>
              <button class="icon-btn small" title="Ansicht hinzufügen" onClick={(e) => openAddView(e.currentTarget.getBoundingClientRect(), props.id, setActiveView)}>
                <IconPlus />
              </button>
            </Show>
          </div>
          <div class="db-actions">
            <button class="btn" classList={{ highlighted: view()!.filter.rules.length > 0 }} onClick={(e) => openFilterMenu(e.currentTarget.getBoundingClientRect(), props.id, view()!.id)}>
              <IconFilter />
              <Show when={!props.inline}>Filter</Show>
            </button>
            <button class="btn" classList={{ highlighted: view()!.sorts.length > 0 }} onClick={(e) => openSortMenu(e.currentTarget.getBoundingClientRect(), props.id, view()!.id)}>
              <IconSort />
              <Show when={!props.inline}>Sortieren</Show>
            </button>
            <Show
              when={searchOpen() || search()}
              fallback={
                <button class="icon-btn" title="Suchen" onClick={() => setSearchOpen(true)}>
                  <IconSearch />
                </button>
              }
            >
              <input
                class="db-search"
                placeholder="Suchen …"
                ref={(el) => setTimeout(() => el.focus())}
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
                onBlur={() => !search() && setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    setSearchOpen(false);
                  }
                }}
              />
            </Show>
            <button class="icon-btn" title="Ansicht anpassen" onClick={(e) => openViewSettings(e.currentTarget.getBoundingClientRect(), props.id, view()!.id)}>
              <IconMore />
            </button>
            <Show when={!props.readOnly}>
              <button class="btn-primary db-new" onClick={(e) => void newRow(e)}>
                Neu
              </button>
            </Show>
          </div>
        </div>
        <Show when={view()!.filter.rules.length || view()!.sorts.length}>
          <FilterChips db={db()!} view={view()!} />
        </Show>
        <div class="db-body">
          <Switch>
            <Match when={view()!.type === "table"}>
              <TableView db={db()!} view={view()!} rows={rows()} inline={!!props.inline} readOnly={!!props.readOnly} onNew={() => newRow()} />
            </Match>
            <Match when={view()!.type === "board"}>
              <BoardView db={db()!} view={view()!} rows={rows()} readOnly={!!props.readOnly} />
            </Match>
            <Match when={view()!.type === "list"}>
              <ListView db={db()!} view={view()!} rows={rows()} readOnly={!!props.readOnly} onNew={() => newRow(new MouseEvent("click"))} />
            </Match>
            <Match when={view()!.type === "gallery"}>
              <GalleryView db={db()!} view={view()!} rows={rows()} readOnly={!!props.readOnly} onNew={() => newRow(new MouseEvent("click"))} />
            </Match>
            <Match when={view()!.type === "calendar"}>
              <CalendarView db={db()!} view={view()!} rows={rows()} readOnly={!!props.readOnly} />
            </Match>
            <Match when={view()!.type === "graph"}>
              <DbGraph db={db()!} rows={rows()} height={props.inline ? 420 : 560} />
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}

// ---------- Filter-Chips ----------

function FilterChips(props: { db: DatabaseData; view: ViewDef }) {
  const name = (id: string) => props.db.schema.find((p) => p.id === id)?.name ?? "?";
  return (
    <div class="filter-chips">
      <For each={props.view.sorts}>
        {(s) => (
          <button class="chip" onClick={(e) => openSortMenu(e.currentTarget.getBoundingClientRect(), props.db.id, props.view.id)}>
            <IconSort /> {name(s.prop)} {s.dir === "asc" ? "↑" : "↓"}
          </button>
        )}
      </For>
      <Show when={props.view.sorts.length && props.view.filter.rules.length}>
        <span class="chip-sep" />
      </Show>
      <For each={props.view.filter.rules}>
        {(r) => (
          <button class="chip" onClick={(e) => openFilterMenu(e.currentTarget.getBoundingClientRect(), props.db.id, props.view.id)}>
            <IconFilter /> {"prop" in r ? `${name(r.prop)}: ${condLabel(props.db, r)}` : "Filtergruppe"}
          </button>
        )}
      </For>
    </div>
  );
}

function condLabel(db: DatabaseData, r: FilterRule): string {
  const p = db.schema.find((x) => x.id === r.prop);
  if (!p) return "";
  const c = FILTER_CONDS[condGroup(p.type)].find((x) => x.cond === r.cond);
  let v = r.value === undefined || r.value === "" ? "" : String(r.value);
  if ((p.type === "select" || p.type === "status" || p.type === "multi_select") && v) v = p.options?.find((o) => o.id === v)?.name ?? v;
  return `${c?.label ?? r.cond}${v ? " " + v : ""}`;
}

// ---------- Menüs ----------

function openAddView(anchor: Anchor, dbId: ID, setActive: (id: string) => void) {
  openPopover(anchor, (close) => (
    <div class="menu" style={{ width: "220px" }}>
      <MenuSection title="Neue Ansicht" />
      <For each={Object.keys(VIEW_LABELS) as ViewType[]}>
        {(t) => (
          <MenuItem
            icon={(() => {
              const I = VIEW_ICONS[t];
              return <I />;
            })()}
            label={VIEW_LABELS[t]}
            onClick={async () => {
              close();
              const d = getDatabase(dbId);
              if (!d) return;
              const v = newView(t, d.schema);
              await updateViews(dbId, [...d.views, v]);
              setActive(v.id);
            }}
          />
        )}
      </For>
    </div>
  ));
}

function openViewMenu(anchor: Anchor, dbId: ID, viewId: string, setActive: (id: string) => void) {
  openPopover(anchor, (close) => {
    const d = getDatabase(dbId)!;
    const v = d.views.find((x) => x.id === viewId)!;
    return (
      <div class="menu" style={{ width: "240px" }}>
        <div style={{ padding: "6px 8px" }}>
          <input
            class="text-input"
            value={v.name}
            ref={(el) => setTimeout(() => (el.focus(), el.select()))}
            onChange={(e) => e.currentTarget.value.trim() && updateView(dbId, viewId, { name: e.currentTarget.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && close()}
          />
        </div>
        <MenuItem
          icon={<IconMore />}
          label="Ansicht bearbeiten"
          onClick={(e) => {
            close();
            openViewSettings((e.currentTarget as HTMLElement).getBoundingClientRect(), dbId, viewId);
          }}
        />
        <MenuItem
          icon={<IconDuplicate />}
          label="Ansicht duplizieren"
          onClick={async () => {
            close();
            const copy = { ...JSON.parse(JSON.stringify(v)), id: shortId(), name: `${v.name} (Kopie)` };
            const i = d.views.findIndex((x) => x.id === viewId);
            const views = [...d.views];
            views.splice(i + 1, 0, copy);
            await updateViews(dbId, views);
            setActive(copy.id);
          }}
        />
        <Show when={d.views.length > 1}>
          <MenuItem
            icon={<IconTrash />}
            label="Ansicht löschen"
            danger
            onClick={async () => {
              close();
              if (!(await confirmDialog({ title: `Ansicht „${v.name}“ löschen?`, confirm: "Löschen", danger: true }))) return;
              const views = d.views.filter((x) => x.id !== viewId);
              await updateViews(dbId, views);
              setActive(views[0].id);
            }}
          />
        </Show>
      </div>
    );
  });
}

export function openViewSettings(anchor: Anchor, dbId: ID, viewId: string) {
  openPopover(anchor, () => <ViewSettings dbId={dbId} viewId={viewId} />, { placement: "bottom-end" });
}

function ViewSettings(props: { dbId: ID; viewId: string }) {
  const db = () => getDatabase(props.dbId);
  const view = () => db()?.views.find((v) => v.id === props.viewId);
  const set = (p: Partial<ViewDef>) => updateView(props.dbId, props.viewId, p);
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);
  return (
    <Show when={db() && view()}>
      <div class="menu view-settings" style={{ width: "290px" }}>
        <MenuSection title="Layout" />
        <div class="layout-grid">
          <For each={Object.keys(VIEW_LABELS) as ViewType[]}>
            {(t) => (
              <button
                class="layout-btn"
                classList={{ active: view()!.type === t }}
                onClick={() => {
                  const fresh = newView(t, db()!.schema);
                  set({
                    type: t,
                    groupBy: t === "board" ? (view()!.groupBy ?? fresh.groupBy) : view()!.groupBy,
                    dateProp: t === "calendar" ? (view()!.dateProp ?? fresh.dateProp) : view()!.dateProp,
                    cardCover: t === "gallery" && view()!.cardCover === "none" ? "cover" : view()!.cardCover,
                  });
                }}
              >
                {(() => {
                  const I = VIEW_ICONS[t];
                  return <I />;
                })()}
                <span>{VIEW_LABELS[t]}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={view()!.type === "board" || view()!.type === "table" || view()!.type === "list"}>
          <MenuSection title="Gruppieren nach" />
          <select class="menu-select" value={view()!.groupBy ?? ""} onChange={(e) => set({ groupBy: e.currentTarget.value || null })}>
            <option value="">{view()!.type === "board" ? "– wählen –" : "Keine Gruppierung"}</option>
            <For each={db()!.schema.filter((p) => ["select", "status", "multi_select", "checkbox", "text", "number", "date", "relation", "formula"].includes(p.type))}>
              {(p) => <option value={p.id}>{p.name}</option>}
            </For>
          </select>
        </Show>
        <Show when={view()!.type === "calendar"}>
          <MenuSection title="Kalender anzeigen nach" />
          <select class="menu-select" value={view()!.dateProp ?? ""} onChange={(e) => set({ dateProp: e.currentTarget.value || null })}>
            <option value="">– wählen –</option>
            <For each={db()!.schema.filter((p) => p.type === "date")}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </Show>
        <Show when={view()!.type === "gallery" || view()!.type === "board"}>
          <MenuSection title="Kartenvorschau" />
          <select class="menu-select" value={view()!.cardCover ?? "none"} onChange={(e) => set({ cardCover: e.currentTarget.value })}>
            <option value="none">Keine</option>
            <option value="cover">Seitencover</option>
            <For each={db()!.schema.filter((p) => p.type === "files")}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
          <MenuSection title="Kartengröße" />
          <select class="menu-select" value={view()!.cardSize ?? "medium"} onChange={(e) => set({ cardSize: e.currentTarget.value as any })}>
            <option value="small">Klein</option>
            <option value="medium">Mittel</option>
            <option value="large">Groß</option>
          </select>
        </Show>
        <MenuSection title="Eigenschaften" />
        <div class="menu-scroll" style={{ "max-height": "260px" }}>
          <For each={orderedProps(db()!, view()!)}>
            {(p, i) => {
              const hidden = () => p.type !== "title" && view()!.hidden.includes(p.id);
              const Icon = propIcon(p.type);
              return (
                <div
                  draggable={p.type !== "title"}
                  onDragStart={(e) => {
                    setDragIdx(i());
                    e.dataTransfer!.effectAllowed = "move";
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragIdx();
                    setDragIdx(null);
                    if (from === null || from === i()) return;
                    const ids = orderedProps(db()!, view()!).map((x) => x.id);
                    const [moved] = ids.splice(from, 1);
                    ids.splice(Math.max(1, i()), 0, moved);
                    set({ order: ids });
                  }}
                >
                  <MenuItem
                    icon={<Icon />}
                    label={p.name}
                    right={
                      <Show when={p.type !== "title"}>
                        <button
                          class="icon-btn small"
                          title={hidden() ? "Einblenden" : "Ausblenden"}
                          onClick={(e) => {
                            e.stopPropagation();
                            set({ hidden: hidden() ? view()!.hidden.filter((x) => x !== p.id) : [...view()!.hidden, p.id] });
                          }}
                        >
                          {hidden() ? <IconEyeOff /> : <IconEye />}
                        </button>
                      </Show>
                    }
                  />
                </div>
              );
            }}
          </For>
        </div>
        <MenuDivider />
        <MenuItem label="Zellen umbrechen" checked={!!view()!.wrap} onClick={() => set({ wrap: !view()!.wrap })} />
      </div>
    </Show>
  );
}

export function openFilterMenu(anchor: Anchor, dbId: ID, viewId: string) {
  openPopover(anchor, () => <FilterMenu dbId={dbId} viewId={viewId} />);
}

function FilterMenu(props: { dbId: ID; viewId: string }) {
  const db = () => getDatabase(props.dbId);
  const view = () => db()?.views.find((v) => v.id === props.viewId);
  const filter = (): FilterGroup => view()?.filter ?? { op: "and", rules: [] };
  const setFilter = (f: FilterGroup) => updateView(props.dbId, props.viewId, { filter: f });
  const setRule = (i: number, r: FilterRule | FilterGroup) => setFilter({ ...filter(), rules: filter().rules.map((x, j) => (j === i ? r : x)) });
  const removeRule = (i: number) => setFilter({ ...filter(), rules: filter().rules.filter((_, j) => j !== i) });
  const addRule = () => {
    const p = db()!.schema[0];
    setFilter({ ...filter(), rules: [...filter().rules, { prop: p.id, cond: defaultCond(p.type) }] });
  };
  return (
    <Show when={db() && view()}>
      <div class="menu filter-menu" style={{ "min-width": "460px" }}>
        {/* Index statt For: Zeilen bleiben beim Tippen erhalten (kein Fokusverlust) */}
        <Show when={filter().rules.length} fallback={<div class="menu-empty">Keine Filter angewendet</div>}>
          <Index each={filter().rules}>
            {(r, i) => (
              <Show when={"prop" in r()}>
                <FilterRow
                  db={db()!}
                  rule={r() as FilterRule}
                  index={i}
                  op={filter().op}
                  onOp={(op) => setFilter({ ...filter(), op })}
                  onChange={(nr) => setRule(i, nr)}
                  onRemove={() => removeRule(i)}
                />
              </Show>
            )}
          </Index>
        </Show>
        <MenuItem icon={<IconPlus />} label="Filterregel hinzufügen" onClick={addRule} />
        <Show when={filter().rules.length}>
          <MenuItem icon={<IconTrash />} label="Alle Filter entfernen" danger onClick={() => setFilter({ op: "and", rules: [] })} />
        </Show>
      </div>
    </Show>
  );
}

function FilterRow(props: {
  db: DatabaseData;
  rule: FilterRule;
  index: number;
  op: "and" | "or";
  onOp: (op: "and" | "or") => void;
  onChange: (r: FilterRule) => void;
  onRemove: () => void;
}) {
  const prop = () => props.db.schema.find((p) => p.id === props.rule.prop);
  const group = () => (prop() ? condGroup(prop()!.type) : "text");
  const conds = () => FILTER_CONDS[group()];
  const needsValue = () => !conds().find((c) => c.cond === props.rule.cond)?.noValue;
  return (
    <div class="filter-row">
      <span class="filter-op">
        <Show when={props.index > 0} fallback={<span>Wo</span>}>
          <Show when={props.index === 1} fallback={<span>{props.op === "and" ? "Und" : "Oder"}</span>}>
            <select value={props.op} onChange={(e) => props.onOp(e.currentTarget.value as "and" | "or")}>
              <option value="and">Und</option>
              <option value="or">Oder</option>
            </select>
          </Show>
        </Show>
      </span>
      <select
        value={props.rule.prop}
        onChange={(e) => {
          const p = props.db.schema.find((x) => x.id === e.currentTarget.value)!;
          props.onChange({ prop: p.id, cond: defaultCond(p.type) });
        }}
      >
        <For each={props.db.schema}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>
      <select value={props.rule.cond} onChange={(e) => props.onChange({ ...props.rule, cond: e.currentTarget.value as FilterCond })}>
        <For each={conds()}>{(c) => <option value={c.cond}>{c.label}</option>}</For>
      </select>
      <Show when={needsValue()} fallback={<span style={{ flex: 1 }} />}>
        <Switch fallback={<input class="text-input" value={String(props.rule.value ?? "")} placeholder="Wert" onInput={(e) => props.onChange({ ...props.rule, value: e.currentTarget.value })} />}>
          <Match when={group() === "select" || group() === "multi"}>
            <select value={String(props.rule.value ?? "")} onChange={(e) => props.onChange({ ...props.rule, value: e.currentTarget.value })}>
              <option value="">– Option –</option>
              <For each={prop()?.options ?? []}>{(o) => <option value={o.id}>{o.name}</option>}</For>
            </select>
          </Match>
          <Match when={group() === "number"}>
            <input class="text-input" type="number" value={String(props.rule.value ?? "")} onInput={(e) => props.onChange({ ...props.rule, value: e.currentTarget.value === "" ? "" : Number(e.currentTarget.value) })} />
          </Match>
          <Match when={group() === "date"}>
            <DateFilterValue value={props.rule.value} onChange={(v) => props.onChange({ ...props.rule, value: v })} />
          </Match>
        </Switch>
      </Show>
      <button class="icon-btn small" title="Entfernen" onClick={props.onRemove}>
        <IconTrash />
      </button>
    </div>
  );
}

const RELATIVE_DATES: [string, string][] = [
  ["today", "Heute"],
  ["tomorrow", "Morgen"],
  ["yesterday", "Gestern"],
  ["week_ago", "Vor einer Woche"],
  ["week_ahead", "In einer Woche"],
  ["month_ago", "Vor einem Monat"],
  ["month_ahead", "In einem Monat"],
];

function DateFilterValue(props: { value: unknown; onChange: (v: string) => void }) {
  const isRelative = () => RELATIVE_DATES.some(([k]) => k === props.value);
  const [mode, setMode] = createSignal(isRelative() || !props.value ? "relative" : "exact");
  onMount(() => {
    if (!props.value) props.onChange("today");
  });
  return (
    <span class="date-filter">
      <select
        value={mode() === "exact" ? "exact" : String(props.value ?? "today")}
        onChange={(e) => {
          if (e.currentTarget.value === "exact") setMode("exact");
          else {
            setMode("relative");
            props.onChange(e.currentTarget.value);
          }
        }}
      >
        <For each={RELATIVE_DATES}>{([k, l]) => <option value={k}>{l}</option>}</For>
        <option value="exact">Genaues Datum …</option>
      </select>
      <Show when={mode() === "exact"}>
        <input class="text-input" type="date" value={isRelative() ? "" : String(props.value ?? "")} onChange={(e) => props.onChange(e.currentTarget.value)} />
      </Show>
    </span>
  );
}

export function openSortMenu(anchor: Anchor, dbId: ID, viewId: string) {
  openPopover(anchor, () => <SortMenu dbId={dbId} viewId={viewId} />);
}

function SortMenu(props: { dbId: ID; viewId: string }) {
  const db = () => getDatabase(props.dbId);
  const view = () => db()?.views.find((v) => v.id === props.viewId);
  const sorts = (): SortRule[] => view()?.sorts ?? [];
  const set = (s: SortRule[]) => updateView(props.dbId, props.viewId, { sorts: s });
  return (
    <Show when={db() && view()}>
      <div class="menu" style={{ "min-width": "360px" }}>
        <For each={sorts()} fallback={<div class="menu-empty">Keine Sortierung – manuelle Reihenfolge</div>}>
          {(s, i) => (
            <div class="filter-row">
              <select value={s.prop} onChange={(e) => set(sorts().map((x, j) => (j === i() ? { ...x, prop: e.currentTarget.value } : x)))}>
                <For each={db()!.schema}>{(p) => <option value={p.id}>{p.name}</option>}</For>
              </select>
              <select value={s.dir} onChange={(e) => set(sorts().map((x, j) => (j === i() ? { ...x, dir: e.currentTarget.value as "asc" | "desc" } : x)))}>
                <option value="asc">Aufsteigend</option>
                <option value="desc">Absteigend</option>
              </select>
              <button class="icon-btn small" onClick={() => set(sorts().filter((_, j) => j !== i()))}>
                <IconTrash />
              </button>
            </div>
          )}
        </For>
        <MenuItem
          icon={<IconPlus />}
          label="Sortierung hinzufügen"
          onClick={() => {
            const used = new Set(sorts().map((s) => s.prop));
            const p = db()!.schema.find((x) => !used.has(x.id)) ?? db()!.schema[0];
            set([...sorts(), { prop: p.id, dir: "asc" }]);
          }}
        />
        <Show when={sorts().length}>
          <MenuItem icon={<IconTrash />} label="Sortierung entfernen" danger onClick={() => set([])} />
        </Show>
      </div>
    </Show>
  );
}

