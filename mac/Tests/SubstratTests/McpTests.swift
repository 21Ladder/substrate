import Foundation
import XCTest
@testable import SubstratCore

final class McpTests: XCTestCase {
    let token = String(repeating: "ab", count: 32)
    var config: McpConfig { McpConfig(enabled: true, port: 47321, token: token) }

    private func raw(_ method: String = "POST", path: String = "/mcp", headers: [String: String] = [:], body: String = "") -> Data {
        var h = ["Host": "127.0.0.1:47321", "Authorization": "Bearer \(token)", "Content-Type": "application/json"]
        for (k, v) in headers { h[k] = v.isEmpty ? nil : v }
        if method == "POST" && h["Content-Length"] == nil { h["Content-Length"] = String(body.utf8.count) }
        var s = "\(method) \(path) HTTP/1.1\r\n"
        for (k, v) in h.sorted(by: { $0.key < $1.key }) { s += "\(k): \(v)\r\n" }
        return Data((s + "\r\n" + body).utf8)
    }

    /// Zerlegt und beantwortet eine Anfrage; Werkzeuge liefern ihren Namen und ihre Argumente zurück.
    private func send(_ data: Data, tool: ((String, [String: Any]) -> Result<Any, McpToolError>)? = nil) -> HttpResponse {
        guard case .request(let req) = HttpParser.parse(data) else {
            if case .failure(let r) = HttpParser.parse(data) { return r }
            XCTFail("unvollständig")
            return HttpResponse(status: 0)
        }
        let proto = McpProtocol(config: { self.config }) { name, args, done in
            done(tool?(name, args) ?? .success(["tool": name, "args": args]))
        }
        var out: HttpResponse?
        proto.handle(req) { out = $0 }
        return out!
    }

    private func json(_ r: HttpResponse) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]) ?? [:]
    }

    private func rpc(_ method: String, id: Any? = 1, params: [String: Any]? = nil) -> String {
        var m: [String: Any] = ["jsonrpc": "2.0", "method": method]
        if let id { m["id"] = id }
        if let params { m["params"] = params }
        return String(data: try! JSONSerialization.data(withJSONObject: m), encoding: .utf8)!
    }

    func testParserWaitsForCompleteBodyAndEnforcesLimits() {
        let full = raw(body: rpc("ping"))
        if case .incomplete = HttpParser.parse(full.prefix(full.count - 3)) {} else { XCTFail("Body unvollständig") }
        if case .incomplete = HttpParser.parse(Data("POST /mcp HTTP/1.1\r\nHost: x".utf8)) {} else { XCTFail("Header unvollständig") }
        if case .request(let r) = HttpParser.parse(full) { XCTAssertEqual(r.headers["host"], "127.0.0.1:47321") } else { XCTFail() }
        let big = raw(headers: ["Content-Length": String(HttpParser.maxBodyBytes + 1)])
        if case .failure(let r) = HttpParser.parse(big) { XCTAssertEqual(r.status, 413) } else { XCTFail("413 erwartet") }
        let longHeader = Data(("POST /mcp HTTP/1.1\r\nX: " + String(repeating: "a", count: HttpParser.maxHeaderBytes + 10)).utf8)
        if case .failure(let r) = HttpParser.parse(longHeader) { XCTAssertEqual(r.status, 431) } else { XCTFail("431 erwartet") }
        let noLength = Data("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:47321\r\n\r\n".utf8)
        if case .failure(let r) = HttpParser.parse(noLength) { XCTAssertEqual(r.status, 411) } else { XCTFail("411 erwartet") }
        let chunked = raw(headers: ["Transfer-Encoding": "chunked"])
        if case .failure(let r) = HttpParser.parse(chunked) { XCTAssertEqual(r.status, 501) } else { XCTFail("501 erwartet") }
        let twice = Data("POST /mcp HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab".utf8)
        if case .failure(let r) = HttpParser.parse(twice) { XCTAssertEqual(r.status, 400) } else { XCTFail("doppelte Länge") }
    }

    func testAccessChecks() {
        XCTAssertEqual(send(raw(headers: ["Authorization": ""], body: rpc("ping"))).status, 401)
        XCTAssertEqual(send(raw(headers: ["Authorization": "Bearer " + String(repeating: "cd", count: 32)], body: rpc("ping"))).status, 401)
        XCTAssertEqual(send(raw(headers: ["Authorization": "Bearer abab"], body: rpc("ping"))).status, 401)
        XCTAssertEqual(send(raw(headers: ["Host": "evil.example:47321"], body: rpc("ping"))).status, 403, "DNS-Rebinding")
        XCTAssertEqual(send(raw(headers: ["Host": "127.0.0.1:1234"], body: rpc("ping"))).status, 403)
        XCTAssertEqual(send(raw(headers: ["Origin": "https://example.com"], body: rpc("ping"))).status, 403, "Browser")
        XCTAssertEqual(send(raw(path: "/other", body: rpc("ping"))).status, 404)
        XCTAssertEqual(send(raw("GET")).status, 405)
        XCTAssertEqual(send(raw(headers: ["Content-Type": "text/plain"], body: rpc("ping"))).status, 415)
        XCTAssertEqual(send(raw(headers: ["Host": "localhost:47321", "Authorization": "bearer \(token)"], body: rpc("ping"))).status, 200)
        // Ohne Schlüssel (noch nie eingeschaltet) kommt niemand hinein – auch nicht mit leerem Schlüssel
        let proto = McpProtocol(config: { McpConfig(enabled: true, port: 47321, token: "") }) { _, _, _ in XCTFail("darf nicht laufen") }
        if case .request(let req) = HttpParser.parse(raw(headers: ["Authorization": "Bearer "], body: rpc("ping"))) {
            var status = 0
            proto.handle(req) { status = $0.status }
            XCTAssertEqual(status, 401)
        }
    }

    func testProtocol() throws {
        let initResult = json(send(raw(body: rpc("initialize", params: ["protocolVersion": "2025-03-26", "capabilities": [:], "clientInfo": ["name": "t", "version": "1"]]))))
        let result = try XCTUnwrap(initResult["result"] as? [String: Any])
        XCTAssertEqual(result["protocolVersion"] as? String, "2025-03-26")
        XCTAssertNotNil((result["capabilities"] as? [String: Any])?["tools"])
        let unknownVersion = json(send(raw(body: rpc("initialize", params: ["protocolVersion": "1999-01-01"]))))
        XCTAssertEqual((unknownVersion["result"] as? [String: Any])?["protocolVersion"] as? String, McpProtocol.supportedVersions[0])

        XCTAssertEqual(send(raw(body: rpc("notifications/initialized", id: nil))).status, 202)
        XCTAssertEqual(json(send(raw(body: "{nicht json"))).keys.contains("error"), true)
        XCTAssertEqual(((json(send(raw(body: "{nicht json")))["error"] as? [String: Any])?["code"] as? Int), -32700)
        XCTAssertEqual(((json(send(raw(body: "[1,2]")))["error"] as? [String: Any])?["code"] as? Int), -32600)
        XCTAssertEqual(((json(send(raw(body: rpc("gibtsnicht"))))["error"] as? [String: Any])?["code"] as? Int), -32601)

        let tools = try XCTUnwrap((json(send(raw(body: rpc("tools/list"))))["result"] as? [String: Any])?["tools"] as? [[String: Any]])
        XCTAssertEqual(Set(tools.compactMap { $0["name"] as? String }), McpTools.names)
        for t in tools { XCTAssertTrue(JSONSerialization.isValidJSONObject(t)); XCTAssertNotNil(t["inputSchema"]) }
        XCTAssertTrue(McpTools.names.isSuperset(of: ["search", "create_page", "create_database", "append_to_page", "add_database_row", "trash_page"]))
        // Gefährliche Werkzeuge sind als destruktiv markiert
        let trash = try XCTUnwrap(tools.first { $0["name"] as? String == "trash_page" })
        XCTAssertEqual((trash["annotations"] as? [String: Any])?["destructiveHint"] as? Bool, true)
    }

    func testToolCalls() throws {
        let ok = json(send(raw(body: rpc("tools/call", id: "a", params: ["name": "search", "arguments": ["query": "x"]]))))
        XCTAssertEqual(ok["id"] as? String, "a")
        let res = try XCTUnwrap(ok["result"] as? [String: Any])
        XCTAssertEqual(res["isError"] as? Bool, false)
        let text = try XCTUnwrap((res["content"] as? [[String: Any]])?.first?["text"] as? String)
        XCTAssertTrue(text.contains("\"tool\" : \"search\""), text)

        let failed = json(send(raw(body: rpc("tools/call", params: ["name": "read_page", "arguments": ["id": "x"]]))) { _, _ in .failure(McpToolError("Seite nicht gefunden")) })
        let fres = try XCTUnwrap(failed["result"] as? [String: Any])
        XCTAssertEqual(fres["isError"] as? Bool, true)
        XCTAssertEqual((fres["content"] as? [[String: Any]])?.first?["text"] as? String, "Seite nicht gefunden")

        // Unbekannte Werkzeuge erreichen die App nie
        let unknown = json(send(raw(body: rpc("tools/call", params: ["name": "purge_everything"]))) { _, _ in XCTFail("darf nicht laufen"); return .success(1) })
        XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? Int, -32602)
        let badArgs = json(send(raw(body: rpc("tools/call", params: ["name": "search", "arguments": [1, 2]]))))
        XCTAssertEqual((badArgs["error"] as? [String: Any])?["code"] as? Int, -32602)
    }

    func testConfigFileIsPrivateAndTokensAreRandom() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("substrat-mcp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(McpConfig.load(dir), McpConfig(enabled: false, port: McpConfig.defaultPort, token: ""), "standardmäßig aus")
        let cfg = McpConfig(enabled: true, port: 47400, token: McpConfig.newToken())
        try cfg.save(dir)
        try cfg.save(dir) // Überschreiben klappt
        XCTAssertEqual(McpConfig.load(dir), cfg)
        let attrs = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("mcp.json").path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertNotEqual(McpConfig.newToken(), McpConfig.newToken())
        XCTAssertEqual(McpConfig.newToken().count, 64)
        XCTAssertTrue(constantTimeEquals("abc", "abc"))
        XCTAssertFalse(constantTimeEquals("abc", "abd"))
        XCTAssertFalse(constantTimeEquals("abc", "abcd"))
        XCTAssertFalse(constantTimeEquals("", "a"))
    }

    func testResponseSerialization() {
        let r = HttpResponse(status: 401, body: Data("x".utf8), headers: ["WWW-Authenticate": "Bearer"]).serialized()
        let s = String(data: r, encoding: .utf8)!
        XCTAssertTrue(s.hasPrefix("HTTP/1.1 401 Unauthorized\r\n"))
        XCTAssertTrue(s.contains("Content-Length: 1\r\n"))
        XCTAssertTrue(s.contains("Connection: close\r\n"))
        XCTAssertTrue(s.hasSuffix("\r\n\r\nx"))
    }
}
