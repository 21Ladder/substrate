export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: number | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type ColorName = (typeof COLORS)[number];

export const COLOR_LABELS: Record<ColorName, string> = {
  default: "Standard",
  gray: "Grau",
  brown: "Braun",
  orange: "Orange",
  yellow: "Gelb",
  green: "Grün",
  blue: "Blau",
  purple: "Lila",
  pink: "Pink",
  red: "Rot",
};

const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shortFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "gerade eben";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return dateFmt.format(ts);
}

export function formatDateTime(ts: number) {
  return dateTimeFmt.format(ts);
}

/** "YYYY-MM-DD" bzw. ISO-Zeitpunkt → lokales Date (Datumswerte ohne Zeit in lokaler Zeitzone). */
export function parseDateValue(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(s);
}

export function toDateValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDateValue(s: string, style: "full" | "short" | "relative" | "iso" = "full"): string {
  const d = parseDateValue(s);
  if (isNaN(d.getTime())) return s;
  const hasTime = s.includes("T");
  if (style === "iso") return s;
  if (style === "short") return shortFmt.format(d) + (hasTime ? " " + d.toTimeString().slice(0, 5) : "");
  if (style === "relative") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return "Heute" + (hasTime ? " " + d.toTimeString().slice(0, 5) : "");
    if (diff === 1) return "Morgen";
    if (diff === -1) return "Gestern";
  }
  return (hasTime ? dateTimeFmt : dateFmt).format(d);
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function extOf(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop()! : "";
  if (fromName) return fromName.toLowerCase();
  const sub = file.type.split("/")[1] ?? "bin";
  return sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/g, "");
}

/** Sichere URL für Links: nur http(s), mailto und interne Ziele. */
export function safeHref(href: string): string | null {
  const s = href.trim();
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return "https://" + s;
  return null;
}

export function pageTitle(t: string | null | undefined) {
  return t && t.trim() ? t : "Unbenannt";
}

/** Minimum/Maximum ohne Spread (Math.min(...xs) scheitert ab ~65k Elementen). */
export function minMax(xs: number[]): { min: number; max: number } | null {
  if (!xs.length) return null;
  let min = xs[0];
  let max = xs[0];
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

/** Zahl aus Text, tolerant gegenüber deutschem/englischem Format ("1.234,50", "1,234.50", "12 %"). */
export function parseLocaleNumber(raw: string): number | null {
  let s = raw.replace(/[\s%€$]/g, "").replace(/\u00a0/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Das zuletzt stehende Zeichen ist das Dezimaltrennzeichen
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Einzelnes Komma = Dezimalkomma (deutsch); mehrere Dreiergruppen = Tausendertrennung ("1,234,567")
    s = /^-?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Kalendertage addieren (sicher über Sommer-/Winterzeit hinweg). */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
}

/** Differenz in Kalendertagen (a − b), unabhängig von Uhrzeit und Zeitumstellung. */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
