import Foundation
import UserNotifications
import Darwin

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
// Confined to reminderQueue. Every meaningful write republishes reminders, so
// ask at most once per process and report missing permission only on change.
private var requestedAuthorization = false
private var reportedMissingPermission = false

func initializeDevTaskNotificationCenter() {
    // Cache the helper's app bundle proxy before the runner unregisters its
    // Launch Services entry to keep the installed Balance app canonical.
    let center = UNUserNotificationCenter.current()
    center.delegate = reminderDelegate
}

// Called on the native database worker, never the main thread. Serialized
// reconciliation prevents an older regeneration callback restoring stale alarms.
@_cdecl("balance_replace_task_notifications")
func balanceReplaceTaskNotifications(_ raw: UnsafePointer<CChar>) -> Int32 {
    let json = String(cString: raw)
    // Bare Tauri executables cannot acquire a notification center. The existing
    // app-shaped widget helper registers reminders on their behalf instead.
    guard Bundle.main.bundleURL.pathExtension == "app",
          Bundle.main.bundleIdentifier != nil else {
        if let path = ProcessInfo.processInfo.environment["BALANCE_DEV_NOTIFICATION_SOCKET"] {
            reminderQueue.async {
                if !sendDevTaskNotifications(json, path: path) {
                    NSLog("Could not forward Balance dev task notifications")
                }
            }
        }
        return 0
    }
    guard let data = json.data(using: .utf8),
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
        var allowed = authorization != .notDetermined && authorization != .denied
        if authorization == .notDetermined && !requestedAuthorization {
            requestedAuthorization = true
            let permission = DispatchSemaphore(value: 0)
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in allowed = granted; permission.signal() }
            permission.wait()
        }
        guard allowed else {
            if !reportedMissingPermission { NSLog("Balance sunset notifications need notification permission") }
            reportedMissingPermission = true
            return
        }
        reportedMissingPermission = false
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

// Private, owner-only Unix socket: task bodies travel in memory, never through
// preferences, files, command-line arguments, or distributed notifications.
private func withSocketAddress<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T? {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return nil }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

private func prepareSocket(_ descriptor: Int32) {
    var noSignal: Int32 = 1
    setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
}

func sendDevTaskNotifications(_ json: String, path: String) -> Bool {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { close(descriptor) }
    prepareSocket(descriptor)
    guard withSocketAddress(path, { connect(descriptor, $0, $1) }) == 0 else { return false }
    let data = Data(json.utf8)
    guard data.count <= 16 * 1024 * 1024 else { return false }
    let sent = data.withUnsafeBytes { bytes -> Bool in
        var offset = 0
        while offset < bytes.count {
            let count = write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return false }
            offset += count
        }
        return true
    }
    guard sent else { return false }
    shutdown(descriptor, SHUT_WR)
    var acknowledgement: UInt8 = 1
    return read(descriptor, &acknowledgement, 1) == 1 && acknowledgement == 0
}

func startDevTaskNotificationServer(path: String, parent: pid_t) -> Bool {
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { return false }
    guard withSocketAddress(path, { bind(listener, $0, $1) }) == 0,
          chmod(path, 0o600) == 0, listen(listener, 4) == 0 else {
        close(listener)
        return false
    }
    DispatchQueue(label: "app.balance.dev-notification-socket").async {
        while true {
            let client = accept(listener, nil, nil)
            if client < 0 { if errno == EINTR { continue }; return }
            defer { close(client) }
            prepareSocket(client)
            var peer: pid_t = 0
            var size = socklen_t(MemoryLayout<pid_t>.size)
            var user: uid_t = 0
            var group: gid_t = 0
            guard getpeereid(client, &user, &group) == 0, user == getuid(),
                  getsockopt(client, SOL_LOCAL, LOCAL_PEERPID, &peer, &size) == 0, peer == parent else { continue }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 8192)
            var complete = false
            while data.count <= 16 * 1024 * 1024 {
                let count = read(client, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count == 0 { complete = true; break }
                if count < 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            guard complete, let json = String(data: data, encoding: .utf8) else { continue }
            var result = UInt8(json.withCString { balanceReplaceTaskNotifications($0) })
            _ = write(client, &result, 1)
        }
    }
    return true
}
