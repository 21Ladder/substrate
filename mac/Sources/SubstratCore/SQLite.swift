import Foundation
import SQLite3

public struct SQLiteError: Error, CustomStringConvertible {
    public let code: Int32
    public let message: String
    public var description: String { "SQLite error \(code): \(message)" }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Minimaler SQLite-Wrapper. Nicht thread-safe: Zugriff nur von einer seriellen Queue.
public final class SQLiteDB {
    private var handle: OpaquePointer?
    private var cache: [String: OpaquePointer] = [:]

    public init(path: String, readOnly: Bool = false) throws {
        let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_NOMUTEX
        let rc = sqlite3_open_v2(path, &handle, flags, nil)
        guard rc == SQLITE_OK else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw SQLiteError(code: rc, message: msg)
        }
        sqlite3_busy_timeout(handle, 2000)
    }

    deinit {
        for stmt in cache.values { sqlite3_finalize(stmt) }
        sqlite3_close(handle)
    }

    private func error(_ rc: Int32) -> SQLiteError {
        SQLiteError(code: rc, message: String(cString: sqlite3_errmsg(handle)))
    }

    public func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(handle, sql, nil, nil, &err)
        if rc != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(err)
            throw SQLiteError(code: rc, message: msg)
        }
    }

    private func statement(_ sql: String) throws -> OpaquePointer {
        if let stmt = cache[sql] {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            return stmt
        }
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v3(handle, sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &stmt, nil)
        guard rc == SQLITE_OK, let stmt else { throw error(rc) }
        cache[sql] = stmt
        return stmt
    }

    private func bind(_ stmt: OpaquePointer, _ args: [Any?]) throws {
        for (i, arg) in args.enumerated() {
            let idx = Int32(i + 1)
            let rc: Int32
            switch arg {
            case nil, is NSNull:
                rc = sqlite3_bind_null(stmt, idx)
            case let v as String:
                rc = sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT)
            case let v as Data:
                rc = v.withUnsafeBytes { buf in
                    sqlite3_bind_blob(stmt, idx, buf.baseAddress, Int32(buf.count), SQLITE_TRANSIENT)
                }
            case let v as NSNumber:
                // Deckt Int, Double, Bool und die NSNumber-Werte aus JS ab.
                if CFNumberIsFloatType(v) {
                    rc = sqlite3_bind_double(stmt, idx, v.doubleValue)
                } else {
                    rc = sqlite3_bind_int64(stmt, idx, v.int64Value)
                }
            default:
                rc = sqlite3_bind_text(stmt, idx, String(describing: arg!), -1, SQLITE_TRANSIENT)
            }
            if rc != SQLITE_OK { throw error(rc) }
        }
    }

    @discardableResult
    public func run(_ sql: String, _ args: Any?...) throws -> Int {
        try run(sql, args: args)
    }

    @discardableResult
    public func run(_ sql: String, args: [Any?]) throws -> Int {
        let stmt = try statement(sql)
        defer { sqlite3_reset(stmt) }
        try bind(stmt, args)
        var rc = sqlite3_step(stmt)
        while rc == SQLITE_ROW { rc = sqlite3_step(stmt) }
        guard rc == SQLITE_DONE else { throw error(rc) }
        return Int(sqlite3_changes(handle))
    }

    public func query(_ sql: String, _ args: Any?...) throws -> [[String: Any]] {
        try query(sql, args: args)
    }

    public func query(_ sql: String, args: [Any?]) throws -> [[String: Any]] {
        let stmt = try statement(sql)
        defer { sqlite3_reset(stmt) }
        try bind(stmt, args)
        var rows: [[String: Any]] = []
        let count = sqlite3_column_count(stmt)
        var names: [String] = []
        for i in 0..<count { names.append(String(cString: sqlite3_column_name(stmt, i))) }
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw error(rc) }
            var row: [String: Any] = [:]
            for i in 0..<count {
                switch sqlite3_column_type(stmt, i) {
                case SQLITE_INTEGER: row[names[Int(i)]] = Int(sqlite3_column_int64(stmt, i))
                case SQLITE_FLOAT: row[names[Int(i)]] = sqlite3_column_double(stmt, i)
                case SQLITE_TEXT: row[names[Int(i)]] = String(cString: sqlite3_column_text(stmt, i))
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, i))
                    if let p = sqlite3_column_blob(stmt, i) { row[names[Int(i)]] = Data(bytes: p, count: n) }
                    else { row[names[Int(i)]] = Data() }
                default: row[names[Int(i)]] = NSNull()
                }
            }
            rows.append(row)
        }
        return rows
    }

    public func scalar(_ sql: String, _ args: Any?...) throws -> Any? {
        try query(sql, args: args).first?.values.first
    }

    private var depth = 0

    /// Transaktion; verschachtelte Aufrufe werden zu Savepoints.
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        let name = "sp\(depth)"
        let outer = depth == 0
        try exec(outer ? "BEGIN IMMEDIATE" : "SAVEPOINT \(name)")
        depth += 1
        let result: T
        do {
            result = try body()
        } catch {
            depth -= 1
            rollback(outer: outer, name: name)
            throw error
        }
        depth -= 1
        do {
            try exec(outer ? "COMMIT" : "RELEASE \(name)")
        } catch {
            rollback(outer: outer, name: name)
            throw error
        }
        return result
    }

    private func rollback(outer: Bool, name: String) {
        if outer {
            try? exec("ROLLBACK")
        } else {
            try? exec("ROLLBACK TO \(name)")
            try? exec("RELEASE \(name)")
        }
    }
}
