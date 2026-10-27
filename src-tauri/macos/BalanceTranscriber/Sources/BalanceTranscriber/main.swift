// balance-transcriber <pcm>...: each file holds 16 kHz mono little-endian Float32
// samples. Writes one JSON object per line: model/progress events, then one
// result per file, or an error.
import FluidAudio
import Foundation

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func samples(at path: String) throws -> [Float] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

// Prefer whatever is already on disk, so VoiceInk users never download twice.
func installedVersion() -> AsrModelVersion? {
    [AsrModelVersion.v3, .v2].first { version in
        AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: version), version: version)
    }
}

func modelName(_ version: AsrModelVersion) -> String {
    AsrModels.defaultCacheDirectory(for: version).lastPathComponent
}

let paths = Array(CommandLine.arguments.dropFirst())
do {
    let version: AsrModelVersion
    if let installed = installedVersion() {
        version = installed
    } else {
        version = .v3
        emit(["event": "download", "model": modelName(version), "fraction": 0])
        try await AsrModels.download(version: version) { progress in
            emit(["event": "download", "model": modelName(version), "fraction": progress.fractionCompleted])
        }
    }
    emit(["event": "model", "model": modelName(version)])
    let models = try await AsrModels.load(from: AsrModels.defaultCacheDirectory(for: version), version: version)
    let manager = AsrManager()
    try await manager.loadModels(models)
    for (index, path) in paths.enumerated() {
        var state = TdtDecoderState.make(decoderLayers: version.decoderLayers)
        let result = try await manager.transcribe(try samples(at: path), decoderState: &state)
        let words = buildWordTimings(from: result.tokenTimings ?? []).map { word in
            ["text": word.word, "start": word.startTime, "end": word.endTime] as [String: Any]
        }
        emit(["event": "result", "index": index, "model": modelName(version), "text": result.text, "words": words])
    }
} catch {
    emit(["event": "error", "message": error.localizedDescription])
    exit(1)
}
