import AppIntents
import AppKit
import Foundation

private let maximumSiriTaskLength = 2_000

private enum AddToBalanceIntentError: Error {
    case invalidURL
    case launchFailed
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

        var components = URLComponents()
        components.scheme = "balance"
        components.host = "add"
        components.queryItems = [
            URLQueryItem(name: "text", value: text),
            URLQueryItem(name: "request", value: UUID().uuidString),
        ]
        guard let url = components.url else {
            throw AddToBalanceIntentError.invalidURL
        }

        // OpenURLIntent accepts universal links only. Balance uses a local URL
        // scheme, which macOS Shortcuts supports through Launch Services.
        guard NSWorkspace.shared.open(url) else {
            throw AddToBalanceIntentError.launchFailed
        }

        return .result(dialog: "Sending that to Balance.")
    }
}
