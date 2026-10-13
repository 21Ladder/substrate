import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { api } from "../api/client";
import type { DatabaseData, DatabaseRow, ID, PropertyDef, SelectOption } from "../api/types";
import { shortId } from "../lib/id";
import { COLORS, COLOR_LABELS, formatDateValue, pageTitle, parseDateValue, parseLocaleNumber, safeHref, toDateValue } from "../lib/util";
import { navigation, ws } from "../state/workspace";
import { MenuItem, MenuSection, openPopover, type Anchor } from "../components/popovers";
import { PageIcon } from "../components/PageIcon";
import { IconClose, IconDrag, IconTrash } from "../components/Icons";
import { dbs, getDatabase, loadDatabase, setRowProps, updateSchema } from "./store";
import { displayText, formatNumber, getValue, READONLY_TYPES, rowTitle } from "./properties";

// ---------- Anzeige ----------

export function OptionTag(props: { option: SelectOption | undefined; onRemove?: () => void }) {
  return (
    <Show when={props.option}>
      <span class={`tag tag-${props.option!.color}`}>
        <Show when={props.option!.group}>
          <span class={`status-dot status-${props.option!.group}`} />
        </Show>
        <span class="ellipsis">{props.option!.name}</span>
        <Show when={props.onRemove}>
          <button
            class="tag-remove"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              props.onRemove!();
            }}
          >
            <IconClose />
          </button>
        </Show>
      </span>
    </Show>
  );
}

function NumberBar(props: { value: number; format: "bar" | "ring" }) {
  const pct = () => Math.max(0, Math.min(100, props.value <= 1 && props.value >= 0 && !Number.isInteger(props.value) ? props.value * 100 : props.value));
  return (
    <span class="num-visual">
      <Show
        when={props.format === "bar"}
        fallback={
          <svg viewBox="0 0 20 20" width="16" height="16">
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border-strong)" stroke-width="3" />
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray={`${(pct() / 100) * 50.3} 50.3`} transform="rotate(-90 10 10)" />
          </svg>
        }
      >
        <span class="num-bar">
          <span style={{ width: `${pct()}%` }} />
        </span>
      </Show>
      <span>{Math.round(pct())}%</span>
    </span>
  );
}

/** Darstellung eines Eigenschaftswerts (Tabellenzelle, Karte, Eigenschaftsliste). */
export function CellValue(props: { db: DatabaseData; row: DatabaseRow; prop: PropertyDef; wrap?: boolean }) {
  const v = () => getValue(props.db, props.row, props.prop);
  const opt = (id: unknown) => props.prop.options?.find((o) => o.id === id);
  return (
    <Switch fallback={<span class={props.wrap ? "cell-text wrap" : "cell-text"}>{displayText(props.db, props.row, props.prop)}</span>}>
      <Match when={props.prop.type === "title"}>
        <span class="cell-title">
          <Show when={ws.pages[props.row.id]?.icon}>
            <PageIcon id={props.row.id} size={16} />
          </Show>
          <span class={props.wrap ? "cell-text wrap" : "cell-text"}>{rowTitle(props.row)}</span>
        </span>
      </Match>
      <Match when={props.prop.type === "select" || props.prop.type === "status"}>
        <span class="cell-tags">
          <OptionTag option={opt(v())} />
        </span>
      </Match>
      <Match when={props.prop.type === "multi_select"}>
        <span class="cell-tags" classList={{ wrap: props.wrap }}>
          <For each={(Array.isArray(v()) ? (v() as string[]) : []).map(opt).filter(Boolean)}>{(o) => <OptionTag option={o} />}</For>
        </span>
      </Match>
      <Match when={props.prop.type === "checkbox"}>
        <span class="checkbox" classList={{ checked: !!v() }}>
          <Show when={v()}>
            <svg viewBox="0 0 14 14">
              <path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z" fill="currentColor" />
            </svg>
          </Show>
        </span>
      </Match>
      <Match when={props.prop.type === "number" && typeof v() === "number" && (props.prop.format === "bar" || props.prop.format === "ring")}>
        <NumberBar value={v() as number} format={props.prop.format as "bar" | "ring"} />
      </Match>
      <Match when={props.prop.type === "number"}>
        <span class="cell-text num">{displayText(props.db, props.row, props.prop)}</span>
      </Match>
      <Match when={props.prop.type === "relation"}>
        <span class="cell-tags" classList={{ wrap: props.wrap }}>
          <For each={Array.isArray(v()) ? (v() as ID[]) : []}>
            {(id) => (
              <span
                class="relation-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  navigation.setPeek(id);
                }}
              >
                <PageIcon id={id} size={14} />
                <span class="ellipsis">{pageTitle(ws.pages[id]?.title)}</span>
              </span>
            )}
          </For>
        </span>
      </Match>
      <Match when={props.prop.type === "url" || props.prop.type === "email" || props.prop.type === "phone"}>
        <span
          class="cell-text cell-link"
          onClick={(e) => {
            const s = String(v() ?? "");
            const href = props.prop.type === "email" ? `mailto:${s}` : props.prop.type === "phone" ? null : safeHref(s);
            if (href && (e.metaKey || e.target === e.currentTarget)) {
              e.stopPropagation();
              void api.openURL(href);
            }
          }}
        >
          {String(v() ?? "")}
        </span>
      </Match>
      <Match when={props.prop.type === "files"}>
        <span class="cell-tags">
          <For each={Array.isArray(v()) ? (v() as { name: string; url: string }[]) : []}>
            {(f) => (
              <Show when={/\.(png|jpe?g|gif|webp|svg|heic)$/i.test(f.name) || f.url.startsWith("data:image")} fallback={<span class="file-chip">📎 {f.name}</span>}>
                <img class="file-thumb" src={f.url} alt={f.name} />
              </Show>
            )}
          </For>
        </span>
      </Match>
      <Match when={(props.prop.type === "formula" || props.prop.type === "rollup") && v() && typeof v() === "object" && "error" in (v() as object)}>
        <span class="cell-text formula-error" title={(v() as any).error}>
          #Fehler
        </span>
      </Match>
      <Match when={(props.prop.type === "formula" || props.prop.type === "rollup") && typeof v() === "number"}>
        <span class="cell-text num">{displayText(props.db, props.row, props.prop)}</span>
      </Match>
      <Match when={props.prop.type === "formula" && typeof v() === "boolean"}>
        <span class="checkbox" classList={{ checked: !!v() }}>
          <Show when={v()}>
            <svg viewBox="0 0 14 14">
              <path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z" fill="currentColor" />
            </svg>
          </Show>
        </span>
      </Match>
    </Switch>
  );
}

// ---------- Bearbeitung ----------

/** Öffnet den passenden Editor für eine Zelle. Checkboxen werden direkt umgeschaltet. */
export function editCell(anchor: Anchor, dbId: ID, row: DatabaseRow, prop: PropertyDef) {
  const db = dbs[dbId];
  if (!db || READONLY_TYPES.has(prop.type) || prop.type === "title") return;
  if (prop.type === "checkbox") {
    void setRowProps(dbId, row.id, { [prop.id]: !row.props[prop.id] });
    return;
  }
  const set = (v: unknown) => setRowProps(dbId, row.id, { [prop.id]: v });
  const minWidth = Math.max(anchor.width, 240);
  openPopover(
    { left: anchor.left, right: anchor.right, top: anchor.top - 4, bottom: anchor.top - 4, width: anchor.width, height: 0 },
    (close) => (
      <div class="cell-editor" style={{ "min-width": `${minWidth}px` }}>
        <Switch>
          <Match when={prop.type === "text" || prop.type === "url" || prop.type === "email" || prop.type === "phone"}>
            <TextEditor initial={String(row.props[prop.id] ?? "")} multiline={prop.type === "text"} onSave={(v) => set(v || null)} onClose={close} />
          </Match>
          <Match when={prop.type === "number"}>
            <TextEditor
              initial={typeof row.props[prop.id] === "number" ? String(row.props[prop.id]) : ""}
              onSave={(v) => set(v.trim() === "" ? null : parseLocaleNumber(v))}
              onClose={close}
              numeric
            />
          </Match>
          <Match when={prop.type === "select" || prop.type === "status" || prop.type === "multi_select"}>
            <SelectEditor dbId={dbId} rowId={row.id} propId={prop.id} />
          </Match>
          <Match when={prop.type === "date"}>
            <DateEditor value={row.props[prop.id] as any} onChange={(v) => set(v)} />
          </Match>
          <Match when={prop.type === "relation"}>
            <RelationEditor dbId={dbId} rowId={row.id} prop={prop} />
          </Match>
          <Match when={prop.type === "files"}>
            <FilesEditor value={(row.props[prop.id] as any[]) ?? []} onChange={(v) => set(v.length ? v : null)} />
          </Match>
        </Switch>
      </div>
    ),
    { placement: "bottom-start" },
  );
}

function TextEditor(props: { initial: string; multiline?: boolean; numeric?: boolean; onSave: (v: string) => unknown; onClose: () => void }) {
  let el!: HTMLTextAreaElement;
  let saved = false;
  const save = () => {
    if (saved) return;
    saved = true;
    if (el.value !== props.initial) void props.onSave(el.value);
  };
  onMount(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoGrow();
  });
  const autoGrow = () => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  };
  return (
    <textarea
      ref={el}
      class="cell-textarea"
      classList={{ numeric: props.numeric }}
      rows={1}
      value={props.initial}
      onInput={autoGrow}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (!props.multiline || !e.shiftKey)) {
          e.preventDefault();
          save();
          props.onClose();
        }
      }}
    />
  );
}

export function SelectEditor(props: { dbId: ID; rowId: ID; propId: string }) {
  const [q, setQ] = createSignal("");
  const [active, setActive] = createSignal(0);
  const db = () => dbs[props.dbId];
  const prop = () => db()?.schema.find((p) => p.id === props.propId);
  const row = () => db()?.rows.find((r) => r.id === props.rowId);
  const multi = () => prop()?.type === "multi_select";
  const selected = (): string[] => {
    const v = row()?.props[props.propId];
    return Array.isArray(v) ? (v as string[]) : v ? [String(v)] : [];
  };
  const options = createMemo(() => {
    const s = q().trim().toLowerCase();
    return (prop()?.options ?? []).filter((o) => !s || o.name.toLowerCase().includes(s));
  });
  const exact = () => (prop()?.options ?? []).some((o) => o.name.toLowerCase() === q().trim().toLowerCase());
  const items = () => [...options().map((o) => ({ kind: "opt" as const, o })), ...(q().trim() && !exact() ? [{ kind: "new" as const, o: null }] : [])];

  const toggle = (id: string) => {
    const cur = selected();
    let next: unknown;
    if (multi()) next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    else next = cur[0] === id ? null : id;
    void setRowProps(props.dbId, props.rowId, { [props.propId]: next });
  };

  const create = async () => {
    const name = q().trim();
    const p = prop();
    if (!name || !p) return;
    const color = COLORS[1 + Math.floor(Math.random() * (COLORS.length - 1))];
    const o: SelectOption = { id: shortId(), name, color, ...(p.type === "status" ? { group: "todo" as const } : {}) };
    await updateSchema(
      props.dbId,
      db()!.schema.map((x) => (x.id === p.id ? { ...x, options: [...(x.options ?? []), o] } : x)),
    );
    setQ("");
    toggle(o.id);
  };

  let input!: HTMLInputElement;
  onMount(() => input.focus());

  return (
    <div class="select-editor">
      <div class="select-input">
        <For each={selected().map((id) => prop()?.options?.find((o) => o.id === id)).filter(Boolean)}>
          {(o) => <OptionTag option={o!} onRemove={() => toggle(o!.id)} />}
        </For>
        <input
          ref={input}
          data-own-nav
          placeholder={selected().length ? "" : "Option suchen oder erstellen …"}
          value={q()}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
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
              if (!it) return;
              if (it.kind === "new") void create();
              else toggle(it.o.id);
            } else if (e.key === "Backspace" && !q() && selected().length) {
              toggle(selected()[selected().length - 1]);
            }
          }}
        />
      </div>
      <div class="menu-scroll" style={{ "max-height": "280px", padding: "4px 0" }}>
        <MenuSection title={multi() ? "Wähle eine oder mehrere Optionen" : "Wähle eine Option oder erstelle eine"} />
        <For each={items()}>
          {(it, i) => (
            <Show
              when={it.kind === "opt"}
              fallback={
                <MenuItem
                  active={active() === i()}
                  onMouseEnter={() => setActive(i())}
                  label={
                    <span>
                      Erstellen <span class="tag tag-default">{q().trim()}</span>
                    </span>
                  }
                  onClick={() => void create()}
                />
              }
            >
              <MenuItem
                active={active() === i()}
                onMouseEnter={() => setActive(i())}
                icon={<span class="drag-dots"><IconDrag /></span>}
                label={<OptionTag option={it.o!} />}
                checked={selected().includes(it.o!.id)}
                onClick={() => toggle(it.o!.id)}
                right={
                  <button
                    class="icon-btn small option-more"
                    onClick={(e) => {
                      e.stopPropagation();
                      openOptionMenu(e.currentTarget.getBoundingClientRect(), props.dbId, props.propId, it.o!.id);
                    }}
                  >
                    ⋯
                  </button>
                }
              />
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

/** Menü zum Umbenennen, Einfärben und Löschen einer Option. */
export function openOptionMenu(anchor: Anchor, dbId: ID, propId: string, optionId: string) {
  openPopover(anchor, (close) => {
    const prop = () => dbs[dbId]?.schema.find((p) => p.id === propId);
    const option = () => prop()?.options?.find((o) => o.id === optionId);
    const patch = (p: Partial<SelectOption> | null) => {
      const d = dbs[dbId];
      if (!d) return;
      void updateSchema(
        dbId,
        d.schema.map((x) =>
          x.id !== propId
            ? x
            : { ...x, options: p === null ? (x.options ?? []).filter((o) => o.id !== optionId) : (x.options ?? []).map((o) => (o.id === optionId ? { ...o, ...p } : o)) },
        ),
      );
    };
    return (
      <div class="menu" style={{ width: "220px" }}>
        <div style={{ padding: "6px 8px" }}>
          <input class="text-input" value={option()?.name ?? ""} onChange={(e) => e.currentTarget.value.trim() && patch({ name: e.currentTarget.value.trim() })} />
        </div>
        <MenuItem
          icon={<IconTrash />}
          label="Löschen"
          onClick={() => {
            patch(null);
            close();
          }}
        />
        <Show when={prop()?.type === "status"}>
          <MenuSection title="Gruppe" />
          <For each={[["todo", "Zu erledigen"], ["progress", "In Bearbeitung"], ["done", "Erledigt"]] as const}>
            {([g, label]) => <MenuItem label={label} checked={option()?.group === g} onClick={() => patch({ group: g })} />}
          </For>
        </Show>
        <MenuSection title="Farben" />
        <For each={COLORS}>
          {(c) => <MenuItem icon={<span class={`color-square tag-${c}`} />} label={COLOR_LABELS[c]} checked={option()?.color === c} onClick={() => patch({ color: c })} />}
        </For>
      </div>
    );
  });
}

// ---------- Datum ----------

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export function DateEditor(props: { value: { start?: string; end?: string } | null; onChange: (v: { start: string; end?: string } | null) => void }) {
  const [val, setVal] = createSignal(props.value?.start ? { ...props.value } : null);
  const initialDate = val()?.start ? parseDateValue(val()!.start!) : new Date();
  const [month, setMonth] = createSignal(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));
  const [withEnd, setWithEnd] = createSignal(!!props.value?.end);
  const [withTime, setWithTime] = createSignal(!!props.value?.start?.includes("T"));
  const [picking, setPicking] = createSignal<"start" | "end">("start");

  const commit = (v: { start?: string; end?: string } | null) => {
    setVal(v);
    props.onChange(v?.start ? { start: v.start, ...(v.end ? { end: v.end } : {}) } : null);
  };

  const days = createMemo(() => {
    const m = month();
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) out.push(new Date(m.getFullYear(), m.getMonth(), 1 - offset + i));
    return out;
  });

  const timeOf = (s?: string) => (s && s.includes("T") ? parseDateValue(s).toTimeString().slice(0, 5) : "09:00");
  const withTimeValue = (day: string, time: string) => {
    if (!withTime()) return day;
    const [h, mi] = time.split(":").map(Number);
    const d = parseDateValue(day);
    d.setHours(h || 0, mi || 0, 0, 0);
    return d.toISOString();
  };
  const dayStr = (s?: string) => (s ? toDateValue(parseDateValue(s)) : "");

  const pick = (d: Date) => {
    const day = toDateValue(d);
    const cur = val() ?? {};
    if (withEnd() && picking() === "end") {
      let start = cur.start ?? withTimeValue(day, "09:00");
      let end = withTimeValue(day, timeOf(cur.end));
      if (dayStr(end) < dayStr(start)) [start, end] = [end, start];
      commit({ start, end });
      setPicking("start");
    } else {
      commit({ start: withTimeValue(day, timeOf(cur.start)), end: withEnd() ? cur.end : undefined });
      if (withEnd()) setPicking("end");
    }
  };

  const inRange = (d: Date) => {
    const v = val();
    if (!v?.start || !v.end) return false;
    const s = toDateValue(d);
    return s >= dayStr(v.start) && s <= dayStr(v.end);
  };

  return (
    <div class="date-editor">
      <div class="date-inputs">
        <div class="text-input date-field" classList={{ focused: picking() === "start" }} onClick={() => setPicking("start")}>
          {val()?.start ? formatDateValue(val()!.start!, "full") : <span class="muted">Startdatum</span>}
        </div>
        <Show when={withEnd()}>
          <div class="text-input date-field" classList={{ focused: picking() === "end" }} onClick={() => setPicking("end")}>
            {val()?.end ? formatDateValue(val()!.end!, "full") : <span class="muted">Enddatum</span>}
          </div>
        </Show>
      </div>
      <div class="cal-head">
        <span class="cal-title">{month().toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</span>
        <button class="btn" onClick={() => setMonth(new Date())}>
          Heute
        </button>
        <button class="icon-btn small" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
          ‹
        </button>
        <button class="icon-btn small" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
          ›
        </button>
      </div>
      <div class="cal-grid">
        <For each={WEEKDAYS}>{(d) => <span class="cal-wd">{d}</span>}</For>
        <For each={days()}>
          {(d) => {
            const s = toDateValue(d);
            return (
              <button
                class="cal-day"
                classList={{
                  other: d.getMonth() !== month().getMonth(),
                  today: s === toDateValue(new Date()),
                  selected: s === dayStr(val()?.start) || s === dayStr(val()?.end),
                  range: inRange(d),
                }}
                onClick={() => pick(d)}
              >
                {d.getDate()}
              </button>
            );
          }}
        </For>
      </div>
      <div class="date-options">
        <label class="switch-row">
          <span>Enddatum</span>
          <input
            type="checkbox"
            class="switch"
            checked={withEnd()}
            onChange={(e) => {
              setWithEnd(e.currentTarget.checked);
              if (!e.currentTarget.checked && val()) commit({ start: val()!.start });
              else setPicking("end");
            }}
          />
        </label>
        <label class="switch-row">
          <span>Uhrzeit einschließen</span>
          <input
            type="checkbox"
            class="switch"
            checked={withTime()}
            onChange={(e) => {
              setWithTime(e.currentTarget.checked);
              const v = val();
              if (!v?.start) return;
              if (e.currentTarget.checked) commit({ start: withTimeValue(dayStr(v.start), "09:00"), end: v.end ? withTimeValue(dayStr(v.end), "10:00") : undefined });
              else commit({ start: dayStr(v.start), end: v.end ? dayStr(v.end) : undefined });
            }}
          />
        </label>
        <Show when={withTime() && val()?.start}>
          <div class="time-row">
            <input
              type="time"
              class="text-input"
              value={timeOf(val()!.start)}
              onChange={(e) => commit({ ...val()!, start: withTimeValue(dayStr(val()!.start), e.currentTarget.value) })}
            />
            <Show when={withEnd() && val()?.end}>
              <span>–</span>
              <input
                type="time"
                class="text-input"
                value={timeOf(val()!.end)}
                onChange={(e) => commit({ ...val()!, end: withTimeValue(dayStr(val()!.end), e.currentTarget.value) })}
              />
            </Show>
          </div>
        </Show>
        <button class="menu-item" onClick={() => commit(null)}>
          <span class="menu-label">Löschen</span>
        </button>
      </div>
    </div>
  );
}

// ---------- Relation ----------

function RelationEditor(props: { dbId: ID; rowId: ID; prop: PropertyDef }) {
  const target = () => props.prop.relation?.databaseId ?? "";
  void loadDatabase(target());
  const [q, setQ] = createSignal("");
  const selected = (): ID[] => (dbs[props.dbId]?.rows.find((r) => r.id === props.rowId)?.props[props.prop.id] as ID[]) ?? [];
  const candidates = createMemo(() => {
    const d = getDatabase(target());
    const s = q().trim().toLowerCase();
    return (d?.rows ?? []).filter((r) => r.id !== props.rowId && (!s || rowTitle(r).toLowerCase().includes(s))).slice(0, 100);
  });
  const toggle = (id: ID) => {
    const cur = selected();
    void setRowProps(props.dbId, props.rowId, { [props.prop.id]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <div class="relation-editor">
      <div style={{ padding: "6px 8px" }}>
        <input ref={input} class="text-input" placeholder={`In „${pageTitle(ws.pages[target()]?.title)}“ suchen …`} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      <Show when={selected().length}>
        <MenuSection title="Verknüpft" />
        <For each={selected()}>
          {(id) => <MenuItem icon={<PageIcon id={id} />} label={pageTitle(ws.pages[id]?.title)} checked onClick={() => toggle(id)} />}
        </For>
      </Show>
      <MenuSection title="Seiten" />
      <div class="menu-scroll" style={{ "max-height": "260px" }}>
        <For each={candidates().filter((r) => !selected().includes(r.id))} fallback={<div class="menu-empty">Keine Einträge</div>}>
          {(r) => <MenuItem icon={<PageIcon id={r.id} />} label={pageTitle(rowTitle(r))} onClick={() => toggle(r.id)} />}
        </For>
      </div>
    </div>
  );
}

// ---------- Dateien ----------

function FilesEditor(props: { value: { name: string; url: string }[]; onChange: (v: { name: string; url: string }[]) => void }) {
  const [files, setFiles] = createSignal(props.value);
  const add = async () => {
    const picked = await api.pickFiles({ multiple: true });
    if (!picked.length) return;
    const out = [...files(), ...picked.map((f) => ({ name: f.name, url: f.url }))];
    setFiles(out);
    props.onChange(out);
  };
  return (
    <div class="files-editor">
      <For each={files()}>
        {(f, i) => (
          <div class="menu-item">
            <span class="menu-label ellipsis">📎 {f.name}</span>
            <button
              class="icon-btn small"
              onClick={() => {
                const out = files().filter((_, j) => j !== i());
                setFiles(out);
                props.onChange(out);
              }}
            >
              <IconTrash />
            </button>
          </div>
        )}
      </For>
      <button class="menu-item" onClick={() => void add()}>
        <span class="menu-label">＋ Datei hochladen</span>
      </button>
    </div>
  );
}

export { formatNumber };
