// Fractional Indexing: Sortierschlüssel, zwischen die sich immer ein weiterer einfügen lässt.
// Schlüssel bestehen nur aus Base62-Ziffern und werden per einfachem String-Vergleich sortiert
// (identisch zur BINARY-Sortierung in SQLite).

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digit(c: string | undefined): number {
  return c === undefined ? 0 : DIGITS.indexOf(c);
}

/** Liefert einen Schlüssel strikt zwischen a und b (beide optional, a < b). */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? "";
  const hi = b ?? null;
  if (hi !== null && lo >= hi) throw new Error(`keyBetween: ${lo} >= ${hi}`);
  let result = "";
  for (let i = 0; ; i++) {
    const dl = digit(lo[i]);
    const dh = hi === null ? BASE : i < hi.length ? digit(hi[i]) : 0;
    if (hi !== null && i >= hi.length) {
      // hi ist ein Präfix des bisherigen Ergebnisses – kann nicht passieren, da lo < hi
      throw new Error("keyBetween: invalid range");
    }
    if (dh - dl > 1) {
      const mid = Math.floor((dl + dh) / 2);
      return result + DIGITS[mid];
    }
    // Ziffer übernehmen und eine Stelle weiter suchen
    result += DIGITS[dl];
    if (dh - dl === 1) {
      // Ab hier ist hi irrelevant: alles, was mit result beginnt und > lo ist, liegt unter hi.
      return result + keyAfter(lo.slice(i + 1));
    }
  }
}

/** Schlüssel, der größer als `suffix` ist (bei gleichem Präfix). */
function keyAfter(suffix: string): string {
  let result = "";
  for (let i = 0; ; i++) {
    const d = digit(suffix[i]);
    if (d < BASE - 1) {
      const mid = Math.floor((d + BASE) / 2);
      if (mid > d) return result + DIGITS[mid];
    }
    result += DIGITS[d];
  }
}

/** n Schlüssel gleichmäßig zwischen a und b. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  // Ohne Grenzen (z. B. Import): gleich breite, gleichmäßig verteilte Schlüssel – kurz auch bei Tausenden
  if (a === null && b === null) return evenKeys(n);
  const keys: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    const k = keyBetween(prev, b);
    keys.push(k);
    prev = k;
  }
  return keys;
}

/** n gleichmäßig verteilte Schlüssel fester Breite (ohne Null am Ende, damit davor immer Platz bleibt). */
function evenKeys(n: number): string[] {
  let width = 1;
  while (BASE ** width < n + 1) width++;
  const space = BASE ** width;
  const keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * space) / (n + 1));
    let k = "";
    for (let w = 0; w < width; w++) {
      k = DIGITS[v % BASE] + k;
      v = Math.floor(v / BASE);
    }
    // Endende Nullen weglassen: Reihenfolge bleibt gleich (alle Schlüssel gleich breit), Einfügen davor bleibt möglich
    keys.push(k.replace(/0+$/, "") || DIGITS[1]);
  }
  return keys;
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Robuste Variante für die App: hängt eine zufällige Endung an (verhindert, dass zwei Geräte/Aktionen
 * denselben Schlüssel erzeugen) und weicht bei ungültigem Bereich (a ≥ b) hinter a aus statt zu werfen.
 */
export function newSortKey(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a || null;
  const hi = b || null;
  const base = hi !== null && lo !== null && lo >= hi ? keyBetween(lo, null) : keyBetween(lo, hi);
  // Endung aus 1–z: bleibt strikt zwischen a und b, da base kein Präfix von b ist
  let suffix = "";
  for (let i = 0; i < 2; i++) suffix += DIGITS[1 + Math.floor(Math.random() * (BASE - 1))];
  return base + suffix;
}
