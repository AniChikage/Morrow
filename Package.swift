// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NoHuman",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "NoHuman", targets: ["NoHuman"])],
    targets: [.executableTarget(name: "NoHuman", path: "Sources/NoHuman")],
    swiftLanguageModes: [.v5]
)
