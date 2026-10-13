// swift-tools-version:5.9
import PackageDescription

// Keine Fremdabhängigkeiten: nur AppKit, WebKit, CryptoKit und die System-SQLite.
let package = Package(
    name: "Substrat",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "SubstratCore",
            path: "Sources/SubstratCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "Substrat",
            dependencies: ["SubstratCore"],
            path: "Sources/Substrat"
        ),
        .testTarget(
            name: "SubstratTests",
            dependencies: ["SubstratCore"],
            path: "Tests/SubstratTests"
        ),
    ]
)
