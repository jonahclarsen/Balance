import SwiftUI
import WidgetKit
import Security

private let encryptedSnapshotKey = "balance.widget.encrypted-snapshot.v2"
private let snapshotVisibleUntilKey = "balance.widget.snapshot-visible-until.v1"
private let snapshotDomain = "app.balance.local"
private let widgetKind = "BalanceToday"
private let dayRolloverHour = 3

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
        let calendar = Calendar.autoupdatingCurrent
        let now = Date()
        let currentDay = calendar.component(.hour, from: now) < dayRolloverHour
            ? calendar.date(byAdding: .day, value: -1, to: now) ?? now
            : now
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: currentDay)
    }

    static var visibleUntil: Date? {
        UserDefaults(suiteName: snapshotDomain)?.object(forKey: snapshotVisibleUntilKey) as? Date
    }

    static func load(at now: Date = Date()) -> BalanceSnapshot? {
        if let visibleUntil, now >= visibleUntil {
            return nil
        }
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
        let dayBoundary = Calendar.autoupdatingCurrent.nextDate(
            after: now,
            matching: DateComponents(hour: dayRolloverHour, minute: 0),
            matchingPolicy: .nextTime
        ) ?? regularRefresh
        let visibleUntil = BalanceSnapshot.visibleUntil
        let expirationRefresh = visibleUntil.flatMap { $0 > now ? $0 : nil } ?? regularRefresh
        let refresh = min(min(regularRefresh, dayBoundary), expirationRefresh)
        let snapshot = BalanceSnapshot.load(at: now)
        var entries = [BalanceEntry(date: now, snapshot: snapshot)]
        if snapshot != nil, let visibleUntil, visibleUntil > now {
            entries.append(BalanceEntry(date: visibleUntil, snapshot: nil))
        }
        completion(Timeline(
            entries: entries,
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

    private var contentPadding: CGFloat {
        family == .systemLarge ? 14 : 10
    }

    private var contentSpacing: CGFloat {
        family == .systemLarge ? 9 : 6
    }

    private var rowVerticalPadding: CGFloat {
        family == .systemLarge ? 6 : 4
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
            GeometryReader { geometry in
                ViewThatFits(in: .vertical) {
                    // Keep these as direct children. Wrapping the candidates in
                    // ForEach makes ViewThatFits measure them as one combined view.
                    snapshotContent(snapshot, itemLimit: 10)
                    snapshotContent(snapshot, itemLimit: 9)
                    snapshotContent(snapshot, itemLimit: 8)
                    snapshotContent(snapshot, itemLimit: 7)
                    snapshotContent(snapshot, itemLimit: 6)
                    snapshotContent(snapshot, itemLimit: 5)
                    snapshotContent(snapshot, itemLimit: 4)
                    snapshotContent(snapshot, itemLimit: 3)
                    snapshotContent(snapshot, itemLimit: 2)
                    snapshotContent(snapshot, itemLimit: 1)
                }
                .frame(
                    width: geometry.size.width,
                    height: geometry.size.height,
                    alignment: .center
                )
            }
            .padding(.horizontal, contentPadding)
            .padding(.vertical, contentPadding - 2)
        }
    }

    private func snapshotContent(_ snapshot: BalanceSnapshot, itemLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: contentSpacing) {
            HStack(alignment: .center, spacing: 8) {
                brand
                Spacer(minLength: 4)
                Text(progressLabel(snapshot))
                    .font(.caption.weight(.bold))
                    .fontDesign(.rounded)
                    .foregroundStyle(palette.statusAccent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(palette.statusAccent.opacity(0.12), in: Capsule())
                    .overlay(
                        Capsule().stroke(
                            palette.statusAccent.opacity(0.2),
                            lineWidth: 1
                        )
                    )
                    .accessibilityLabel("\(snapshot.done) of \(snapshot.total) tasks complete")
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("TODAY")
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(palette.accent)
                Text(snapshot.title.isEmpty ? "Today’s plan" : snapshot.title)
                    .font(.headline)
                    .fontDesign(.rounded)
                    .foregroundStyle(palette.ink)
                    .lineLimit(family == .systemSmall ? 1 : 2)
                    .fixedSize(horizontal: false, vertical: true)
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
                            .fill(palette.progressStyle)
                            .frame(width: geometry.size.width * progress(snapshot))
                    }
                }
                .frame(height: 4)
                .shadow(
                    color: palette.progressAccent.opacity(0.24),
                    radius: 3
                )
                .accessibilityHidden(true)
            }

            if snapshot.items.isEmpty {
                Label("All done", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.doneAccent)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(snapshot.items.prefix(itemLimit).enumerated()), id: \.offset) { offset, item in
                        if offset > 0 {
                            Divider()
                                .overlay(palette.line.opacity(0.75))
                        }
                        HStack(alignment: .center, spacing: 8) {
                            Circle()
                                .strokeBorder(
                                    palette.taskAccent.opacity(0.72),
                                    lineWidth: 1.5
                                )
                                .frame(width: 11, height: 11)
                            taskLabel(
                                item,
                                time: snapshot.itemTimes?[safe: offset],
                                rowIndex: offset
                            )
                                .fixedSize(horizontal: false, vertical: true)
                        }
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func progress(_ snapshot: BalanceSnapshot) -> CGFloat {
        guard snapshot.total > 0 else { return 0 }
        return CGFloat(min(max(snapshot.done, 0), snapshot.total)) / CGFloat(snapshot.total)
    }

    private func progressLabel(_ snapshot: BalanceSnapshot) -> String {
        guard snapshot.total > 0 else { return "No tasks" }
        return snapshot.done == snapshot.total ? "Done" : "\(snapshot.done)/\(snapshot.total)"
    }

    private func taskLabel(_ item: String, time: String?, rowIndex: Int) -> some View {
        HStack(alignment: .center, spacing: 6) {
            if let time, !time.isEmpty {
                Text(time)
                    .font(.system(size: 9, weight: .regular, design: .rounded).monospacedDigit())
                    .foregroundStyle(palette.timePillInk)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(palette.timePillStyle(at: rowIndex), in: Capsule())
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

    private var brand: some View {
        Text("Balance")
            .font(.system(size: 20, weight: .bold, design: .rounded))
            .foregroundStyle(palette.brandStyle)
            .shadow(
                color: palette.brandShadow,
                radius: 1,
                x: 0,
                y: 1
            )
            .accessibilityAddTraits(.isHeader)
    }

    private func emptyView(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            brand
            HStack {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(palette.ink)
                Spacer()
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
            }
            Text(message)
                .font(.subheadline)
                .foregroundStyle(palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, contentPadding)
        .padding(.vertical, contentPadding - 2)
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
    let statusAccent: Color
    let taskAccent: Color
    let doneAccent: Color
    let progressAccent: Color
    let progressColors: [Color]?
    let brandColors: [Color]?
    let brandShadow: Color
    let timePill: Color
    let timePillGradients: [[Color]]?
    let timePillInk: Color
    let backgroundColors: [Color]?

    private init(
        paper: UInt32,
        surface: UInt32,
        ink: UInt32,
        muted: UInt32,
        line: UInt32,
        accent: UInt32,
        statusAccent: UInt32? = nil,
        taskAccent: UInt32? = nil,
        doneAccent: UInt32? = nil,
        progressAccent: UInt32? = nil,
        progressColors: [UInt32]? = nil,
        brandColors: [UInt32]? = nil,
        brandShadow: UInt32? = nil,
        timePill: UInt32? = nil,
        timePillGradients: [[UInt32]]? = nil,
        timePillInk: UInt32? = nil,
        backgroundColors: [UInt32]? = nil
    ) {
        self.paper = Color(rgb: paper)
        self.surface = Color(rgb: surface)
        self.ink = Color(rgb: ink)
        self.muted = Color(rgb: muted)
        self.line = Color(rgb: line)
        self.accent = Color(rgb: accent)
        self.statusAccent = Color(rgb: statusAccent ?? accent)
        self.taskAccent = Color(rgb: taskAccent ?? accent)
        self.doneAccent = Color(rgb: doneAccent ?? accent)
        self.progressAccent = Color(rgb: progressAccent ?? accent)
        self.progressColors = progressColors?.map(Color.init(rgb:))
        self.brandColors = brandColors?.map(Color.init(rgb:))
        self.brandShadow = brandShadow.map { Color(rgb: $0).opacity(0.16) } ?? .clear
        self.timePill = Color(rgb: timePill ?? accent)
        self.timePillGradients = timePillGradients?.map { $0.map(Color.init(rgb:)) }
        self.timePillInk = Color(rgb: timePillInk ?? paper)
        self.backgroundColors = backgroundColors?.map(Color.init(rgb:))
    }

    var progressStyle: AnyShapeStyle {
        if let progressColors {
            return AnyShapeStyle(
                LinearGradient(
                    colors: progressColors,
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
        }
        return AnyShapeStyle(progressAccent)
    }

    var brandStyle: AnyShapeStyle {
        if let brandColors {
            return AnyShapeStyle(
                LinearGradient(
                    colors: brandColors,
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
        }
        return AnyShapeStyle(ink)
    }

    func timePillStyle(at index: Int) -> AnyShapeStyle {
        if let gradients = timePillGradients, !gradients.isEmpty {
            return AnyShapeStyle(
                LinearGradient(
                    colors: gradients[index % gradients.count],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
        }
        return AnyShapeStyle(timePill)
    }

    @ViewBuilder
    var background: some View {
        if let backgroundColors {
            LinearGradient(
                colors: backgroundColors,
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
            paper
        }
    }

    static func resolve(themeId: String?, colorScheme: ColorScheme) -> WidgetPalette {
        if colorScheme == .dark {
            switch themeId {
            case "iridescent":
                return WidgetPalette(
                    paper: 0x1F1926,
                    surface: 0x2A2232,
                    ink: 0xF4EDF6,
                    muted: 0xB5A6BD,
                    line: 0x493B54,
                    accent: 0xF5B8E3,
                    statusAccent: 0xB79AF2,
                    taskAccent: 0xB79AF2,
                    doneAccent: 0x65CFAA,
                    progressAccent: 0xB79AF2,
                    progressColors: [0x4257C9, 0x6A54D1, 0x9455C9, 0xC85FB0, 0xEC6A8F, 0xF7856A, 0xF9A94F, 0xF6CF68],
                    brandColors: [0xEF77BC, 0xAA8BEA, 0x58C3C5, 0xE9B36B, 0xEF77BC],
                    brandShadow: 0x4E2B65,
                    timePill: 0x4C6877,
                    timePillGradients: [
                        [0x4A5E91, 0x645586],
                        [0x654F80, 0x80536F],
                        [0x3F706B, 0x4B6684],
                        [0x7B594C, 0x78526A]
                    ],
                    timePillInk: 0xFFFFFF,
                    backgroundColors: [0x15101B, 0x10191E, 0x1C1710]
                )
            case "forest":
                return WidgetPalette(paper: 0x1B201F, surface: 0x232A28, ink: 0xE7ECE8, muted: 0x9BA8A3, line: 0x34403C, accent: 0x79B9AE)
            case "ocean":
                return WidgetPalette(paper: 0x18222B, surface: 0x202D38, ink: 0xE8F0F6, muted: 0x9FB0BD, line: 0x30414E, accent: 0x73B7E6)
            case "orange":
                return WidgetPalette(paper: 0x231F1A, surface: 0x2D2821, ink: 0xF2ECE5, muted: 0xB7AA9D, line: 0x473E34, accent: 0xDFA15F)
            case "earth":
                return WidgetPalette(paper: 0x201B17, surface: 0x2A231E, ink: 0xF0EBE5, muted: 0xAFA49A, line: 0x40362E, accent: 0xBDA58F)
            case "crimson":
                return WidgetPalette(paper: 0x24181B, surface: 0x2E2023, ink: 0xF2E8EA, muted: 0xBAA4A9, line: 0x4B3439, accent: 0xE67F8E)
            case "banana":
                return WidgetPalette(paper: 0x211F18, surface: 0x2B2920, ink: 0xEEEADE, muted: 0xAAA38F, line: 0x403C30, accent: 0xC3B574)
            case "pink":
                return WidgetPalette(paper: 0x261A20, surface: 0x312229, ink: 0xF4E8EE, muted: 0xBAA3AF, line: 0x4D3541, accent: 0xF08DB8)
            case "midnight":
                return WidgetPalette(paper: 0x181C29, surface: 0x212638, ink: 0xE9ECF5, muted: 0xA1A9BD, line: 0x343B52, accent: 0x91A7E4)
            case "graphite":
                return WidgetPalette(paper: 0x161617, surface: 0x202022, ink: 0xF0F0ED, muted: 0xA1A19D, line: 0x343436, accent: 0x70706E, timePillInk: 0xFFFFFF)
            default:
                return WidgetPalette(paper: 0x201C25, surface: 0x29232F, ink: 0xEEE9F2, muted: 0xAFA3B8, line: 0x42384B, accent: 0xB69ADB)
            }
        }

        switch themeId {
        case "iridescent":
            return WidgetPalette(
                paper: 0xFFFDFE,
                surface: 0xFFFFFF,
                ink: 0x282134,
                muted: 0x736B80,
                line: 0xDDD3E6,
                accent: 0xA13C91,
                statusAccent: 0x7B5BD6,
                taskAccent: 0x7B5BD6,
                doneAccent: 0x28A987,
                progressAccent: 0x7B5BD6,
                progressColors: [0x4257C9, 0x6A54D1, 0x9455C9, 0xC85FB0, 0xEC6A8F, 0xF7856A, 0xF9A94F, 0xF6CF68],
                brandColors: [0xA13C91, 0x7256B7, 0x2F7F8A, 0x9C6D35, 0xA13C91],
                brandShadow: 0x4E2B65,
                timePill: 0x52798A,
                timePillGradients: [
                    [0x4257A8, 0x6655A7],
                    [0x6B4F92, 0x87527F],
                    [0x34726F, 0x466C91],
                    [0x825A4B, 0x7E526C]
                ],
                timePillInk: 0xFFFFFF,
                backgroundColors: [0xF8F3FB, 0xF2F8FA, 0xFAF6EF]
            )
        case "forest":
            return WidgetPalette(paper: 0xFFFDF8, surface: 0xFFFFFF, ink: 0x1D2428, muted: 0x687276, line: 0xD8D4CA, accent: 0x2F6F68)
        case "ocean":
            return WidgetPalette(paper: 0xF9FCFF, surface: 0xFFFFFF, ink: 0x172733, muted: 0x637581, line: 0xCCD9E1, accent: 0x276A9F)
        case "orange":
            return WidgetPalette(paper: 0xFFFDF9, surface: 0xFFFFFF, ink: 0x30271F, muted: 0x796D61, line: 0xE4D8CA, accent: 0xB96F25)
        case "earth":
            return WidgetPalette(paper: 0xFCFAF6, surface: 0xFFFFFF, ink: 0x2D2924, muted: 0x756E65, line: 0xDED7CD, accent: 0x796451)
        case "crimson":
            return WidgetPalette(paper: 0xFFFAFB, surface: 0xFFFFFF, ink: 0x321F23, muted: 0x78666A, line: 0xE1CFD3, accent: 0xA92F42)
        case "banana":
            return WidgetPalette(paper: 0xFFFDF8, surface: 0xFFFFFF, ink: 0x302D24, muted: 0x777164, line: 0xE2DED0, accent: 0x827136)
        case "pink":
            return WidgetPalette(paper: 0xFFF9FC, surface: 0xFFFFFF, ink: 0x31232B, muted: 0x7D6A74, line: 0xE6D0DC, accent: 0xC33F7A)
        case "midnight":
            return WidgetPalette(paper: 0xFAFBFE, surface: 0xFFFFFF, ink: 0x202738, muted: 0x687083, line: 0xD1D6E2, accent: 0x425B9B)
        case "graphite":
            return WidgetPalette(paper: 0xF9F9F7, surface: 0xFFFFFF, ink: 0x191918, muted: 0x6D6D69, line: 0xD1D1CD, accent: 0x3A3A38)
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
                palette.background
            }
        } else {
            background(palette.background)
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
