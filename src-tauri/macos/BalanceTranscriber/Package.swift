// swift-tools-version: 6.0
import PackageDescription

// Separate process so Core ML's model memory is returned once transcription ends.
let package = Package(
    name: "BalanceTranscriber",
    platforms: [.macOS(.v14)],
    dependencies: [
        // VoiceInk uses FluidAudio too, so both apps share its model directory.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7"),
    ],
    targets: [
        .executableTarget(
            name: "BalanceTranscriber",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
