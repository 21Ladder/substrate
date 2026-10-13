import Darwin
import Foundation

/// Welche Anhänge dürfen per Klick in einer anderen App geöffnet werden?
/// Bewusst eine Positivliste: Skripte (.command, .terminal, .sh), Verweise (.fileloc, .webloc),
/// Programme, Installer und aktive Inhalte (HTML, SVG) werden nur im Finder gezeigt.
public enum AssetPolicy {
    static let openable: Set<String> = [
        // Bilder
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
        // Dokumente
        "pdf", "txt", "md", "markdown", "csv", "rtf",
        "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pages", "numbers", "key", "odt", "ods", "odp",
        // Audio & Video
        "mp3", "m4a", "wav", "aac", "flac", "aiff", "aif", "ogg", "mp4", "mov", "m4v", "webm",
    ]

    public static func isSafeToOpen(_ filename: String) -> Bool {
        let ext = (filename as NSString).pathExtension.lowercased()
        return openable.contains(ext)
    }

    /// Markiert eine Datei wie einen Download, damit Gatekeeper beim Öffnen prüft und warnt.
    public static func quarantine(_ url: URL, agent: String = "Substrat") {
        var values = URLResourceValues()
        values.quarantineProperties = [
            "LSQuarantineAgentName": agent,
            "LSQuarantineType": "LSQuarantineTypeOtherDownload",
            "LSQuarantineTimeStamp": Date(),
        ]
        var target = url
        try? target.setResourceValues(values)
    }

    public static func isQuarantined(_ url: URL) -> Bool {
        ((try? url.resourceValues(forKeys: [.quarantinePropertiesKey]))?.quarantineProperties) != nil
    }
}

/// Exklusive Sperre auf den Datenordner: verhindert, dass zwei App-Instanzen gleichzeitig
/// dieselbe Datenbank bearbeiten und sich gegenseitig Änderungen überschreiben.
public final class InstanceLock {
    private let fd: Int32

    /// Gibt nil zurück, wenn bereits eine andere Instanz die Sperre hält.
    public init?(directory: URL) {
        let path = directory.appendingPathComponent(".substrat.lock").path
        let fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }
        self.fd = fd
        // PID hineinschreiben (nur zur Diagnose)
        let pid = "\(getpid())\n"
        _ = ftruncate(fd, 0)
        _ = pid.withCString { write(fd, $0, strlen($0)) }
    }

    deinit {
        flock(fd, LOCK_UN)
        close(fd)
    }
}

/// Freier Speicherplatz, der beim Speichern von Anhängen mindestens erhalten bleiben soll.
public enum DiskReserve {
    public static let forAssets: Int64 = 512 * 1024 * 1024
}

/// Grenzen für das Entpacken von Archiven (Schutz vor ZIP-Bomben).
public struct UnzipBudget {
    /// Höchstens so viele Bytes dürfen insgesamt entpackt werden.
    public var remainingBytes: Int64
    public var remainingFiles: Int
    /// Mindestens so viel Speicherplatz soll auf dem Volume frei bleiben.
    public let reserveBytes: Int64

    public init(maxBytes: Int64 = 2 * 1024 * 1024 * 1024, maxFiles: Int = 50_000, reserveBytes: Int64 = 5 * 1024 * 1024 * 1024) {
        remainingBytes = maxBytes
        remainingFiles = maxFiles
        self.reserveBytes = reserveBytes
    }
}

public enum ZipInspector {
    /// Liest Dateianzahl und entpackte Gesamtgröße aus dem Archivverzeichnis (ohne zu entpacken).
    /// Nutzt das System-Werkzeug `zipinfo`; nil, wenn das Archiv nicht lesbar ist.
    public static func totals(of zip: URL) -> (files: Int, bytes: Int64)? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
        p.arguments = ["-t", zip.path]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0, let text = String(data: data, encoding: .utf8) else { return nil }
        return parseTotals(text)
    }

    /// "3 files, 52428800 bytes uncompressed, 51083 bytes compressed:  99.9%"
    static func parseTotals(_ text: String) -> (files: Int, bytes: Int64)? {
        let line = text.split(separator: "\n").last.map(String.init) ?? ""
        let numbers = line.split(whereSeparator: { !$0.isNumber && $0 != "." }).compactMap { Double($0) }
        guard numbers.count >= 2, line.contains("uncompressed") else { return nil }
        return (Int(numbers[0]), Int64(numbers[1]))
    }

    /// Freier Platz auf dem Volume des Ordners.
    public static func availableCapacity(at url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }
}
