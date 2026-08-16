import Darwin
import Foundation
import WidgetKit

private let widgetReloadNotification = Notification.Name("app.balance.local.widget.reload")

guard
    CommandLine.arguments.count == 3,
    let parentProcessIdentifier = pid_t(CommandLine.arguments[1]),
    parentProcessIdentifier > 1
else {
    fputs("usage: BalanceWidgetDevBridge <parent-pid> <ready-file>\n", stderr)
    exit(64)
}

let readyFile = CommandLine.arguments[2]
let notificationCenter = DistributedNotificationCenter.default()
let observer = notificationCenter.addObserver(
    forName: widgetReloadNotification,
    object: nil,
    queue: .main
) { _ in
    WidgetCenter.shared.reloadTimelines(ofKind: "BalanceToday")
}

guard FileManager.default.createFile(atPath: readyFile, contents: Data()) else {
    fputs("BalanceWidgetDevBridge could not create its ready file\n", stderr)
    exit(73)
}

Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    if kill(parentProcessIdentifier, 0) == -1 && errno == ESRCH {
        exit(0)
    }
}

withExtendedLifetime(observer) {
    RunLoop.main.run()
}
