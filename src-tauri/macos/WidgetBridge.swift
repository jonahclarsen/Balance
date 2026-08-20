import AppKit
import Foundation
import Security
import WidgetKit

private let encryptedSnapshotKey = "balance.widget.encrypted-snapshot.v2"
private let legacyPlaintextSnapshotKey = "balance.widget.snapshot.v1"
private let hideContentAfterCloseKey = "balance.widget.hide-content-after-close.v1"
private let snapshotVisibleUntilKey = "balance.widget.snapshot-visible-until.v1"
private let snapshotPreferenceDomain = "app.balance.local"
private let widgetPreferenceDomain = "app.balance.local.widget"
private let widgetReloadNotification = Notification.Name("app.balance.local.widget.reload")
private let rawDevelopmentExecutableSuffix = "/src-tauri/target/debug/Balance"
private let developmentAppExecutableSuffix = "/BalanceDev.app/Contents/MacOS/Balance"

private var snapshotDefaults: UserDefaults {
    UserDefaults(suiteName: snapshotPreferenceDomain) ?? .standard
}

private func widgetPublicKeyString() -> String? {
    // Sandboxed extension preferences live in the extension's container. A
    // suite lookup from the unsandboxed Tauri host targets the global domain
    // instead, so read the extension's flushed plist directly. This value is
    // public key material; the corresponding private key never leaves Keychain.
    let preferences = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Containers", isDirectory: true)
        .appendingPathComponent(widgetPreferenceDomain, isDirectory: true)
        .appendingPathComponent("Data/Library/Preferences", isDirectory: true)
        .appendingPathComponent("\(widgetPreferenceDomain).plist")
    guard
        let data = try? Data(contentsOf: preferences),
        let propertyList = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let values = propertyList as? [String: Any]
    else {
        return nil
    }
    return values[WidgetSnapshotKey.publicPreferenceKey] as? String
}

private func requestWidgetReload() {
    if Bundle.main.executableURL?.path.hasSuffix(rawDevelopmentExecutableSuffix) == true {
        DistributedNotificationCenter.default().postNotificationName(
            widgetReloadNotification,
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        return
    }
    WidgetCenter.shared.reloadTimelines(ofKind: "BalanceToday")
}

private func isDevelopmentExecutable(_ executablePath: String) -> Bool {
    if executablePath.hasSuffix(rawDevelopmentExecutableSuffix) {
        return true
    }
    return executablePath.contains("/src-tauri/target/")
        && executablePath.hasSuffix(developmentAppExecutableSuffix)
}

@_cdecl("balance_publish_encrypted_widget_snapshot")
public func balancePublishEncryptedWidgetSnapshot(_ snapshot: UnsafePointer<CChar>?) -> Bool {
    // Always erase the old plaintext cache, including when the extension has not
    // generated its private widget-cache key yet.
    snapshotDefaults.removeObject(forKey: legacyPlaintextSnapshotKey)
    // Publishing means Balance is open again, so cancel any grace-period expiry
    // left by the previous normal shutdown.
    snapshotDefaults.removeObject(forKey: snapshotVisibleUntilKey)
    guard
        let snapshot,
        let publicKeyString = widgetPublicKeyString(),
        let publicKeyData = Data(base64Encoded: publicKeyString)
    else {
        snapshotDefaults.removeObject(forKey: encryptedSnapshotKey)
        _ = snapshotDefaults.synchronize()
        requestWidgetReload()
        return false
    }

    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass: kSecAttrKeyClassPublic,
        kSecAttrKeySizeInBits: 256,
    ]
    guard
        let publicKey = SecKeyCreateWithData(publicKeyData as CFData, attributes as CFDictionary, nil),
        SecKeyIsAlgorithmSupported(publicKey, .encrypt, WidgetSnapshotKey.algorithm),
        let plaintext = String(cString: snapshot).data(using: .utf8),
        let ciphertext = SecKeyCreateEncryptedData(
            publicKey,
            WidgetSnapshotKey.algorithm,
            plaintext as CFData,
            nil
        ) as Data?
    else {
        snapshotDefaults.removeObject(forKey: encryptedSnapshotKey)
        _ = snapshotDefaults.synchronize()
        requestWidgetReload()
        return false
    }

    snapshotDefaults.set(ciphertext.base64EncodedString(), forKey: encryptedSnapshotKey)
    let saved = snapshotDefaults.synchronize()
    requestWidgetReload()
    return saved
}

@_cdecl("balance_schedule_widget_snapshot_expiration")
public func balanceScheduleWidgetSnapshotExpiration(_ delaySeconds: Double) -> Bool {
    snapshotDefaults.removeObject(forKey: legacyPlaintextSnapshotKey)
    // A successful publish removes the previous deadline, so a normal session
    // reaches this branch and receives a fresh grace period. If the app exits
    // before startup publishes, preserve an older deadline instead of extending
    // it and accidentally revealing an already-hidden stale snapshot.
    if snapshotDefaults.object(forKey: snapshotVisibleUntilKey) == nil {
        snapshotDefaults.set(
            Date(timeIntervalSinceNow: max(0, delaySeconds)),
            forKey: snapshotVisibleUntilKey
        )
    }
    let saved = snapshotDefaults.synchronize()
    requestWidgetReload()
    return saved
}

@_cdecl("balance_widget_hides_content_after_close")
public func balanceWidgetHidesContentAfterClose() -> Bool {
    guard snapshotDefaults.object(forKey: hideContentAfterCloseKey) != nil else {
        return true
    }
    return snapshotDefaults.bool(forKey: hideContentAfterCloseKey)
}

@_cdecl("balance_set_widget_hides_content_after_close")
public func balanceSetWidgetHidesContentAfterClose(_ enabled: Bool) -> Bool {
    snapshotDefaults.set(enabled, forKey: hideContentAfterCloseKey)
    return snapshotDefaults.synchronize()
}

private enum WidgetSnapshotKey {
    static let publicPreferenceKey = "balance.widget.public-key.v2"
    static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorX963SHA256AESGCM
}

@_cdecl("balance_activate_running_development_app")
public func balanceActivateRunningDevelopmentApp() -> Int32 {
    let currentProcess = ProcessInfo.processInfo.processIdentifier
    guard let developmentApp = NSWorkspace.shared.runningApplications.first(where: { app in
        guard
            app.processIdentifier != currentProcess,
            let executablePath = app.executableURL?.path
        else {
            return false
        }
        return isDevelopmentExecutable(executablePath)
    }) else {
        return 0
    }

    _ = developmentApp.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    // `activate` can report false when the process is already frontmost. Finding
    // the development process is sufficient reason for the installed app to
    // exit instead of continuing into normal startup.
    return 1
}
