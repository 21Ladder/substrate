import { For, Show } from "solid-js";
import type { ID } from "../api/types";
import { IconPlus } from "../components/Icons";
import { dbs, getDatabase } from "./store";
import { isEmpty, propIcon, READONLY_TYPES } from "./properties";
import { CellValue, editCell } from "./cells";
import { openAddProperty, openPropertyMenu } from "./propertyMenu";

/** Eigenschaften eines Datenbankeintrags unter dem Seitentitel. */
export function RowProperties(props: { dbId: ID; rowId: ID; readOnly: boolean }) {
  const db = () => getDatabase(props.dbId);
  const row = () => db()?.rows.find((r) => r.id === props.rowId);
  return (
    <Show when={db() && row()}>
      <div class="row-props">
        <For each={db()!.schema.filter((p) => p.type !== "title")}>
          {(p) => {
            const Icon = propIcon(p.type);
            return (
              <div class="row-prop">
                <button class="row-prop-name" onClick={(e) => !props.readOnly && openPropertyMenu(e.currentTarget.getBoundingClientRect(), props.dbId, p.id)}>
                  <Icon />
                  <span class="ellipsis">{p.name}</span>
                </button>
                <div
                  class="row-prop-value"
                  classList={{ readonly: READONLY_TYPES.has(p.type), empty: isEmpty(dbs[props.dbId]!, row()!, p) }}
                  onClick={(e) => !props.readOnly && editCell(e.currentTarget.getBoundingClientRect(), props.dbId, row()!, p)}
                >
                  <Show when={!isEmpty(dbs[props.dbId]!, row()!, p) || p.type === "checkbox"} fallback={<span class="placeholder">Leer</span>}>
                    <CellValue db={db()!} row={row()!} prop={p} wrap />
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
        <Show when={!props.readOnly}>
          <button class="btn add-prop" onClick={(e) => openAddProperty(e.currentTarget.getBoundingClientRect(), props.dbId)}>
            <IconPlus /> Eigenschaft hinzufügen
          </button>
        </Show>
      </div>
    </Show>
  );
}
