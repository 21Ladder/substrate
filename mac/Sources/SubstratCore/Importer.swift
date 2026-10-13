import Foundation

/// Liest Import-Quellen (Notion-Export als ZIP/Ordner, Markdown, CSV, HTML) ein.
/// Textdateien werden als Text zurückgegeben, Bilder und andere Dateien als Anhänge gespeichert.
/// Die eigentliche Umwandlung in Seiten passiert in der Web-UI.
/// Thread-sicher bezüglich der Datenbank: berührt nur das Dateisystem (Anhänge).
public final class Importer {
    let store: Store
    static let textExtensions: Set<String> = ["md", "markdown", "txt", "csv", "html", "htm"]
    static let maxFileSize = 50 * 1024 * 1024
    static let maxFiles = 20000
    /// Gesamtmenge an Text, die an die Oberfläche übergeben wird (begrenzt den Speicherbedarf).
    static let maxTextBytes = 300 * 1024 * 1024
    private var textBytes = 0

    private var budget: UnzipBudget
    private var warnings: [String] = []

    public init(store: Store, budget: UnzipBudget = UnzipBudget()) {
        self.store = store
        self.budget = budget
    }

    /// Ergebnis: `files` (Pfad + Text oder Anhang-URL) und `warnings` (übersprungene Archive o. Ä.).
    public func read(_ urls: [URL]) -> [String: Any] {
        var out: [[String: Any]] = []
        var temps: [URL] = []
        defer { for t in temps { try? FileManager.default.removeItem(at: t) } }

        for url in urls {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir {
                walk(url, prefix: url.lastPathComponent, into: &out, temps: &temps)
            } else if url.pathExtension.lowercased() == "zip" {
                if let dir = unzip(url) {
                    temps.append(dir)
                    walk(dir, prefix: url.deletingPathExtension().lastPathComponent, into: &out, temps: &temps)
                }
            } else {
                add(url, path: url.lastPathComponent, into: &out)
            }
        }
        return ["files": out, "warnings": warnings]
    }

    private func walk(_ root: URL, prefix: String, into out: inout [[String: Any]], temps: inout [URL]) {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
        let base = root.standardizedFileURL.path
        for case let file as URL in e {
            guard out.count < Importer.maxFiles else {
                warnings.append("Mehr als \(Importer.maxFiles) Dateien – der Rest wurde übersprungen.")
                return
            }
            // Symlinks und Sonderdateien werden nicht verfolgt (isRegularFile ist für Links false)
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let full = file.standardizedFileURL.path
            guard full.hasPrefix(base + "/") else { continue }
            let rel = prefix + "/" + String(full.dropFirst(base.count + 1))
            // Notion verschachtelt große Exporte in weitere ZIPs.
            if file.pathExtension.lowercased() == "zip" {
                if let dir = unzip(file) {
                    temps.append(dir)
                    // Nur die Endung entfernen (auch .ZIP), nicht „.zip“ mitten im Pfad
                    walk(dir, prefix: String(rel.dropLast(4)), into: &out, temps: &temps)
                }
                continue
            }
            add(file, path: rel, into: &out)
        }
    }

    private func add(_ file: URL, path: String, into out: inout [[String: Any]]) {
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Importer.maxFileSize else {
            warnings.append("„\(file.lastPathComponent)“ ist größer als 50 MB und wurde übersprungen.")
            return
        }
        let ext = file.pathExtension.lowercased()
        if Importer.textExtensions.contains(ext) {
            guard textBytes + size <= Importer.maxTextBytes else {
                if textBytes <= Importer.maxTextBytes {
                    warnings.append("Mehr als 300 MB Text – weitere Textdateien wurden übersprungen.")
                    textBytes = Importer.maxTextBytes + 1
                }
                return
            }
            guard let data = try? Data(contentsOf: file) else { return }
            textBytes += data.count
            let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
            out.append(["path": path, "text": text])
        } else if let name = try? store.saveAssetFile(file, ext: ext) {
            // Importierte Anhänge wie Downloads markieren: Gatekeeper prüft sie vor dem Öffnen
            if let url = store.assetURL(name) { AssetPolicy.quarantine(url) }
            out.append(["path": path, "url": "app://asset/\(name)", "size": size])
        }
    }

    /// Entpackt mit dem System-Werkzeug `ditto` – aber nur, wenn Größe und Dateianzahl ins Budget passen
    /// und danach noch genug Speicherplatz frei bleibt (Schutz vor ZIP-Bomben).
    func unzip(_ source: URL) -> URL? {
        let name = source.lastPathComponent
        let tempRoot = FileManager.default.temporaryDirectory
        // In der App-Sandbox dürfen Unterprozesse (zipinfo, ditto) verlässlich nur im eigenen Container lesen:
        // das gewählte Archiv deshalb zuerst dorthin kopieren.
        let zip: URL
        if source.standardizedFileURL.path.hasPrefix(tempRoot.standardizedFileURL.path) {
            zip = source
        } else {
            let copy = tempRoot.appendingPathComponent("substrat-zip-\(UUID().uuidString).zip")
            let size = Int64((try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            if let free = ZipInspector.availableCapacity(at: tempRoot), free - size < budget.reserveBytes {
                warnings.append("Nicht genug freier Speicherplatz, um „\(name)“ zu verarbeiten.")
                return nil
            }
            do {
                try FileManager.default.copyItem(at: source, to: copy)
            } catch {
                warnings.append("„\(name)“ konnte nicht gelesen werden.")
                return nil
            }
            zip = copy
        }
        defer { if zip != source { try? FileManager.default.removeItem(at: zip) } }
        guard let totals = ZipInspector.totals(of: zip) else {
            warnings.append("„\(name)“ ist kein lesbares ZIP-Archiv.")
            return nil
        }
        let free = ZipInspector.availableCapacity(at: tempRoot) ?? Int64.max
        if totals.bytes > budget.remainingBytes || totals.files > budget.remainingFiles {
            warnings.append("„\(name)“ ist entpackt zu groß (\(ByteCountFormatter.string(fromByteCount: totals.bytes, countStyle: .file)), \(totals.files) Dateien) und wurde übersprungen.")
            return nil
        }
        if free - totals.bytes < budget.reserveBytes {
            warnings.append("Nicht genug freier Speicherplatz, um „\(name)“ zu entpacken.")
            return nil
        }
        budget.remainingBytes -= totals.bytes
        budget.remainingFiles -= totals.files

        let dir = tempRoot.appendingPathComponent("substrat-import-\(UUID().uuidString)")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, dir.path]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return nil
        }
        guard p.terminationStatus == 0 else {
            try? FileManager.default.removeItem(at: dir)
            warnings.append("„\(name)“ konnte nicht entpackt werden.")
            return nil
        }
        return dir
    }
}
