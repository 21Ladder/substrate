import { createSignal, onMount, Show } from "solid-js";
import { ui } from "../state/ui";
import { IconChevronDown, IconClose } from "./Icons";

// WebKit unterstützt window.find() – reicht für eine schlanke Suche in der Seite (⌘F).
type FindFn = (s: string, caseSensitive: boolean, backwards: boolean, wrap: boolean) => boolean;

export function FindBar() {
  return (
    <Show when={ui.findBar()}>
      <FindBarInner />
    </Show>
  );
}

function FindBarInner() {
  const [q, setQ] = createSignal("");
  const [miss, setMiss] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => {
    const sel = window.getSelection()?.toString() ?? "";
    if (sel && sel.length < 80) setQ(sel);
    input.focus();
    input.select();
  });
  const find = (backwards = false) => {
    const f = (window as unknown as { find?: FindFn }).find;
    if (!f || !q()) return;
    const ok = f(q(), false, backwards, true);
    setMiss(!ok);
    // Fokus zurück ins Suchfeld (window.find verschiebt die Auswahl)
    input.focus();
  };
  return (
    <div class="find-bar">
      <input
        ref={input}
        classList={{ miss: miss() }}
        placeholder="In Seite suchen"
        value={q()}
        onInput={(e) => {
          setQ(e.currentTarget.value);
          setMiss(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            find(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            ui.setFindBar(false);
          }
        }}
      />
      <button class="icon-btn small" title="Vorheriger Treffer (⇧↵)" onClick={() => find(true)}>
        <IconChevronDown style={{ transform: "rotate(180deg)" }} />
      </button>
      <button class="icon-btn small" title="Nächster Treffer (↵)" onClick={() => find(false)}>
        <IconChevronDown />
      </button>
      <button class="icon-btn small" title="Schließen" onClick={() => ui.setFindBar(false)}>
        <IconClose />
      </button>
    </div>
  );
}
