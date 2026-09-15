import AppKit
import Foundation

@main
struct SiriConfirmationTests {
    @MainActor
    static func main() async throws {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--receipt" {
            CommandLine.arguments[2].withCString { balanceConfirmSiriRequestSaved($0) }
            return
        }

        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--wait" {
            try await SiriSaveConfirmation.send(requestID: CommandLine.arguments[2], timeout: .seconds(5)) {
                print("READY")
                fflush(stdout)
                return true
            }
            print("SAVED")
            return
        }

        func postFromHost(_ request: String) -> Bool {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            process.arguments = ["--receipt", request]
            do { try process.run(); return true } catch { return false }
        }

        let request = UUID().uuidString
        try await SiriSaveConfirmation.send(requestID: request, timeout: .seconds(3)) {
            postFromHost(request)
        }
        print("PASS: a matching receipt from another process confirms the save")

        do {
            try await SiriSaveConfirmation.send(requestID: UUID().uuidString, timeout: .milliseconds(200)) {
                postFromHost(UUID().uuidString)
            }
            fatalError("An unrelated receipt must not confirm the save")
        } catch {
            precondition(error.localizedDescription.contains("Couldn’t confirm"))
        }
        print("PASS: missing or unrelated receipts time out without claiming success")

        do {
            try await SiriSaveConfirmation.send(requestID: UUID().uuidString) { false }
            fatalError("A rejected URL must fail")
        } catch {
            precondition(error.localizedDescription.contains("Couldn’t open"))
        }
        print("PASS: launch failure is reported immediately")

        let waiting = Task { @MainActor in
            try await SiriSaveConfirmation.send(requestID: UUID().uuidString) { true }
        }
        try await Task.sleep(for: .milliseconds(100))
        waiting.cancel()
        do {
            try await waiting.value
            fatalError("Cancellation must not report success")
        } catch is CancellationError {}
        print("PASS: cancellation stops waiting")
    }
}
