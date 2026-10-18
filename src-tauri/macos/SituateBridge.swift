import AppKit
import Foundation

private var situateModes: [[String: Any]] = []
private var situateObserver: NSObjectProtocol?
private var situatePrevious = Set<String>()
private var situateShowing = false
@_silgen_name("balance_replace_task_notifications") private func situateNotice(_ raw: UnsafePointer<CChar>) -> Int32

@_cdecl("balance_situate_update")
func balanceSituateUpdate(_ raw: UnsafePointer<CChar>) {
    let data = Data(String(cString: raw).utf8)
    guard let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let modes = status["modes"] as? [[String: Any]] else { return }
    DispatchQueue.main.async {
        situateModes = modes
        let active = Set(modes.filter { $0["active"] as? Bool == true }.compactMap { $0["id"] as? String })
        for mode in modes where active.contains(mode["id"] as? String ?? "") && !situatePrevious.contains(mode["id"] as? String ?? "") {
            let notice: [String: String] = ["situateNotice": "\(mode["name"] as? String ?? "Situate") is on", "mode": mode["id"] as? String ?? ""]
            if let data = try? JSONSerialization.data(withJSONObject: notice), let json = String(data: data, encoding: .utf8) { _ = json.withCString { situateNotice($0) } }
        }
        situatePrevious = active
        if situateObserver == nil {
            situateObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in enforceSituate() }
        }
        enforceSituate()
    }
}
private func enforceSituate() {
    guard !situateShowing, let app = NSWorkspace.shared.frontmostApplication,
          let bundle = app.bundleIdentifier, bundle != "app.balance.local" else { return }
    for mode in situateModes {
        guard let targets = mode["targets"] as? [[String: Any]],
              let target = targets.first(where: { $0["kind"] as? String == "app" && $0["value"] as? String == bundle }) else { continue }
        situateShowing = true
        app.hide()
        let alert = NSAlert()
        alert.messageText = "\(mode["name"] as? String ?? "Situate") is on"
        alert.informativeText = "Take a moment before opening this app. Your work is still there."
        alert.addButton(withTitle: "Keep the boundary")
        alert.addButton(withTitle: "Open quiz")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn {
            var url = URLComponents(string: "balance://situate")!
            url.queryItems = [URLQueryItem(name: "mode", value: mode["id"] as? String)]
            if target["category"] as? String == "entertainment" { url.queryItems?.append(URLQueryItem(name: "target", value: target["id"] as? String)) }
            if let url = url.url { NSWorkspace.shared.open(url) }
        }
        situateShowing = false
        return
    }
}
