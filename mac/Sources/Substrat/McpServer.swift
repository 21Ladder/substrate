import Foundation
import Network
import SubstratCore

/// Lokaler MCP-Server: lauscht nur auf 127.0.0.1, eine Anfrage je Verbindung, danach wird geschlossen.
/// Werkzeugaufrufe laufen nacheinander (eine Warteschlange), damit sich Änderungen nie überholen.
final class McpServer {
    enum Status: Equatable {
        case off
        case starting
        case running
        case failed(String)
    }

    private let queue = DispatchQueue(label: "substrat.mcp")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    /// Erhöht sich bei jedem Start/Stopp: Rückmeldungen alter Listener und Aufrufe werden verworfen.
    private var generation = 0
    private var config: McpConfig
    private let runTool: McpProtocol.ToolRunner
    // Wird nur auf `queue` benutzt (dort laufen alle Verbindungs-Rückrufe) – daher direkter Zugriff auf config
    private lazy var mcp = McpProtocol(config: { [unowned self] in self.config }, run: { [unowned self] name, args, done in
        self.enqueue(name, args, done)
    })

    /// Statusänderungen (auf dem Main-Thread).
    var onStatus: ((Status) -> Void)?
    private(set) var status: Status = .off

    static let maxConnections = 4
    static let readTimeout: TimeInterval = 10
    static let toolTimeout: TimeInterval = 30

    init(config: McpConfig, runTool: @escaping McpProtocol.ToolRunner) {
        self.config = config
        self.runTool = runTool
    }

    // MARK: Start/Stopp

    /// Übernimmt neue Einstellungen und startet bzw. stoppt den Listener entsprechend.
    func apply(_ newConfig: McpConfig) {
        queue.async {
            let restart = newConfig.port != self.config.port || newConfig.enabled != self.config.enabled || self.listener == nil
            self.config = newConfig
            guard restart else { return }
            self.stopLocked()
            if newConfig.enabled && !newConfig.token.isEmpty { self.startLocked() }
        }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    private func startLocked() {
        generation += 1
        let gen = generation
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Nur an die Loopback-Adresse binden – nie aus dem Netzwerk erreichbar
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: config.port)!)
        let listener: NWListener
        do {
            listener = try NWListener(using: params)
        } catch {
            setStatus(.failed("Server konnte nicht starten: \(error.localizedDescription)"))
            return
        }
        self.listener = listener
        setStatus(.starting)
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, gen == self.generation else { return }
            switch state {
            case .ready:
                self.setStatus(.running)
            case .failed(let error):
                let text: String
                if case .posix(let code) = error, code == .EADDRINUSE {
                    text = "Port \(self.config.port) ist belegt – bitte einen anderen wählen"
                } else {
                    text = "Server-Fehler: \(error.localizedDescription)"
                }
                self.stopLocked()
                self.setStatus(.failed(text))
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self, gen == self.generation else { conn.cancel(); return }
            self.accept(conn, gen: gen)
        }
        listener.start(queue: queue)
    }

    private func stopLocked() {
        generation += 1
        listener?.cancel()
        listener = nil
        for conn in connections.values { conn.cancel() }
        connections.removeAll()
        // Noch nicht begonnene Aufrufe verwerfen (ein laufender Aufruf endet ohne Antwort)
        pending.removeAll()
        setStatus(.off)
    }

    private func setStatus(_ s: Status) {
        status = s
        DispatchQueue.main.async { [weak self] in self?.onStatus?(s) }
    }

    // MARK: Verbindungen

    private func accept(_ conn: NWConnection, gen: Int) {
        // Zweite Absicherung zur Bindung an 127.0.0.1: nur Verbindungen von der eigenen Maschine
        if case .hostPort(let host, _) = conn.endpoint, !Self.isLoopback(host) {
            conn.cancel()
            return
        }
        guard connections.count < Self.maxConnections else {
            conn.cancel()
            return
        }
        let key = ObjectIdentifier(conn)
        connections[key] = conn
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.connections.removeValue(forKey: key)
                self?.answering.remove(key)
            default:
                break
            }
        }
        conn.start(queue: queue)
        // Langsame oder hängende Clients nicht ewig offen halten
        queue.asyncAfter(deadline: .now() + Self.readTimeout) { [weak self, weak conn] in
            guard let self, let conn, self.connections[key] != nil, !self.answering.contains(key) else { return }
            conn.cancel()
        }
        receive(conn, key: key, gen: gen, buffer: Data())
    }

    /// Verbindungen, deren Anfrage gerade bearbeitet wird (für sie gilt das Lese-Timeout nicht mehr).
    private var answering = Set<ObjectIdentifier>()

    private func receive(_ conn: NWConnection, key: ObjectIdentifier, gen: Int, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self, gen == self.generation else { conn.cancel(); return }
            var buffer = buffer
            if let data { buffer.append(data) }
            switch HttpParser.parse(buffer) {
            case .incomplete:
                if isComplete || error != nil { conn.cancel(); return }
                self.receive(conn, key: key, gen: gen, buffer: buffer)
            case .failure(let response):
                self.send(response, on: conn)
            case .request(let request):
                self.answering.insert(key)
                self.mcp.handle(request) { [weak self] response in
                    self?.queue.async {
                        guard let self, gen == self.generation else { conn.cancel(); return }
                        self.answering.remove(key)
                        self.send(response, on: conn)
                    }
                }
            }
        }
    }

    private func send(_ response: HttpResponse, on conn: NWConnection) {
        conn.send(content: response.serialized(), completion: .contentProcessed { _ in conn.cancel() })
    }

    static func isLoopback(_ host: NWEndpoint.Host) -> Bool {
        switch host {
        case .ipv4(let a): return a.isLoopback
        case .ipv6(let a): return a.isLoopback
        case .name(let n, _): return n == "localhost"
        @unknown default: return false
        }
    }

    // MARK: Werkzeug-Warteschlange

    private struct Job {
        let name: String
        let args: [String: Any]
        let done: (Result<Any, McpToolError>) -> Void
        let gen: Int
    }
    private var pending: [Job] = []
    private var busy = false

    private func enqueue(_ name: String, _ args: [String: Any], _ done: @escaping (Result<Any, McpToolError>) -> Void) {
        queue.async {
            self.pending.append(Job(name: name, args: args, done: done, gen: self.generation))
            self.next()
        }
    }

    private func next() {
        guard !busy, !pending.isEmpty else { return }
        let job = pending.removeFirst()
        guard job.gen == generation else { return next() }
        busy = true
        var answered = false
        let answer: (Result<Any, McpToolError>) -> Void = { result in
            guard !answered else { return }
            answered = true
            job.done(result)
        }
        // Zeitlimit: Claude bekommt eine Antwort; der nächste Aufruf startet aber erst, wenn dieser wirklich fertig ist
        queue.asyncAfter(deadline: .now() + Self.toolTimeout) {
            answer(.failure(McpToolError("Zeitüberschreitung: Substrat hat nicht innerhalb von \(Int(Self.toolTimeout)) Sekunden geantwortet")))
        }
        let finish: (Result<Any, McpToolError>) -> Void = { [weak self] result in
            guard let self else { return }
            self.queue.async {
                answer(result)
                self.busy = false
                self.next()
            }
        }
        DispatchQueue.main.async { self.runTool(job.name, job.args, finish) }
    }
}
