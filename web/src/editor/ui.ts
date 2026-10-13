import { createRoot, createSignal } from "solid-js";
import type { EditorView } from "prosemirror-view";
import type { ID } from "../api/types";

// Gemeinsamer Zustand der schwebenden Editor-Menüs (Slash-Menü, Erwähnungen, Toolbar, Blockmenü).

export interface SuggestState {
  view: EditorView;
  /** Position des Auslösezeichens ("/", "@" oder "[["). */
  from: number;
  query: string;
  trigger: "/" | "@" | "[[";
  pageId: ID;
}

export interface BlockMenuState {
  view: EditorView;
  /** Top-Level-Index des Blocks. */
  index: number;
  rect: DOMRect;
  pageId: ID;
}

export interface LinkEditState {
  view: EditorView;
  from: number;
  to: number;
  href: string;
}

export const editorUI = createRoot(() => {
  const [suggest, setSuggest] = createSignal<SuggestState | null>(null);
  const [toolbar, setToolbar] = createSignal<{ view: EditorView; pageId: ID } | null>(null);
  const [blockMenu, setBlockMenu] = createSignal<BlockMenuState | null>(null);
  const [linkEdit, setLinkEdit] = createSignal<LinkEditState | null>(null);
  /** Wird bei jeder Editor-Änderung erhöht, damit Menüs ihre Position neu berechnen. */
  const [tick, setTick] = createSignal(0);
  return { suggest, setSuggest, toolbar, setToolbar, blockMenu, setBlockMenu, linkEdit, setLinkEdit, tick, bump: () => setTick((t) => t + 1) };
});

/** Pro Editor: Callbacks, die Plugins und NodeViews brauchen. */
export interface EditorContext {
  pageId: ID;
  readOnly: boolean;
  createSubpage: (view: EditorView) => Promise<void>;
  createDatabase: (view: EditorView, viewType: string, inline: boolean) => Promise<void>;
  docVersion: () => number;
  focusTitle?: () => void;
}

/** Zuordnung EditorView → Kontext (für Menüs, die nur die View kennen). */
export const editorContexts = new WeakMap<EditorView, EditorContext>();

/** Offene Editoren je Seite (für Änderungen von außen, z. B. neue Unterseite über die Sidebar). */
export const openEditors = new Map<ID, EditorView>();
