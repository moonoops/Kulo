import AppKit

let desktopRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = desktopRoot.appendingPathComponent("assets")
let webPublic = desktopRoot.deletingLastPathComponent().appendingPathComponent("web/public")
let sourceURL = assets.appendingPathComponent("kulo-icon-source.png")
guard let source = NSImage(contentsOf: sourceURL) else {
    fatalError("Cannot load Kulo icon source: \(sourceURL.path)")
}
let traySourceURL = assets.appendingPathComponent("kulo-tray-source.png")
guard let traySource = NSImage(contentsOf: traySourceURL) else {
    fatalError("Cannot load Kulo tray icon source: \(traySourceURL.path)")
}

func render(image: NSImage, size: Int, inset: CGFloat, radius: CGFloat, to file: URL) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot create icon bitmap")
    }
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let canvas = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor.clear.setFill()
    canvas.fill(using: .copy)
    let frame = canvas.insetBy(dx: CGFloat(size) * inset, dy: CGFloat(size) * inset)
    if radius > 0 {
        NSBezierPath(roundedRect: frame, xRadius: frame.width * radius, yRadius: frame.height * radius).addClip()
    }
    image.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Cannot encode icon PNG")
    }
    try png.write(to: file, options: .atomic)
}

func render(size: Int, inset: CGFloat, radius: CGFloat, to file: URL) throws {
    try render(image: source, size: size, inset: inset, radius: radius, to: file)
}

let manager = FileManager.default
try manager.createDirectory(at: webPublic, withIntermediateDirectories: true)
try render(size: 512, inset: 0, radius: 0.14, to: webPublic.appendingPathComponent("kulo-icon.png"))
try render(size: 32, inset: 0, radius: 0.14, to: webPublic.appendingPathComponent("favicon-32.png"))
// Home-screen launchers supply their own mask; retain the full paper background.
try render(size: 180, inset: 0, radius: 0, to: webPublic.appendingPathComponent("apple-touch-icon.png"))
try render(size: 1024, inset: 0.09375, radius: 0.22, to: assets.appendingPathComponent("kulo-icon.png"))
// macOS menu bar template icons: 22x22pt canvas with ~20pt optical glyph centered cleanly.
try render(image: traySource, size: 22, inset: 0.05, radius: 0, to: assets.appendingPathComponent("kulo-trayTemplate.png"))
try render(image: traySource, size: 44, inset: 0.05, radius: 0, to: assets.appendingPathComponent("kulo-trayTemplate@2x.png"))

let temporary = manager.temporaryDirectory.appendingPathComponent("kulo-icons-\(UUID().uuidString)")
let iconset = temporary.appendingPathComponent("kulo.iconset")
try manager.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? manager.removeItem(at: temporary) }
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try render(size: points * scale, inset: 0.09375, radius: 0.22,
                   to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
    }
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", assets.appendingPathComponent("kulo.icns").path, iconset.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Generated Kulo desktop and web icons.")
