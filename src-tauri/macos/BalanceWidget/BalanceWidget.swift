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
    let themeId: String?

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
        itemTimes: ["8:30am–9am", "", "2pm–2:30pm"],
        themeId: "violet"
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
        case .systemMedium: return 2
        default: return 6
        }
    }

    private var contentPadding: CGFloat {
        family == .systemLarge ? 14 : 10
    }

    private var contentSpacing: CGFloat {
        family == .systemLarge ? 9 : 6
    }

    private var rowVerticalPadding: CGFloat {
        family == .systemLarge ? 6 : 4
    }

    private var accentColor: Color {
        palette.accent
    }

    private var palette: WidgetPalette {
        WidgetPalette.resolve(themeId: entry.snapshot?.themeId, colorScheme: colorScheme)
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
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .balanceWidgetBackground(palette: palette)
        .widgetURL(URL(string: "balance://today"))
    }

    @ViewBuilder
    private func snapshotView(_ snapshot: BalanceSnapshot) -> some View {
        if snapshot.unavailable {
            emptyView(title: "Today", message: "Open Balance to refresh your plan.")
        } else if !snapshot.hasPlan {
            emptyView(title: "Today", message: "No plan yet. Open Balance to make one.")
        } else {
            VStack(alignment: .leading, spacing: contentSpacing) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("TODAY")
                            .font(.caption2.weight(.bold))
                            .tracking(0.8)
                            .foregroundStyle(accentColor)
                        Text(snapshot.title.isEmpty ? "Today’s plan" : snapshot.title)
                            .font(.headline)
                            .fontDesign(.rounded)
                            .foregroundStyle(palette.ink)
                            .lineLimit(family == .systemSmall ? 1 : 2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 4)
                    Text(progressLabel(snapshot))
                        .font(.caption.weight(.bold))
                        .fontDesign(.rounded)
                        .foregroundStyle(accentColor)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(accentColor.opacity(0.12), in: Capsule())
                        .overlay(Capsule().stroke(accentColor.opacity(0.2), lineWidth: 1))
                        .accessibilityLabel("\(snapshot.done) of \(snapshot.total) tasks complete")
                }

                if family != .systemSmall && !snapshot.reminder.isEmpty {
                    Text(snapshot.reminder)
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .lineLimit(family == .systemLarge ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .privacySensitive()
                }

                if family == .systemLarge && snapshot.total > 0 {
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(palette.line.opacity(0.7))
                            Capsule()
                                .fill(accentColor)
                                .frame(width: geometry.size.width * progress(snapshot))
                        }
                    }
                    .frame(height: 4)
                    .accessibilityHidden(true)
                }

                if snapshot.items.isEmpty {
                    Label("All done", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(accentColor)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(snapshot.items.prefix(itemLimit).enumerated()), id: \.offset) { offset, item in
                            if offset > 0 {
                                Divider()
                                    .overlay(palette.line.opacity(0.75))
                            }
                            taskLabel(item, time: snapshot.itemTimes?[safe: offset])
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.vertical, rowVerticalPadding)
                                .padding(
                                    .leading,
                                    CGFloat(min(snapshot.itemDepths?[safe: offset] ?? 0, 4))
                                        * (family == .systemSmall ? 7 : 11)
                                )
                        }
                    }
                    .padding(.horizontal, family == .systemLarge ? 10 : 7)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(palette.line.opacity(0.8), lineWidth: 1)
                    )
                    .privacySensitive()
                }
            }
            .padding(contentPadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func progress(_ snapshot: BalanceSnapshot) -> CGFloat {
        guard snapshot.total > 0 else { return 0 }
        return CGFloat(min(max(snapshot.done, 0), snapshot.total)) / CGFloat(snapshot.total)
    }

    private func progressLabel(_ snapshot: BalanceSnapshot) -> String {
        guard snapshot.total > 0 else { return "No tasks" }
        return snapshot.done == snapshot.total ? "Done" : "\(snapshot.done)/\(snapshot.total)"
    }

    private func taskLabel(_ item: String, time: String?) -> some View {
        HStack(alignment: .center, spacing: 6) {
            if let time, !time.isEmpty {
                Text(time)
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .foregroundStyle(palette.paper)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(accentColor, in: Capsule())
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(item)
                .font(family == .systemSmall ? .caption : .subheadline)
                .foregroundColor(palette.ink)
                .lineLimit(2)
                .layoutPriority(1)
        }
        .fontDesign(.rounded)
    }

    private func emptyView(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(palette.ink)
                Spacer()
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(accentColor)
                    .accessibilityHidden(true)
            }
            Text(message)
                .font(.subheadline)
                .foregroundStyle(palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(contentPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct WidgetPalette {
    let paper: Color
    let surface: Color
    let ink: Color
    let muted: Color
    let line: Color
    let accent: Color

    private init(
        paper: UInt32,
        surface: UInt32,
        ink: UInt32,
        muted: UInt32,
        line: UInt32,
        accent: UInt32
    ) {
        self.paper = Color(rgb: paper)
        self.surface = Color(rgb: surface)
        self.ink = Color(rgb: ink)
        self.muted = Color(rgb: muted)
        self.line = Color(rgb: line)
        self.accent = Color(rgb: accent)
    }

    static func resolve(themeId: String?, colorScheme: ColorScheme) -> WidgetPalette {
        if colorScheme == .dark {
            switch themeId {
            case "forest":
                return WidgetPalette(paper: 0x1B201F, surface: 0x232A28, ink: 0xE7ECE8, muted: 0x9BA8A3, line: 0x34403C, accent: 0x79B9AE)
            case "ocean":
                return WidgetPalette(paper: 0x18222B, surface: 0x202D38, ink: 0xE8F0F6, muted: 0x9FB0BD, line: 0x30414E, accent: 0x73B7E6)
            case "sunset":
                return WidgetPalette(paper: 0x241C18, surface: 0x2E241F, ink: 0xF1E9E4, muted: 0xB8A69B, line: 0x493A32, accent: 0xE5947F)
            case "berry":
                return WidgetPalette(paper: 0x241B20, surface: 0x2E2329, ink: 0xF1E8ED, muted: 0xB5A3AD, line: 0x493741, accent: 0xDB8BAA)
            case "pink":
                return WidgetPalette(paper: 0x261A20, surface: 0x312229, ink: 0xF4E8EE, muted: 0xBAA3AF, line: 0x4D3541, accent: 0xF08DB8)
            case "mint":
                return WidgetPalette(paper: 0x18231F, surface: 0x202E29, ink: 0xE7F1ED, muted: 0x9DB2AA, line: 0x30453E, accent: 0x77C8B1)
            case "midnight":
                return WidgetPalette(paper: 0x181C29, surface: 0x212638, ink: 0xE9ECF5, muted: 0xA1A9BD, line: 0x343B52, accent: 0x91A7E4)
            default:
                return WidgetPalette(paper: 0x201C25, surface: 0x29232F, ink: 0xEEE9F2, muted: 0xAFA3B8, line: 0x42384B, accent: 0xB69ADB)
            }
        }

        switch themeId {
        case "forest":
            return WidgetPalette(paper: 0xFFFDF8, surface: 0xFFFFFF, ink: 0x1D2428, muted: 0x687276, line: 0xD8D4CA, accent: 0x2F6F68)
        case "ocean":
            return WidgetPalette(paper: 0xF9FCFF, surface: 0xFFFFFF, ink: 0x172733, muted: 0x637581, line: 0xCCD9E1, accent: 0x276A9F)
        case "sunset":
            return WidgetPalette(paper: 0xFFFAF5, surface: 0xFFFFFF, ink: 0x33241F, muted: 0x7B6B63, line: 0xE2D3C7, accent: 0xB9563F)
        case "berry":
            return WidgetPalette(paper: 0xFFFAFD, surface: 0xFFFFFF, ink: 0x30242A, muted: 0x786B72, line: 0xDFD2D9, accent: 0x9B496B)
        case "pink":
            return WidgetPalette(paper: 0xFFF9FC, surface: 0xFFFFFF, ink: 0x31232B, muted: 0x7D6A74, line: 0xE6D0DC, accent: 0xC33F7A)
        case "mint":
            return WidgetPalette(paper: 0xF9FDFA, surface: 0xFFFFFF, ink: 0x1E2D29, muted: 0x657771, line: 0xCCDDD7, accent: 0x287968)
        case "midnight":
            return WidgetPalette(paper: 0xFAFBFE, surface: 0xFFFFFF, ink: 0x202738, muted: 0x687083, line: 0xD1D6E2, accent: 0x425B9B)
        default:
            return WidgetPalette(paper: 0xFCFAFF, surface: 0xFFFFFF, ink: 0x292332, muted: 0x756C7F, line: 0xDAD2E2, accent: 0x7355A2)
        }
    }
}

private extension Color {
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }
}

private extension View {
    @ViewBuilder
    func balanceWidgetBackground(palette: WidgetPalette) -> some View {
        if #available(macOSApplicationExtension 14.0, *) {
            containerBackground(for: .widget) {
                palette.paper
            }
        } else {
            background(palette.paper)
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
