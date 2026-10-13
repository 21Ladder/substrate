import Foundation
import Security

// MCP-Server für Claude Code (Model Context Protocol, Transport „Streamable HTTP“, nur JSON-Antworten).
// Dieser Teil ist netzwerkfrei und testbar: HTTP-Anfragen zerlegen, Zugang prüfen, JSON-RPC beantworten.
// Die Werkzeuge selbst laufen in der Web-Schicht der App (dort liegen Markdown-Umwandlung, Link-Index
// und die offenen Editoren) – hier wird nur weitergereicht.

// MARK: HTTP

public struct HttpRequest {
    public let method: String
    public let path: String
    /// Header mit kleingeschriebenen Namen.
    public let headers: [String: String]
    public let body: Data
}

public struct HttpResponse: Equatable {
    public let status: Int
    public let body: Data
    public var headers: [String: String]

    public init(status: Int, body: Data = Data(), headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }

    static func json(_ object: Any, status: Int = 200) -> HttpResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        return HttpResponse(status: status, body: data, headers: ["Content-Type": "application/json"])
    }

    static func text(_ status: Int, _ message: String, headers: [String: String] = [:]) -> HttpResponse {
        var h = headers
        h["Content-Type"] = "text/plain; charset=utf-8"
        return HttpResponse(status: status, body: Data(message.utf8), headers: h)
    }

    static let reasons: [Int: String] = [
        200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
        405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large", 415: "Unsupported Media Type",
        431: "Request Header Fields Too Large", 500: "Internal Server Error", 501: "Not Implemented", 503: "Service Unavailable",
    ]

    /// Fertige HTTP/1.1-Antwort; die Verbindung wird danach immer geschlossen.
    public func serialized() -> Data {
        var head = "HTTP/1.1 \(status) \(HttpResponse.reasons[status] ?? "Status")\r\n"
        var h = headers
        h["Content-Length"] = String(body.count)
        h["Connection"] = "close"
        h["Cache-Control"] = "no-store"
        for key in h.keys.sorted() { head += "\(key): \(h[key]!)\r\n" }
        head += "\r\n"
        return Data(head.utf8) + body
    }
}

public enum HttpParseResult {
    case incomplete
    case request(HttpRequest)
    case failure(HttpResponse)
}

public enum HttpParser {
    public static let maxHeaderBytes = 16 * 1024
    public static let maxBodyBytes = 4 * 1024 * 1024

    /// Zerlegt eine (evtl. noch unvollständige) Anfrage. Nur Content-Length, kein Chunked-Encoding.
    public static func parse(_ buffer: Data) -> HttpParseResult {
        let separator = Data("\r\n\r\n".utf8)
        guard let end = buffer.range(of: separator) else {
            return buffer.count > maxHeaderBytes ? .failure(.text(431, "Header zu groß")) : .incomplete
        }
        guard end.lowerBound <= maxHeaderBytes else { return .failure(.text(431, "Header zu groß")) }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else {
            return .failure(.text(400, "Ungültige Anfrage"))
        }
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: false)
        guard start.count == 3, start[2].hasPrefix("HTTP/1.") else { return .failure(.text(400, "Ungültige Anfrage")) }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { return .failure(.text(400, "Ungültiger Header")) }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return .failure(.text(400, "Ungültiger Header")) }
            // Doppelte Header, die über die Länge oder den Zugang entscheiden, sind mehrdeutig → ablehnen
            if headers[name] != nil, ["content-length", "host", "authorization", "origin", "transfer-encoding"].contains(name) {
                return .failure(.text(400, "Doppelter Header \(name)"))
            }
            headers[name] = value
        }
        if headers["transfer-encoding"] != nil { return .failure(.text(501, "Transfer-Encoding wird nicht unterstützt")) }
        let method = String(start[0])
        var length = 0
        if let raw = headers["content-length"] {
            guard let n = Int(raw), n >= 0 else { return .failure(.text(400, "Ungültige Content-Length")) }
            length = n
        } else if method == "POST" {
            return .failure(.text(411, "Content-Length fehlt"))
        }
        guard length <= maxBodyBytes else { return .failure(.text(413, "Anfrage zu groß (max. 4 MB)")) }
        let bodyStart = end.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return .incomplete }
        let body = buffer[bodyStart..<(bodyStart + length)]
        let target = String(start[1])
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? target
        return .request(HttpRequest(method: method, path: path, headers: headers, body: Data(body)))
    }
}

// MARK: Zugang

public struct McpConfig: Equatable {
    public var enabled: Bool
    public var port: UInt16
    public var token: String

    public static let defaultPort: UInt16 = 47321
    static let fileName = "mcp.json"

    /// Liest die Einstellungen aus dem Datenordner (je Arbeitsbereich, Datei nur für den Benutzer lesbar).
    public static func load(_ directory: URL) -> McpConfig {
        let url = directory.appendingPathComponent(fileName)
        if let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let port = (obj["port"] as? NSNumber)?.intValue ?? Int(defaultPort)
            let token = obj["token"] as? String ?? ""
            return McpConfig(
                enabled: (obj["enabled"] as? Bool) ?? false,
                port: (1024...65535).contains(port) ? UInt16(port) : defaultPort,
                token: isValidToken(token) ? token : ""
            )
        }
        return McpConfig(enabled: false, port: defaultPort, token: "")
    }

    public func save(_ directory: URL) throws {
        let url = directory.appendingPathComponent(McpConfig.fileName)
        let data = try JSONSerialization.data(withJSONObject: ["enabled": enabled, "port": Int(port), "token": token], options: [.sortedKeys])
        // Erst mit Rechten 0600 anlegen, dann atomar ersetzen – der Schlüssel ist nie für andere lesbar
        let tmp = directory.appendingPathComponent(".\(McpConfig.fileName).tmp")
        try? FileManager.default.removeItem(at: tmp)
        guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw StoreError("MCP-Einstellungen konnten nicht gespeichert werden")
        }
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// 32 Zufallsbytes als Hex (64 Zeichen).
    public static func newToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "Kein Zufall verfügbar")
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func isValidToken(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit }
    }
}

/// Vergleich in konstanter Zeit (verrät über die Laufzeit nicht, wie viele Zeichen stimmen).
func constantTimeEquals(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    var diff = UInt8(x.count == y.count ? 0 : 1)
    for i in 0..<max(x.count, y.count) {
        diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
    }
    return diff == 0
}

// MARK: Protokoll

/// Fehler eines Werkzeugs (wird Claude als `isError` gemeldet, nicht als Protokollfehler).
public struct McpToolError: Error {
    public let message: String
    public init(_ message: String) { self.message = message }
}

public final class McpProtocol {
    public static let supportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05"]
    public static let serverVersion = "1.0"

    /// Führt ein Werkzeug aus und liefert das JSON-Ergebnis (Dictionary/Array/…) oder einen Fehler.
    public typealias ToolRunner = (_ name: String, _ arguments: [String: Any], _ done: @escaping (Result<Any, McpToolError>) -> Void) -> Void

    private let config: () -> McpConfig
    private let run: ToolRunner

    public init(config: @escaping () -> McpConfig, run: @escaping ToolRunner) {
        self.config = config
        self.run = run
    }

    /// Prüft Pfad, Herkunft und Schlüssel; beantwortet dann die JSON-RPC-Nachricht.
    public func handle(_ req: HttpRequest, reply: @escaping (HttpResponse) -> Void) {
        let cfg = config()
        guard req.path == "/mcp" else { return reply(.text(404, "Nicht gefunden")) }
        // Schutz gegen DNS-Rebinding: nur Anfragen an die Loopback-Adresse dieses Ports
        let host = (req.headers["host"] ?? "").lowercased()
        guard host == "127.0.0.1:\(cfg.port)" || host == "localhost:\(cfg.port)" else {
            return reply(.text(403, "Unerwarteter Host"))
        }
        // Browser senden immer Origin – Webseiten dürfen den Server nie erreichen
        guard req.headers["origin"] == nil else { return reply(.text(403, "Anfragen aus dem Browser sind nicht erlaubt")) }
        let auth = req.headers["authorization"] ?? ""
        let prefix = "bearer "
        let given = auth.lowercased().hasPrefix(prefix) ? String(auth.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces) : ""
        guard !cfg.token.isEmpty, constantTimeEquals(given, cfg.token) else {
            return reply(.text(401, "Zugangsschlüssel fehlt oder ist falsch", headers: ["WWW-Authenticate": "Bearer"]))
        }
        guard req.method == "POST" else {
            // Kein Server-Sent-Events-Kanal und keine Sitzungen
            return reply(.text(405, "Nur POST", headers: ["Allow": "POST"]))
        }
        let type = (req.headers["content-type"] ?? "").lowercased()
        guard type.hasPrefix("application/json") else { return reply(.text(415, "Erwartet application/json")) }

        guard let message = try? JSONSerialization.jsonObject(with: req.body) else {
            return reply(.json(McpProtocol.error(id: NSNull(), code: -32700, "Ungültiges JSON")))
        }
        guard let msg = message as? [String: Any], (msg["jsonrpc"] as? String) == "2.0" else {
            return reply(.json(McpProtocol.error(id: NSNull(), code: -32600, "Ungültige JSON-RPC-Nachricht")))
        }
        guard let method = msg["method"] as? String else {
            // Antwort des Clients auf eine Anfrage des Servers (gibt es hier nicht) → bestätigen
            return reply(HttpResponse(status: 202))
        }
        guard let id = msg["id"], id is String || id is NSNumber else {
            // Benachrichtigung (z. B. notifications/initialized): keine Antwort
            return reply(HttpResponse(status: 202))
        }
        let params = msg["params"] as? [String: Any] ?? [:]
        respond(id: id, method: method, params: params) { reply(.json($0)) }
    }

    private func respond(id: Any, method: String, params: [String: Any], done: @escaping ([String: Any]) -> Void) {
        switch method {
        case "initialize":
            let asked = params["protocolVersion"] as? String ?? ""
            let version = McpProtocol.supportedVersions.contains(asked) ? asked : McpProtocol.supportedVersions[0]
            done(McpProtocol.result(id: id, [
                "protocolVersion": version,
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "substrat", "title": "Substrat", "version": McpProtocol.serverVersion],
                "instructions": McpTools.instructions,
            ]))
        case "ping":
            done(McpProtocol.result(id: id, [:]))
        case "tools/list":
            done(McpProtocol.result(id: id, ["tools": McpTools.list]))
        case "tools/call":
            guard let name = params["name"] as? String, McpTools.names.contains(name) else {
                return done(McpProtocol.error(id: id, code: -32602, "Unbekanntes Werkzeug: \(params["name"] as? String ?? "")"))
            }
            let raw = params["arguments"]
            guard raw == nil || raw is NSNull || raw is [String: Any] else {
                return done(McpProtocol.error(id: id, code: -32602, "„arguments“ muss ein Objekt sein"))
            }
            let args = raw as? [String: Any] ?? [:]
            run(name, args) { result in
                switch result {
                case .success(let value):
                    done(McpProtocol.result(id: id, ["content": [["type": "text", "text": McpProtocol.text(value)]], "isError": false]))
                case .failure(let error):
                    done(McpProtocol.result(id: id, ["content": [["type": "text", "text": error.message]], "isError": true]))
                }
            }
        default:
            done(McpProtocol.error(id: id, code: -32601, "Unbekannte Methode: \(method)"))
        }
    }

    static func result(id: Any, _ result: [String: Any]) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "result": result]
    }

    static func error(id: Any, code: Int, _ message: String) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
    }

    /// Ergebnis als gut lesbarer JSON-Text (Zeichenketten unverändert).
    static func text(_ value: Any) -> String {
        if let s = value as? String { return s }
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let s = String(data: data, encoding: .utf8) else { return String(describing: value) }
        return s
    }
}

// MARK: Werkzeuge

public enum McpTools {
    static let instructions = """
    Substrat ist die lokale Notiz-App des Nutzers (ähnlich wie Notion): Seiten mit Unterseiten und Datenbanken. \
    Inhalte werden als Markdown gelesen und geschrieben. Verweise auf andere Seiten: [[Seitentitel]] oder \
    [Titel](substrat://<id>). Ohne Angabe eines Ziels landen neue Seiten in der Seite „Eingang“. \
    Suche zuerst mit search, bevor du Seiten anlegst, damit nichts doppelt entsteht. \
    Datenbank-Zeilen legst du mit add_database_row an; die Eigenschaften gibst du mit ihren Namen an \
    (query_database oder read_page zeigt das Schema).
    """

    private static func schema(_ properties: [String: [String: Any]], required: [String] = []) -> [String: Any] {
        var s: [String: Any] = ["type": "object", "properties": properties, "additionalProperties": false]
        if !required.isEmpty { s["required"] = required }
        return s
    }

    private static let id: [String: Any] = ["type": "string", "description": "ID der Seite (aus search, list_pages oder read_page)"]
    private static let markdown: [String: Any] = ["type": "string", "description": "Inhalt als Markdown (Überschriften, Listen, To-dos „- [ ]“, Code, Zitate, [[Seitentitel]] für Verweise)"]

    private static func tool(_ name: String, _ title: String, _ description: String, _ input: [String: Any], readOnly: Bool = false, destructive: Bool = false, idempotent: Bool = false) -> [String: Any] {
        ["name": name, "title": title, "description": description, "inputSchema": input,
         "annotations": ["title": title, "readOnlyHint": readOnly, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": false]]
    }

    public static let list: [[String: Any]] = [
        tool("search", "Suchen", "Volltextsuche über Titel und Inhalte aller Seiten. Liefert ID, Titel, Pfad und einen Ausschnitt.",
             schema(["query": ["type": "string", "description": "Suchbegriffe"],
                     "limit": ["type": "integer", "minimum": 1, "maximum": 50, "description": "Höchstens so viele Treffer (Standard 20)"]],
                    required: ["query"]), readOnly: true, idempotent: true),
        tool("list_pages", "Seiten auflisten", "Listet die Unterseiten einer Seite auf, ohne parent_id die oberste Ebene der Seitenleiste.",
             schema(["parent_id": ["type": "string", "description": "ID der Elternseite (leer = oberste Ebene)"]]), readOnly: true, idempotent: true),
        tool("read_page", "Seite lesen", "Liest eine Seite als Markdown, mit Eigenschaften (bei Datenbank-Zeilen) und Unterseiten. Bei einer Datenbank: Schema und Zeilen.",
             schema(["id": id], required: ["id"]), readOnly: true, idempotent: true),
        tool("create_page", "Seite anlegen", "Legt eine neue Seite an. Ohne parent_id landet sie in der Seite „Eingang“. Für Datenbank-Zeilen add_database_row verwenden.",
             schema(["title": ["type": "string", "description": "Titel der Seite"],
                     "markdown": markdown,
                     "parent_id": ["type": "string", "description": "ID der Elternseite (optional)"],
                     "icon": ["type": "string", "description": "Ein Emoji als Symbol (optional)"]],
                    required: ["title"])),
        tool("append_to_page", "An Seite anhängen", "Hängt Markdown-Inhalt an das Ende einer bestehenden Seite an.",
             schema(["id": id, "markdown": markdown], required: ["id", "markdown"])),
        tool("replace_page_content", "Seiteninhalt ersetzen", "Ersetzt den gesamten Inhalt einer Seite. Der vorige Stand bleibt im Versionsverlauf; Unterseiten bleiben erhalten.",
             schema(["id": id, "markdown": markdown], required: ["id", "markdown"]), destructive: true, idempotent: true),
        tool("update_page", "Seite ändern", "Ändert Titel und/oder Symbol einer Seite.",
             schema(["id": id,
                     "title": ["type": "string", "description": "Neuer Titel"],
                     "icon": ["type": "string", "description": "Neues Emoji-Symbol, leer entfernt es"]],
                    required: ["id"]), idempotent: true),
        tool("move_page", "Seite verschieben", "Verschiebt eine Seite unter eine andere Seite (ohne parent_id auf die oberste Ebene).",
             schema(["id": id, "parent_id": ["type": "string", "description": "ID der neuen Elternseite (leer = oberste Ebene)"]],
                    required: ["id"]), idempotent: true),
        tool("trash_page", "In den Papierkorb", "Legt eine Seite samt Unterseiten in den Papierkorb (30 Tage wiederherstellbar).",
             schema(["id": id], required: ["id"]), destructive: true, idempotent: true),
        tool("query_database", "Datenbank abfragen", "Liest Schema und Zeilen einer Datenbank, optional gefiltert nach Text.",
             schema(["database_id": ["type": "string", "description": "ID der Datenbank"],
                     "text": ["type": "string", "description": "Nur Zeilen, die diesen Text enthalten (optional)"],
                     "limit": ["type": "integer", "minimum": 1, "maximum": 500, "description": "Höchstens so viele Zeilen (Standard 100)"]],
                    required: ["database_id"]), readOnly: true, idempotent: true),
        tool("add_database_row", "Datenbank-Zeile anlegen", "Legt eine Zeile in einer Datenbank an. Eigenschaften mit ihrem Namen angeben, Werte als Text (Datum JJJJ-MM-TT, Auswahl mit dem Namen der Option, Mehrfachauswahl kommagetrennt, Kontrollkästchen true/false).",
             schema(["database_id": ["type": "string", "description": "ID der Datenbank"],
                     "title": ["type": "string", "description": "Titel der Zeile"],
                     "properties": ["type": "object", "description": "Eigenschaften: { \"Name\": \"Wert\" }", "additionalProperties": ["type": ["string", "number", "boolean", "array", "null"]]],
                     "markdown": markdown],
                    required: ["database_id", "title"])),
        tool("update_database_row", "Datenbank-Zeile ändern", "Ändert Titel und/oder Eigenschaften einer Datenbank-Zeile. Ein leerer Wert oder null leert die Eigenschaft.",
             schema(["row_id": ["type": "string", "description": "ID der Zeile"],
                     "title": ["type": "string", "description": "Neuer Titel (optional)"],
                     "properties": ["type": "object", "description": "Eigenschaften: { \"Name\": \"Wert\" }", "additionalProperties": ["type": ["string", "number", "boolean", "array", "null"]]]],
                    required: ["row_id"]), idempotent: true),
    ]

    public static let names: Set<String> = Set(list.compactMap { $0["name"] as? String })
}
