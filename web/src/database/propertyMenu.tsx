import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { api } from "../api/client";
import type { DatabaseData, ID, NumberFormat, PropType, PropertyDef, RollupFn, SelectOption, ViewDef } from "../api/types";
import { shortId } from "../lib/id";
import { COLORS, pageTitle, parseDateValue, parseLocaleNumber, toDateValue } from "../lib/util";
import { ws } from "../state/workspace";
import { confirmDialog, MenuDivider, MenuItem, MenuSection, openPagePicker, openPopover, type Anchor } from "../components/popovers";
import { IconChevronRight, IconDuplicate, IconEyeOff, IconSort, IconTrash, IconFilter } from "../components/Icons";
import { dbs, dropReverseRelation, getDatabase, loadDatabase, rebuildRelationLinks, updateSchema, updateView } from "./store";
import { displayText, PROP_TYPES, propIcon, propTypeLabel, ROLLUP_FNS } from "./properties";
import { OptionTag, openOptionMenu } from "./cells";
import { checkFormula, FORMULA_FUNCTIONS } from "./formula";
import { defaultStatusOptions } from "./defaults";

const NUMBER_FORMATS: { f: NumberFormat; label: string }[] = [
  { f: "number", label: "Zahl" },
  { f: "comma", label: "Zahl mit Tausendertrennzeichen" },
  { f: "percent", label: "Prozent" },
  { f: "euro", label: "Euro" },
  { f: "dollar", label: "US-Dollar" },
  { f: "bar", label: "Balken" },
  { f: "ring", label: "Ring" },
];

/** Neue Eigenschaft anlegen (Typauswahl) und danach das Eigenschaftsmenü öffnen. */
export function openAddProperty(anchor: Anchor, dbId: ID, viewId?: string) {
  openPopover(anchor, (close) => (
    <div class="menu" style={{ width: "240px" }}>
      <MenuSection title="Typ" />
      <div class="menu-scroll" style={{ "max-height": "360px" }}>
        <For each={PROP_TYPES}>
          {(t) => (
            <MenuItem
              icon={<t.icon />}
              label={t.label}
              onClick={async () => {
                close();
                const d = dbs[dbId];
                if (!d) return;
                const id = shortId();
                let name = t.label;
                for (let i = 2; d.schema.some((p) => p.name === name); i++) name = `${t.label} ${i}`;
                const prop: PropertyDef = { id, name, type: t.type, ...(t.type === "status" ? { options: defaultStatusOptions() } : {}), ...(t.type === "select" || t.type === "multi_select" ? { options: [] } : {}) };
                await updateSchema(dbId, [...d.schema, prop]);
                // In allen Ansichten am Ende einreihen
                for (const v of d.views) if (!v.order.includes(id)) updateView(dbId, v.id, { order: [...v.order, id] });
                if (t.type === "unique_id") await assignUniqueIds(dbId, id);
                openPropertyMenu(anchor, dbId, id, viewId);
              }}
            />
          )}
        </For>
      </div>
    </div>
  ));
}

async function assignUniqueIds(dbId: ID, propId: string) {
  const d = dbs[dbId];
  if (!d) return;
  const rows = [...d.rows].sort((a, b) => a.createdAt - b.createdAt);
  const ops = rows.map((r, i) => ({ method: "page.update", params: { id: r.id, patch: { props: JSON.stringify({ ...r.props, [propId]: i + 1 }) } } }));
  for (let i = 0; i < ops.length; i += 500) await api.batch(ops.slice(i, i + 500));
  await updateSchema(dbId, d.schema.map((p) => (p.id === propId ? { ...p, nextId: rows.length + 1 } : p)));
  await loadDatabase(dbId, true);
}

export function openPropertyMenu(anchor: Anchor, dbId: ID, propId: string, viewId?: string) {
  openPopover(anchor, (close) => <PropertyMenu dbId={dbId} propId={propId} viewId={viewId} close={close} />);
}

function PropertyMenu(props: { dbId: ID; propId: string; viewId?: string; close: () => void }) {
  const db = () => dbs[props.dbId];
  const prop = () => db()?.schema.find((p) => p.id === props.propId);
  const view = (): ViewDef | undefined => db()?.views.find((v) => v.id === props.viewId);
  const patch = (p: Partial<PropertyDef>) => {
    const d = db();
    if (!d) return;
    void updateSchema(props.dbId, d.schema.map((x) => (x.id === props.propId ? { ...x, ...p } : x)));
  };
  let nameInput!: HTMLInputElement;
  onMount(() => {
    nameInput?.focus();
    nameInput?.select();
  });

  return (
    <Show when={prop()}>
      <div class="menu" style={{ width: "280px" }}>
        <div style={{ padding: "6px 8px", display: "flex", gap: "6px", "align-items": "center" }}>
          <span class="prop-type-icon">{(() => { const I = propIcon(prop()!.type); return <I />; })()}</span>
          <input
            ref={nameInput}
            class="text-input"
            value={prop()!.name}
            onChange={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== prop()!.name) rename(props.dbId, props.propId, name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
                props.close();
              }
            }}
          />
        </div>
        <Show when={prop()!.type !== "title"}>
          <MenuItem
            label="Typ"
            hint={propTypeLabel(prop()!.type)}
            right={<span class="menu-arrow"><IconChevronRight /></span>}
            onClick={(e) => openTypeMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), props.dbId, props.propId)}
          />
        </Show>
        <PropertyConfig dbId={props.dbId} prop={prop()!} patch={patch} />
        <MenuDivider />
        <Show when={view()}>
          <MenuItem
            icon={<IconSort />}
            label="Aufsteigend sortieren"
            onClick={() => {
              updateView(props.dbId, view()!.id, { sorts: [{ prop: props.propId, dir: "asc" }] });
              props.close();
            }}
          />
          <MenuItem
            icon={<IconSort />}
            label="Absteigend sortieren"
            onClick={() => {
              updateView(props.dbId, view()!.id, { sorts: [{ prop: props.propId, dir: "desc" }] });
              props.close();
            }}
          />
          <MenuItem
            icon={<IconFilter />}
            label="Filter"
            onClick={() => {
              const f = view()!.filter;
              updateView(props.dbId, view()!.id, { filter: { ...f, rules: [...f.rules, { prop: props.propId, cond: defaultCond(prop()!.type) }] } });
              props.close();
            }}
          />
          <Show when={prop()!.type !== "title"}>
            <MenuItem
              icon={<IconEyeOff />}
              label="In Ansicht ausblenden"
              onClick={() => {
                updateView(props.dbId, view()!.id, { hidden: [...view()!.hidden, props.propId] });
                props.close();
              }}
            />
          </Show>
          <MenuItem label="Spalte umbrechen" checked={!!view()!.wrap} onClick={() => updateView(props.dbId, view()!.id, { wrap: !view()!.wrap })} />
        </Show>
        <Show when={prop()!.type !== "title"}>
          <MenuItem
            icon={<IconDuplicate />}
            label="Eigenschaft duplizieren"
            onClick={async () => {
              const d = db()!;
              const id = shortId();
              const copy = { ...JSON.parse(JSON.stringify(prop()!)), id, name: `${prop()!.name} (Kopie)` };
              // Die Kopie einer zweiseitigen Relation ist einseitig – sie darf das Gegenstück des Originals nicht teilen
              // (sonst löscht das Entfernen der Kopie die Gegenspalte des Originals samt Werten)
              if (copy.relation?.reverseProp) delete copy.relation.reverseProp;
              await updateSchema(props.dbId, [...d.schema, copy]);
              const ops = d.rows
                .filter((r) => r.props[props.propId] !== undefined)
                .map((r) => ({ method: "page.update", params: { id: r.id, patch: { props: JSON.stringify({ ...r.props, [id]: r.props[props.propId] }) } } }));
              if (ops.length) await api.batch(ops);
              await loadDatabase(props.dbId, true);
              props.close();
            }}
          />
          <MenuItem
            icon={<IconTrash />}
            label="Eigenschaft löschen"
            danger
            onClick={async () => {
              props.close();
              if (!(await confirmDialog({ title: `„${prop()!.name}“ löschen?`, message: "Die Werte dieser Eigenschaft gehen in allen Einträgen verloren.", confirm: "Löschen", danger: true }))) return;
              const d = db()!;
              const removed = prop()!;
              await updateSchema(props.dbId, d.schema.filter((x) => x.id !== props.propId));
              void updateViewsAfterDelete(props.dbId, props.propId);
              if (removed.type === "relation") {
                await rebuildRelationLinks(props.dbId);
                await dropReverseRelation(removed);
              }
            }}
          />
        </Show>
      </div>
    </Show>
  );
}

/** Umbenennen und Formeln, die die Eigenschaft per prop("Name") verwenden, mitziehen. */
function rename(dbId: ID, propId: string, name: string) {
  const d = dbs[dbId];
  const old = d?.schema.find((p) => p.id === propId)?.name;
  if (!d || old === undefined) return;
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`prop\\(\\s*(["'“„])${escaped}["'”“]\\s*\\)`, "g");
  const replacement = `prop("${name.replace(/"/g, '\\"')}")`;
  // Ersetzung per Funktion: "$1" o. Ä. im neuen Namen wird nicht als Rückverweis gedeutet
  const rewrite = (formula: string) => formula.replace(re, () => replacement);
  void updateSchema(
    dbId,
    d.schema.map((p) => {
      if (p.id === propId) return { ...p, name };
      if (p.type === "formula" && p.formula) return { ...p, formula: rewrite(p.formula) };
      return p;
    }),
  );
  // Formeln anderer (geladener) Datenbanken, die über eine Relation auf diese Datenbank zugreifen
  for (const other of Object.values(dbs)) {
    if (other.id === dbId || !other.schema.some((p) => p.type === "relation" && p.relation?.databaseId === dbId)) continue;
    const next = other.schema.map((p) => (p.type === "formula" && p.formula ? { ...p, formula: p.formula.replace(new RegExp(`\\.${re.source}`, "g"), () => "." + replacement) } : p));
    if (next.some((p, i) => p !== other.schema[i] && p.formula !== other.schema[i].formula)) void updateSchema(other.id, next);
  }
}

async function updateViewsAfterDelete(dbId: ID, propId: string) {
  const d = dbs[dbId];
  if (!d) return;
  for (const v of d.views) {
    updateView(dbId, v.id, {
      order: v.order.filter((x) => x !== propId),
      hidden: v.hidden.filter((x) => x !== propId),
      sorts: v.sorts.filter((s) => s.prop !== propId),
      filter: { ...v.filter, rules: v.filter.rules.filter((r) => !("prop" in r) || r.prop !== propId) },
      groupBy: v.groupBy === propId ? null : v.groupBy,
      dateProp: v.dateProp === propId ? null : v.dateProp,
    });
  }
}

export function defaultCond(type: PropType) {
  switch (type) {
    case "checkbox":
      return "checked" as const;
    case "number":
    case "unique_id":
      return "eq" as const;
    case "select":
    case "status":
      return "is" as const;
    case "date":
    case "created_time":
    case "last_edited_time":
      return "is" as const;
    case "multi_select":
    case "relation":
    case "files":
      return "contains" as const;
    default:
      return "contains" as const;
  }
}

function openTypeMenu(anchor: Anchor, dbId: ID, propId: string) {
  openPopover(
    anchor,
    (close) => (
      <div class="menu" style={{ width: "240px" }}>
        <div class="menu-scroll" style={{ "max-height": "380px" }}>
          <For each={PROP_TYPES}>
            {(t) => (
              <MenuItem
                icon={<t.icon />}
                label={t.label}
                checked={dbs[dbId]?.schema.find((p) => p.id === propId)?.type === t.type}
                onClick={() => {
                  close();
                  void changeType(dbId, propId, t.type);
                }}
              />
            )}
          </For>
        </div>
      </div>
    ),
    { placement: "right-start" },
  );
}

/** Typ ändern und vorhandene Werte sinnvoll umwandeln. */
async function changeType(dbId: ID, propId: string, type: PropType) {
  const d = dbs[dbId];
  const prop = d?.schema.find((p) => p.id === propId);
  if (!d || !prop || prop.type === type) return;
  const texts = new Map(d.rows.map((r) => [r.id, displayText(d, r, prop)]));
  const next: PropertyDef = { id: prop.id, name: prop.name, type };
  if (type === "select" || type === "multi_select" || type === "status") {
    const names = new Set<string>();
    for (const t of texts.values()) for (const part of type === "multi_select" ? t.split(",") : [t]) if (part.trim()) names.add(part.trim());
    const existing = prop.options ?? [];
    next.options = type === "status" && !existing.length ? defaultStatusOptions() : existing.map((o) => ({ ...o }));
    for (const n of names) {
      if (!next.options.some((o) => o.name === n)) {
        next.options.push({ id: shortId(), name: n, color: COLORS[1 + (next.options.length % (COLORS.length - 1))], ...(type === "status" ? { group: "todo" as const } : {}) });
      }
    }
  }
  const convert = (rowId: ID, old: unknown): unknown => {
    const t = texts.get(rowId) ?? "";
    switch (type) {
      case "text":
      case "url":
      case "email":
      case "phone":
        return t || undefined;
      case "number":
        return parseLocaleNumber(t) ?? undefined;
      case "checkbox":
        return !!old && t !== "" ? true : undefined;
      case "select":
      case "status":
        return next.options!.find((o) => o.name === t.trim())?.id;
      case "multi_select": {
        const ids = t.split(",").map((x) => next.options!.find((o) => o.name === x.trim())?.id).filter(Boolean);
        return ids.length ? ids : undefined;
      }
      case "date": {
        if (prop.type === "created_time" || prop.type === "last_edited_time") return undefined;
        const dt = parseDateValue(String(t));
        return t && !Number.isNaN(dt.getTime()) ? { start: toDateValue(dt) } : undefined;
      }
      default:
        return undefined;
    }
  };
  // Berechnete Typen haben keine gespeicherten Werte
  const ops = d.rows.map((r) => {
    const props = { ...r.props };
    const v = convert(r.id, r.props[propId]);
    if (v === undefined) delete props[propId];
    else props[propId] = v;
    return { method: "page.update", params: { id: r.id, patch: { props: JSON.stringify(props) } } };
  });
  await updateSchema(dbId, d.schema.map((p) => (p.id === propId ? next : p)));
  for (let i = 0; i < ops.length; i += 500) await api.batch(ops.slice(i, i + 500));
  if (type === "unique_id") await assignUniqueIds(dbId, propId);
  else await loadDatabase(dbId, true);
  if (prop.type === "relation") {
    await rebuildRelationLinks(dbId);
    await dropReverseRelation(prop);
  }
}

function PropertyConfig(props: { dbId: ID; prop: PropertyDef; patch: (p: Partial<PropertyDef>) => void }) {
  return (
    <Switch>
      <Match when={props.prop.type === "number" || props.prop.type === "formula" || props.prop.type === "rollup"}>
        <Show when={props.prop.type === "formula"}>
          <FormulaField dbId={props.dbId} prop={props.prop} patch={props.patch} />
        </Show>
        <Show when={props.prop.type === "rollup"}>
          <RollupConfig dbId={props.dbId} prop={props.prop} patch={props.patch} />
        </Show>
        <MenuSection title="Zahlenformat" />
        <select class="menu-select" value={props.prop.format ?? "number"} onChange={(e) => props.patch({ format: e.currentTarget.value as NumberFormat })}>
          <For each={NUMBER_FORMATS}>{(f) => <option value={f.f}>{f.label}</option>}</For>
        </select>
      </Match>
      <Match when={props.prop.type === "select" || props.prop.type === "multi_select" || props.prop.type === "status"}>
        <OptionsList dbId={props.dbId} prop={props.prop} patch={props.patch} />
      </Match>
      <Match when={props.prop.type === "relation"}>
        <RelationConfig dbId={props.dbId} prop={props.prop} patch={props.patch} />
      </Match>
      <Match when={props.prop.type === "unique_id"}>
        <MenuSection title="Präfix" />
        <div style={{ padding: "0 8px 6px" }}>
          <input class="text-input" placeholder="z. B. TASK" value={props.prop.prefix ?? ""} onChange={(e) => props.patch({ prefix: e.currentTarget.value.trim() || undefined })} />
        </div>
      </Match>
      <Match when={props.prop.type === "date"}>
        <MenuSection title="Datumsformat" />
        <select class="menu-select" value={props.prop.dateFormat ?? "full"} onChange={(e) => props.patch({ dateFormat: e.currentTarget.value as any })}>
          <option value="full">Vollständig (7. Oktober 2026)</option>
          <option value="short">Kurz (07.10.2026)</option>
          <option value="relative">Relativ (Heute, Morgen …)</option>
          <option value="iso">ISO (2026-10-07)</option>
        </select>
      </Match>
    </Switch>
  );
}

function OptionsList(props: { dbId: ID; prop: PropertyDef; patch: (p: Partial<PropertyDef>) => void }) {
  const [adding, setAdding] = createSignal(false);
  const add = (name: string) => {
    const n = name.trim();
    if (!n) return;
    const opt: SelectOption = { id: shortId(), name: n, color: COLORS[1 + ((props.prop.options?.length ?? 0) % (COLORS.length - 1))], ...(props.prop.type === "status" ? { group: "todo" as const } : {}) };
    props.patch({ options: [...(props.prop.options ?? []), opt] });
  };
  return (
    <>
      <div class="menu-section-row">
        <MenuSection title="Optionen" />
        <button class="icon-btn small" title="Option hinzufügen" onClick={() => setAdding(true)}>
          ＋
        </button>
      </div>
      <Show when={adding()}>
        <div style={{ padding: "0 8px 6px" }}>
          <input
            class="text-input"
            placeholder="Neue Option"
            ref={(el) => setTimeout(() => el.focus())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                add(e.currentTarget.value);
                e.currentTarget.value = "";
              }
            }}
            onBlur={() => setAdding(false)}
          />
        </div>
      </Show>
      <div class="menu-scroll" style={{ "max-height": "220px" }}>
        <For each={props.prop.options ?? []}>
          {(o) => (
            <MenuItem
              label={<OptionTag option={o} />}
              hint={props.prop.type === "status" ? ({ todo: "Zu erledigen", progress: "In Arbeit", done: "Erledigt" } as const)[o.group ?? "todo"] : undefined}
              onClick={(e) => openOptionMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), props.dbId, props.prop.id, o.id)}
            />
          )}
        </For>
      </div>
    </>
  );
}

function RelationConfig(props: { dbId: ID; prop: PropertyDef; patch: (p: Partial<PropertyDef>) => void }) {
  const target = () => props.prop.relation?.databaseId;
  const pickTarget = (e: MouseEvent) =>
    openPagePicker(
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
      async (id) => {
        if (!id) return;
        props.patch({ relation: { databaseId: id } });
        await loadDatabase(id);
      },
      { onlyDatabases: true, placeholder: "Datenbank suchen …" },
    );
  const toggleTwoWay = async () => {
    const t = target();
    if (!t) return;
    await loadDatabase(t);
    const td = dbs[t];
    if (!td) return;
    const rev = props.prop.relation?.reverseProp;
    if (rev) {
      // Gegenrichtung samt Werten und Links entfernen
      await dropReverseRelation(props.prop);
      props.patch({ relation: { databaseId: t } });
      return;
    }
    const revId = shortId();
    const name = pageTitle(ws.pages[props.dbId]?.title);
    const revProp: PropertyDef = { id: revId, name: `Verknüpft: ${name}`, type: "relation", relation: { databaseId: props.dbId, reverseProp: props.prop.id } };
    await updateSchema(t, [...dbs[t].schema, revProp]);
    for (const v of dbs[t].views) updateView(t, v.id, { order: [...v.order, revId] });
    props.patch({ relation: { databaseId: t, reverseProp: revId } });
    // Bestehende Verknüpfungen in die Gegenrichtung übertragen
    const d = dbs[props.dbId];
    const reverse = new Map<ID, ID[]>();
    for (const r of d?.rows ?? []) for (const dst of (r.props[props.prop.id] as ID[]) ?? []) reverse.set(dst, [...(reverse.get(dst) ?? []), r.id]);
    const ops = [...reverse.entries()]
      .map(([id, srcs]) => {
        const row = dbs[t]?.rows.find((r) => r.id === id);
        return row ? { method: "page.update", params: { id, patch: { props: JSON.stringify({ ...row.props, [revId]: srcs }) } } } : null;
      })
      .filter(Boolean) as { method: string; params: Record<string, unknown> }[];
    if (ops.length) await api.batch(ops);
    await loadDatabase(t, true);
  };
  return (
    <>
      <MenuSection title="Bezogen auf" />
      <MenuItem label={target() ? pageTitle(ws.pages[target()!]?.title) : "Datenbank wählen …"} right={<span class="menu-arrow"><IconChevronRight /></span>} onClick={pickTarget} />
      <Show when={target()}>
        <MenuItem label="Zweiseitige Relation" checked={!!props.prop.relation?.reverseProp} onClick={() => void toggleTwoWay()} />
      </Show>
    </>
  );
}

function RollupConfig(props: { dbId: ID; prop: PropertyDef; patch: (p: Partial<PropertyDef>) => void }) {
  const db = (): DatabaseData | undefined => dbs[props.dbId];
  const relations = () => db()?.schema.filter((p) => p.type === "relation") ?? [];
  const cfg = () => props.prop.rollup ?? { relationProp: relations()[0]?.id ?? "", targetProp: "title", fn: "count" as RollupFn };
  const targetDb = createMemo(() => {
    const rel = relations().find((r) => r.id === cfg().relationProp);
    return rel?.relation ? getDatabase(rel.relation.databaseId) : undefined;
  });
  const set = (p: Partial<NonNullable<PropertyDef["rollup"]>>) => props.patch({ rollup: { ...cfg(), ...p } });
  // Angezeigte Standardwerte auch speichern (sonst bleibt die Spalte leer, obwohl sie konfiguriert aussieht)
  onMount(() => {
    if (!props.prop.rollup && relations().length) set({});
  });
  return (
    <>
      <MenuSection title="Relation" />
      <select class="menu-select" value={cfg().relationProp} onChange={(e) => set({ relationProp: e.currentTarget.value })}>
        <option value="">– wählen –</option>
        <For each={relations()}>{(r) => <option value={r.id}>{r.name}</option>}</For>
      </select>
      <MenuSection title="Eigenschaft" />
      <select class="menu-select" value={cfg().targetProp} onChange={(e) => set({ targetProp: e.currentTarget.value })}>
        <For each={targetDb()?.schema ?? []}>{(p) => <option value={p.type === "title" ? "title" : p.id}>{p.name}</option>}</For>
      </select>
      <MenuSection title="Berechnen" />
      <select class="menu-select" value={cfg().fn} onChange={(e) => set({ fn: e.currentTarget.value as RollupFn })}>
        <For each={ROLLUP_FNS}>{(f) => <option value={f.fn}>{f.label}</option>}</For>
      </select>
    </>
  );
}

function FormulaField(props: { dbId: ID; prop: PropertyDef; patch: (p: Partial<PropertyDef>) => void }) {
  const [src, setSrc] = createSignal(props.prop.formula ?? "");
  const error = () => (src().trim() ? checkFormula(src()) : null);
  const names = () => dbs[props.dbId]?.schema.filter((p) => p.id !== props.prop.id).map((p) => p.name) ?? [];
  let ta!: HTMLTextAreaElement;
  const insert = (text: string) => {
    const s = ta.selectionStart;
    const v = src().slice(0, s) + text + src().slice(ta.selectionEnd);
    setSrc(v);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(s + text.length, s + text.length);
    });
  };
  return (
    <div class="formula-field">
      <MenuSection title="Formel" />
      <textarea ref={ta} class="formula-input" spellcheck={false} value={src()} onInput={(e) => setSrc(e.currentTarget.value)} placeholder='z. B. prop("Preis") * prop("Menge")' />
      <Show when={error()}>
        <div class="formula-error">{error()}</div>
      </Show>
      <div class="formula-help">
        <div class="formula-chips">
          <For each={names()}>{(n) => <button class="formula-chip" onClick={() => insert(`prop("${n}")`)}>{n}</button>}</For>
        </div>
        <div class="formula-chips">
          <For each={FORMULA_FUNCTIONS.slice(0, 40)}>{(f) => <button class="formula-chip fn" onClick={() => insert(`${f}(`)}>{f}</button>}</For>
        </div>
      </div>
      <button class="btn-primary" style={{ width: "calc(100% - 16px)", margin: "6px 8px", height: "28px" }} disabled={!!error()} onClick={() => props.patch({ formula: src() })}>
        Fertig
      </button>
    </div>
  );
}
