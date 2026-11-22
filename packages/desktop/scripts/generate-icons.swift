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
/// Uses compact ~15pt optical bounds with rounded mochi cheeks and a light 1.3pt stroke
/// so it matches native macOS menu bar icons in weight and visual height.
func drawTrayTemplateIcon(in ctx: CGContext, ink: CGColor = NSColor.black.cgColor) {
    let head = CGMutablePath()
    // Soft arched forehead dome
    head.move(to: CGPoint(x: 8.15, y: 15.15))
    head.addQuadCurve(to: CGPoint(x: 13.85, y: 15.15), control: CGPoint(x: 11.0, y: 16.1))
    // Right ear flowing smoothly into plump round cheek
    head.addQuadCurve(to: CGPoint(x: 15.95, y: 17.2), control: CGPoint(x: 15.05, y: 16.45))
    head.addQuadCurve(to: CGPoint(x: 17.35, y: 16.45), control: CGPoint(x: 17.05, y: 17.85))
    head.addCurve(
        to: CGPoint(x: 18.45, y: 9.45),
        control1: CGPoint(x: 17.85, y: 14.35),
        control2: CGPoint(x: 18.8, y: 11.85)
    )
    // Plump round lower cheeks & chin
    head.addCurve(
        to: CGPoint(x: 11.0, y: 4.1),
        control1: CGPoint(x: 18.05, y: 6.15),
        control2: CGPoint(x: 15.2, y: 4.1)
    )
    head.addCurve(
        to: CGPoint(x: 3.55, y: 9.45),
        control1: CGPoint(x: 6.8, y: 4.1),
        control2: CGPoint(x: 3.95, y: 6.15)
    )
    // Left cheek flowing smoothly into soft rounded left ear
    head.addCurve(
        to: CGPoint(x: 4.65, y: 16.45),
        control1: CGPoint(x: 3.2, y: 11.85),
        control2: CGPoint(x: 4.15, y: 14.35)
    )
    head.addQuadCurve(to: CGPoint(x: 6.05, y: 17.2), control: CGPoint(x: 4.95, y: 17.85))
    head.addQuadCurve(to: CGPoint(x: 8.15, y: 15.15), control: CGPoint(x: 6.95, y: 16.45))
    head.closeSubpath()

    ctx.setStrokeColor(ink)
    ctx.setLineWidth(1.3)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    ctx.addPath(head)
    ctx.strokePath()

    // Soft rounded sunglasses meeting the inner cheek contour seamlessly.
    let glasses = CGMutablePath()
    glasses.move(to: CGPoint(x: 3.7, y: 11.2))
    glasses.addQuadCurve(to: CGPoint(x: 10.05, y: 11.15), control: CGPoint(x: 7.0, y: 11.75))
    glasses.addQuadCurve(to: CGPoint(x: 11.95, y: 11.15), control: CGPoint(x: 11.0, y: 11.25))
    glasses.addQuadCurve(to: CGPoint(x: 18.3, y: 11.2), control: CGPoint(x: 15.0, y: 11.75))
    glasses.addCurve(
        to: CGPoint(x: 14.7, y: 8.0),
        control1: CGPoint(x: 18.45, y: 9.35),
        control2: CGPoint(x: 16.9, y: 8.0)
    )
    glasses.addCurve(
        to: CGPoint(x: 11.8, y: 10.1),
        control1: CGPoint(x: 12.8, y: 8.0),
        control2: CGPoint(x: 12.05, y: 9.05)
    )
    glasses.addQuadCurve(to: CGPoint(x: 10.2, y: 10.1), control: CGPoint(x: 11.0, y: 10.45))
    glasses.addCurve(
        to: CGPoint(x: 7.3, y: 8.0),
        control1: CGPoint(x: 9.95, y: 9.05),
        control2: CGPoint(x: 9.2, y: 8.0)
    )
    glasses.addCurve(
        to: CGPoint(x: 3.7, y: 11.2),
        control1: CGPoint(x: 5.1, y: 8.0),
        control2: CGPoint(x: 3.55, y: 9.35)
    )
    glasses.closeSubpath()

    ctx.setFillColor(ink)
    ctx.addPath(glasses)
    ctx.fillPath()

    // Small rounded ^ cat mouth.
    ctx.setStrokeColor(ink)
    ctx.setLineWidth(1.15)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: 10.05, y: 6.1))
    ctx.addLine(to: CGPoint(x: 11.0, y: 6.95))
    ctx.addLine(to: CGPoint(x: 11.95, y: 6.1))
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
        let dotCenter = CGPoint(x: 17.6, y: 17.4)
        let cutoutRadius: CGFloat = 3.1
        let dotRadius: CGFloat = 2.3
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
