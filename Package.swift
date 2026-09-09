// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Morrow",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Morrow", targets: ["Morrow"])],
    targets: [.executableTarget(name: "Morrow", path: "Sources/Morrow")],
    swiftLanguageModes: [.v5]
)
