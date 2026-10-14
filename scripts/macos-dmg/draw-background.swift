// Draws the installer window's background in the balance.jonah.art style, at
// normal and Retina resolutions. Coordinates are Finder content points from
// the top left; icon positions live in build-dmg.sh.
import AppKit
import CoreText

let width = 680
let height = 440
// Finder's window height includes its 28-point title bar.
let visibleHeight = CGFloat(height - 28)

guard CommandLine.arguments.count == 3,
      let logo = NSImage(contentsOfFile: CommandLine.arguments[1]) else {
    fatalError("Expected logo PNG and output TIFF paths")
}

let fonts = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fonts")
for filename in ["rubik-bold.ttf", "geist-mono-regular.ttf"] {
    var fontError: Unmanaged<CFError>?
    guard CTFontManagerRegisterFontsForURL(
        fonts.appendingPathComponent(filename) as CFURL, .process, &fontError
    ) else { fatalError("Cannot register DMG artwork font: \(filename)") }
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// website/public/assets/site.css, light scheme.
let mint = color(0x9bd2b9)
let sea = color(0x539f9c)
let teal = color(0x166f7b)
let background = color(0xf2f8f5)
let surface = color(0xffffff)
let ink = color(0x0c2e30)
let muted = color(0x4f6f6e)
let line = color(0xd3e7de)

func text(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat, face: String,
          ink: NSColor, tracking: CGFloat = 0, centered: Bool = false) {
    guard let font = NSFont(name: face, size: size) else {
        fatalError("Missing registered artwork font: \(face)")
    }
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font, .foregroundColor: ink, .kern: tracking * size,
    ]
    let label = value as NSString
    let originX = centered ? x - label.size(withAttributes: attributes).width / 2 : x
    label.draw(at: NSPoint(x: originX, y: y), withAttributes: attributes)
}

func glow(_ cg: CGContext, center: CGPoint, radius: CGFloat, color glowColor: NSColor) {
    let colors = [glowColor.cgColor, glowColor.withAlphaComponent(0).cgColor] as CFArray
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 1])!
    cg.drawRadialGradient(gradient, startCenter: center, startRadius: 0,
                          endCenter: center, endRadius: radius, options: [])
}

var representations: [NSBitmapImageRep] = []
for scale in [1, 2] {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot allocate DMG background")
    }
    bitmap.size = NSSize(width: CGFloat(width), height: CGFloat(height))
    NSGraphicsContext.saveGraphicsState()
    let cg = context.cgContext
    cg.translateBy(x: 0, y: CGFloat(height * scale))
    cg.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

    // The landing page hero: pale mint page with mint and sea glows.
    background.setFill()
    NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)).fill()
    glow(cg, center: CGPoint(x: 120, y: 90), radius: 300, color: mint.withAlphaComponent(0.55))
    glow(cg, center: CGPoint(x: 560, y: 240), radius: 260, color: sea.withAlphaComponent(0.22))

    // Header: logo and wordmark, as in the site's top bar.
    logo.draw(in: NSRect(x: 40, y: 26, width: 30, height: 30), from: .zero,
              operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    text("Balance", x: 79, y: 29, size: 19, face: "RubikLight-Bold", ink: ink, tracking: -0.02)

    text("Install Balance", x: 40, y: 74, size: 34, face: "RubikLight-Bold", ink: ink, tracking: -0.035)
    text("Drag Balance into Applications.", x: 41, y: 122, size: 14,
         face: "GeistMono-Regular", ink: muted)

    // The icons sit on a site-style tile: white surface, line border, soft
    // deep-teal shadow.
    let tile = NSRect(x: 40, y: 166, width: 600, height: 196)
    let tilePath = NSBezierPath(roundedRect: tile, xRadius: 20, yRadius: 20)
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -14), blur: 30,
                 color: color(0x023e3e, 0.14).cgColor)
    surface.setFill()
    tilePath.fill()
    cg.restoreGState()
    line.setStroke()
    tilePath.lineWidth = 1
    tilePath.stroke()

    // Arrow from the app icon (x 200) to Applications (x 480), centred on the
    // icons at y 252.
    teal.setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 278, y: 256))
    arrow.curve(to: NSPoint(x: 402, y: 256),
                controlPoint1: NSPoint(x: 310, y: 222),
                controlPoint2: NSPoint(x: 370, y: 222))
    arrow.move(to: NSPoint(x: 386, y: 252))
    arrow.line(to: NSPoint(x: 402, y: 256))
    arrow.line(to: NSPoint(x: 401, y: 240))
    arrow.stroke()

    let footerFont = NSFont(name: "GeistMono-Regular", size: 12)!
    let footerTop = tile.maxY + (visibleHeight - tile.maxY - footerFont.boundingRectForFont.height) / 2
    text("Then open Balance from Applications.", x: CGFloat(width) / 2, y: footerTop, size: 12,
         face: "GeistMono-Regular", ink: muted, centered: true)

    NSGraphicsContext.restoreGraphicsState()
    representations.append(bitmap)
}
guard let tiff = NSBitmapImageRep.tiffRepresentationOfImageReps(
    in: representations, using: .lzw, factor: 1
) else { fatalError("Cannot encode DMG background") }
try tiff.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
