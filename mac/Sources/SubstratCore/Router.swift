import Foundation

/// Übersetzt Bridge-Aufrufe aus der Web-UI in Store-Operationen.
/// Rückgabewerte sind JSON-kompatibel (Dictionary, Array, String, Zahl, NSNull).
public final class Router {
    public let store: Store

    public init(store: Store) { self.store = store }

    /// ~100 MB Nutzdaten als Base64.
    static let maxInlineAssetBase64 = 100 * 1024 * 1024 / 3 * 4 + 4

    private func str(_ p: [String: Any], _ key: String) throws -> String {
        guard let v = p[key] as? String else { throw StoreError("Parameter '\(key)' fehlt") }
        return v
    }

    public func handle(_ method: String, _ p: [String: Any]) throws -> Any {
        switch method {
        case "bootstrap":
            return try store.bootstrap()
        case "page.get":
            return try store.getPage(try str(p, "id")) ?? NSNull()
        case "page.getMany":
            return try store.getPages((p["ids"] as? [String]) ?? [])
        case "page.create":
            return try store.createPage(p)
        case "page.update":
            return try store.updatePage(try str(p, "id"), (p["patch"] as? [String: Any]) ?? [:])
        case "page.trash":
            return try store.trashPage(try str(p, "id"))
        case "page.restore":
            return try store.restorePage(try str(p, "id"))
        case "page.purge":
            try store.purgePage(try str(p, "id"))
            return NSNull()
        case "trash.list":
            return try store.listTrash()
        case "db.get":
            return try store.getDatabase(try str(p, "id")) ?? NSNull()
        case "db.update":
            try store.updateDatabase(try str(p, "id"), (p["patch"] as? [String: Any]) ?? [:])
            return NSNull()
        case "search":
            let limit = (p["limit"] as? NSNumber)?.intValue ?? 30
            return try store.search(try str(p, "query"), limit: max(1, min(limit, 200)))
        case "backlinks":
            return try store.backlinks(try str(p, "id"))
        case "graph.edges":
            return try store.graphEdges()
        case "history.list":
            return try store.history(try str(p, "pageId"))
        case "history.get":
            guard let id = (p["id"] as? NSNumber)?.intValue else { throw StoreError("Parameter 'id' fehlt") }
            return try store.historyEntry(id) ?? NSNull()
        case "settings.set":
            try store.setSetting(try str(p, "key"), p["value"] as? String)
            return NSNull()
        case "layout.get":
            return try store.layout(try str(p, "scope")) ?? NSNull()
        case "layout.save":
            try store.saveLayout(try str(p, "scope"), try str(p, "data"))
            return NSNull()
        case "asset.save":
            let b64 = try str(p, "data")
            // Einfügen/Ziehen aus der Oberfläche: Obergrenze, große Dateien laufen über asset.pick
            guard b64.utf8.count <= Router.maxInlineAssetBase64 else { throw StoreError("Datei ist zu groß zum Einfügen (max. 100 MB). Bitte über „Datei hochladen“ wählen.") }
            guard let data = Data(base64Encoded: b64) else { throw StoreError("Ungültige Daten") }
            let name = try store.saveAsset(data, ext: (p["ext"] as? String) ?? "")
            return ["url": "app://asset/\(name)"]
        case "batch":
            // Mehrere Operationen in einer Transaktion (z. B. beim Import).
            let ops = (p["ops"] as? [[String: Any]]) ?? []
            return try store.db.transaction {
                try ops.map { op in
                    try handle(try str(op, "method"), (op["params"] as? [String: Any]) ?? [:])
                }
            }
        default:
            throw StoreError("Unbekannte Methode: \(method)")
        }
    }
}
