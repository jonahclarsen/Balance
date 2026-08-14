import Foundation
import Security
import WidgetKit

private let encryptedSnapshotKey = "balance.widget.encrypted-snapshot.v2"
private let legacyPlaintextSnapshotKey = "balance.widget.snapshot.v1"
private let widgetPreferenceDomain = "app.balance.local.widget"

@_cdecl("balance_publish_encrypted_widget_snapshot")
public func balancePublishEncryptedWidgetSnapshot(_ snapshot: UnsafePointer<CChar>?) -> Bool {
    // Always erase the old plaintext cache, including when the extension has not
    // generated its private widget-cache key yet.
    UserDefaults.standard.removeObject(forKey: legacyPlaintextSnapshotKey)

    guard
        let snapshot,
        let widgetDefaults = UserDefaults(suiteName: widgetPreferenceDomain),
        let publicKeyString = widgetDefaults.string(forKey: WidgetSnapshotKey.publicPreferenceKey),
        let publicKeyData = Data(base64Encoded: publicKeyString)
    else {
        UserDefaults.standard.removeObject(forKey: encryptedSnapshotKey)
        _ = UserDefaults.standard.synchronize()
        WidgetCenter.shared.reloadAllTimelines()
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
        UserDefaults.standard.removeObject(forKey: encryptedSnapshotKey)
        _ = UserDefaults.standard.synchronize()
        WidgetCenter.shared.reloadAllTimelines()
        return false
    }

    UserDefaults.standard.set(ciphertext.base64EncodedString(), forKey: encryptedSnapshotKey)
    let saved = UserDefaults.standard.synchronize()
    WidgetCenter.shared.reloadAllTimelines()
    return saved
}

private enum WidgetSnapshotKey {
    static let publicPreferenceKey = "balance.widget.public-key.v2"
    static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorX963SHA256AESGCM
}

@_cdecl("balance_reload_widget_timelines")
public func balanceReloadWidgetTimelines() {
    WidgetCenter.shared.reloadTimelines(ofKind: "BalanceToday")
}
