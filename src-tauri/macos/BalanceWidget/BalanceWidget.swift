import SwiftUI
import WidgetKit
import Security

private let encryptedSnapshotKey = "balance.widget.encrypted-snapshot.v2"
private let snapshotDomain = "app.balance.local"
private let widgetKind = "BalanceToday"

private enum WidgetSnapshotKey {
    static let tag = Data("app.balance.local.widget.snapshot-key.v2".utf8)
    static let publicPreferenceKey = "balance.widget.public-key.v2"
    static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorX963SHA256AESGCM

    static func privateKey() -> SecKey? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: tag,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef: true,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let key = item as! SecKey?,
           SecKeyIsAlgorithmSupported(key, .decrypt, algorithm) {
            publishPublicKey(for: key)
            return key
        }

        let privateAttributes: [CFString: Any] = [
            kSecAttrIsPermanent: true,
            kSecAttrApplicationTag: tag,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let baseAttributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
        ]

        var key: SecKey?
        if let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            nil
        ) {
            var secureEnclaveAttributes = baseAttributes
            secureEnclaveAttributes[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
            secureEnclaveAttributes[kSecPrivateKeyAttrs] = [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: tag,
                kSecAttrAccessControl: access,
            ]
            key = SecKeyCreateRandomKey(secureEnclaveAttributes as CFDictionary, nil)
        }

        if key == nil {
            var keychainAttributes = baseAttributes
            keychainAttributes[kSecPrivateKeyAttrs] = privateAttributes
            key = SecKeyCreateRandomKey(keychainAttributes as CFDictionary, nil)
        }
        guard let key else {
            return nil
        }
        publishPublicKey(for: key)
        return key
    }

    private static func publishPublicKey(for privateKey: SecKey) {
        guard
            let publicKey = SecKeyCopyPublicKey(privateKey),
            let data = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
        else {
            return
        }
        UserDefaults.standard.set(data.base64EncodedString(), forKey: publicPreferenceKey)
        _ = UserDefaults.standard.synchronize()
    }
}

private struct BalanceSnapshot: Codable {
    let date: String
    let hasPlan: Bool
    let unavailable: Bool
    let title: String
    let reminder: String
    let done: Int
    let total: Int
    let items: [String]
    let itemDepths: [Int]?
    let itemTimes: [String]?

    static let placeholder = BalanceSnapshot(
        date: Self.today,
        hasPlan: true,
        unavailable: false,
        title: "Today’s plan",
        reminder: "This shouldn't be aspirational",
        done: 2,
        total: 6,
        items: ["Plan the day", "Focus on the next thing", "Take a proper break"],
        itemDepths: [0, 1, 0],
        itemTimes: ["8:30am–9am", "", "2pm–2:30pm"]
    )

    static var today: String {
        let formatter = DateFormatter()
        formatter.calendar = .autoupdatingCurrent
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    static func load() -> BalanceSnapshot? {
        guard
            let privateKey = WidgetSnapshotKey.privateKey(),
            SecKeyIsAlgorithmSupported(privateKey, .decrypt, WidgetSnapshotKey.algorithm),
            let encoded = UserDefaults(suiteName: snapshotDomain)?
                .string(forKey: encryptedSnapshotKey),
            let ciphertext = Data(base64Encoded: encoded),
            let plaintext = SecKeyCreateDecryptedData(
                privateKey,
                WidgetSnapshotKey.algorithm,
                ciphertext as CFData,
                nil
            ) as Data?
        else {
            return nil
        }
        return try? JSONDecoder().decode(BalanceSnapshot.self, from: plaintext)
    }
}

private struct BalanceEntry: TimelineEntry {
    let date: Date
    let snapshot: BalanceSnapshot?
}

private struct BalanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> BalanceEntry {
        // Preparing the extension-owned key while WidgetKit renders its gallery
        // preview lets the host encrypt the first real snapshot it publishes.
        _ = WidgetSnapshotKey.privateKey()
        return BalanceEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (BalanceEntry) -> Void) {
        completion(BalanceEntry(
            date: Date(),
            snapshot: context.isPreview ? .placeholder : BalanceSnapshot.load()
        ))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BalanceEntry>) -> Void) {
        let now = Date()
        let regularRefresh = Calendar.autoupdatingCurrent.date(byAdding: .minute, value: 15, to: now)
            ?? now.addingTimeInterval(15 * 60)
        let midnight = Calendar.autoupdatingCurrent.nextDate(
            after: now,
            matching: DateComponents(hour: 0, minute: 0),
            matchingPolicy: .nextTime
        ) ?? regularRefresh
        let refresh = min(regularRefresh, midnight)
        completion(Timeline(
            entries: [BalanceEntry(date: now, snapshot: BalanceSnapshot.load())],
            policy: .after(refresh)
        ))
    }
}

private struct BalanceWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    let entry: BalanceEntry

    private var snapshotIsCurrent: Bool {
        entry.snapshot?.date == BalanceSnapshot.today
    }

    private var itemLimit: Int {
        switch family {
        case .systemSmall: return 2
        case .systemMedium: return 4
        default: return 10
        }
    }

    private var accentColor: Color {
        Color.balanceAccent(for: colorScheme)
    }

    var body: some View {
        Group {
            if let snapshot = entry.snapshot, snapshotIsCurrent {
                snapshotView(snapshot)
            } else {
                emptyView(
                    title: "Today",
                    message: entry.snapshot == nil
                        ? "Open Balance to load your plan."
                        : "Open Balance to refresh today’s plan."
                )
            }
        }
        .balanceWidgetBackground(colorScheme: colorScheme)
        .widgetURL(URL(string: "balance://today"))
    }

    @ViewBuilder
    private func snapshotView(_ snapshot: BalanceSnapshot) -> some View {
        if snapshot.unavailable {
            emptyView(title: "Today", message: "Open Balance to refresh your plan.")
        } else if !snapshot.hasPlan {
            emptyView(title: "Today", message: "No plan yet. Open Balance to make one.")
        } else {
            VStack(alignment: .leading, spacing: family == .systemSmall ? 8 : 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(snapshot.title.isEmpty ? "Today’s plan" : snapshot.title)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(snapshot.done)/\(snapshot.total)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(accentColor)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(accentColor.opacity(0.13), in: Capsule())
                        .accessibilityLabel("\(snapshot.done) of \(snapshot.total) tasks complete")
                }

                if family != .systemSmall && !snapshot.reminder.isEmpty {
                    Text(snapshot.reminder)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .privacySensitive()
                }

                if snapshot.items.isEmpty {
                    Spacer(minLength: 0)
                    Label("All done", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(accentColor)
                    Spacer(minLength: 0)
                } else {
                    VStack(alignment: .leading, spacing: family == .systemSmall ? 5 : 7) {
                        ForEach(Array(snapshot.items.prefix(itemLimit).enumerated()), id: \.offset) { offset, item in
                            HStack(alignment: .firstTextBaseline, spacing: 7) {
                                Circle()
                                    .fill(accentColor.opacity(0.8))
                                    .frame(width: 5, height: 5)
                                if let time = snapshot.itemTimes?[safe: offset], !time.isEmpty {
                                    Text(time)
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                                Text(item)
                                    .font(family == .systemSmall ? .caption : .subheadline)
                                    .lineLimit(1)
                            }
                            .padding(
                                .leading,
                                CGFloat(min(snapshot.itemDepths?[safe: offset] ?? 0, 4))
                                    * (family == .systemSmall ? 8 : 12)
                            )
                        }
                    }
                    .privacySensitive()
                    Spacer(minLength: 0)
                }
            }
            .padding()
        }
    }

    private func emptyView(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(accentColor)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding()
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private extension Color {
    static func balancePaper(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.11, green: 0.13, blue: 0.12)
            : Color(red: 0.99, green: 0.98, blue: 0.95)
    }

    static func balanceAccent(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.47, green: 0.73, blue: 0.68)
            : Color(red: 0.18, green: 0.44, blue: 0.41)
    }
}

private extension View {
    @ViewBuilder
    func balanceWidgetBackground(colorScheme: ColorScheme) -> some View {
        if #available(macOSApplicationExtension 14.0, *) {
            containerBackground(for: .widget) {
                Color.balancePaper(for: colorScheme)
            }
        } else {
            background(Color.balancePaper(for: colorScheme))
        }
    }
}

private struct BalanceTodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: widgetKind, provider: BalanceProvider()) { entry in
            BalanceWidgetView(entry: entry)
        }
        .configurationDisplayName("Balance Today")
        .description("Your progress and next tasks for today.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
private struct BalanceWidgetBundle: WidgetBundle {
    var body: some Widget {
        BalanceTodayWidget()
    }
}
