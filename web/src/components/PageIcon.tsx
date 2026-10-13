import { Match, Switch } from "solid-js";
import type { ID } from "../api/types";
import { ws } from "../state/workspace";
import { IconPage, IconPageEmpty, IconTable } from "./Icons";

export function isImageIcon(icon: string | null | undefined): boolean {
  // Externe Icons werden nicht geladen (offline) → Standardsymbol
  return !!icon && (icon.startsWith("app://") || icon.startsWith("data:image/"));
}

/** Icon einer Seite: Emoji, Bild oder Standardsymbol. */
export function IconView(props: { icon: string | null | undefined; kind?: string; empty?: boolean; size?: number }) {
  const size = () => props.size ?? 18;
  return (
    <span class="page-icon" style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${size() * 0.9}px` }}>
      <Switch fallback={props.kind === "database" ? <IconTable /> : props.empty ? <IconPageEmpty /> : <IconPage />}>
        <Match when={isImageIcon(props.icon)}>
          <img src={props.icon!} alt="" draggable={false} />
        </Match>
        <Match when={props.icon}>
          <span class="emoji">{props.icon}</span>
        </Match>
      </Switch>
    </span>
  );
}

export function PageIcon(props: { id: ID; size?: number }) {
  const p = () => ws.pages[props.id];
  return <IconView icon={p()?.icon} kind={p()?.kind} size={props.size} />;
}
