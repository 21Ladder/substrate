// Zeichnet das App-Symbol (gestapelte Schichten = „Substrat“) und erzeugt mac/AppIcon.icns.
// Nur Bordmittel von macOS (CoreGraphics, ImageIO, sips, iconutil) – keine Pakete.
// Aufruf: swift scripts/make-icon.swift
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
// Oben links als Ursprung, damit die Maße wie in einem Grafikprogramm lesbar sind
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

// Fläche im macOS-Raster: 824 × 824 mit abgerundeten Ecken und leichtem Schatten
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: 12), blur: 28, color: color(0, 0, 0, 0.35))
ctx.addPath(tilePath)
ctx.setFillColor(color(24, 24, 24))
ctx.fillPath()
ctx.restoreGState()

// Dunkler Verlauf auf der Fläche
ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(52, 52, 50), color(16, 16, 15)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
ctx.restoreGState()

// Drei Schichten als Rauten (isometrisch), von unten nach oben gezeichnet; dunkle Kontur trennt sie
func layer(centerY: CGFloat, fill: CGColor) {
    let w: CGFloat = 520, h: CGFloat = 260
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 512, y: centerY - h / 2))
    path.addLine(to: CGPoint(x: 512 + w / 2, y: centerY))
    path.addLine(to: CGPoint(x: 512, y: centerY + h / 2))
    path.addLine(to: CGPoint(x: 512 - w / 2, y: centerY))
    path.closeSubpath()
    ctx.addPath(path)
    ctx.setLineJoin(.round)
    ctx.setLineWidth(22)
    ctx.setStrokeColor(color(22, 22, 21))
    ctx.setFillColor(fill)
    ctx.drawPath(using: .fillStroke)
}
layer(centerY: 640, fill: color(120, 120, 117))
layer(centerY: 540, fill: color(190, 190, 186))
layer(centerY: 440, fill: color(255, 255, 255))

// PNG schreiben, dann alle Größen für das iconset und daraus die .icns
let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("substrat-icon-\(UUID().uuidString)")
let iconset = tmp.appendingPathComponent("AppIcon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: tmp) }
let master = tmp.appendingPathComponent("icon_1024.png")
let dest = CGImageDestinationCreateWithURL(master as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("PNG konnte nicht geschrieben werden") }

func run(_ tool: String, _ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    try! p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { fatalError("\(tool) fehlgeschlagen") }
}
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let px = base * scale
        let name = "icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png"
        run("/usr/bin/sips", ["-z", "\(px)", "\(px)", master.path, "--out", iconset.appendingPathComponent(name).path])
    }
}
let out = root.appendingPathComponent("mac/AppIcon.icns")
run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", out.path])
print("✓ \(out.path)")
