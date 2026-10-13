#!/bin/zsh
# Baut Substrat.app: Web-UI (Vite) + Swift-Shell, signiert mit App-Sandbox und Hardened Runtime.
# Aufruf: scripts/build-app.sh [--debug]
#   SIGN_IDENTITY="Developer ID Application: …"  → mit eigenem Zertifikat signieren (sonst ad hoc)
#   NOTARIZE_PROFILE=<notarytool-Profil>          → zusätzlich notarisieren (nur mit Developer ID)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG=release
[[ "${1:-}" == "--debug" ]] && CONFIG=debug

echo "→ Web-UI bauen"
cd "$ROOT/web"
[[ -d node_modules ]] || npm ci --ignore-scripts
npx tsc --noEmit -p .
rm -rf "$ROOT/build/web"
if [[ "$CONFIG" == "debug" ]]; then
  # Debug-Build enthält den automatischen Oberflächentest
  VITE_SELFTEST=1 npx vite build --logLevel warn
else
  npx vite build --logLevel warn
fi

# seroval ist per Override auf eine abgesicherte Version festgelegt und darf nur in Solids Server-Code stecken
if grep -qr "seroval" "$ROOT/build/web"; then
  echo "✗ seroval ist im App-Bundle gelandet – Override in web/package.json prüfen"
  exit 1
fi

echo "→ Swift-Shell bauen ($CONFIG)"
cd "$ROOT/mac"
swift build -c "$CONFIG" --product Substrat
BIN="$(swift build -c "$CONFIG" --show-bin-path)/Substrat"

echo "→ App-Bundle zusammenstellen"
APP="$ROOT/build/Substrat.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Substrat"
cp -R "$ROOT/build/web" "$APP/Contents/Resources/web"
[[ -f "$ROOT/mac/AppIcon.icns" ]] && cp "$ROOT/mac/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/mac/container-migration.plist" "$APP/Contents/Resources/container-migration.plist"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Substrat</string>
  <key>CFBundleDisplayName</key><string>Substrat</string>
  <key>CFBundleIdentifier</key><string>dev.substrat.app</string>
  <key>CFBundleExecutable</key><string>Substrat</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSHumanReadableCopyright</key><string>Substrat – lokal, schnell, verbunden.</string>
</dict>
</plist>
PLIST
IDENTITY="${SIGN_IDENTITY:--}"
# Mit echtem Zertifikat sicherer Zeitstempel (für Notarisierung nötig), ad hoc ohne
TIMESTAMP="--timestamp=none"
[[ "$IDENTITY" != "-" ]] && TIMESTAMP="--timestamp"
# Ad hoc: Die Standard-Anforderung wäre der Hash des Builds – jeder Neubau sähe für macOS wie eine andere App
# aus (Rückfrage beim Zugriff auf den Sandbox-Container). Für lokale Builds daher an die Bundle-ID binden.
# Für die Weitergabe mit SIGN_IDENTITY signieren; dann gilt die übliche zertifikatsbasierte Anforderung.
REQ=()
[[ "$IDENTITY" == "-" ]] && REQ=(--requirements '=designated => identifier "dev.substrat.app"')
codesign --force --options runtime "$TIMESTAMP" "${REQ[@]}" --entitlements "$ROOT/mac/Substrat.entitlements" --sign "$IDENTITY" "$APP" >/dev/null
codesign --verify --strict "$APP"
if [[ -n "${NOTARIZE_PROFILE:-}" && "$IDENTITY" != "-" ]]; then
  echo "→ Notarisieren"
  ZIP="$ROOT/build/Substrat-notarize.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARIZE_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
fi
echo "✓ $APP ($(du -sh "$APP" | cut -f1))"
