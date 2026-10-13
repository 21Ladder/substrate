import AppKit
import SubstratCore
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webController: WebController!
    private var terminating = false
    private var instanceLock: InstanceLock?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store: Store
        do {
            let dir = try Self.dataDirectory()
            // Nur eine Instanz pro Datenordner: sonst überschreiben sich zwei Fenster gegenseitig
            guard let lock = InstanceLock(directory: dir) else {
                Self.activateOtherInstance()
                NSApp.terminate(nil)
                return
            }
            instanceLock = lock
            // Integrität nur nach einem unsauberen Ende prüfen (die Prüfung liest die ganze Datenbank)
            let marker = Store.sessionMarker(dir)
            #if DEBUG
            if FileManager.default.fileExists(atPath: marker.path) { print("SESSION: unsauberes Ende erkannt, Integritätsprüfung läuft"); fflush(stdout) }
            #endif
            if FileManager.default.fileExists(atPath: marker.path),
               !Store.quickCheck(dir.appendingPathComponent("workspace.sqlite")),
               !Self.offerRestore(dir) {
                NSApp.terminate(nil)
                return
            }
            FileManager.default.createFile(atPath: marker.path, contents: Data())
            #if DEBUG
            print("SESSION: gestartet"); fflush(stdout)
            #endif
            sessionMarker = marker
            store = try Store(directory: dir)
            scheduleBackups(dir)
            try? store.purgeExpiredTrash()
        } catch {
            let alert = NSAlert()
            alert.messageText = "Substrat konnte die Datenbank nicht öffnen."
            alert.informativeText = String(describing: error)
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Substrat"
        window.minSize = NSSize(width: 640, height: 420)
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0.098, green: 0.098, blue: 0.098, alpha: 1)
                : NSColor.white
        }
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("SubstratMain")
        window.tabbingMode = .disallowed

        webController = WebController(store: store, window: window)
        window.contentView = webController.webView
        window.makeKeyAndOrderFront(nil)

        NSApp.mainMenu = MainMenu.build(target: self)
        NSApp.activate(ignoringOtherApps: true)
        #if DEBUG
        if ProcessInfo.processInfo.environment["SUBSTRAT_SELFTEST_DIR"] != nil {
            // Automatischer Test: Fenster sichtbar halten, sonst pausiert WebKit das Zeichnen
            window.level = .floating
            window.orderFrontRegardless()
        }
        #endif
    }

    private var backupTimer: Timer?
    private var sessionMarker: URL?
    private let backupQueue = DispatchQueue(label: "substrat.backup", qos: .utility)

    /// Tägliches Backup über eine eigene Verbindung im Hintergrund: kurz nach dem Start und alle 6 Stunden
    /// geprüft (höchstens eines pro Tag). Blockiert weder Speichern noch Beenden.
    private func scheduleBackups(_ dir: URL) {
        let run: () -> Void = { [backupQueue] in
            backupQueue.async {
                do {
                    _ = try Store.backup(directory: dir, kind: .daily)
                } catch {
                    // Nicht verschlucken: z. B. „Datenbank beschädigt“ muss der Nutzer erfahren
                    let message = (error as? StoreError)?.description ?? error.localizedDescription
                    DispatchQueue.main.async { [weak self] in
                        self?.webController.webView.callAsyncJavaScript(
                            "window.__substrat && window.__substrat.emit('backup-error', message)",
                            arguments: ["message": message], in: nil, in: .page) { _ in }
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { run() }
        backupTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in run() }
    }

    /// Bietet an, das neueste Backup wiederherzustellen. Gibt false zurück, wenn beendet werden soll.
    /// Fragt nach einem unsauberen Ende mit Integritätsfehler, wie es weitergehen soll.
    /// Gibt false zurück, wenn beendet werden soll.
    static func offerRestore(_ dir: URL) -> Bool {
        let latest = Store.listBackups(directory: dir).first { Store.quickCheck($0) }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Die Datenbank meldet Integritätsfehler."
        alert.informativeText = latest.map {
            "Oft lässt sie sich trotzdem öffnen. Alternativ stellt Substrat das letzte intakte Backup (\($0.lastPathComponent)) wieder her – Änderungen seit diesem Backup gehen dann verloren. Die beschädigte Datei bleibt erhalten."
        } ?? "Oft lässt sie sich trotzdem öffnen. Es gibt kein intaktes Backup."
        alert.addButton(withTitle: "Trotzdem öffnen")
        if latest != nil { alert.addButton(withTitle: "Backup wiederherstellen") }
        alert.addButton(withTitle: "Beenden")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn { return true }
        if let latest, response == .alertSecondButtonReturn {
            do {
                try Store.restore(backup: latest, into: dir)
                return true
            } catch {
                let e = NSAlert()
                e.messageText = "Wiederherstellen fehlgeschlagen."
                e.informativeText = String(describing: error)
                e.runModal()
            }
        }
        return false
    }

    /// Holt die bereits laufende Instanz nach vorne (oder meldet, dass sie läuft).
    static func activateOtherInstance() {
        let me = NSRunningApplication.current
        if let id = Bundle.main.bundleIdentifier,
           let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != me.processIdentifier }) {
            other.activate()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Substrat läuft bereits."
        alert.informativeText = "Eine andere Instanz verwendet denselben Datenordner."
        alert.runModal()
    }

    /// Pfad unter "Application Support/Substrat" (in der Sandbox: im App-Container); absolute Pfade bleiben.
    static func resolveDataPath(_ path: String) throws -> URL {
        if path.hasPrefix("/") { return URL(fileURLWithPath: path, isDirectory: true) }
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Substrat", isDirectory: true)
        return base.appendingPathComponent(path, isDirectory: true)
    }

    static func dataDirectory() throws -> URL {
        let custom = ProcessInfo.processInfo.environment["SUBSTRAT_DATA_DIR"] ?? ""
        let url = try resolveDataPath(custom.isEmpty ? "default" : custom)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        webController?.mcpServer?.stop()
        // Sauber beendet: beim nächsten Start ist keine Integritätsprüfung nötig
        if let sessionMarker { try? FileManager.default.removeItem(at: sessionMarker) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let webController, !terminating else { return .terminateNow }
        terminating = true
        // Ausstehende Änderungen der UI sichern, bevor beendet wird (mit Zeitlimit).
        var replied = false
        let reply = {
            guard !replied else { return }
            replied = true
            webController.drainStoreQueue()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        webController.flush { reply() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { reply() }
        return .terminateLater
    }

    func windowDidEnterFullScreen(_ notification: Notification) { webController?.emit("fullscreen", true) }
    func windowDidExitFullScreen(_ notification: Notification) { webController?.emit("fullscreen", false) }

    // MARK: Menüaktionen

    @objc func zoomIn(_ sender: Any?) { webController.webView.pageZoom = min(webController.webView.pageZoom + 0.1, 2.0) }
    @objc func zoomOut(_ sender: Any?) { webController.webView.pageZoom = max(webController.webView.pageZoom - 0.1, 0.5) }
    @objc func openSettings(_ sender: Any?) {
        webController.webView.evaluateJavaScript("window.__substrat && window.__substrat.openSettings()")
    }
    @objc func zoomReset(_ sender: Any?) { webController.webView.pageZoom = 1.0 }
}
