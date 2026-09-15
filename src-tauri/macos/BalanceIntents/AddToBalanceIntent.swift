import AppIntents
import AppKit
import Foundation

private let maximumSiriTaskLength = 2_000

private enum AddToBalanceIntentError: Error, LocalizedError {
    case invalidURL
    case launchFailed
    case confirmationTimedOut

    var errorDescription: String? {
        switch self {
        case .invalidURL, .launchFailed:
            return "Couldn’t open Balance to add that task."
        case .confirmationTimedOut:
            return "Couldn’t confirm that Balance saved the task. Check Balance before trying again."
        }
    }
}

@available(macOS 15.0, *)
struct AddToBalanceIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task to Balance"
    static let description = IntentDescription("Add a task to Balance.")

    @Parameter(
        title: "Task",
        description: "What you want to add to Balance",
        requestValueDialog: "What would you like to add to Balance?",
        inputConnectionBehavior: .connectToPreviousIntentResult
    )
    var task: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$task) to Balance")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = String(String.UnicodeScalarView(task.unicodeScalars.prefix(maximumSiriTaskLength)))
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw $task.needsValueError("What would you like to add to Balance?")
        }

        let requestID = UUID().uuidString
        var components = URLComponents()
        components.scheme = "balance"
        components.host = "add"
        components.queryItems = [
            URLQueryItem(name: "text", value: text),
            URLQueryItem(name: "request", value: requestID),
        ]
        guard let url = components.url else {
            throw AddToBalanceIntentError.invalidURL
        }

        // OpenURLIntent accepts universal links only. Balance uses a local URL
        // scheme, which macOS Shortcuts supports through Launch Services.
        try await SiriSaveConfirmation.send(requestID: requestID) {
            NSWorkspace.shared.open(url)
        }
        return .result(dialog: "Added that to Balance.")
    }
}

// Listen before opening the URL so even an immediate save cannot race the
// observer. Only the random request ID crosses this notification, never text.
@MainActor
final class SiriSaveConfirmation {
    private var saved = false

    static func send(
        requestID: String,
        timeout: Duration = .seconds(15),
        open: () -> Bool
    ) async throws {
        let confirmation = SiriSaveConfirmation()
        let center = DistributedNotificationCenter.default()
        let observer = center.addObserver(
            forName: Notification.Name("app.balance.local.siri.saved"),
            object: requestID,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { confirmation.saved = true }
        }
        defer { center.removeObserver(observer) }
        try Task.checkCancellation()
        guard open() else { throw AddToBalanceIntentError.launchFailed }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !confirmation.saved {
            guard clock.now < deadline else {
                throw AddToBalanceIntentError.confirmationTimedOut
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        try Task.checkCancellation()
    }
}
