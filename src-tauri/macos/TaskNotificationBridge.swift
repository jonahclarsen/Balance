import Foundation
import UserNotifications

private struct TaskReminder: Decodable {
    let id: String
    let at: Double
    let text: String
}

private final class TaskNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .sound])
    }
}

private let reminderDelegate = TaskNotificationDelegate()
private let reminderQueue = DispatchQueue(label: "app.balance.task-notifications")
private let prefix = "balance.sunset."

// Called on the native database worker, never the main thread. Serialized
// reconciliation prevents an older regeneration callback restoring stale alarms.
@_cdecl("balance_replace_task_notifications")
func balanceReplaceTaskNotifications(_ raw: UnsafePointer<CChar>) -> Int32 {
    // Tauri dev runs a bare executable. Even an embedded bundle identifier is
    // insufficient: current() raises an Objective-C exception without an app
    // bundle proxy, which Swift cannot catch. Keep durable schedules for the
    // packaged app to register when it launches.
    guard Bundle.main.bundleURL.pathExtension == "app",
          Bundle.main.bundleIdentifier != nil else { return 0 }
    guard let data = String(cString: raw).data(using: .utf8),
          let records = try? JSONDecoder().decode([TaskReminder].self, from: data) else { return 1 }
    reminderQueue.async {
        let center = UNUserNotificationCenter.current()
        center.delegate = reminderDelegate
        var existing: [UNNotificationRequest] = []
        let pending = DispatchSemaphore(value: 0)
        center.getPendingNotificationRequests { existing = $0; pending.signal() }
        pending.wait()
        let wanted = records.filter { $0.at / 1000 > Date().timeIntervalSince1970 }
        let ids = Set(wanted.map { prefix + $0.id })
        center.removePendingNotificationRequests(withIdentifiers: existing.filter { $0.identifier.hasPrefix(prefix) && !ids.contains($0.identifier) }.map(\.identifier))
        guard !wanted.isEmpty else { return }
        var authorization: UNAuthorizationStatus = .notDetermined
        let settings = DispatchSemaphore(value: 0)
        center.getNotificationSettings { authorization = $0.authorizationStatus; settings.signal() }
        settings.wait()
        if authorization == .notDetermined {
            let permission = DispatchSemaphore(value: 0)
            var allowed = false
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in allowed = granted; permission.signal() }
            permission.wait()
            if !allowed { NSLog("Balance sunset notifications need notification permission"); return }
        } else if authorization == .denied { NSLog("Balance sunset notifications need notification permission"); return }
        var failed = false
        for record in wanted {
            let id = prefix + record.id
            let at = Date(timeIntervalSince1970: record.at / 1000)
            if let old = existing.first(where: { $0.identifier == id }), old.content.body == record.text,
               let trigger = old.trigger as? UNCalendarNotificationTrigger,
               let next = trigger.nextTriggerDate(), abs(next.timeIntervalSince(at)) < 1 { continue }
            let content = UNMutableNotificationContent()
            content.body = record.text
            content.sound = .default
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: at)
            components.timeZone = calendar.timeZone
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let added = DispatchSemaphore(value: 0)
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { error in
                if error != nil { failed = true }; added.signal()
            }
            added.wait()
        }
        if failed { NSLog("Could not register Balance sunset notifications") }
    }
    return 0
}
