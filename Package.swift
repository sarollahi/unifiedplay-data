// swift-tools-version:5.10
// UnifiedPlay Data for iOS and tvOS. The Swift package sits at the repo root because SwiftPM needs it
// there; its sources are under ios/. Each player library is its own product: an app adds only the
// ones for its players, and SwiftPM fetches only those players' packages.
import PackageDescription

let package = Package(
    name: "UnifiedPlayData",
    platforms: [.iOS(.v15), .tvOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "UnifiedPlayData", targets: ["UnifiedPlayData"]),
    ],
    targets: [
        // Core + AVPlayer (AVFoundation is part of the system).
        .target(name: "UnifiedPlayData", path: "ios/Sources/UnifiedPlayData"),
        .testTarget(name: "UnifiedPlayDataTests", dependencies: ["UnifiedPlayData"], path: "ios/Tests/UnifiedPlayDataTests"),
    ]
)
