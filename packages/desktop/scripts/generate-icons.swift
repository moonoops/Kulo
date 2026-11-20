import AppKit
import CoreGraphics

let desktopRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = desktopRoot.appendingPathComponent("assets")
let webPublic = desktopRoot.deletingLastPathComponent().appendingPathComponent("web/public")
let sourceURL = assets.appendingPathComponent("kulo-icon-source.png")
guard let source = NSImage(contentsOf: sourceURL) else {
    fatalError("Cannot load Kulo icon source: \(sourceURL.path)")
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

/// Draws the macOS menu bar cat icon in a normalized 22x22pt vector canvas.
func drawTrayTemplateIcon(in ctx: CGContext, ink: CGColor = NSColor.black.cgColor) {
    let head = CGMutablePath()
    head.move(to: CGPoint(x: 2.8, y: 10.6))
    head.addLine(to: CGPoint(x: 3.3, y: 18.4))
    head.addQuadCurve(to: CGPoint(x: 4.6, y: 18.8), control: CGPoint(x: 3.5, y: 19.3))
    head.addLine(to: CGPoint(x: 8.3, y: 15.6))
    head.addQuadCurve(to: CGPoint(x: 13.7, y: 15.6), control: CGPoint(x: 11.0, y: 16.4))
    head.addLine(to: CGPoint(x: 17.4, y: 18.8))
    head.addQuadCurve(to: CGPoint(x: 18.7, y: 18.4), control: CGPoint(x: 18.5, y: 19.3))
    head.addLine(to: CGPoint(x: 19.2, y: 10.6))
    head.addCurve(
        to: CGPoint(x: 11.0, y: 3.2),
        control1: CGPoint(x: 20.0, y: 5.5),
        control2: CGPoint(x: 16.2, y: 3.2)
    )
    head.addCurve(
        to: CGPoint(x: 2.8, y: 10.6),
        control1: CGPoint(x: 5.8, y: 3.2),
        control2: CGPoint(x: 2.0, y: 5.5)
    )
    head.closeSubpath()

    ctx.setStrokeColor(ink)
    ctx.setLineWidth(1.75)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    ctx.addPath(head)
    ctx.strokePath()

    let glasses = CGMutablePath()
    glasses.move(to: CGPoint(x: 1.9, y: 12.0))
    glasses.addLine(to: CGPoint(x: 20.1, y: 12.0))
    glasses.addLine(to: CGPoint(x: 19.8, y: 10.4))
    glasses.addCurve(
        to: CGPoint(x: 15.5, y: 7.2),
        control1: CGPoint(x: 19.3, y: 8.0),
        control2: CGPoint(x: 17.7, y: 7.2)
    )
    glasses.addCurve(
        to: CGPoint(x: 12.0, y: 10.1),
        control1: CGPoint(x: 13.4, y: 7.2),
        control2: CGPoint(x: 12.4, y: 8.6)
    )
    glasses.addQuadCurve(to: CGPoint(x: 10.0, y: 10.1), control: CGPoint(x: 11.0, y: 10.6))
    glasses.addCurve(
        to: CGPoint(x: 6.5, y: 7.2),
        control1: CGPoint(x: 9.6, y: 8.6),
        control2: CGPoint(x: 8.6, y: 7.2)
    )
    glasses.addCurve(
        to: CGPoint(x: 2.2, y: 10.4),
        control1: CGPoint(x: 4.3, y: 7.2),
        control2: CGPoint(x: 2.7, y: 8.0)
    )
    glasses.closeSubpath()

    ctx.setFillColor(ink)
    ctx.addPath(glasses)
    ctx.fillPath()

    // Cut out diagonal highlight on left lens so the shades stay legible at 22px.
    ctx.saveGState()
    ctx.setBlendMode(.clear)
    ctx.setLineWidth(1.15)
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: 4.2, y: 8.9))
    ctx.addLine(to: CGPoint(x: 5.7, y: 10.8))
    ctx.strokePath()
    ctx.restoreGState()

    ctx.setStrokeColor(ink)
    ctx.setLineWidth(1.3)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: 9.9, y: 5.1))
    ctx.addLine(to: CGPoint(x: 11.0, y: 6.0))
    ctx.addLine(to: CGPoint(x: 12.1, y: 5.1))
    ctx.strokePath()
}

func renderTrayIcon(size: Int, to file: URL, ink: CGColor = NSColor.black.cgColor, badge: Bool = false) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot create tray icon bitmap")
    }
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let cg = context.cgContext
    cg.clear(CGRect(x: 0, y: 0, width: size, height: size))
    let scale = CGFloat(size) / 22.0
    cg.scaleBy(x: scale, y: scale)
    drawTrayTemplateIcon(in: cg, ink: ink)
    if badge {
        let dotCenter = CGPoint(x: 18.2, y: 17.8)
        let cutoutRadius: CGFloat = 3.8
        let dotRadius: CGFloat = 2.8
        cg.saveGState()
        cg.setBlendMode(.clear)
        cg.addArc(center: dotCenter, radius: cutoutRadius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        cg.fillPath()
        cg.restoreGState()

        cg.setFillColor(NSColor(srgbRed: 1.0, green: 0.231, blue: 0.188, alpha: 1.0).cgColor)
        cg.addArc(center: dotCenter, radius: dotRadius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        cg.fillPath()
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Cannot encode tray icon PNG")
    }
    try png.write(to: file, options: .atomic)
}

let manager = FileManager.default
try manager.createDirectory(at: webPublic, withIntermediateDirectories: true)
try render(size: 512, inset: 0, radius: 0.14, to: webPublic.appendingPathComponent("kulo-icon.png"))
try render(size: 32, inset: 0, radius: 0.14, to: webPublic.appendingPathComponent("favicon-32.png"))
// Home-screen launchers supply their own mask; retain the full paper background.
try render(size: 180, inset: 0, radius: 0, to: webPublic.appendingPathComponent("apple-touch-icon.png"))
try render(size: 1024, inset: 0.09375, radius: 0.22, to: assets.appendingPathComponent("kulo-icon.png"))
// macOS menu bar template icons rendered directly from CoreGraphics vectors (built-in optical margin in 0...22 space).
try renderTrayIcon(size: 1024, to: assets.appendingPathComponent("kulo-tray-source.png"))
try renderTrayIcon(size: 22, to: assets.appendingPathComponent("kulo-trayTemplate.png"))
try renderTrayIcon(size: 44, to: assets.appendingPathComponent("kulo-trayTemplate@2x.png"))
let lightMenuBarInk = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.118, alpha: 1.0).cgColor
let darkMenuBarInk = NSColor(srgbRed: 0.96, green: 0.96, blue: 0.97, alpha: 1.0).cgColor
try renderTrayIcon(size: 22, to: assets.appendingPathComponent("kulo-tray-badge-light.png"), ink: lightMenuBarInk, badge: true)
try renderTrayIcon(size: 44, to: assets.appendingPathComponent("kulo-tray-badge-light@2x.png"), ink: lightMenuBarInk, badge: true)
try renderTrayIcon(size: 22, to: assets.appendingPathComponent("kulo-tray-badge-dark.png"), ink: darkMenuBarInk, badge: true)
try renderTrayIcon(size: 44, to: assets.appendingPathComponent("kulo-tray-badge-dark@2x.png"), ink: darkMenuBarInk, badge: true)

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
