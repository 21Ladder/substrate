import Foundation
import XCTest
@testable import SubstratCore

final class SecurityTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("substrat-sec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testOnlyHarmlessAssetsOpen() {
        for ok in ["a.png", "b.PDF", "c.mp4", "d.docx", "e.txt"] { XCTAssertTrue(AssetPolicy.isSafeToOpen(ok), ok) }
        for bad in ["x.command", "x.terminal", "x.sh", "x.app", "x.pkg", "x.dmg", "x.fileloc", "x.webloc", "x.inetloc",
                    "x.html", "x.svg", "x.scpt", "x.workflow", "x.jar", "x.py", "x", "x.bin"] {
            XCTAssertFalse(AssetPolicy.isSafeToOpen(bad), bad)
        }
    }

    func testQuarantineAttribute() throws {
        let f = dir.appendingPathComponent("q.png")
        try Data([1, 2, 3]).write(to: f)
        XCTAssertFalse(AssetPolicy.isQuarantined(f))
        AssetPolicy.quarantine(f)
        XCTAssertTrue(AssetPolicy.isQuarantined(f))
    }

    func testInstanceLockIsExclusive() {
        let first = InstanceLock(directory: dir)
        XCTAssertNotNil(first)
        XCTAssertNil(InstanceLock(directory: dir), "Zweite Instanz darf die Sperre nicht bekommen")
        _ = first
    }

    func testInstanceLockReleasedOnDeinit() {
        var first = InstanceLock(directory: dir)
        XCTAssertNotNil(first)
        first = nil
        XCTAssertNotNil(InstanceLock(directory: dir))
    }

    func testZipinfoParsing() {
        let t = ZipInspector.parseTotals("Archive:  x.zip\nZip file size: 1 bytes\n3 files, 52428800 bytes uncompressed, 51083 bytes compressed:  99.9%\n")
        XCTAssertEqual(t?.files, 3)
        XCTAssertEqual(t?.bytes, 52_428_800)
        XCTAssertNil(ZipInspector.parseTotals("garbage"))
    }

    private func makeZip(_ name: String, files: [(String, Data)]) throws -> URL {
        let src = dir.appendingPathComponent("src-\(name)")
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        for (n, d) in files { try d.write(to: src.appendingPathComponent(n)) }
        let zip = dir.appendingPathComponent("\(name).zip")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-c", "-k", "--sequesterRsrc", src.path, zip.path]
        try p.run()
        p.waitUntilExit()
        return zip
    }

    func testZipBombIsSkippedAndAssetsQuarantined() throws {
        let store = try Store(directory: dir.appendingPathComponent("data"))
        let bomb = try makeZip("bomb", files: [("big.txt", Data(count: 5 * 1024 * 1024))])
        let ok = try makeZip("ok", files: [("note.md", Data("# Hallo".utf8)), ("bild.png", Data([0x89, 0x50, 0x4E, 0x47]))])
        // Budget: 1 MB entpackt – die Bombe (5 MB) wird übersprungen, das kleine Archiv nicht
        let importer = Importer(store: store, budget: UnzipBudget(maxBytes: 1024 * 1024, maxFiles: 100, reserveBytes: 0))
        let result = importer.read([bomb, ok])
        let files = result["files"] as! [[String: Any]]
        let warnings = result["warnings"] as! [String]
        XCTAssertTrue(warnings.contains { $0.contains("bomb.zip") }, "\(warnings)")
        XCTAssertTrue(files.contains { ($0["path"] as? String)?.hasSuffix("note.md") == true })
        XCTAssertFalse(files.contains { ($0["path"] as? String)?.hasSuffix("big.txt") == true })
        let asset = files.first { ($0["path"] as? String)?.hasSuffix("bild.png") == true }?["url"] as? String
        let name = String(asset?.dropFirst("app://asset/".count) ?? "")
        XCTAssertTrue(AssetPolicy.isQuarantined(store.assetURL(name)!), "Importierte Anhänge tragen Quarantäne")
    }

    func testNotAZip() throws {
        let store = try Store(directory: dir.appendingPathComponent("data"))
        let fake = dir.appendingPathComponent("fake.zip")
        try Data("kein zip".utf8).write(to: fake)
        let result = Importer(store: store).read([fake])
        XCTAssertEqual((result["files"] as! [Any]).count, 0)
        XCTAssertEqual((result["warnings"] as! [String]).count, 1)
    }
}
