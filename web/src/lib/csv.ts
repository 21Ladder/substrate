import type { PropertyDef, SelectOption } from "../api/types";
import { shortId } from "./id";
import { COLORS, parseLocaleNumber } from "./util";

// ---------- CSV ----------

export function parseCSV(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      // Nur am Feldanfang (Leerzeichen davor erlaubt) – sonst z. B. Zoll-Zeichen: Monitor 27"
      quoted = true;
      cell = "";
    }
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function toCSV(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", mär: "03", apr: "04", may: "05", mai: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", okt: "10", nov: "11", dec: "12", dez: "12",
};

/** Erkennt Datumsangaben in gängigen Formaten (ISO, deutsch, Notion-Export auf Englisch). */
export function parseLooseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // "October 7, 2026", "7. Oktober 2026" (auch mit Uhrzeit dahinter)
  m = /^([A-Za-zäÄ]+)\.? (\d{1,2}),? (\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (month) return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})\.? ([A-Za-zäÄ]+)\.? (\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (month) return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** Leitet aus CSV-Spalten passende Eigenschaftstypen ab. */
export function inferSchema(header: string[], rows: string[][]): PropertyDef[] {
  return header.map((name, col) => {
    if (col === 0) return { id: "title", name: name || "Name", type: "title" } as PropertyDef;
    const values = rows.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    const id = shortId();
    if (!values.length) return { id, name, type: "text" } as PropertyDef;
    if (values.every((v) => /^(yes|no|ja|nein|true|false|✓|x)$/i.test(v))) return { id, name, type: "checkbox" };
    if (values.every((v) => /^-?[\d.,]+\s?%?$/.test(v) && parseLocaleNumber(v) !== null)) {
      return { id, name, type: "number", format: values.some((v) => v.includes("%")) ? "percent" : "number" };
    }
    if (values.every((v) => parseLooseDate(v))) return { id, name, type: "date" };
    if (values.every((v) => /^https?:\/\//.test(v))) return { id, name, type: "url" };
    if (values.every((v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v))) return { id, name, type: "email" };
    const parts = values.flatMap((v) => v.split(",").map((x) => x.trim()));
    const distinct = new Set(parts);
    const avgLen = parts.reduce((a, b) => a + b.length, 0) / parts.length;
    if (avgLen < 30 && distinct.size <= Math.max(12, values.length / 2)) {
      const multi = values.some((v) => v.includes(","));
      const options: SelectOption[] = [...distinct].map((n, i) => ({ id: shortId(), name: n, color: COLORS[1 + (i % (COLORS.length - 1))] }));
      if (/^status$/i.test(name) && !multi) {
        return {
          id,
          name,
          type: "status",
          options: options.map((o) => ({ ...o, group: /done|fertig|erledigt|complete/i.test(o.name) ? ("done" as const) : /progress|bearbeitung|doing/i.test(o.name) ? ("progress" as const) : ("todo" as const) })),
        };
      }
      return { id, name, type: multi ? "multi_select" : "select", options };
    }
    return { id, name, type: "text" };
  });
}

