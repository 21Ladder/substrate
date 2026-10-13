import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import { navigation } from "../state/workspace";
import { hasPopover } from "./popovers";
import { PageView } from "./PageView";
import { IconDoubleChevronRight, IconOpen } from "./Icons";

/** Seitenvorschau rechts (Notion "Side Peek") – z. B. für Datenbankeinträge. */
export function SidePeek() {
  return (
    <Show when={navigation.peek()} keyed>
      {(id) => (
        <Portal>
          <div
            class="peek-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !hasPopover()) navigation.setPeek(null);
            }}
          >
            <div class="peek">
              <div class="peek-bar">
                <button class="icon-btn" title="Schließen (esc)" onClick={() => navigation.setPeek(null)}>
                  <IconDoubleChevronRight />
                </button>
                <button class="icon-btn" title="Als ganze Seite öffnen" onClick={() => navigation.open(id)}>
                  <IconOpen />
                </button>
              </div>
              <div class="peek-scroll page-scroller">
                <PageView id={id} peek />
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
