import Foundation
import XCTest
@testable import SubstratCore

final class StoreTests: XCTestCase {
    var dir: URL!
    var store: Store!
    var router: Router!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("substrat-test-\(UUID().uuidString)")
        store = try Store(directory: dir)
        router = Router(store: store)
    }

    override func tearDownWithError() throws {
        store = nil
        router = nil
        try? FileManager.default.removeItem(at: dir)
    }

    @discardableResult
    func create(_ id: String, parent: String? = nil, title: String = "", text: String = "", kind: String = "page", database: String? = nil) throws -> [String: Any] {
        var p: [String: Any] = ["id": id, "title": title, "text": text, "kind": kind, "sortKey": "a0"]
        if let parent { p["parentId"] = parent }
        if let database { p["databaseId"] = database }
        if kind == "database" { p["schema"] = "[]"; p["views"] = "[]" }
        return try store.createPage(p)
    }

    func testCreateAndBootstrap() throws {
        try create("a", title: "Alpha")
        try create("b", parent: "a", title: "Beta")
        let boot = try store.bootstrap()
        let pages = boot["pages"] as! [[String: Any]]
        XCTAssertEqual(pages.count, 2)
        XCTAssertEqual(pages.first(where: { $0["id"] as? String == "b" })?["parentId"] as? String, "a")
    }

    func testUpdateTouchesUpdatedAtOnlyForContent() throws {
        try create("a", title: "Alpha")
        let before = try store.getPage("a")!["updatedAt"] as! Int
        Thread.sleep(forTimeInterval: 0.01)
        _ = try store.updatePage("a", ["sortKey": "b0"])
        XCTAssertEqual(try store.getPage("a")!["updatedAt"] as! Int, before)
        _ = try store.updatePage("a", ["title": "Alpha 2"])
        XCTAssertGreaterThan(try store.getPage("a")!["updatedAt"] as! Int, before)
    }

    func testSearchFindsTitleBodyAndDiacritics() throws {
        try create("a", title: "Café Notizen", text: "Über Graphen und Zusammenhänge")
        try create("b", title: "Einkauf", text: "Milch")
        XCTAssertEqual(try store.search("cafe").first?["id"] as? String, "a")
        XCTAssertEqual(try store.search("zusammen").first?["id"] as? String, "a")
        XCTAssertEqual(try store.search("ueber").count, 0)
        XCTAssertEqual(try store.search("uber").first?["id"] as? String, "a")
        XCTAssertEqual(try store.search("inkau").first?["id"] as? String, "b", "Teilwort im Titel")
        XCTAssertEqual(try store.search("\"\"").count, 0, "Leere/ungültige Abfrage darf nicht werfen")
        XCTAssertNoThrow(try store.search("a OR b NEAR( *"))
        _ = try store.updatePage("b", ["text": "Brot"])
        XCTAssertEqual(try store.search("milch").count, 0)
        XCTAssertEqual(try store.search("brot").first?["id"] as? String, "b")
    }

    func testSearchSnippetMarkers() throws {
        try create("a", title: "X", text: "eins zwei drei")
        let snip = try store.search("zwei").first?["snippet"] as? String
        XCTAssertEqual(snip, "eins \u{1}zwei\u{2} drei")
    }

    func testTrashRestorePurge() throws {
        try create("a", title: "A")
        try create("b", parent: "a", title: "B")
        try create("c", parent: "b", title: "C")
        try create("x", title: "X")
        // c wird vorher separat gelöscht und darf beim Wiederherstellen von a nicht zurückkommen
        _ = try store.trashPage("c")
        let trashed = try store.trashPage("a")
        XCTAssertEqual(Set(trashed), ["a", "b"])
        XCTAssertEqual(try store.listTrash().map { $0["id"] as! String }.sorted(), ["a", "c"])
        XCTAssertEqual(try store.search("B").count, 0)

        let restored = try store.restorePage("a")
        XCTAssertEqual(Set(restored), ["a", "b"])
        XCTAssertNotNil(try store.getPage("c")!["deletedAt"] as? Int, "c bleibt im Papierkorb")

        // c wiederherstellen, obwohl Eltern existieren → bleibt unter b
        _ = try store.restorePage("c")
        XCTAssertEqual(try store.getPage("c")!["parentId"] as? String, "b")

        _ = try store.trashPage("b")
        try store.purgePage("b")
        XCTAssertNil(try store.getPage("b"))
        XCTAssertNil(try store.getPage("c"))
        XCTAssertNotNil(try store.getPage("a"))
    }

    func testRestoreWithDeletedParentMovesToRoot() throws {
        try create("a", title: "A")
        try create("b", parent: "a", title: "B")
        _ = try store.trashPage("b")
        _ = try store.trashPage("a")
        _ = try store.restorePage("b")
        XCTAssertTrue(try store.getPage("b")!["parentId"] is NSNull)
    }

    func testLinksBacklinksAndGraph() throws {
        try create("a", title: "A")
        try create("b", title: "B")
        _ = try store.updatePage("a", ["links": ["kinds": ["mention"], "items": [["dst": "b", "kind": "mention"], ["dst": "a", "kind": "mention"]]]])
        XCTAssertEqual(try store.backlinks("b").map { $0["id"] as! String }, ["a"])
        XCTAssertEqual(try store.graphEdges().count, 1, "Selbstlinks werden ignoriert")
        // Ersetzen nur der Erwähnungen
        _ = try store.updatePage("a", ["links": ["kinds": ["mention"], "items": []]])
        XCTAssertEqual(try store.backlinks("b").count, 0)
        // Gelöschte Seiten tauchen im Graph nicht auf
        _ = try store.updatePage("a", ["links": ["kinds": ["relation"], "items": [["dst": "b", "kind": "relation", "prop": "p1"]]]])
        XCTAssertEqual(try store.graphEdges().count, 1)
        _ = try store.trashPage("b")
        XCTAssertEqual(try store.graphEdges().count, 0)
    }

    func testDatabaseRows() throws {
        try create("db", title: "Aufgaben", kind: "database")
        try create("r1", parent: "db", title: "Zeile 1", database: "db")
        try store.updateDatabase("db", ["schema": "[{\"id\":\"p\"}]"])
        let d = try store.getDatabase("db")!
        XCTAssertEqual(d["schema"] as? String, "[{\"id\":\"p\"}]")
        XCTAssertEqual((d["rows"] as! [[String: Any]]).count, 1)
    }

    func testHistorySnapshots() throws {
        try create("a", title: "A")
        _ = try store.updatePage("a", ["content": "{\"v\":1}"])
        _ = try store.updatePage("a", ["content": "{\"v\":2}"])
        let h = try store.history("a")
        XCTAssertEqual(h.count, 1, "Höchstens ein Snapshot pro Intervall")
        let entry = try store.historyEntry(h[0]["id"] as! Int)!
        XCTAssertEqual(entry["content"] as? String, "{\"v\":1}")
    }

    func testBatchIsAtomic() throws {
        let ops: [[String: Any]] = [
            ["method": "page.create", "params": ["id": "a", "title": "A"]],
            ["method": "page.create", "params": ["id": "a", "title": "Doppelt"]],
        ]
        XCTAssertThrowsError(try router.handle("batch", ["ops": ops]))
        XCTAssertNil(try store.getPage("a"), "Fehlgeschlagener Batch wird vollständig zurückgerollt")
        _ = try router.handle("page.create", ["id": "z", "title": "Z"])
        XCTAssertNotNil(try store.getPage("z"), "DB ist nach Rollback weiter benutzbar")
    }

    func testAssetsAreContentAddressedAndSafe() throws {
        let name = try store.saveAsset(Data("hallo".utf8), ext: "PNG")
        XCTAssertTrue(name.hasSuffix(".png"))
        XCTAssertNotNil(store.assetURL(name))
        XCTAssertNil(store.assetURL("../workspace.sqlite"))
        XCTAssertNil(store.assetURL(String(repeating: "a", count: 64) + "./x"))
        XCTAssertNil(store.assetURL(String(repeating: "A", count: 64) + ".png"))
    }

    func testSnapshotKeepsPreviousContentAndForce() throws {
        try create("a", title: "A")
        _ = try store.updatePage("a", ["content": "{\"v\":1}"])
        _ = try store.updatePage("a", ["content": "{\"v\":2}"])
        // Wiederherstellen erzwingt eine Sicherung des aktuellen Stands (v2)
        _ = try store.updatePage("a", ["content": "{\"v\":1}", "snapshot": true])
        let contents = try store.history("a").compactMap { try store.historyEntry($0["id"] as! Int)?["content"] as? String }
        XCTAssertEqual(Set(contents), ["{\"v\":1}", "{\"v\":2}"])
    }

    func testNestedTransactionRecovers() throws {
        XCTAssertThrowsError(try store.db.transaction {
            try store.db.transaction { try store.db.run("INSERT INTO nope VALUES (1)") }
        })
        // Danach müssen normale Transaktionen weiter funktionieren
        try create("ok", title: "OK")
        XCTAssertNotNil(try store.getPage("ok"))
    }

    func testPropsPatchMergesOnServer() throws {
        try create("r", title: "R")
        _ = try store.updatePage("r", ["props": "{\"a\":1,\"b\":[\"x\"]}"])
        _ = try store.updatePage("r", ["propsPatch": "{\"b\":[\"y\"],\"c\":true}"])
        _ = try store.updatePage("r", ["propsPatch": "{\"a\":null}"])
        let props = try JSONSerialization.jsonObject(with: Data((try store.getPage("r")!["props"] as! String).utf8)) as! [String: Any]
        XCTAssertNil(props["a"])
        XCTAssertEqual(props["b"] as? [String], ["y"])
        XCTAssertEqual(props["c"] as? Bool, true)
    }

    func testPurgeExpiredWithNestedTrashRoots() throws {
        try create("p", title: "P")
        try create("c", parent: "p", title: "C")
        _ = try store.trashPage("c")
        _ = try store.trashPage("p")
        try store.db.run("UPDATE pages SET deleted_at = 1")
        XCTAssertNoThrow(try store.purgeExpiredTrash())
        XCTAssertNil(try store.getPage("p"))
        XCTAssertNil(try store.getPage("c"))
        XCTAssertNoThrow(try store.purgePage("gibt-es-nicht"))
    }

    func testPurgeOnlyFromTrash() throws {
        try create("live", title: "Lebt")
        XCTAssertThrowsError(try store.purgePage("live"), "Lebende Seiten dürfen nicht endgültig gelöscht werden")
        XCTAssertNotNil(try store.getPage("live"))
        _ = try store.trashPage("live")
        XCTAssertNoThrow(try store.purgePage("live"))
        XCTAssertNil(try store.getPage("live"))
    }

    func testBackupsAndIntegrity() throws {
        try create("a", title: "Gesichert")
        let day = { (d: Int) in Date(timeIntervalSince1970: TimeInterval(1_790_000_000 + d * 86400)) }
        for d in 0..<10 { _ = try store.backupIfNeeded(now: day(d), keep: 7) }
        XCTAssertNil(try store.backupIfNeeded(now: day(9), keep: 7), "Höchstens ein Backup pro Tag")
        XCTAssertEqual(store.listBackups().count, 7)
        // Manuelle Backups verdrängen die täglichen nicht und erscheinen als neueste
        for k in 0..<8 { _ = try Store.backup(directory: dir, kind: .manual, now: day(20).addingTimeInterval(TimeInterval(k))) }
        XCTAssertEqual(Store.listBackups(directory: dir, kind: .daily).count, 7)
        XCTAssertEqual(Store.listBackups(directory: dir, kind: .manual).count, 5)
        let backups = store.listBackups()
        XCTAssertTrue(backups[0].lastPathComponent.contains("manual"), "Neuestes zuerst")
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: store.backupsDir.path).contains { $0.hasSuffix(".part") })
        XCTAssertTrue(Store.quickCheck(backups[0]))
        // Inhalt des Backups lesbar
        let copy = try SQLiteDB(path: backups[0].path, readOnly: true)
        XCTAssertEqual(try copy.scalar("SELECT title FROM pages WHERE id = 'a'") as? String, "Gesichert")
        // Beschädigte Datei wird erkannt
        let broken = dir.appendingPathComponent("broken.sqlite")
        try Data(repeating: 0x42, count: 8192).write(to: broken)
        XCTAssertFalse(Store.quickCheck(broken))
    }

    func testRestoreFailureKeepsDatabase() throws {
        try create("a", title: "Bleibt")
        store = nil
        router = nil
        let db = dir.appendingPathComponent("workspace.sqlite")
        // Backup existiert nicht → Kopieren schlägt fehl; die Datenbank muss unverändert bleiben
        XCTAssertThrowsError(try Store.restore(backup: dir.appendingPathComponent("gibt-es-nicht.sqlite"), into: dir))
        XCTAssertTrue(FileManager.default.fileExists(atPath: db.path))
        store = try Store(directory: dir)
        XCTAssertEqual(try store.getPage("a")?["title"] as? String, "Bleibt")
    }

    func testConcurrentBackupsDoNotInterfere() throws {
        try create("a", title: "Parallel")
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var failures = 0
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: 4) { k in
            do { _ = try Store.backup(directory: dir, kind: k == 0 ? .daily : .manual, now: base.addingTimeInterval(TimeInterval(k))) } catch {
                lock.lock(); failures += 1; lock.unlock()
            }
        }
        XCTAssertEqual(failures, 0)
        XCTAssertEqual(store.listBackups().count, 4)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: store.backupsDir.path).contains { $0.hasSuffix(".part") })
    }

    func testPickedAssetIsPlainData() throws {
        let src = dir.appendingPathComponent("tool.sh")
        try Data("#!/bin/sh\necho hi\n".utf8).write(to: src)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: src.path)
        let name = try store.saveAssetFile(src, ext: "sh")
        let url = try XCTUnwrap(store.assetURL(name))
        let perms = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o644, "Anhänge sind nie ausführbar")
        // Pakete/Ordner werden abgelehnt, ohne Reste zu hinterlassen
        let pkg = dir.appendingPathComponent("Notiz.rtfd")
        try FileManager.default.createDirectory(at: pkg, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: pkg.appendingPathComponent("TXT.rtf"))
        XCTAssertThrowsError(try store.saveAssetFile(pkg, ext: "rtfd"))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: store.assetsDir.path).contains { $0.hasSuffix(".part") })
        XCTAssertEqual(name, try store.saveAsset(Data("#!/bin/sh\necho hi\n".utf8), ext: "sh"), "Gleicher Name wie beim Einfügen")
    }

    func testRestoreFromBackup() throws {
        try create("a", title: "Original")
        let backup = try store.backupIfNeeded(force: true)!
        store = nil
        router = nil
        let db = dir.appendingPathComponent("workspace.sqlite")
        try Data(repeating: 0x42, count: 8192).write(to: db)
        XCTAssertFalse(Store.quickCheck(db))
        // Eine beschädigte Datenbank wird nicht gesichert und verdrängt keine intakten Backups
        let before = Store.listBackups(directory: dir)
        XCTAssertThrowsError(try Store.backup(directory: dir, kind: .daily, now: Date().addingTimeInterval(86400)))
        XCTAssertEqual(Store.listBackups(directory: dir), before)
        try Store.restore(backup: backup, into: dir)
        XCTAssertTrue(Store.quickCheck(db))
        store = try Store(directory: dir)
        XCTAssertEqual(try store.getPage("a")?["title"] as? String, "Original")
        let corrupt = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("workspace.corrupt-") }
        XCTAssertFalse(corrupt.isEmpty, "Beschädigte Datei bleibt erhalten")
    }

    func testStreamingAssetSaveMatchesInline() throws {
        let data = Data((0..<300_000).map { UInt8($0 % 251) })
        let src = dir.appendingPathComponent("video.mp4")
        try data.write(to: src)
        let a = try store.saveAssetFile(src, ext: "mp4")
        let b = try store.saveAsset(data, ext: "mp4")
        XCTAssertEqual(a, b, "Gleicher Inhalt → gleicher Name")
        XCTAssertEqual(try Data(contentsOf: store.assetURL(a)!), data)
    }

    func testFtsQueryEscaping() {
        XCTAssertEqual(Store.ftsQuery("  foo \"bar\" "), "\"foo\"* \"bar\"*")
        XCTAssertEqual(Store.ftsQuery("\"\""), "")
    }

    func testPerformanceSearch10k() throws {
        try store.db.transaction {
            for i in 0..<10_000 {
                _ = try store.createPage(["id": "p\(i)", "title": "Seite \(i)", "text": "Inhalt Nummer \(i) mit etwas Text über Projekte"])
            }
        }
        let start = Date()
        for _ in 0..<20 { _ = try store.search("projekte nummer") }
        let avg = Date().timeIntervalSince(start) / 20 * 1000
        print("Durchschnittliche Suchzeit bei 10k Seiten: \(avg) ms")
        XCTAssertLessThan(avg, 30)
        let t0 = Date()
        _ = try store.bootstrap()
        print("Bootstrap 10k Seiten: \(Date().timeIntervalSince(t0) * 1000) ms")
    }
}
