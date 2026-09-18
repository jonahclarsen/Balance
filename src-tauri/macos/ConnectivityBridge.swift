import Foundation
import Network

// Unknown until the first callback. A connection may activate an on-demand
// path, so requiresConnection must never be treated as offline.
private final class ConnectivityMonitor {
    static let shared = ConnectivityMonitor()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var offline: Int32 = -1

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.lock.lock()
            self.offline = path.status == .unsatisfied ? 1 : 0
            self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "app.balance.connectivity"))
    }

    func snapshot() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        return offline
    }
}

@_cdecl("balance_network_offline")
public func balanceNetworkOffline() -> Int32 {
    ConnectivityMonitor.shared.snapshot()
}
