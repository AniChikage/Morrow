import AppKit

let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: rep)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let s = CGFloat(pixels) / 1024
        context.cgContext.scaleBy(x: s, y: s)
        let tile = NSBezierPath(roundedRect: NSRect(x: 70, y: 70, width: 884, height: 884), xRadius: 204, yRadius: 204)
        NSColor(calibratedRed: 0.32, green: 0.29, blue: 0.83, alpha: 1).setFill()
        tile.fill()
        NSGradient(starting: NSColor(calibratedRed: 0.47, green: 0.40, blue: 0.97, alpha: 1), ending: NSColor(calibratedRed: 0.28, green: 0.25, blue: 0.76, alpha: 1))!.draw(in: tile, angle: -90)
        let m = NSBezierPath()
        m.move(to: NSPoint(x: 270, y: 315))
        m.line(to: NSPoint(x: 270, y: 700))
        m.curve(to: NSPoint(x: 322, y: 714), controlPoint1: NSPoint(x: 270, y: 737), controlPoint2: NSPoint(x: 300, y: 740))
        m.line(to: NSPoint(x: 512, y: 450))
        m.line(to: NSPoint(x: 702, y: 714))
        m.curve(to: NSPoint(x: 754, y: 700), controlPoint1: NSPoint(x: 724, y: 740), controlPoint2: NSPoint(x: 754, y: 737))
        m.line(to: NSPoint(x: 754, y: 315))
        m.lineWidth = 72
        m.lineCapStyle = .round
        m.lineJoinStyle = .round
        NSColor.white.setStroke()
        m.stroke()
        NSColor(calibratedRed: 0.74, green: 1, blue: 0.80, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 711, y: 680, width: 86, height: 86)).fill()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/icon_\(size)x\(size)\(suffix).png"))
    }
}
