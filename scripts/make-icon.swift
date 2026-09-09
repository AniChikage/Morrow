import AppKit

// Export every macOS icon size from the same committed brand artwork.
guard CommandLine.arguments.count == 3 else {
    fputs("Usage: swift scripts/make-icon.swift <source.png> <output.iconset>\n", stderr)
    exit(1)
}
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let data = try? Data(contentsOf: source),
      let bitmap = NSBitmapImageRep(data: data),
      bitmap.pixelsWide == bitmap.pixelsHigh, bitmap.pixelsWide >= 1024,
      bitmap.hasAlpha, let sourceImage = bitmap.cgImage else {
    fputs("Icon source must be a square PNG with alpha, at least 1024 pixels wide.\n", stderr)
    exit(1)
}
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
        context.interpolationQuality = .high
        context.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
        context.draw(sourceImage, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
        let suffix = scale == 2 ? "@2x" : ""
        try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
