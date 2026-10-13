import CryptoKit
import Foundation
import os

public struct StoreError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// Lokaler Datenspeicher. Alle Methoden laufen auf einer seriellen Queue (siehe Bridge).
/// Komplexe Felder (Inhalt, Eigenschaften, Schema, Ansichten) werden als JSON-Strings
/// durchgereicht; der Store interpretiert sie nicht.
public final class Store {
    public let db: SQLiteDB
    public let directory: URL
    public let assetsDir: URL

    /// Abstand zwischen zwei Versions-Snapshots einer Seite.
    static let snapshotInterval = 10 * 60 * 1000
    static let snapshotsPerPage = 50

    public init(directory: URL) throws {
        self.directory = directory
        self.assetsDir = directory.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
        db = try SQLiteDB(path: directory.appendingPathComponent("workspace.sqlite").path)
        try migrate()
    }

    static func now() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func migrate() throws {
        try db.exec("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL; -- Notizen überstehen auch Stromausfall (WAL+NORMAL könnte die letzten Sekunden verlieren)
        PRAGMA temp_store=MEMORY;
        """)
        let version = (try db.scalar("PRAGMA user_version") as? Int) ?? 0
        if version < 1 {
            try db.transaction {
                try db.exec("""
                CREATE TABLE pages(
                  rid INTEGER PRIMARY KEY,
                  id TEXT NOT NULL UNIQUE,
                  parent_id TEXT,
                  database_id TEXT,
                  kind TEXT NOT NULL DEFAULT 'page',
                  title TEXT NOT NULL DEFAULT '',
                  icon TEXT,
                  cover TEXT,
                  sort_key TEXT NOT NULL DEFAULT '',
                  favorite INTEGER NOT NULL DEFAULT 0,
                  inline INTEGER NOT NULL DEFAULT 0,
                  props TEXT NOT NULL DEFAULT '{}',
                  content TEXT,
                  settings TEXT NOT NULL DEFAULT '{}',
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  deleted_at INTEGER,
                  trash_root INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX pages_parent ON pages(parent_id, sort_key);
                CREATE INDEX pages_database ON pages(database_id, sort_key);
                CREATE INDEX pages_deleted ON pages(deleted_at);
                CREATE TABLE databases(
                  id TEXT PRIMARY KEY,
                  schema TEXT NOT NULL,
                  views TEXT NOT NULL
                );
                CREATE TABLE links(
                  src TEXT NOT NULL,
                  dst TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  prop TEXT NOT NULL DEFAULT '',
                  PRIMARY KEY(src, dst, kind, prop)
                ) WITHOUT ROWID;
                CREATE INDEX links_dst ON links(dst);
                CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize="unicode61 remove_diacritics 2");
                CREATE TABLE history(
                  id INTEGER PRIMARY KEY,
                  page_id TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  title TEXT NOT NULL,
                  content TEXT
                );
                CREATE INDEX history_page ON history(page_id, created_at);
                CREATE TABLE layouts(scope TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                PRAGMA user_version = 1;
                """)
            }
        }
    }

    // MARK: - Seiten

    private static let metaColumns = """
    id, parent_id AS parentId, database_id AS databaseId, kind, title, icon, sort_key AS sortKey,
    favorite, inline, created_at AS createdAt, updated_at AS updatedAt
    """

    public func bootstrap() throws -> [String: Any] {
        let pages = try db.query("SELECT \(Store.metaColumns) FROM pages WHERE deleted_at IS NULL ORDER BY sort_key, id")
        let settings = try db.query("SELECT key, value FROM settings")
        var map: [String: Any] = [:]
        for row in settings { if let k = row["key"] as? String { map[k] = row["value"] } }
        return ["pages": pages, "settings": map]
    }

    public func getPage(_ id: String) throws -> [String: Any]? {
        try db.query("""
        SELECT \(Store.metaColumns), cover, props, content, settings, deleted_at AS deletedAt
        FROM pages WHERE id = ?
        """, id).first
    }

    public func getPages(_ ids: [String]) throws -> [[String: Any]] {
        try ids.compactMap { try getPage($0) }
    }

    public func createPage(_ p: [String: Any]) throws -> [String: Any] {
        guard let id = p["id"] as? String, !id.isEmpty else { throw StoreError("id fehlt") }
        let now = Store.now()
        let kind = (p["kind"] as? String) ?? "page"
        let title = (p["title"] as? String) ?? ""
        try db.transaction {
            try db.run("""
            INSERT INTO pages(id, parent_id, database_id, kind, title, icon, cover, sort_key, inline, props, content, settings, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, args: [
                id, p["parentId"], p["databaseId"], kind, title, p["icon"], p["cover"],
                (p["sortKey"] as? String) ?? "", (p["inline"] as? Bool) ?? false,
                (p["props"] as? String) ?? "{}", p["content"], (p["settings"] as? String) ?? "{}", now, now,
            ])
            let rid = try db.scalar("SELECT rid FROM pages WHERE id = ?", id)
            try db.run("INSERT INTO search(rowid, title, body) VALUES(?, ?, ?)", rid, title, (p["text"] as? String) ?? "")
            if kind == "database" {
                try db.run("INSERT INTO databases(id, schema, views) VALUES(?, ?, ?)",
                           id, (p["schema"] as? String) ?? "[]", (p["views"] as? String) ?? "[]")
            }
            if let links = p["links"] as? [String: Any] { try replaceLinks(src: id, links) }
        }
        return try getPage(id) ?? [:]
    }

    private static let patchColumns: [(key: String, column: String, touches: Bool)] = [
        ("title", "title", true), ("icon", "icon", true), ("cover", "cover", true),
        ("props", "props", true), ("content", "content", true), ("settings", "settings", false),
        ("sortKey", "sort_key", false), ("parentId", "parent_id", false),
        ("databaseId", "database_id", false), ("favorite", "favorite", false), ("inline", "inline", false),
    ]

    public func updatePage(_ id: String, _ patch: [String: Any]) throws -> [String: Any] {
        let now = Store.now()
        var sets: [String] = []
        var args: [Any?] = []
        var touches = false
        for col in Store.patchColumns where patch.keys.contains(col.key) {
            sets.append("\(col.column) = ?")
            let value = patch[col.key]
            args.append(value is NSNull ? nil : value)
            touches = touches || col.touches
        }
        if let propsPatch = patch["propsPatch"] as? String {
            // RFC 7396 Merge-Patch: null entfernt einen Schlüssel, alles andere wird ersetzt
            sets.append("props = json_patch(props, ?)")
            args.append(propsPatch)
            touches = true
        }
        if touches {
            sets.append("updated_at = ?")
            args.append(now)
        }
        try db.transaction {
            guard let rid = try db.scalar("SELECT rid FROM pages WHERE id = ?", id) else {
                throw StoreError("Seite \(id) nicht gefunden")
            }
            // Version des bisherigen Inhalts sichern, bevor er überschrieben wird
            if patch["content"] != nil { try snapshot(id, now: now, force: (patch["snapshot"] as? Bool) == true) }
            if !sets.isEmpty {
                try db.run("UPDATE pages SET \(sets.joined(separator: ", ")) WHERE id = ?", args: args + [id])
            }
            if let title = patch["title"] as? String {
                try db.run("UPDATE search SET title = ? WHERE rowid = ?", title, rid)
            }
            if let text = patch["text"] as? String {
                try db.run("UPDATE search SET body = ? WHERE rowid = ?", text, rid)
            }
            if let links = patch["links"] as? [String: Any] { try replaceLinks(src: id, links) }
        }
        return ["id": id, "updatedAt": touches ? now : ((try db.scalar("SELECT updated_at FROM pages WHERE id = ?", id)) ?? now)]
    }

    /// Ersetzt die Links einer Seite für die angegebenen Arten (z. B. nur Erwähnungen aus dem Inhalt).
    private func replaceLinks(src: String, _ links: [String: Any]) throws {
        let kinds = (links["kinds"] as? [String]) ?? []
        for kind in kinds { try db.run("DELETE FROM links WHERE src = ? AND kind = ?", src, kind) }
        for item in (links["items"] as? [[String: Any]]) ?? [] {
            guard let dst = item["dst"] as? String, let kind = item["kind"] as? String, dst != src else { continue }
            try db.run("INSERT OR IGNORE INTO links(src, dst, kind, prop) VALUES(?, ?, ?, ?)",
                       src, dst, kind, (item["prop"] as? String) ?? "")
        }
    }

    /// Speichert den aktuellen (noch nicht überschriebenen) Inhalt als Version –
    /// höchstens einmal pro Intervall, außer `force` (z. B. vor dem Wiederherstellen einer Version).
    private func snapshot(_ id: String, now: Int, force: Bool = false) throws {
        let last = (try db.scalar("SELECT MAX(created_at) FROM history WHERE page_id = ?", id) as? Int) ?? 0
        guard force || now - last >= Store.snapshotInterval else { return }
        try db.run("""
        INSERT INTO history(page_id, created_at, title, content)
        SELECT id, ?, title, content FROM pages WHERE id = ? AND content IS NOT NULL
        """, now, id)
        try db.run("""
        DELETE FROM history WHERE page_id = ? AND id NOT IN
          (SELECT id FROM history WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)
        """, id, id, Store.snapshotsPerPage)
    }

    private func subtree(_ id: String, deletedAt: Int?) throws -> [String] {
        let rows: [[String: Any]]
        if let deletedAt {
            rows = try db.query("""
            WITH RECURSIVE sub(id) AS (
              SELECT ? UNION SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
              WHERE p.deleted_at = ? AND p.trash_root = 0
            ) SELECT id FROM sub
            """, id, deletedAt)
        } else {
            rows = try db.query("""
            WITH RECURSIVE sub(id) AS (
              SELECT ? UNION SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
            ) SELECT id FROM sub
            """, id)
        }
        return rows.compactMap { $0["id"] as? String }
    }

    /// Verschiebt eine Seite samt Unterseiten in den Papierkorb. Gibt alle betroffenen IDs zurück.
    public func trashPage(_ id: String) throws -> [String] {
        let now = Store.now()
        return try db.transaction {
            let ids = try subtree(id, deletedAt: nil)
            for sub in ids {
                try db.run("UPDATE pages SET deleted_at = ?, trash_root = ? WHERE id = ? AND deleted_at IS NULL", now, sub == id, sub)
            }
            return ids
        }
    }

    public func restorePage(_ id: String) throws -> [String] {
        try db.transaction {
            guard let deletedAt = try db.scalar("SELECT deleted_at FROM pages WHERE id = ?", id) as? Int else { return [] }
            let ids = try subtree(id, deletedAt: deletedAt)
            for sub in ids {
                try db.run("UPDATE pages SET deleted_at = NULL, trash_root = 0 WHERE id = ?", sub)
            }
            // Ist das Elternelement weg, landet die Seite auf oberster Ebene.
            try db.run("""
            UPDATE pages SET parent_id = NULL, database_id = NULL WHERE id = ? AND parent_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = pages.parent_id AND p.deleted_at IS NULL)
            """, id)
            return ids
        }
    }

    /// Löscht eine Seite und alle Nachfahren endgültig – nur, wenn sie im Papierkorb liegt.
    /// (Schutz gegen versehentliches oder bösartiges Löschen lebender Seiten über die Bridge.)
    public func purgePage(_ id: String) throws {
        try db.transaction {
            let found = try db.query("SELECT deleted_at AS d FROM pages WHERE id = ?", id)
            // Bereits gelöscht (z. B. als Nachfahre einer anderen Papierkorb-Seite): nichts zu tun
            guard let row = found.first else { return }
            guard row["d"] is Int else {
                throw StoreError("Nur Seiten im Papierkorb können endgültig gelöscht werden.")
            }
            let rows = try db.query("""
            WITH RECURSIVE sub(id) AS (
              SELECT ? UNION SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
            ) SELECT id FROM sub
            """, id)
            for row in rows {
                guard let sub = row["id"] as? String else { continue }
                try db.run("DELETE FROM search WHERE rowid = (SELECT rid FROM pages WHERE id = ?)", sub)
                try db.run("DELETE FROM links WHERE src = ? OR dst = ?", sub, sub)
                try db.run("DELETE FROM history WHERE page_id = ?", sub)
                try db.run("DELETE FROM databases WHERE id = ?", sub)
                try db.run("DELETE FROM pages WHERE id = ?", sub)
            }
        }
    }

    public func listTrash() throws -> [[String: Any]] {
        try db.query("""
        SELECT id, title, icon, kind, parent_id AS parentId, deleted_at AS deletedAt
        FROM pages WHERE deleted_at IS NOT NULL AND trash_root = 1 ORDER BY deleted_at DESC
        """)
    }

    public func purgeExpiredTrash(olderThanDays days: Int = 30) throws {
        let cutoff = Store.now() - days * 24 * 3600 * 1000
        let rows = try db.query("SELECT id FROM pages WHERE trash_root = 1 AND deleted_at < ?", cutoff)
        // Einzelfehler sollen die übrigen abgelaufenen Seiten nicht blockieren, aber sichtbar bleiben
        for row in rows {
            guard let id = row["id"] as? String else { continue }
            do { try purgePage(id) } catch { Store.log.error("Papierkorb: \(id, privacy: .public) konnte nicht endgültig gelöscht werden: \(String(describing: error), privacy: .public)") }
        }
    }

    // MARK: - Datenbanken

    public func getDatabase(_ id: String) throws -> [String: Any]? {
        guard var db0 = try db.query("SELECT id, schema, views FROM databases WHERE id = ?", id).first else { return nil }
        db0["rows"] = try db.query("""
        SELECT id, title, icon, cover, props, sort_key AS sortKey, created_at AS createdAt, updated_at AS updatedAt
        FROM pages WHERE database_id = ? AND deleted_at IS NULL ORDER BY sort_key, id
        """, id)
        return db0
    }

    public func updateDatabase(_ id: String, _ patch: [String: Any]) throws {
        try db.transaction {
            if let schema = patch["schema"] as? String {
                try db.run("UPDATE databases SET schema = ? WHERE id = ?", schema, id)
            }
            if let views = patch["views"] as? String {
                try db.run("UPDATE databases SET views = ? WHERE id = ?", views, id)
            }
        }
    }

    // MARK: - Suche, Links, Graph

    /// Baut eine sichere FTS5-Abfrage: jedes Wort wird als Präfix-Phrase gesucht.
    static func ftsQuery(_ input: String) -> String {
        input.split(whereSeparator: { $0.isWhitespace })
            .map { $0.replacingOccurrences(of: "\"", with: "") }
            .filter { !$0.isEmpty }
            .map { "\"\($0)\"*" }
            .joined(separator: " ")
    }

    public func search(_ input: String, limit: Int = 30) throws -> [[String: Any]] {
        let q = Store.ftsQuery(input)
        guard !q.isEmpty else { return [] }
        var results = try db.query("""
        SELECT p.id, p.title, p.icon, p.kind, p.parent_id AS parentId, p.database_id AS databaseId,
               p.updated_at AS updatedAt, snippet(search, 1, char(1), char(2), '…', 12) AS snippet
        FROM search JOIN pages p ON p.rid = search.rowid
        WHERE search MATCH ? AND p.deleted_at IS NULL
        ORDER BY bm25(search, 10.0, 1.0) LIMIT ?
        """, q, limit)
        if results.count < limit {
            // Teilwort-Treffer im Titel (z. B. "otion" findet "Notion").
            let seen = Set(results.compactMap { $0["id"] as? String })
            let escaped = input.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "%", with: "\\%")
                .replacingOccurrences(of: "_", with: "\\_")
            let extra = try db.query("""
            SELECT id, title, icon, kind, parent_id AS parentId, database_id AS databaseId, updated_at AS updatedAt, '' AS snippet
            FROM pages WHERE deleted_at IS NULL AND title LIKE '%' || ? || '%' ESCAPE '\\'
            ORDER BY updated_at DESC LIMIT ?
            """, escaped, limit)
            for row in extra where results.count < limit {
                if let id = row["id"] as? String, !seen.contains(id) { results.append(row) }
            }
        }
        return results
    }

    public func backlinks(_ id: String) throws -> [[String: Any]] {
        try db.query("""
        SELECT DISTINCT p.id, p.title, p.icon, p.kind FROM links l JOIN pages p ON p.id = l.src
        WHERE l.dst = ? AND p.deleted_at IS NULL AND l.kind = 'mention'
        ORDER BY p.title
        """, id)
    }

    public func graphEdges() throws -> [[String: Any]] {
        try db.query("""
        SELECT l.src, l.dst, l.kind, l.prop FROM links l
        JOIN pages a ON a.id = l.src JOIN pages b ON b.id = l.dst
        WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
        """)
    }

    // MARK: - Verlauf

    public func history(_ pageId: String) throws -> [[String: Any]] {
        try db.query("SELECT id, created_at AS createdAt, title FROM history WHERE page_id = ? ORDER BY created_at DESC", pageId)
    }

    public func historyEntry(_ id: Int) throws -> [String: Any]? {
        try db.query("SELECT id, page_id AS pageId, created_at AS createdAt, title, content FROM history WHERE id = ?", id).first
    }

    // MARK: - Einstellungen & Layouts

    public func setSetting(_ key: String, _ value: String?) throws {
        if let value {
            try db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
        } else {
            try db.run("DELETE FROM settings WHERE key = ?", key)
        }
    }

    public func layout(_ scope: String) throws -> String? {
        try db.scalar("SELECT data FROM layouts WHERE scope = ?", scope) as? String
    }

    public func saveLayout(_ scope: String, _ data: String) throws {
        try db.run("INSERT INTO layouts(scope, data) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data", scope, data)
    }

    // MARK: - Backups & Integrität

    public var backupsDir: URL { directory.appendingPathComponent("Backups", isDirectory: true) }

    public enum BackupKind: String { case daily, manual }

    static let log = Logger(subsystem: "dev.substrat.app", category: "store")

    /// Erstellt ein Backup per `VACUUM INTO` über eine eigene, nur lesende Verbindung – blockiert also
    /// weder die Speicher-Queue noch das Beenden. Geschrieben wird unter temporärem Namen und erst danach
    /// umbenannt, damit ein Abbruch kein halbes Backup hinterlässt. Täglich höchstens eines; behalten werden
    /// die letzten 7 täglichen und 5 manuellen. Anhänge werden nie verändert und müssen nicht mitgesichert werden.
    /// Backups laufen nie gleichzeitig (tägliches im Hintergrund und „Backup jetzt“ könnten sich sonst
    /// gegenseitig die temporären Dateien löschen oder während des Aufräumens schreiben).
    private static let backupLock = NSLock()

    @discardableResult
    public static func backup(directory: URL, kind: BackupKind, now: Date = Date(), keepDaily: Int = 7, keepManual: Int = 5) throws -> URL? {
        backupLock.lock()
        defer { backupLock.unlock() }
        let dir = directory.appendingPathComponent("Backups", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Reste abgebrochener Backups entfernen
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "part" {
            try? FileManager.default.removeItem(at: f)
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = kind == .daily ? "yyyy-MM-dd" : "yyyy-MM-dd-HHmmss"
        let target = dir.appendingPathComponent("workspace-\(kind.rawValue)-\(f.string(from: now)).sqlite")
        if FileManager.default.fileExists(atPath: target.path) { return nil }
        let tmp = dir.appendingPathComponent(".\(UUID().uuidString).part")
        do {
            let source = try SQLiteDB(path: directory.appendingPathComponent("workspace.sqlite").path, readOnly: true)
            // Nie eine beschädigte Datenbank sichern – sonst verdrängt sie beim Aufräumen die intakten Backups
            guard (try? source.scalar("PRAGMA quick_check") as? String) == "ok" else {
                throw StoreError("Die Datenbank ist beschädigt – es wurde kein Backup erstellt, vorhandene Backups bleiben erhalten.")
            }
            try source.run("VACUUM INTO ?", tmp.path)
            try FileManager.default.moveItem(at: tmp, to: target)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
        prune(directory: directory, kind: .daily, keep: keepDaily)
        prune(directory: directory, kind: .manual, keep: keepManual)
        return target
    }

    @discardableResult
    public func backupIfNeeded(now: Date = Date(), keep: Int = 7, force: Bool = false) throws -> URL? {
        try Store.backup(directory: directory, kind: force ? .manual : .daily, now: now, keepDaily: keep)
    }

    /// Alle Backups, neueste zuerst (nach Erstellungszeit, unabhängig von der Art).
    public static func listBackups(directory: URL, kind: BackupKind? = nil) -> [URL] {
        let dir = directory.appendingPathComponent("Backups", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        let prefix = kind.map { "workspace-\($0.rawValue)-" } ?? "workspace-"
        // Erstellungsdatum einmal je Datei lesen, nicht bei jedem Vergleich
        var entries: [(url: URL, created: Date)] = []
        for u in files where u.lastPathComponent.hasPrefix(prefix) && u.pathExtension == "sqlite" {
            let created = (try? u.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date.distantPast
            entries.append((u, created))
        }
        entries.sort { a, b in a.created != b.created ? a.created > b.created : a.url.lastPathComponent > b.url.lastPathComponent }
        return entries.map { $0.url }
    }

    public func listBackups() -> [URL] { Store.listBackups(directory: directory) }

    private static func prune(directory: URL, kind: BackupKind, keep: Int) {
        for old in listBackups(directory: directory, kind: kind).dropFirst(keep) { try? FileManager.default.removeItem(at: old) }
    }

    /// Schnelle Integritätsprüfung einer Datenbankdatei (ohne sie zu verändern).
    public static func quickCheck(_ file: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: file.path) else { return true }
        guard let db = try? SQLiteDB(path: file.path, readOnly: true) else { return false }
        let r = try? db.scalar("PRAGMA quick_check") as? String
        return r == "ok"
    }

    /// Ersetzt eine beschädigte Datenbank durch ein Backup; die beschädigte Datei bleibt zur Analyse erhalten.
    public static func restore(backup: URL, into directory: URL) throws {
        let fm = FileManager.default
        let db = directory.appendingPathComponent("workspace.sqlite")
        let stamp = Int(Date().timeIntervalSince1970)
        // Erst das Backup daneben kopieren – schlägt das fehl (z. B. Platte voll), bleibt alles unverändert
        let staged = directory.appendingPathComponent(".restore-\(UUID().uuidString).sqlite")
        try fm.copyItem(at: backup, to: staged)
        var moved: [(from: URL, to: URL)] = []
        do {
            for suffix in ["", "-wal", "-shm"] {
                let f = URL(fileURLWithPath: db.path + suffix)
                if fm.fileExists(atPath: f.path) {
                    let target = directory.appendingPathComponent("workspace.corrupt-\(stamp).sqlite\(suffix)")
                    try fm.moveItem(at: f, to: target)
                    moved.append((f, target))
                }
            }
            // Umbenennen im selben Ordner ist atomar
            try fm.moveItem(at: staged, to: db)
        } catch {
            // Alles zurück (auch WAL/SHM – im WAL stehen evtl. noch nicht übernommene Änderungen)
            for m in moved.reversed() where !fm.fileExists(atPath: m.from.path) { try? fm.moveItem(at: m.to, to: m.from) }
            try? fm.removeItem(at: staged)
            throw error
        }
    }

    // MARK: - Sauberes Beenden

    /// Markiert eine laufende Sitzung; bleibt die Datei nach einem Absturz liegen, wird beim nächsten Start geprüft.
    public static func sessionMarker(_ directory: URL) -> URL { directory.appendingPathComponent(".session-open") }

    // MARK: - Anhänge

    /// Speichert Bytes inhaltsadressiert (SHA-256) und gibt den Dateinamen zurück.
    public func saveAsset(_ data: Data, ext rawExt: String) throws -> String {
        let name = Store.assetName(hash: SHA256.hash(data: data), ext: rawExt)
        let url = assetsDir.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: url.path) {
            try data.write(to: url, options: .atomic)
        }
        return name
    }

    /// Speichert eine Datei als Anhang, ohne sie komplett in den Speicher zu laden
    /// (Hash in Blöcken, Kopie über das Dateisystem). Für große Videos o. Ä.
    public func saveAssetFile(_ source: URL, ext rawExt: String) throws -> String {
        let fm = FileManager.default
        // Ordner und Pakete (.app, .rtfd …) sind keine einzelnen Dateien
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: source.path, isDirectory: &isDir), isDir.boolValue {
            throw StoreError("Ordner und Pakete können nicht als Anhang gespeichert werden.")
        }
        // Erst kopieren, dann die KOPIE hashen: so passen Name und Inhalt immer zusammen,
        // auch wenn die Quelle während des Vorgangs noch geschrieben wird.
        let tmp = assetsDir.appendingPathComponent(".\(UUID().uuidString).part")
        try fm.copyItem(at: source, to: tmp)
        do {
            // Rechte der Quelle (z. B. ausführbar) nicht übernehmen: Anhänge sind reine Daten
            try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tmp.path)
            let handle = try FileHandle(forReadingFrom: tmp)
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
            try handle.close()
            let name = Store.assetName(hash: hasher.finalize(), ext: rawExt)
            let target = assetsDir.appendingPathComponent(name)
            if fm.fileExists(atPath: target.path) {
                try? fm.removeItem(at: tmp)
                // Ältere Anhänge können noch ausführbar gespeichert sein
                try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: target.path)
            } else {
                try fm.moveItem(at: tmp, to: target)
            }
            return name
        } catch {
            try? fm.removeItem(at: tmp)
            throw error
        }
    }

    /// Inhaltsadressierter Dateiname – gemeinsam für eingefügte und gewählte Dateien (gleicher Inhalt = gleicher Name).
    static func assetName(hash: SHA256.Digest, ext rawExt: String) -> String {
        let ext = String(rawExt.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(8))
        let hex = hash.map { String(format: "%02x", $0) }.joined()
        return ext.isEmpty ? "\(hex).bin" : "\(hex).\(ext)"
    }

    /// Liefert die Datei eines Anhangs nur für gültige, inhaltsadressierte Namen (kein Path-Traversal).
    public func assetURL(_ name: String) -> URL? {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 64,
              parts[0].allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }),
              (1...8).contains(parts[1].count),
              parts[1].allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber) })
        else { return nil }
        return assetsDir.appendingPathComponent(name)
    }
}
