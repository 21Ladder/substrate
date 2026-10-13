import { api, isNative } from "../api/client";

/** Fenster über leere Bereiche der Titelleiste ziehen (wie die native Titelleiste). */
export function startWindowDrag(e: MouseEvent) {
  if (!isNative || e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest("button, input, a, select, textarea, [contenteditable=true], .sb-workspace, .crumb, .no-drag")) return;
  if (e.detail === 2) {
    void api.windowZoom();
    return;
  }
  void api.windowDrag();
}
