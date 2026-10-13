#!/bin/zsh
# Prüft die npm-Abhängigkeiten vor einem Update oder Release:
#  1. bekannte Schwachstellen (npm audit)
#  2. gültige Registry-Signaturen (npm audit signatures)
#  3. keine Install-Skripte aktiv (.npmrc ignore-scripts)
#  4. jede installierte Version ist mindestens MIN_AGE_DAYS alt
#     (kompromittierte Versionen werden in der Regel innerhalb von Stunden bis Tagen entdeckt)
# Neue Versionen installieren: npm install <paket>@<version> --before="$(date -v-7d +%Y-%m-%d)"
set -euo pipefail
cd "$(dirname "$0")/../web"
MIN_AGE_DAYS="${MIN_AGE_DAYS:-7}"

echo "→ npm audit"
npm audit --audit-level=low
echo "→ Signaturen"
npm audit signatures
echo "→ Install-Skripte"
grep -q "^ignore-scripts=true" .npmrc || { echo "✗ .npmrc muss ignore-scripts=true enthalten"; exit 1; }
echo "→ Alter der Versionen (mind. $MIN_AGE_DAYS Tage)"
node --input-type=module -e '
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
const run = promisify(execFile);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const min = Number(process.env.MIN_AGE_DAYS ?? 7) * 86400000;
const now = Date.now();
const seen = new Map();
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || info.link) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + 13);
  seen.set(`${name}@${info.version}`, { name, version: info.version, dev: !!info.dev });
}
// Veröffentlichungszeiten je Paketname einmal abrufen, 8 Abfragen gleichzeitig (statt Hunderte nacheinander)
const names = [...new Set([...seen.values()].map((p) => p.name))];
const times = new Map();
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < names.length) {
    const name = names[next++];
    try {
      const { stdout } = await run("npm", ["view", name, "time", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      times.set(name, JSON.parse(stdout));
    } catch {
      times.set(name, null);
    }
  }
}));
let bad = 0;
for (const { name, version, dev } of seen.values()) {
  const info = times.get(name);
  if (!info) {
    bad++;
    console.log(`✗ ${name}@${version}: Veröffentlichungszeit nicht abrufbar – Alter nicht prüfbar`);
    continue;
  }
  const t = Date.parse(info[version] ?? "");
  const age = (now - t) / 86400000;
  if (!Number.isFinite(t) || now - t < min) {
    bad++;
    console.log(`✗ ${name}@${version} ist erst ${age.toFixed(1)} Tage alt${dev ? " (nur Build)" : " (LAUFZEIT)"}`);
  }
}
if (bad) { console.log(`${bad} zu junge Versionen – vor dem Release erneut prüfen oder ältere Version wählen.`); process.exit(2); }
console.log(`✓ ${seen.size} Pakete, alle älter als ${process.env.MIN_AGE_DAYS ?? 7} Tage`);
'
