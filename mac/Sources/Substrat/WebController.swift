import AppKit
import SubstratCore
import UniformTypeIdentifiers
import WebKit

/// Hält die WKWebView, beantwortet Bridge-Aufrufe und liefert lokale Dateien über `app://` aus.
final class WebController: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let router: Router
    private weak var window: NSWindow?
    private let queue = DispatchQueue(label: "substrat.store", qos: .userInitiated)
    /// Dateiarbeit (Import/Export) läuft getrennt, damit Speichern nicht blockiert wird.
    private let fileQueue = DispatchQueue(label: "substrat.files", qos: .utility)
    private let devURL: URL?
    /// Nur für automatisierte Tests: Ordner für Protokoll und Snapshots.
    private let selftestDir: URL?
    /// Zugriff für Claude Code (MCP), standardmäßig aus.
    private(set) var mcpServer: McpServer!
    private var mcpConfig: McpConfig
    private var mcpStatus: McpServer.Status = .off

    init(store: Store, window: NSWindow) {
        self.router = Router(store: store)
        self.window = window
        self.mcpConfig = McpConfig.load(store.directory)
        if let dev = ProcessInfo.processInfo.environment["SUBSTRAT_DEV_URL"], let url = URL(string: dev),
           url.host == "localhost" || url.host == "127.0.0.1" {
            devURL = url
        } else {
            devURL = nil
        }

        var testDir: URL?
        #if DEBUG
        // Automatischer Oberflächentest – im Release-Build nicht enthalten
        if let dir = ProcessInfo.processInfo.environment["SUBSTRAT_SELFTEST_DIR"], !dir.isEmpty {
            testDir = try? AppDelegate.resolveDataPath(dir)
            if let testDir { try? FileManager.default.createDirectory(at: testDir, withIntermediateDirectories: true) }
        }
        #endif
        selftestDir = testDir

        let config = WKWebViewConfiguration()
        if testDir != nil {
            // Testlauf auch bei gesperrtem Bildschirm/verdecktem Fenster nicht drosseln (Timer liefen sonst minutenlang)
            config.preferences.inactiveSchedulingPolicy = .none
            // Konsole und Fehler im Testmodus nach stdout spiegeln
            let hook = """
            window.__substratSelftest = true;
            (function () {
              const send = (line) => { try { window.webkit.messageHandlers.bridge.postMessage({ method: "debug.log", params: { line } }); } catch (e) {} };
              for (const level of ["log", "warn", "error"]) {
                const orig = console[level].bind(console);
                console[level] = (...args) => { orig(...args); send("CONSOLE." + level + " " + args.map((a) => a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")); };
              }
              window.addEventListener("error", (e) => send("JSERROR " + e.message + " @ " + e.filename + ":" + e.lineno));
              window.addEventListener("unhandledrejection", (e) => send("JSREJECT " + (e.reason && e.reason.stack || e.reason)));
            })();
            """
            config.userContentController.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        config.setURLSchemeHandler(SchemeHandler(webRoot: webRoot, store: store), forURLScheme: "app")
        config.websiteDataStore = .nonPersistent()
        config.preferences.isElementFullscreenEnabled = true
        config.suppressesIncrementalRendering = true
        webView = AppWebView(frame: .zero, configuration: config)
        super.init()

        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        #if DEBUG
        webView.isInspectable = true
        #endif

        webView.load(URLRequest(url: startURL(safeMode: false)))

        mcpServer = McpServer(config: mcpConfig) { [weak self] name, args, done in
            guard let self else { return done(.failure(McpToolError("Substrat wird beendet"))) }
            self.callTool(name, args, done)
        }
        mcpServer.onStatus = { [weak self] status in
            guard let self else { return }
            self.mcpStatus = status
            self.emit("mcp-status", self.mcpStatusInfo())
        }
        mcpServer.apply(mcpConfig)
    }

    private func isTrustedOrigin(_ origin: WKSecurityOrigin) -> Bool {
        if origin.protocol == "app" && origin.host == "local" { return true }
        if let devURL, origin.protocol == devURL.scheme, origin.host == devURL.host, origin.port == (devURL.port ?? 0) { return true }
        return false
    }

    // MARK: JS → Swift

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Nur das Hauptdokument der App darf die Bridge benutzen, keine eingebetteten Frames.
        guard message.frameInfo.isMainFrame, isTrustedOrigin(message.frameInfo.securityOrigin) else {
            replyHandler(nil, "forbidden")
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "bad request")
            return
        }
        let params = (body["params"] as? [String: Any]) ?? [:]

        if handleAppMethod(method, params, replyHandler) { return }

        queue.async { [router] in
            do {
                let result = try router.handle(method, params)
                DispatchQueue.main.async { replyHandler(result, nil) }
            } catch {
                DispatchQueue.main.async { replyHandler(nil, String(describing: error)) }
            }
        }
    }

    /// Methoden, die AppKit brauchen und deshalb auf dem Main-Thread laufen.
    private func handleAppMethod(_ method: String, _ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) -> Bool {
        switch method {
        case "window.drag":
            // Mit dem gemerkten Mausdruck ziehen (die Nachricht kommt asynchron, currentEvent ist dann oft ein anderes)
            if let window, let event = (webView as? AppWebView)?.recentMouseDown(), NSEvent.pressedMouseButtons & 1 == 1 {
                window.performDrag(with: event)
            }
            reply(NSNull(), nil)
        case "window.zoom":
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.zoom(nil) }
            reply(NSNull(), nil)
        case "app.openURL":
            if let s = p["url"] as? String, let url = URL(string: s), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            reply(NSNull(), nil)
        case "export.save":
            exportSave(p, reply)
        case "export.saveFiles":
            exportSaveFiles(p, reply)
        case "import.pick":
            importPick(reply)
        case "asset.fetch":
            fetchAsset(p, reply)
        case "asset.pick":
            pickAssets(p, reply)
        case "backup.now":
            // Erst alle bereits eingereihten Schreibvorgänge abwarten (serielle Queue), dann im Hintergrund
            // sichern – die Speicher-Queue bleibt während des Kopierens frei
            let dir = router.store.directory
            queue.async {
                DispatchQueue.global(qos: .utility).async {
                    do {
                        let url = try Store.backup(directory: dir, kind: .manual)
                        DispatchQueue.main.async { reply(["file": url?.lastPathComponent ?? ""], nil) }
                    } catch {
                        DispatchQueue.main.async { reply(nil, String(describing: error)) }
                    }
                }
            }
        case "backup.reveal":
            let dir = router.store.backupsDir
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            NSWorkspace.shared.activateFileViewerSelecting([dir])
            reply(NSNull(), nil)
        case "mcp.status":
            reply(mcpStatusInfo(), nil)
        case "mcp.setEnabled":
            var cfg = mcpConfig
            cfg.enabled = (p["enabled"] as? Bool) ?? false
            if cfg.enabled && cfg.token.isEmpty { cfg.token = McpConfig.newToken() }
            applyMcp(cfg, reply)
        case "mcp.rotateToken":
            var cfg = mcpConfig
            cfg.token = McpConfig.newToken()
            applyMcp(cfg, reply)
        case "mcp.setPort":
            guard let port = (p["port"] as? NSNumber)?.intValue, (1024...65535).contains(port) else {
                reply(nil, "Port muss zwischen 1024 und 65535 liegen")
                return true
            }
            var cfg = mcpConfig
            cfg.port = UInt16(port)
            applyMcp(cfg, reply)
        case "debug.log", "debug.snapshot", "debug.quit", "debug.importZip", "debug.mcpProbe":
            #if DEBUG
            guard let dir = selftestDir else { reply(nil, "forbidden"); return true }
            handleDebug(method, p, dir, reply)
            #else
            reply(nil, "forbidden")
            #endif
        default:
            return false
        }
        return true
    }

    // MARK: Selbsttest (nur Debug-Build mit SUBSTRAT_SELFTEST_DIR)

    #if DEBUG
    private func handleDebug(_ method: String, _ p: [String: Any], _ dir: URL, _ reply: @escaping (Any?, String?) -> Void) {
        switch method {
        case "debug.log":
            let line = (p["line"] as? String) ?? ""
            print(line)
            fflush(stdout)
            if let h = try? FileHandle(forWritingTo: dir.appendingPathComponent("selftest.log")) {
                h.seekToEndOfFile()
                h.write(Data((line + "\n").utf8))
                try? h.close()
            } else {
                try? Data((line + "\n").utf8).write(to: dir.appendingPathComponent("selftest.log"))
            }
            reply(NSNull(), nil)
        case "debug.snapshot":
            let name = WebController.safeFileName((p["name"] as? String) ?? "snapshot")
            webView.takeSnapshot(with: nil) { image, _ in
                if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: dir.appendingPathComponent("\(name).png"))
                }
                reply(NSNull(), nil)
            }
        case "debug.mcpProbe":
            // Echte HTTP-Anfrage an den eigenen MCP-Server (Port, Schlüssel, Origin-Schutz)
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(mcpConfig.port)/mcp")!, timeoutInterval: 5)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if (p["auth"] as? Bool) ?? true { req.setValue("Bearer \(mcpConfig.token)", forHTTPHeaderField: "Authorization") }
            if (p["origin"] as? Bool) ?? false { req.setValue("https://evil.example", forHTTPHeaderField: "Origin") }
            let body: [String: Any] = (p["body"] as? [String: Any]) ?? ["jsonrpc": "2.0", "id": 1, "method": "ping"]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            let session = URLSession(configuration: .ephemeral)
            session.dataTask(with: req) { data, response, _ in
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                DispatchQueue.main.async { reply(["status": status, "body": text], nil) }
                session.finishTasksAndInvalidate()
            }.resume()
        case "debug.importZip":
            // Prüft ZIP-Import (zipinfo/ditto als Unterprozesse) unter den echten Sandbox-Bedingungen
            fileQueue.async {
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("selftest-\(UUID().uuidString)")
                let src = tmp.appendingPathComponent("Export")
                try? FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
                try? Data("# Aus ZIP\n\nHallo".utf8).write(to: src.appendingPathComponent("Seite.md"))
                let zip = tmp.appendingPathComponent("Export.zip")
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                p.arguments = ["-c", "-k", src.path, zip.path]
                try? p.run()
                p.waitUntilExit()
                let result = Importer(store: self.router.store).read([zip])
                try? FileManager.default.removeItem(at: tmp)
                DispatchQueue.main.async { reply(result, nil) }
            }
        default:
            reply(NSNull(), nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
        }
    }
    #endif

    // MARK: Swift → JS

    func emit(_ event: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [event, value]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__substrat && window.__substrat.emit(...\(json))")
    }

    func flush(_ done: @escaping () -> Void) {
        webView.callAsyncJavaScript("if (window.__substrat) { await window.__substrat.flush(); }", arguments: [:], in: nil, in: .page) { _ in
            done()
        }
    }

    // MARK: MCP

    private func mcpStatusInfo() -> [String: Any] {
        var info: [String: Any] = ["enabled": mcpConfig.enabled, "port": Int(mcpConfig.port), "token": mcpConfig.token]
        switch mcpStatus {
        case .off: info["state"] = "off"
        case .starting: info["state"] = "starting"
        case .running: info["state"] = "running"
        case .failed(let message):
            info["state"] = "failed"
            info["error"] = message
        }
        return info
    }

    private func applyMcp(_ cfg: McpConfig, _ reply: @escaping (Any?, String?) -> Void) {
        do {
            try cfg.save(router.store.directory)
        } catch {
            reply(nil, String(describing: error))
            return
        }
        mcpConfig = cfg
        mcpServer.apply(cfg)
        reply(mcpStatusInfo(), nil)
    }

    /// Führt ein MCP-Werkzeug in der Web-Schicht aus (dort liegen Markdown, Link-Index und offene Editoren).
    func callTool(_ name: String, _ args: [String: Any], _ done: @escaping (Result<Any, McpToolError>) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8) else {
            return done(.failure(McpToolError("Ungültige Argumente")))
        }
        let script = """
        if (!window.__substrat || !window.__substrat.mcp) return JSON.stringify({ ok: false, error: "Substrat lädt noch – bitte gleich erneut versuchen." });
        return JSON.stringify(await window.__substrat.mcp(name, JSON.parse(args)));
        """
        webView.callAsyncJavaScript(script, arguments: ["name": name, "args": json], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                guard let text = value as? String, let data = text.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return done(.failure(McpToolError("Unerwartete Antwort der App")))
                }
                if (obj["ok"] as? Bool) == true {
                    done(.success(obj["data"] ?? NSNull()))
                } else {
                    done(.failure(McpToolError((obj["error"] as? String) ?? "Unbekannter Fehler")))
                }
            case .failure(let error):
                done(.failure(McpToolError("Fehler in der App: \(error.localizedDescription)")))
            }
        }
    }

    /// Wartet, bis alle bereits eingereihten Schreibvorgänge abgeschlossen sind.
    func drainStoreQueue() { queue.sync {} }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let isMain = action.targetFrame?.isMainFrame ?? false
        if isMain {
            // Klick auf einen Anhang: in der passenden App öffnen statt die Oberfläche zu ersetzen
            if url.scheme == "app", url.host == "asset" {
                openAsset(String(url.path.dropFirst()))
                return decisionHandler(.cancel)
            }
            if url.scheme == "app" { return decisionHandler(.allow) }
            if let devURL, url.host == devURL.host, url.port == devURL.port { return decisionHandler(.allow) }
            if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
            return decisionHandler(.cancel)
        }
        // Eingebettete Inhalte (iframes) dürfen nur https laden.
        decisionHandler(url.scheme == "https" || url.scheme == "about" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// Öffnet nur harmlose Dateitypen in ihrer App; alles andere (Skripte, Programme, Verweise) nur im Finder.
    private func openAsset(_ name: String) {
        guard let file = router.store.assetURL(name), FileManager.default.fileExists(atPath: file.path) else { return }
        if AssetPolicy.isSafeToOpen(file.lastPathComponent) {
            NSWorkspace.shared.open(file)
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([file])
        }
    }

    /// Zeitpunkte der letzten Abstürze des Web-Prozesses (gegen Neustart-Schleifen).
    private var crashTimes: [Date] = []

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        crashTimes = crashTimes.filter { now.timeIntervalSince($0) < 60 } + [now]
        if crashTimes.count > 6 {
            // Auch der abgesicherte Modus stürzt ab: nicht weiter neu laden, Datenordner anbieten
            let alert = NSAlert()
            alert.messageText = "Substrat kann die Oberfläche nicht laden."
            alert.informativeText = "Die Darstellung ist mehrfach abgestürzt. Deine Daten sind gespeichert. Du kannst den Datenordner öffnen oder die App beenden."
            alert.addButton(withTitle: "Datenordner zeigen")
            alert.addButton(withTitle: "Beenden")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.activateFileViewerSelecting([router.store.directory])
            }
            NSApp.terminate(nil)
            return
        }
        // Ab dem dritten Absturz pro Minute: abgesicherter Modus (zuletzt geöffnete Seite nicht wieder öffnen)
        let safe = crashTimes.count >= 3
        webView.load(URLRequest(url: startURL(safeMode: safe)))
    }

    private func startURL(safeMode: Bool) -> URL {
        let base = devURL ?? URL(string: "app://local/index.html")!
        guard safeMode, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        c.queryItems = [URLQueryItem(name: "safe", value: "1")]
        return c.url ?? base
    }

    // MARK: Export / Import

    private func exportSave(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = Self.safeFileName((p["name"] as? String) ?? "Export")
        panel.canCreateDirectories = true
        guard let window else { return reply(false, nil) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return reply(false, nil) }
            do {
                try Self.data(from: p).write(to: url, options: .atomic)
                reply(true, nil)
            } catch {
                reply(nil, String(describing: error))
            }
        }
    }

    private func exportSaveFiles(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Exportieren"
        panel.message = "Ordner für den Export wählen"
        guard let window else { return reply(false, nil) }
        let files = (p["files"] as? [[String: Any]]) ?? []
        let folder = Self.safeFileName((p["folder"] as? String) ?? "Substrat Export")
        let assetsDir = router.store.assetsDir
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let base = panel.url else { return reply(false, nil) }
            let root = base.appendingPathComponent(folder, isDirectory: true)
            self.fileQueue.async {
                do {
                    for file in files {
                        guard let rel = file["path"] as? String, let target = Self.resolve(rel, in: root) else { continue }
                        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                        if let asset = file["asset"] as? String, let src = self.router.store.assetURL(asset),
                           src.deletingLastPathComponent().standardizedFileURL == assetsDir.standardizedFileURL {
                            try? FileManager.default.removeItem(at: target)
                            try FileManager.default.copyItem(at: src, to: target)
                        } else {
                            try Self.data(from: file).write(to: target, options: .atomic)
                        }
                    }
                    DispatchQueue.main.async {
                        NSWorkspace.shared.activateFileViewerSelecting([root])
                        reply(true, nil)
                    }
                } catch {
                    DispatchQueue.main.async { reply(nil, String(describing: error)) }
                }
            }
        }
    }

    private func importPick(_ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Importieren"
        panel.message = "Notion-Export (ZIP oder Ordner), Markdown- oder CSV-Dateien wählen"
        guard let window else { return reply([], nil) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else { return reply([], nil) }
            let urls = panel.urls
            self.fileQueue.async {
                let result = Importer(store: self.router.store).read(urls)
                DispatchQueue.main.async { reply(result, nil) }
            }
        }
    }

    /// Lädt ein externes Bild/Medium einmalig herunter und speichert es lokal (nur auf ausdrücklichen Klick).
    /// Keine Cookies, nur https, nur Bild/Audio/Video, Abbruch sobald mehr als 50 MB ankommen.
    private func fetchAsset(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let s = p["url"] as? String, let url = URL(string: s), url.scheme?.lowercased() == "https" else {
            return reply(nil, "Nur https-Adressen werden unterstützt.")
        }
        MediaDownloader.fetch(url, limit: 50 * 1024 * 1024) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .failure(msg):
                DispatchQueue.main.async { reply(nil, msg) }
            case let .success(data, mime):
                let ext = UTType(mimeType: mime)?.preferredFilenameExtension ?? String(mime.split(separator: "/").last ?? "bin")
                self.fileQueue.async {
                    do {
                        let name = try self.router.store.saveAsset(data, ext: ext)
                        if let file = self.router.store.assetURL(name) { AssetPolicy.quarantine(file) }
                        DispatchQueue.main.async { reply(["url": "app://asset/\(name)"], nil) }
                    } catch {
                        DispatchQueue.main.async { reply(nil, "Speichern fehlgeschlagen.") }
                    }
                }
            }
        }
    }

    /// Dateien über den nativen Dialog wählen und direkt als Anhang kopieren (kein Base64 durch JavaScript).
    private func pickAssets(_ p: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = (p["multiple"] as? Bool) ?? false
        if (p["kind"] as? String) == "image" { panel.allowedContentTypes = [.image] }
        guard let window else { return reply([], nil) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else { return reply([], nil) }
            let urls = panel.urls
            let store = self.router.store
            self.fileQueue.async {
                var out: [[String: Any]] = []
                var errors: [String] = []
                for url in urls {
                    let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
                    let free = ZipInspector.availableCapacity(at: store.assetsDir) ?? Int64.max
                    if size > WebController.maxAssetBytes { errors.append("„\(url.lastPathComponent)“ ist größer als 2 GB."); continue }
                    if free - size < DiskReserve.forAssets { errors.append("Nicht genug freier Speicherplatz für „\(url.lastPathComponent)“."); continue }
                    do {
                        let name = try store.saveAssetFile(url, ext: url.pathExtension)
                        // Wie beim Import und Herunterladen: Gatekeeper prüft die Datei, falls sie geöffnet wird
                        if let file = store.assetURL(name) { AssetPolicy.quarantine(file) }
                        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                        out.append(["url": "app://asset/\(name)", "name": url.lastPathComponent, "mime": mime, "size": size])
                    } catch {
                        let reason = (error as? StoreError)?.description
                        errors.append(reason.map { "„\(url.lastPathComponent)“: \($0)" } ?? "„\(url.lastPathComponent)“ konnte nicht gespeichert werden.")
                    }
                }
                DispatchQueue.main.async { reply(["files": out, "errors": errors], nil) }
            }
        }
    }

    static let maxAssetBytes: Int64 = 2 * 1024 * 1024 * 1024

    // MARK: Hilfen

    static func data(from p: [String: Any]) throws -> Data {
        if let b64 = p["base64"] as? String {
            guard let d = Data(base64Encoded: b64) else { throw StoreError("Ungültige Daten") }
            return d
        }
        return Data(((p["content"] as? String) ?? "").utf8)
    }

    static func safeFileName(_ name: String) -> String {
        let cleaned = name.map { "/:\\\0".contains($0) ? "-" : $0 }
        let s = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty || s.hasPrefix(".") ? "Unbenannt" : String(s.prefix(120))
    }

    /// Löst einen relativen Pfad innerhalb von `root` auf und verhindert Ausbrüche über `..`.
    static func resolve(_ rel: String, in root: URL) -> URL? {
        let parts = rel.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        var url = root
        for part in parts { url.appendPathComponent(safeFileName(part)) }
        let rootPath = root.standardizedFileURL.path
        return url.standardizedFileURL.path.hasPrefix(rootPath + "/") ? url : nil
    }
}

/// Liefert die gebaute Web-UI (`app://local/…`) und Anhänge (`app://asset/…`).
/// Dateien werden im Hintergrund gelesen; Byte-Bereiche (Range) werden für Audio/Video unterstützt.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRoot: URL
    private let store: Store
    private let io = DispatchQueue(label: "substrat.scheme", qos: .userInitiated, attributes: .concurrent)
    /// Abgebrochene Aufgaben (nur auf dem Main-Thread benutzt).
    private var stopped = Set<ObjectIdentifier>()

    init(webRoot: URL, store: Store) {
        self.webRoot = webRoot.standardizedFileURL
        self.store = store
    }

    private func fileURL(for url: URL) -> URL? {
        switch url.host {
        case "local":
            var path = url.path
            if path.isEmpty || path == "/" { path = "/index.html" }
            let candidate = webRoot.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            return candidate.path.hasPrefix(webRoot.path + "/") ? candidate : nil
        case "asset":
            return store.assetURL(String(url.path.dropFirst()))
        default:
            return nil
        }
    }

    static let maxRangeBytes = 16 * 1024 * 1024

    /// "bytes=start-end" → Bereich innerhalb der Dateigröße.
    static func parseRange(_ header: String?, size: Int) -> Range<Int>? {
        guard let header, header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty, let suffix = Int(parts[1]), suffix > 0 {
            return max(0, size - suffix)..<size
        }
        guard let start = Int(parts[0]), start < size else { return nil }
        let end = Int(parts[1]).map { min($0, size - 1) } ?? size - 1
        return end >= start ? start..<(end + 1) : nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = fileURL(for: url) else { return fail(task, 404) }
        let rangeHeader = task.request.value(forHTTPHeaderField: "Range")
        let isAsset = url.host == "asset"
        let key = ObjectIdentifier(task)
        io.async {
            guard let handle = try? FileHandle(forReadingFrom: file),
                  let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) else {
                DispatchQueue.main.async { self.fail(task, 404) }
                return
            }
            defer { try? handle.close() }
            // Bereichsanfragen (Video/Audio) höchstens 16 MB je Antwort – der Player fragt den Rest nach.
            // Gelesen und gesendet wird in 4-MB-Blöcken: große Dateien landen nie komplett im Speicher.
            var range = SchemeHandler.parseRange(rangeHeader, size: size)
            if let r = range, r.count > SchemeHandler.maxRangeBytes { range = r.lowerBound..<(r.lowerBound + SchemeHandler.maxRangeBytes) }
            let served = range ?? 0..<size
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            var headers = [
                "Content-Type": mime,
                "Content-Length": String(served.count),
                "Accept-Ranges": "bytes",
                "Cache-Control": isAsset ? "max-age=31536000, immutable" : "no-cache",
            ]
            if let range { headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(size)" }
            DispatchQueue.main.sync {
                guard !self.stopped.contains(key) else { return }
                let response = HTTPURLResponse(url: url, statusCode: range == nil ? 200 : 206, httpVersion: "HTTP/1.1", headerFields: headers)!
                task.didReceive(response)
            }
            do {
                try handle.seek(toOffset: UInt64(served.lowerBound))
                var remaining = served.count
                while remaining > 0 {
                    guard let chunk = try handle.read(upToCount: min(remaining, 4 * 1024 * 1024)), !chunk.isEmpty else { break }
                    remaining -= chunk.count
                    // Synchron übergeben (es liegt immer nur ein Block im Speicher) – ein Sprung je Block,
                    // der zugleich meldet, ob die Anfrage inzwischen abgebrochen wurde
                    let delivered = DispatchQueue.main.sync { () -> Bool in
                        guard !self.stopped.contains(key) else { return false }
                        task.didReceive(chunk)
                        return true
                    }
                    if !delivered { break }
                }
            } catch {
                DispatchQueue.main.async {
                    guard !self.stopped.contains(key) else { self.stopped.remove(key); return }
                    task.didFailWithError(error)
                }
                return
            }
            DispatchQueue.main.async {
                guard !self.stopped.contains(key) else { self.stopped.remove(key); return }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        if stopped.remove(ObjectIdentifier(task)) != nil { return }
        let response = HTTPURLResponse(url: task.request.url ?? URL(string: "app://local/")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        task.didReceive(response)
        task.didFinish()
    }
}

/// Lädt Mediendaten mit Größenlimit: bricht ab, sobald das Limit überschritten wird (auch ohne Content-Length).
final class MediaDownloader: NSObject, URLSessionDataDelegate {
    enum Result {
        case success(Data, String)
        case failure(String)
    }

    private let limit: Int
    private let done: (Result) -> Void
    private var data = Data()
    private var mime = ""
    private var finished = false

    private init(limit: Int, done: @escaping (Result) -> Void) {
        self.limit = limit
        self.done = done
    }

    static func fetch(_ url: URL, limit: Int, done: @escaping (Result) -> Void) {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        let delegate = MediaDownloader(limit: limit, done: done)
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        session.dataTask(with: url).resume()
        session.finishTasksAndInvalidate()
    }

    private func finish(_ r: Result) {
        guard !finished else { return }
        finished = true
        done(r)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        mime = (response.mimeType ?? "").lowercased()
        let okType = (mime.hasPrefix("image/") || mime.hasPrefix("video/") || mime.hasPrefix("audio/")) && mime != "image/svg+xml"
        guard let http, (200..<300).contains(http.statusCode) else {
            finish(.failure("Download fehlgeschlagen."))
            return completionHandler(.cancel)
        }
        guard okType else {
            finish(.failure("Kein unterstützter Medientyp (\(mime))."))
            return completionHandler(.cancel)
        }
        if response.expectedContentLength > Int64(limit) {
            finish(.failure("Datei ist größer als 50 MB."))
            return completionHandler(.cancel)
        }
        completionHandler(.allow)
    }

    /// Weiterleitungen nur auf https folgen (kein Downgrade auf http).
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme?.lowercased() == "https" ? request : nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        data.append(chunk)
        if data.count > limit {
            dataTask.cancel()
            finish(.failure("Datei ist größer als 50 MB."))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error, !finished { return finish(.failure("Download fehlgeschlagen: \(error.localizedDescription)")) }
        finish(.success(data, mime))
    }
}

/// WebView mit zwei Anpassungen für eine native App:
/// - merkt sich den letzten Mausdruck (für zuverlässiges Fensterziehen über die Titelleiste)
/// - entfernt Browser-Einträge wie „Neu laden“ aus dem Kontextmenü
final class AppWebView: WKWebView {
    private var lastMouseDown: (event: NSEvent, time: TimeInterval)?

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = (event, ProcessInfo.processInfo.systemUptime)
        super.mouseDown(with: event)
    }

    /// Der Mausdruck der letzten halben Sekunde (sonst nil).
    func recentMouseDown() -> NSEvent? {
        guard let m = lastMouseDown, ProcessInfo.processInfo.systemUptime - m.time < 0.5 else { return nil }
        return m.event
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        let unwanted: Set<String> = [
            "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
            "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
            "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage",
            "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierInspectElement",
        ]
        for item in menu.items where unwanted.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
        // Doppelte/führende Trennlinien aufräumen
        while let first = menu.items.first, first.isSeparatorItem { menu.removeItem(first) }
        while let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
        var prevSeparator = false
        for item in menu.items {
            if item.isSeparatorItem && prevSeparator { menu.removeItem(item) }
            prevSeparator = item.isSeparatorItem
        }
        super.willOpenMenu(menu, with: event)
    }
}
