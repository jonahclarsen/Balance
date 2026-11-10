import AppKit
import Foundation

private var situateModes: [[String: Any]] = []
private var situateObservers: [NSObjectProtocol] = []
private var situatePrevious = Set<String>()
private var situatePreviousSoon: [String: Int] = [:]
private var situatePrompt: SituatePrompt?
@_silgen_name("balance_replace_task_notifications") private func situateNotice(_ raw: UnsafePointer<CChar>) -> Int32

@_cdecl("balance_situate_update")
func balanceSituateUpdate(_ raw: UnsafePointer<CChar>, _ announce: Bool) {
    let data = Data(String(cString: raw).utf8)
    guard let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let modes = status["modes"] as? [[String: Any]] else { return }
    DispatchQueue.main.async {
        situateModes = modes
        let active = Set(modes.filter { $0["active"] as? Bool == true }.compactMap { $0["id"] as? String })
        func notify(_ mode: [String: Any], _ title: String) {
            let notice: [String: String] = ["situateNotice": "\(mode["name"] as? String ?? "Situate") \(title)", "situateBody": mode["description"] as? String ?? "", "mode": mode["id"] as? String ?? ""]
            if let data = try? JSONSerialization.data(withJSONObject: notice), let json = String(data: data, encoding: .utf8) { _ = json.withCString { situateNotice($0) } }
        }
        let soon = modes.reduce(into: [String: Int]()) { result, mode in
            if let id = mode["id"] as? String, let minutes = mode["soon"] as? Int { result[id] = minutes }
        }
        for mode in modes where announce {
            let id = mode["id"] as? String ?? ""
            if active.contains(id) && !situatePrevious.contains(id) { notify(mode, "is on") }
            else if let minutes = soon[id], situatePreviousSoon[id] != minutes { notify(mode, "in \(minutes) min") }
        }
        situatePrevious = active
        situatePreviousSoon = soon
        if situateObservers.isEmpty {
            let center = NSWorkspace.shared.notificationCenter
            func observe(_ name: Notification.Name, _ handle: @escaping (NSRunningApplication) -> Void) {
                situateObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { note in
                    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { handle(app) }
                })
            }
            observe(NSWorkspace.didActivateApplicationNotification) { enforceSituate($0) }
            // A blocked app can finish launching or unhide itself after it was hidden.
            observe(NSWorkspace.didLaunchApplicationNotification) { hideSituate($0) }
            observe(NSWorkspace.didUnhideApplicationNotification) { hideSituate($0) }
        }
        if let app = NSWorkspace.shared.frontmostApplication { enforceSituate(app) }
    }
}
private func situateBlock(_ app: NSRunningApplication) -> (mode: [String: Any], target: [String: Any])? {
    guard let bundle = app.bundleIdentifier, bundle != "app.balance.local" else { return nil }
    for mode in situateModes {
        if let target = (mode["targets"] as? [[String: Any]])?.first(where: { $0["kind"] as? String == "app" && $0["value"] as? String == bundle }) { return (mode, target) }
    }
    return nil
}
private func hideSituate(_ app: NSRunningApplication) {
    guard situateBlock(app) != nil else { return }
    app.hide()
    // A launching app ignores hide until it finishes and can show its first window later.
    for delay in [0.3, 1.0, 2.5] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { if !app.isHidden && situateBlock(app) != nil { app.hide() } }
    }
}
private func enforceSituate(_ app: NSRunningApplication) {
    guard let (mode, target) = situateBlock(app) else { return }
    hideSituate(app)
    NSApp.activate(ignoringOtherApps: true)
    if let prompt = situatePrompt { prompt.alert.window.makeKeyAndOrderFront(nil); return }
    var url = URLComponents(string: "balance://situate")!
    url.queryItems = [URLQueryItem(name: "mode", value: mode["id"] as? String)]
    if target["category"] as? String == "entertainment" { url.queryItems?.append(URLQueryItem(name: "target", value: target["id"] as? String)) }
    let prompt = SituatePrompt(app: app, quiz: url.url)
    prompt.alert.messageText = "\(mode["name"] as? String ?? "Situate") is on"
    prompt.alert.informativeText = "Take a moment before opening this app. Your work is still there."
    situatePrompt = prompt
    prompt.show()
}
/// A non-modal alert. `runModal` would stall the main run loop, which also
/// delivers Siri captures and other distributed notifications.
private final class SituatePrompt: NSObject {
    let alert = NSAlert()
    private let app: NSRunningApplication
    private let quiz: URL?
    init(app: NSRunningApplication, quiz: URL?) {
        self.app = app
        self.quiz = quiz
        super.init()
    }
    func show() {
        let keep = alert.addButton(withTitle: "Keep the boundary")
        let open = alert.addButton(withTitle: "Open quiz")
        keep.target = self; keep.action = #selector(keepBoundary)
        open.target = self; open.action = #selector(openQuiz)
        alert.layout()
        alert.window.hidesOnDeactivate = false
        alert.window.level = .floating
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
    }
    @objc private func keepBoundary() { finish(nil) }
    @objc private func openQuiz() { finish(quiz) }
    private func finish(_ url: URL?) {
        alert.window.orderOut(nil)
        if situatePrompt === self { situatePrompt = nil }
        if let url { NSWorkspace.shared.open(url) }
        // The app may have come forward behind the prompt; it stays hidden until a pass unblocks it.
        hideSituate(app)
    }
}
