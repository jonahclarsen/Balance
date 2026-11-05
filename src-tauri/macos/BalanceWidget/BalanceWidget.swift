import CoreText
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

private struct SituateMode: Codable, Identifiable {
    let id: String
    let name: String
    let color: String?
    let active: Bool

    var tint: Color? { Color(hex: color) }
}

private let projectDateFormatter = ISO8601DateFormatter()
private let fractionalProjectDateFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private struct ActiveProject: Codable, Identifiable {
    let id: String
    let name: String
    let color: String?
    let activeUntil: String?

    var tint: Color? { Color(hex: color) }

    var expiresAt: Date? {
        guard let activeUntil else { return nil }
        return projectDateFormatter.date(from: activeUntil)
            ?? fractionalProjectDateFormatter.date(from: activeUntil)
    }

    var url: URL {
        URL(string: "balance://projects/\(id)") ?? URL(string: "balance://projects")!
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
    var situateModes: [SituateMode]? = nil
    var activeProjects: [ActiveProject]? = nil

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

    /// Projects stop being active at `activeUntil`, which can pass between
    /// snapshot publications, so every render re-checks it.
    func projects(activeAt date: Date) -> [ActiveProject] {
        (activeProjects ?? []).filter { $0.expiresAt.map { $0 > date } ?? false }
    }

    func nextProjectExpiry(after date: Date) -> Date? {
        projects(activeAt: date).compactMap(\.expiresAt).min()
    }

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
        let hideAt = BalanceSnapshot.visibleUntil.flatMap { $0 > now ? $0 : nil }
        let snapshot = BalanceSnapshot.load(at: now)
        let projectExpiry = snapshot?.nextProjectExpiry(after: now)
        let refresh = [regularRefresh, dayBoundary, hideAt, projectExpiry]
            .compactMap { $0 }
            .min() ?? regularRefresh
        var entries = [BalanceEntry(date: now, snapshot: snapshot)]
        // An entry at the expiry drops the project on time even if WidgetKit
        // defers the reload requested by the refresh policy.
        if let snapshot, let projectExpiry, hideAt.map({ projectExpiry < $0 }) ?? true {
            entries.append(BalanceEntry(date: projectExpiry, snapshot: snapshot))
        }
        if snapshot != nil, let hideAt {
            entries.append(BalanceEntry(date: hideAt, snapshot: nil))
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
        if palette.chrome.isWindow {
            return family == .systemLarge ? 9 : 7
        }
        return family == .systemLarge ? 14 : 10
    }

    private var contentSpacing: CGFloat {
        family == .systemLarge ? 9 : 6
    }

    private var rowVerticalPadding: CGFloat {
        family == .systemLarge ? 6 : 4
    }

    private var projectLimit: Int {
        switch family {
        case .systemSmall: return 1
        case .systemMedium: return 2
        default: return 3
        }
    }

    private var palette: WidgetPalette {
        WidgetPalette.resolve(themeId: entry.snapshot?.themeId, colorScheme: colorScheme)
    }

    var body: some View {
        Group {
            if palette.chrome.isWindow {
                WidgetWindow(palette: palette, status: windowStatus) {
                    widgetContent
                }
                .ignoringWidgetMargins()
            } else {
                widgetContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .balanceWidgetBackground(palette: palette)
        .widgetURL(URL(string: "balance://today"))
    }

    @ViewBuilder
    private var widgetContent: some View {
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

    private var windowStatus: String? {
        guard let snapshot = entry.snapshot, snapshotIsCurrent,
              snapshot.hasPlan, !snapshot.unavailable else { return nil }
        return progressLabel(snapshot)
    }

    @ViewBuilder
    private func snapshotView(_ snapshot: BalanceSnapshot) -> some View {
        if snapshot.unavailable {
            emptyView(title: "Today", message: "Open Balance to refresh your plan.")
        } else if !snapshot.hasPlan {
            emptyView(title: "Today", message: "No plan yet. Open Balance to make one.", snapshot: snapshot)
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
                    alignment: palette.chrome.isWindow ? .top : .center
                )
            }
            .padding(.horizontal, contentPadding)
            .padding(.vertical, contentPadding - 2)
        }
    }

    private func snapshotContent(_ snapshot: BalanceSnapshot, itemLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: contentSpacing) {
            if !palette.chrome.isWindow {
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
            }

            activeProjectRows(snapshot)

            if let modes = snapshot.situateModes, !modes.isEmpty {
                HStack(spacing: 5) {
                    ForEach(modes.filter { $0.active }.prefix(3)) { mode in
                        Link(destination: URL(string: "balance://situate?mode=\(mode.id)&widget=1")!) {
                            Text(mode.name).font(palette.font(.time, fallback: .caption2.weight(.semibold)))
                                .foregroundStyle(mode.tint ?? palette.ink)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background((mode.tint ?? palette.statusAccent).opacity(0.15), in: palette.controlShape)
                                .overlay(palette.controlShape.stroke((mode.tint ?? palette.statusAccent).opacity(0.45), lineWidth: 1))
                        }.privacySensitive()
                    }
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("TODAY")
                    .font(palette.font(.eyebrow, fallback: .caption2.weight(.bold)))
                    .tracking(0.8)
                    .foregroundStyle(palette.accent)
                Text(snapshot.title.isEmpty ? "Today’s plan" : snapshot.title)
                    .font(palette.font(.title, fallback: .headline))
                    .fontDesign(palette.textDesign)
                    .foregroundStyle(palette.ink)
                    .lineLimit(family == .systemSmall ? 1 : 2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if family != .systemSmall && !snapshot.reminder.isEmpty {
                Text(snapshot.reminder)
                    .font(palette.font(.body, fallback: .caption))
                    .foregroundStyle(palette.muted)
                    .lineLimit(family == .systemLarge ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .privacySensitive()
            }

            if family == .systemLarge && snapshot.total > 0 {
                if palette.chrome.isWindow {
                    WindowProgressBar(palette: palette, value: progress(snapshot))
                        .accessibilityHidden(true)
                } else {
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
            }

            if snapshot.items.isEmpty {
                Label("All done", systemImage: "checkmark.circle.fill")
                    .font(palette.font(.title, fallback: .subheadline.weight(.medium)))
                    .foregroundStyle(palette.doneAccent)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(snapshot.items.prefix(itemLimit).enumerated()), id: \.offset) { offset, item in
                        if offset > 0 {
                            Divider()
                                .overlay(palette.line.opacity(0.75))
                        }
                        HStack(alignment: .center, spacing: 8) {
                            TaskMarker(palette: palette)
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
                .background(palette.listWell, in: palette.listShape)
                .overlay(palette.listShape.stroke(palette.line.opacity(palette.chrome.isWindow ? 1 : 0.8), lineWidth: 1))
                .privacySensitive()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func activeProjectRows(_ snapshot: BalanceSnapshot) -> some View {
        let projects = Array(snapshot.projects(activeAt: entry.date).prefix(projectLimit))
        if !projects.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(projects) { project in
                    Link(destination: project.url) {
                        HStack(alignment: .center, spacing: 6) {
                            palette.markerShape
                                .fill(project.tint ?? palette.accent)
                                .frame(width: 7, height: 7)
                            Text(project.name)
                                .font(palette.font(.body, fallback: .caption.weight(.medium)))
                                .fontDesign(palette.textDesign)
                                .foregroundStyle(palette.ink)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("\(project.name), active project")
                    .privacySensitive()
                }
            }
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

    private func taskLabel(_ item: String, time: String?, rowIndex: Int) -> some View {
        HStack(alignment: .center, spacing: 6) {
            if let time, !time.isEmpty {
                Text(time)
                    .font(palette.font(.time, fallback: .system(size: 9, weight: .regular, design: .rounded).monospacedDigit()))
                    .foregroundStyle(palette.timePillInk)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(palette.timePillStyle(at: rowIndex), in: palette.controlShape)
                    .overlay(palette.controlShape.stroke(palette.chrome.isWindow ? palette.line : .clear, lineWidth: 1))
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(item)
                .font(palette.font(.body, fallback: family == .systemSmall ? .caption : .subheadline))
                .foregroundColor(palette.ink)
                .lineLimit(2)
                .layoutPriority(1)
        }
        .fontDesign(palette.textDesign)
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

    private func emptyView(title: String, message: String, snapshot: BalanceSnapshot? = nil) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if !palette.chrome.isWindow {
                brand
            }
            if let snapshot {
                activeProjectRows(snapshot)
            }
            HStack {
                Text(title)
                    .font(palette.font(.title, fallback: .headline))
                    .foregroundStyle(palette.ink)
                Spacer()
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
            }
            Text(message)
                .font(palette.font(.body, fallback: .subheadline))
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
    fileprivate(set) var chrome = WidgetChrome.none
    fileprivate(set) var isDark = false

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
        switch chrome {
        case .windowsxp:
            Color(rgb: 0x0055EA)
        case .windowsvista:
            LinearGradient(
                stops: (isDark
                    ? [(0x3B6179, 0), (0x1A3544, 0.4), (0x32596E, 0.64), (0x162E3D, 1)]
                    : [(0xEEFAFF, 0), (0x75A8C2, 0.4), (0xBEDEEA, 0.64), (0x5893AC, 1)]
                ).map { Gradient.Stop(color: Color(rgb: $0.0), location: $0.1) },
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .windows98:
            Color(rgb: isDark ? 0x003B3B : 0x008080)
        case .system1:
            DitherPattern.image(dark: isDark)
                .resizable(resizingMode: .tile)
        case .none:
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
    }

    /// Retro windows use the dialog face behind the content and a white well
    /// for the list, the reverse of the other themes.
    var windowFace: Color { surface }
    var listWell: Color { chrome.isWindow ? paper : surface }

    var listShape: AnyShape {
        switch chrome {
        case .none: return AnyShape(RoundedRectangle(cornerRadius: 10))
        case .windowsvista: return AnyShape(RoundedRectangle(cornerRadius: 2))
        default: return AnyShape(Rectangle())
        }
    }

    var controlShape: AnyShape {
        switch chrome {
        case .none: return AnyShape(Capsule())
        case .windowsvista: return AnyShape(RoundedRectangle(cornerRadius: 2))
        default: return AnyShape(Rectangle())
        }
    }

    var markerShape: AnyShape {
        chrome.isWindow ? AnyShape(Rectangle()) : AnyShape(Circle())
    }

    /// `fontDesign` replaces custom faces, so retro themes must not set it.
    var textDesign: Font.Design? { chrome.isWindow ? nil : .rounded }

    func font(_ role: WidgetTextRole, fallback: Font) -> Font {
        guard let face = chrome.face(for: role) else { return fallback }
        return .custom(face.name, fixedSize: face.size)
    }

    static func resolve(themeId: String?, colorScheme: ColorScheme) -> WidgetPalette {
        var palette = colors(themeId: themeId, colorScheme: colorScheme)
        palette.chrome = WidgetChrome(themeId: themeId)
        palette.isDark = colorScheme == .dark
        return palette
    }

    private static func colors(themeId: String?, colorScheme: ColorScheme) -> WidgetPalette {
        // Historical days may reference every shipped theme forever. Never
        // delete a palette case; retire the theme from current selection.
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
            case "windows98":
                return WidgetPalette(paper: 0x202020, surface: 0x303030, ink: 0xF2F2F2, muted: 0xC0C0C0, line: 0x808080, accent: 0x80D0D0, taskAccent: 0x80D0D0, doneAccent: 0x80C0B0, timePill: 0x303030, timePillInk: 0x80D0D0)
            case "windowsxp":
                return WidgetPalette(paper: 0x202631, surface: 0x303846, ink: 0xF4F4EF, muted: 0xC1C7D2, line: 0x727E91, accent: 0x8ABEFF, taskAccent: 0x8ABEFF, doneAccent: 0x9ACB82, timePill: 0x303846, timePillInk: 0xC5DEFF)
            case "windowsvista":
                return WidgetPalette(paper: 0x17242C, surface: 0x20343E, ink: 0xF1F7FA, muted: 0xBED0D9, line: 0x658B9E, accent: 0x99D9FA, taskAccent: 0x99D9FA, doneAccent: 0x94DAB0, timePill: 0x203E4F, timePillInk: 0xC5ECFF)
            case "system1":
                return WidgetPalette(paper: 0x101010, surface: 0x181818, ink: 0xFFFFFF, muted: 0xBDBDBD, line: 0xBDBDBD, accent: 0xFFFFFF, taskAccent: 0xFFFFFF, doneAccent: 0xBDBDBD, timePill: 0x181818, timePillInk: 0xFFFFFF)
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
        case "windows98":
            return WidgetPalette(paper: 0xFFFFFF, surface: 0xC0C0C0, ink: 0x000000, muted: 0x404040, line: 0x808080, accent: 0x000080, taskAccent: 0x000080, doneAccent: 0x006060, timePill: 0xDFDFDF, timePillInk: 0x000080)
        case "windowsxp":
            return WidgetPalette(paper: 0xFFFFFF, surface: 0xECE9D8, ink: 0x000000, muted: 0x454339, line: 0xACA899, accent: 0x0055B8, taskAccent: 0x0055B8, doneAccent: 0x347B2A, timePill: 0xF5F3E9, timePillInk: 0x003B82)
        case "windowsvista":
            return WidgetPalette(paper: 0xFFFFFF, surface: 0xEFF7FB, ink: 0x14232D, muted: 0x455E6D, line: 0x7E9DAD, accent: 0x176B98, taskAccent: 0x176B98, doneAccent: 0x277B50, timePill: 0xE4F1F9, timePillInk: 0x174F70)
        case "system1":
            return WidgetPalette(paper: 0xFFFFFF, surface: 0xFFFFFF, ink: 0x000000, muted: 0x404040, line: 0x000000, accent: 0x000000, taskAccent: 0x000000, doneAccent: 0x404040, timePill: 0xFFFFFF, timePillInk: 0x000000)
        case "graphite":
            return WidgetPalette(paper: 0xF9F9F7, surface: 0xFFFFFF, ink: 0x191918, muted: 0x6D6D69, line: 0xD1D1CD, accent: 0x3A3A38)
        default:
            return WidgetPalette(paper: 0xFCFAFF, surface: 0xFFFFFF, ink: 0x292332, muted: 0x756C7F, line: 0xDAD2E2, accent: 0x7355A2)
        }
    }
}

private enum WidgetTextRole {
    case caption, status, eyebrow, title, body, time
}

/// Retro themes draw the widget as a window from their operating system.
/// Every other theme keeps the card layout.
private enum WidgetChrome {
    case none, windows98, system1, windowsxp, windowsvista

    init(themeId: String?) {
        switch themeId {
        case "windows98": self = .windows98
        case "system1": self = .system1
        case "windowsxp": self = .windowsxp
        case "windowsvista": self = .windowsvista
        default: self = .none
        }
    }

    var isWindow: Bool {
        if case .none = self { return false }
        return true
    }

    func face(for role: WidgetTextRole) -> (name: String, size: CGFloat)? {
        switch self {
        case .none:
            return nil
        case .windowsxp:
            switch role {
            case .caption: return ("TrebuchetMS-Bold", 13)
            case .status: return ("Tahoma", 11)
            case .eyebrow: return ("Tahoma-Bold", 9)
            case .title: return ("Tahoma-Bold", 13)
            case .body: return ("Tahoma", 12)
            case .time: return ("Tahoma", 10)
            }
        case .windowsvista:
            switch role {
            case .caption: return ("Selawik-Regular", 14)
            case .status: return ("Selawik-Regular", 12)
            case .eyebrow: return ("Selawik-Bold", 10)
            case .title: return ("Selawik-Bold", 14)
            case .body: return ("Selawik-Regular", 13)
            case .time: return ("Selawik-Regular", 11)
            }
        case .windows98:
            switch role {
            case .caption, .eyebrow, .title: return ("PixelatedMSSansSerif-Bold", 11)
            default: return ("PixelatedMSSansSerif-Regular", 11)
            }
        case .system1:
            switch role {
            case .caption, .status, .title: return ("ChiKareGo2", 16)
            case .eyebrow: return ("ChiKareGo2", 12)
            case .body, .time: return ("FindersKeepers", 16)
            }
        }
    }
}

private enum WidgetFonts {
    /// The Info.plist font path covers the renderer; this covers the extension.
    static func register() {
        let urls = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "widget-fonts") ?? []
        for url in urls {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

private enum DitherPattern {
    static func image(dark: Bool) -> Image {
        // Two-point checks, matching the System 1 desktop in the app.
        let (first, second): (UInt8, UInt8) = dark ? (0x10, 0x50) : (0x00, 0xFF)
        let pixels = [first, first, second, second, first, first, second, second,
                      second, second, first, first, second, second, first, first]
        let image = pixels.withUnsafeBytes { bytes -> CGImage? in
            guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
            return CGImage(
                width: 4, height: 4, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: [],
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
            )
        }
        guard let image else { return Image(systemName: "square.fill") }
        return Image(decorative: image, scale: 1).interpolation(.none)
    }
}

private struct Pinstripes: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        var y = rect.minY + 2
        while y < rect.maxY {
            path.addRect(CGRect(x: rect.minX, y: y, width: rect.width, height: 1))
            y += 5
        }
        return path
    }
}

private struct ProgressBlocks: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        var x = rect.minX
        while x < rect.maxX {
            path.addRect(CGRect(x: x, y: rect.minY, width: min(8, rect.maxX - x), height: rect.height))
            x += 10
        }
        return path
    }
}

private extension View {
    /// One-point edges in the two-tone Windows bevel style.
    func bevel(topLeading: Color, bottomTrailing: Color) -> some View {
        overlay(alignment: .top) { topLeading.frame(height: 1) }
            .overlay(alignment: .leading) { topLeading.frame(width: 1) }
            .overlay(alignment: .bottom) { bottomTrailing.frame(height: 1) }
            .overlay(alignment: .trailing) { bottomTrailing.frame(width: 1) }
    }

    /// The window frame reaches the widget's edges, past the system margins.
    @ViewBuilder
    func ignoringWidgetMargins() -> some View {
        if #available(macOSApplicationExtension 14.0, *) {
            modifier(IgnoreWidgetMargins())
        } else {
            self
        }
    }
}

@available(macOSApplicationExtension 14.0, *)
private struct IgnoreWidgetMargins: ViewModifier {
    @Environment(\.widgetContentMargins) private var margins

    func body(content: Content) -> some View {
        content
            .padding(.top, -margins.top)
            .padding(.bottom, -margins.bottom)
            .padding(.leading, -margins.leading)
            .padding(.trailing, -margins.trailing)
    }
}

private struct WidgetWindow<Content: View>: View {
    let palette: WidgetPalette
    let status: String?
    @ViewBuilder let content: Content

    private var client: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(palette.windowFace)
            .clipped()
    }

    var body: some View {
        switch palette.chrome {
        case .windowsxp:
            VStack(spacing: 0) {
                caption
                client.padding([.horizontal, .bottom], 4)
            }
        case .windowsvista:
            VStack(spacing: 0) {
                caption
                client
                    .overlay(Rectangle().stroke(Color(rgb: 0x173E52).opacity(0.45), lineWidth: 1))
                    .padding(1)
                    .overlay(Rectangle().stroke(Color.white.opacity(palette.isDark ? 0.25 : 0.65), lineWidth: 1))
                    .padding([.horizontal, .bottom], 5)
            }
        case .windows98:
            VStack(spacing: 2) {
                caption
                client
            }
            .padding(3)
            .background(palette.windowFace)
            .bevel(
                topLeading: Color(rgb: palette.isDark ? 0x737373 : 0xFFFFFF),
                bottomTrailing: .black
            )
            .padding(7)
        case .system1:
            VStack(spacing: 0) {
                caption
                palette.ink.frame(height: 1)
                client
            }
            .overlay(Rectangle().stroke(palette.ink, lineWidth: 1))
            .padding(7)
        case .none:
            content
        }
    }

    @ViewBuilder
    private var caption: some View {
        let title = Text("Balance").font(palette.font(.caption, fallback: .headline))
        let statusText = Text(status ?? "").font(palette.font(.status, fallback: .caption))
        switch palette.chrome {
        case .windowsxp:
            HStack {
                title.foregroundStyle(.white).shadow(color: Color(rgb: 0x0F1089), radius: 0, x: 1, y: 1)
                Spacer(minLength: 4)
                statusText.foregroundStyle(.white)
            }
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(
                LinearGradient(
                    stops: [
                        .init(color: Color(rgb: 0x0997FF), location: 0),
                        .init(color: Color(rgb: 0x0053EE), location: 0.08),
                        .init(color: Color(rgb: 0x0050EE), location: 0.4),
                        .init(color: Color(rgb: 0x0066FF), location: 0.88),
                        .init(color: Color(rgb: 0x005BFF), location: 0.95),
                        .init(color: Color(rgb: 0x003DD7), location: 1)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
        case .windowsvista:
            let ink = Color(rgb: palette.isDark ? 0xF1F7FA : 0x102431)
            let glow = Color(rgb: palette.isDark ? 0x071821 : 0xFFFFFF)
            HStack {
                title.foregroundStyle(ink).shadow(color: glow, radius: 4).shadow(color: glow, radius: 7)
                Spacer(minLength: 4)
                statusText.foregroundStyle(ink).shadow(color: glow, radius: 4)
            }
            .padding(.horizontal, 12)
            .frame(height: 26)
        case .windows98:
            HStack {
                title.foregroundStyle(.white)
                Spacer(minLength: 4)
                statusText.foregroundStyle(.white)
            }
            .padding(.horizontal, 4)
            .frame(height: 18)
            .background(
                LinearGradient(colors: [Color(rgb: 0x000080), Color(rgb: 0x1084D0)], startPoint: .leading, endPoint: .trailing)
            )
        case .system1:
            ZStack {
                palette.paper
                Pinstripes().fill(palette.ink)
                title
                    .foregroundStyle(palette.ink)
                    .padding(.horizontal, 6)
                    .background(palette.paper)
                if status != nil {
                    HStack {
                        Spacer(minLength: 0)
                        statusText
                            .foregroundStyle(palette.ink)
                            .padding(.horizontal, 5)
                            .background(palette.paper)
                    }
                    .padding(.trailing, 6)
                }
            }
            .frame(height: 19)
        case .none:
            EmptyView()
        }
    }
}

private struct TaskMarker: View {
    let palette: WidgetPalette

    var body: some View {
        switch palette.chrome {
        case .none:
            Circle()
                .strokeBorder(palette.taskAccent.opacity(0.72), lineWidth: 1.5)
                .frame(width: 11, height: 11)
        case .windowsxp:
            LinearGradient(colors: [Color(rgb: 0xDCDCD7), .white], startPoint: .topLeading, endPoint: .bottomTrailing)
                .overlay(Rectangle().strokeBorder(Color(rgb: 0x1D5281), lineWidth: 1))
                .frame(width: 13, height: 13)
        case .windowsvista:
            LinearGradient(
                stops: [.init(color: Color(rgb: 0xD4D4D4), location: 0), .init(color: Color(rgb: 0xF6F6F6), location: 0.7)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .overlay(Rectangle().inset(by: 1).strokeBorder(Color(rgb: 0xF4F4F4), lineWidth: 1))
            .overlay(Rectangle().strokeBorder(Color(rgb: 0x8E8F8F), lineWidth: 1))
            .frame(width: 13, height: 13)
        case .windows98:
            palette.paper
                .bevel(topLeading: Color(rgb: 0x404040), bottomTrailing: Color(rgb: palette.isDark ? 0x737373 : 0xC0C0C0))
                .frame(width: 13, height: 13)
        case .system1:
            palette.paper
                .overlay(Rectangle().strokeBorder(palette.ink, lineWidth: 1))
                .frame(width: 12, height: 12)
        }
    }
}

private struct WindowProgressBar: View {
    let palette: WidgetPalette
    let value: CGFloat

    var body: some View {
        GeometryReader { geometry in
            let filled = max(0, geometry.size.width - 4) * value
            switch palette.chrome {
            case .windowsxp:
                ZStack(alignment: .leading) {
                    palette.paper
                    ProgressBlocks()
                        .fill(LinearGradient(
                            colors: [0xACEDAD, 0x7BE47D, 0x4CDA50, 0x2ED330, 0x42D845, 0x76E275, 0x8FE791].map(Color.init(rgb:)),
                            startPoint: .top,
                            endPoint: .bottom
                        ))
                        .frame(width: filled)
                        .padding(2)
                }
                .clipShape(RoundedRectangle(cornerRadius: 3))
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(rgb: 0x686868), lineWidth: 1))
            case .windowsvista:
                ZStack(alignment: .leading) {
                    palette.paper
                    LinearGradient(
                        stops: [
                            .init(color: Color(rgb: 0xCFF5CF), location: 0),
                            .init(color: Color(rgb: 0x4FDB4F), location: 0.45),
                            .init(color: Color(rgb: 0x2AC92A), location: 0.5),
                            .init(color: Color(rgb: 0x8DEB8D), location: 1)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(width: filled)
                    .padding(1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 2))
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color(rgb: 0x8E8F8F), lineWidth: 1))
            case .windows98:
                ZStack(alignment: .leading) {
                    palette.paper
                    ProgressBlocks()
                        .fill(palette.accent)
                        .frame(width: filled)
                        .padding(2)
                }
                .bevel(topLeading: Color(rgb: 0x808080), bottomTrailing: Color(rgb: palette.isDark ? 0x737373 : 0xFFFFFF))
            case .system1, .none:
                ZStack(alignment: .leading) {
                    palette.paper
                    palette.ink.frame(width: filled + 4)
                }
                .overlay(Rectangle().strokeBorder(palette.ink, lineWidth: 1))
            }
        }
        .frame(height: 12)
    }
}

private extension Color {
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.hasPrefix("#"),
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(rgb: value)
    }

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
    init() {
        WidgetFonts.register()
    }

    var body: some Widget {
        BalanceTodayWidget()
    }
}
