import SwiftUI

enum ProactiveScheduleFrequency: String, CaseIterable, Sendable {
    case once
    case daily
}

enum ProactiveScheduleSectionKind: Equatable, Sendable {
    case active
    case paused
    case history
}

struct ProactiveScheduleEffectiveBadge: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case active
        case inFlight
        case warning
        case completed
        case neutral
    }

    let titleKey: String.LocalizationValue
    let tone: Tone

    var color: Color {
        switch tone {
        case .active: Color(uiColor: .systemGreen)
        case .inFlight: Color(uiColor: .systemIndigo)
        case .warning: Color(uiColor: .systemOrange)
        case .completed: Color.secondary
        case .neutral: Color(uiColor: .systemRed)
        }
    }
}

struct ProactiveSchedulesSheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var store: ProactiveScheduleStore
    var onOpenChat: (() -> Void)? = nil

    @State private var isShowingCreateSheet = false
    @State private var selectedKind: ProactiveScheduleKind = .brief
    @State private var selectedFrequency: ProactiveScheduleFrequency = .once
    @State private var titleText = ""
    @State private var promptText = ""
    @State private var dailyTime = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var oneTimeFireAt = Date().addingTimeInterval(3600)
    @State private var pendingCancelSchedule: ProactiveScheduleDTO?

    private var subtitleKey: String.LocalizationValue {
        if store.isEndpointUnavailable {
            return "schedules.subtitle.unavailable"
        }
        if store.isMockOnly {
            return "schedules.subtitle.mock"
        }
        return "schedules.subtitle"
    }

    private var activeSchedules: [ProactiveScheduleDTO] {
        Self.groupedSchedules(from: store.schedules, in: .active)
    }

    private var pausedSchedules: [ProactiveScheduleDTO] {
        Self.groupedSchedules(from: store.schedules, in: .paused)
    }

    private var historySchedules: [ProactiveScheduleDTO] {
        Self.groupedSchedules(from: store.schedules, in: .history)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    if store.isMockOnly {
                        MockOnlyBanner()
                    }

                    Text(String(localized: subtitleKey, table: "Conversation"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("schedules-subtitle")

                    if store.isEndpointUnavailable {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "schedules.endpoint_unavailable.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(
                                String(localized: "schedules.endpoint_unavailable.message", table: "Conversation")
                            ),
                            tone: .neutral
                        )
                        .accessibilityIdentifier("schedules-endpoint-unavailable")
                    } else {
                        if let error = store.errorMessage, !store.schedules.isEmpty {
                            ScheduleErrorBanner(message: error, identifier: "schedules-error-notice")
                        }

                        primaryContent
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(EmberDesignTokens.surfaceCanvas)
            .navigationTitle(Text("schedules.nav_title", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await store.refresh()
            }
            .task {
                await store.refresh()
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task { await store.refresh() }
                }
            }
            .toolbar {
                if !store.isEndpointUnavailable {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            openCreateSheet()
                        } label: {
                            Label {
                                Text("schedules.add.short", tableName: "Conversation")
                                    .font(.subheadline.weight(.semibold))
                            } icon: {
                                Image(systemName: "plus")
                            }
                        }
                        .accessibilityLabel(Text("schedules.add.action", tableName: "Conversation"))
                        .accessibilityIdentifier("schedules-add-button")
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Text("tasks.detail.close", tableName: "Conversation")
                    }
                    .accessibilityIdentifier("schedules-sheet-close")
                }
            }
            .alert(
                Text("schedules.cancel.confirm_title", tableName: "Conversation"),
                isPresented: Binding(
                    get: { pendingCancelSchedule != nil },
                    set: { if !$0 { pendingCancelSchedule = nil } }
                )
            ) {
                Button(role: .cancel) {
                    pendingCancelSchedule = nil
                } label: {
                    Text("schedules.cancel.keep", tableName: "Conversation")
                }
                Button(role: .destructive) {
                    if let target = pendingCancelSchedule {
                        pendingCancelSchedule = nil
                        Task { await store.cancel(id: target.scheduleId) }
                    }
                } label: {
                    Text("schedules.cancel.confirm_action", tableName: "Conversation")
                }
            } message: {
                Text("schedules.cancel.confirm_message", tableName: "Conversation")
            }
            .sheet(isPresented: $isShowingCreateSheet) {
                CreateScheduleSheet(
                    store: store,
                    selectedKind: $selectedKind,
                    selectedFrequency: $selectedFrequency,
                    titleText: $titleText,
                    promptText: $promptText,
                    dailyTime: $dailyTime,
                    oneTimeFireAt: $oneTimeFireAt,
                    onCancel: {
                        store.clearError()
                        isShowingCreateSheet = false
                    },
                    onCreated: {
                        titleText = ""
                        promptText = ""
                        if oneTimeFireAt <= Date().addingTimeInterval(60) {
                            oneTimeFireAt = Date().addingTimeInterval(3600)
                        }
                        isShowingCreateSheet = false
                    }
                )
            }
        }
    }

    @ViewBuilder
    private var primaryContent: some View {
        if store.isLoading && store.schedules.isEmpty {
            LoadingPlaceholder(title: "placeholder.loading")
                .accessibilityIdentifier("schedules-loading")
        } else if let error = store.errorMessage, store.schedules.isEmpty {
            ErrorPlaceholder(
                title: LocalizedStringKey(
                    String(localized: "schedules.error.title", table: "Conversation")
                ),
                message: LocalizedStringKey(error),
                retryTitle: LocalizedStringKey("placeholder.retry")
            ) {
                Task { await store.refresh() }
            }
            .accessibilityIdentifier("schedules-error-placeholder")
        } else if store.schedules.isEmpty {
            VStack(spacing: EmberDesignTokens.standardSpacing) {
                EmptyPlaceholder(
                    title: LocalizedStringKey(
                        String(localized: "schedules.empty.title", table: "Conversation")
                    ),
                    message: LocalizedStringKey(
                        String(localized: "schedules.empty.message", table: "Conversation")
                    ),
                    systemImage: "calendar.badge.clock"
                )
                .accessibilityIdentifier("schedules-empty")

                Button {
                    openCreateSheet()
                } label: {
                    Label {
                        Text("schedules.add.action", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    } icon: {
                        Image(systemName: "plus")
                    }
                    .foregroundStyle(EmberDesignTokens.primaryActionForeground)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(EmberDesignTokens.primaryActionFill)
                .accessibilityIdentifier("schedules-empty-add-button")
            }
        } else {
            VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                if !activeSchedules.isEmpty {
                    scheduleSection(
                        titleKey: "schedules.section.active",
                        schedules: activeSchedules,
                        identifier: "schedules-section-active"
                    )
                }
                if !pausedSchedules.isEmpty {
                    scheduleSection(
                        titleKey: "schedules.section.paused",
                        schedules: pausedSchedules,
                        identifier: "schedules-section-paused"
                    )
                }
                if !historySchedules.isEmpty {
                    scheduleSection(
                        titleKey: "schedules.section.history",
                        schedules: historySchedules,
                        identifier: "schedules-section-history"
                    )
                }
            }
        }
    }

    private func openCreateSheet() {
        store.clearError()
        if oneTimeFireAt <= Date().addingTimeInterval(30) {
            oneTimeFireAt = Date().addingTimeInterval(3600)
        }
        isShowingCreateSheet = true
    }

    private func scheduleSection(
        titleKey: String.LocalizationValue,
        schedules: [ProactiveScheduleDTO],
        identifier: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(String(localized: titleKey, table: "Conversation"))
                .font(.headline)

            ForEach(schedules) { schedule in
                scheduleRow(schedule)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func scheduleRow(_ schedule: ProactiveScheduleDTO) -> some View {
        let isMutating = store.mutatingIDs.contains(schedule.scheduleId)
        let idSuffix = schedule.scheduleId.uuidString.lowercased()
        let badge = Self.effectiveBadge(for: schedule)
        let cadence = Self.formattedCadence(for: schedule)
        let canCancel = Self.canCancelSchedule(schedule)
        let hasChatLink = schedule.latestRun?.resultMessageId != nil && onOpenChat != nil
        let showsActions = schedule.status == .active || schedule.status == .paused || canCancel || hasChatLink

        return VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) {
                    kindHeaderLabel(schedule.kind)
                    statusBadgePill(badge, idSuffix: idSuffix)
                    Spacer(minLength: 8)
                    if let cadence {
                        cadenceLabel(cadence, idSuffix: idSuffix)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        kindHeaderLabel(schedule.kind)
                        statusBadgePill(badge, idSuffix: idSuffix)
                    }
                    if let cadence {
                        cadenceLabel(cadence, idSuffix: idSuffix)
                    }
                }
            }

            Text(schedule.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            Text(schedule.prompt)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            if let nextFireAt = schedule.nextFireAt,
               let date = ConversationCardFormatting.date(from: nextFireAt) {
                let formattedDate = Self.formatNextFireAt(date, timezoneID: schedule.timezone)
                let showsTZ = Self.shouldDisplayTimezone(schedule.timezone)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "clock")
                        .font(.caption2)
                        .accessibilityHidden(true)
                    Text(
                        showsTZ
                            ? "\(String(localized: "schedules.next_run", table: "Conversation")) \(formattedDate) (\(schedule.timezone))"
                            : "\(String(localized: "schedules.next_run", table: "Conversation")) \(formattedDate)"
                    )
                    .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityLabel(
                    Text(verbatim: "\(String(localized: "schedules.next_run", table: "Conversation")) \(formattedDate), \(schedule.timezone)")
                )
            }

            if let latestRun = schedule.latestRun {
                latestRunView(latestRun, for: schedule, idSuffix: idSuffix)
            }

            if showsActions {
                actionRow(
                    for: schedule,
                    idSuffix: idSuffix,
                    isMutating: isMutating,
                    canCancel: canCancel,
                    hasChatLink: hasChatLink
                )
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .emberCardSurface(cornerRadius: 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-item-\(idSuffix)")
    }

    private func kindHeaderLabel(_ kind: ProactiveScheduleKind) -> some View {
        Label {
            Text(kindLabel(kind), tableName: "Conversation")
                .font(.caption.weight(.semibold))
        } icon: {
            Image(systemName: Self.kindSymbol(for: kind))
                .font(.caption)
        }
        .foregroundStyle(.secondary)
    }

    private func statusBadgePill(_ badge: ProactiveScheduleEffectiveBadge, idSuffix: String) -> some View {
        Text(String(localized: badge.titleKey, table: "Conversation"))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(badge.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(badge.color.opacity(0.12), in: Capsule())
            .accessibilityIdentifier("schedule-status-\(idSuffix)")
    }

    private func cadenceLabel(_ cadence: String, idSuffix: String) -> some View {
        Text(cadence)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("schedule-cadence-\(idSuffix)")
    }

    @ViewBuilder
    private func latestRunView(
        _ latestRun: ProactiveScheduleRunDTO,
        for schedule: ProactiveScheduleDTO,
        idSuffix: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            switch latestRun.status {
            case "queued", "running":
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text(
                        latestRun.status == "queued"
                            ? String(localized: "schedules.run.queued", table: "Conversation")
                            : String(localized: "schedules.run.running", table: "Conversation")
                    )
                    .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(Color(uiColor: .systemIndigo))
                .accessibilityIdentifier("schedule-run-in-flight-\(idSuffix)")

            case "waiting_approval":
                HStack(spacing: 5) {
                    Image(systemName: "hand.raised")
                        .font(.caption2)
                        .accessibilityHidden(true)
                    Text("schedules.run.waiting_approval", tableName: "Conversation")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(Color(uiColor: .systemOrange))
                .accessibilityIdentifier("schedule-run-waiting-approval-\(idSuffix)")

            case "failed", "retryable_failed":
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.caption2)
                            .accessibilityHidden(true)
                        Text("schedules.last_run_failed", tableName: "Conversation")
                        if let completedAt = latestRun.completedAt,
                           let completedDate = ConversationCardFormatting.date(from: completedAt) {
                            Text("·")
                            Text(Self.formatNextFireAt(completedDate, timezoneID: schedule.timezone))
                        }
                    }
                    if let failureDetail = Self.localizedFailureReason(for: latestRun.reasonCode) {
                        Text(failureDetail)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.caption)
                .foregroundStyle(Color(uiColor: .systemOrange))
                .accessibilityIdentifier("schedule-run-failed-\(idSuffix)")

            case "cancelled":
                HStack(spacing: 5) {
                    Image(systemName: "minus.circle")
                        .font(.caption2)
                        .accessibilityHidden(true)
                    Text("schedules.run.cancelled", tableName: "Conversation")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("schedule-run-cancelled-\(idSuffix)")

            default:
                if let completedAt = latestRun.completedAt,
                   let completedDate = ConversationCardFormatting.date(from: completedAt) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle")
                            .font(.caption2)
                            .accessibilityHidden(true)
                        Text("schedules.last_run", tableName: "Conversation")
                        Text(Self.formatNextFireAt(completedDate, timezoneID: schedule.timezone))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            if let resultText = Self.displayResultText(for: schedule, run: latestRun) {
                Text(resultText)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        EmberDesignTokens.surfaceSubtle,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(EmberDesignTokens.surfaceHairline, lineWidth: 1)
                    }
                    .accessibilityIdentifier("schedule-result-\(idSuffix)")
            }
        }
    }

    @ViewBuilder
    private func actionRow(
        for schedule: ProactiveScheduleDTO,
        idSuffix: String,
        isMutating: Bool,
        canCancel: Bool,
        hasChatLink: Bool
    ) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                primaryStatusActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating)
                cancelActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating, canCancel: canCancel)
                openChatActionButton(idSuffix: idSuffix, hasChatLink: hasChatLink)
                if isMutating {
                    ProgressView()
                        .controlSize(.mini)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    primaryStatusActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating)
                    cancelActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating, canCancel: canCancel)
                    if isMutating {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }
                openChatActionButton(idSuffix: idSuffix, hasChatLink: hasChatLink)
            }

            VStack(alignment: .leading, spacing: 8) {
                primaryStatusActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating)
                cancelActionButton(for: schedule, idSuffix: idSuffix, isMutating: isMutating, canCancel: canCancel)
                openChatActionButton(idSuffix: idSuffix, hasChatLink: hasChatLink)
                if isMutating {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
        }
        .padding(.top, 2)
    }

    @ViewBuilder
    private func primaryStatusActionButton(
        for schedule: ProactiveScheduleDTO,
        idSuffix: String,
        isMutating: Bool
    ) -> some View {
        if schedule.status == .active {
            Button {
                Task { await store.pause(id: schedule.scheduleId) }
            } label: {
                Text("schedules.action.pause", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .disabled(isMutating)
            .accessibilityIdentifier("schedule-pause-\(idSuffix)")
        } else if schedule.status == .paused {
            Button {
                Task { await store.resume(id: schedule.scheduleId) }
            } label: {
                Text("schedules.action.resume", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .disabled(isMutating)
            .accessibilityIdentifier("schedule-resume-\(idSuffix)")
        }
    }

    @ViewBuilder
    private func cancelActionButton(
        for schedule: ProactiveScheduleDTO,
        idSuffix: String,
        isMutating: Bool,
        canCancel: Bool
    ) -> some View {
        if canCancel {
            Button(role: .destructive) {
                pendingCancelSchedule = schedule
            } label: {
                Text("schedules.action.cancel", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.bordered)
            .disabled(isMutating)
            .accessibilityIdentifier("schedule-cancel-\(idSuffix)")
        }
    }

    @ViewBuilder
    private func openChatActionButton(idSuffix: String, hasChatLink: Bool) -> some View {
        if hasChatLink, let onOpenChat {
            Button {
                onOpenChat()
            } label: {
                Text("schedules.action.view_in_chat", tableName: "Conversation")
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .accessibilityIdentifier("schedule-open-chat-\(idSuffix)")
        }
    }

    private func kindLabel(_ kind: ProactiveScheduleKind) -> LocalizedStringKey {
        switch kind {
        case .brief: "schedules.kind.brief"
        case .followUp: "schedules.kind.follow_up"
        case .reminder: "schedules.kind.reminder"
        }
    }

    static func kindSymbol(for kind: ProactiveScheduleKind) -> String {
        switch kind {
        case .brief: "sun.horizon"
        case .followUp: "arrow.turn.up.right"
        case .reminder: "bell"
        }
    }

    static func isLatestRunInFlight(_ schedule: ProactiveScheduleDTO) -> Bool {
        guard let status = schedule.latestRun?.status else { return false }
        return status == "queued" || status == "running" || status == "waiting_approval"
    }

    static func canCancelSchedule(_ schedule: ProactiveScheduleDTO) -> Bool {
        if !schedule.status.isTerminal {
            return true
        }
        return schedule.status == .completed && isLatestRunInFlight(schedule)
    }

    static func effectiveBadge(for schedule: ProactiveScheduleDTO) -> ProactiveScheduleEffectiveBadge {
        switch schedule.status {
        case .active:
            return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.active", tone: .active)
        case .paused:
            return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.paused", tone: .warning)
        case .cancelled:
            return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.cancelled", tone: .neutral)
        case .completed:
            switch schedule.latestRun?.status {
            case "queued":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered_queued", tone: .inFlight)
            case "running":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered_running", tone: .inFlight)
            case "waiting_approval":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered_waiting_approval", tone: .warning)
            case "failed", "retryable_failed":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered_failed", tone: .warning)
            case "cancelled":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered_cancelled", tone: .completed)
            case "completed":
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.completed", tone: .completed)
            default:
                return ProactiveScheduleEffectiveBadge(titleKey: "schedules.status.triggered", tone: .completed)
            }
        }
    }

    static func sectionKind(for schedule: ProactiveScheduleDTO) -> ProactiveScheduleSectionKind {
        switch schedule.status {
        case .active:
            return .active
        case .paused:
            return .paused
        case .completed:
            return isLatestRunInFlight(schedule) ? .active : .history
        case .cancelled:
            return .history
        }
    }

    static func groupedSchedules(
        from schedules: [ProactiveScheduleDTO],
        in section: ProactiveScheduleSectionKind
    ) -> [ProactiveScheduleDTO] {
        let filtered = schedules.filter { sectionKind(for: $0) == section }
        guard section == .active else {
            return filtered.sorted { lhs, rhs in
                if lhs.updatedDate != rhs.updatedDate {
                    return lhs.updatedDate > rhs.updatedDate
                }
                return lhs.scheduleId.uuidString < rhs.scheduleId.uuidString
            }
        }
        return filtered.sorted { lhs, rhs in
            let lhsInFlight = isLatestRunInFlight(lhs)
            let rhsInFlight = isLatestRunInFlight(rhs)
            if lhsInFlight != rhsInFlight {
                return lhsInFlight
            }
            let lhsNext = lhs.nextFireAt.flatMap(ConversationCardFormatting.date(from:))
            let rhsNext = rhs.nextFireAt.flatMap(ConversationCardFormatting.date(from:))
            switch (lhsNext, rhsNext) {
            case let (l?, r?) where l != r:
                return l < r
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            default:
                if lhs.updatedDate != rhs.updatedDate {
                    return lhs.updatedDate > rhs.updatedDate
                }
                return lhs.scheduleId.uuidString < rhs.scheduleId.uuidString
            }
        }
    }

    static func shouldDisplayTimezone(_ timezoneID: String, currentTimeZone: TimeZone = .current) -> Bool {
        timezoneID != currentTimeZone.identifier
    }

    static func defaultDeliveryMode(for kind: ProactiveScheduleKind) -> ProactiveDeliveryMode {
        kind == .reminder ? .directReminder : .modelBrief
    }

    static func formatNextFireAt(
        _ date: Date,
        timezoneID: String,
        locale: Locale = .current,
        fallbackTimeZone: TimeZone = .current
    ) -> String {
        let timeZone = TimeZone(identifier: timezoneID) ?? fallbackTimeZone
        return Date.FormatStyle(locale: locale, timeZone: timeZone)
            .month(.abbreviated)
            .day()
            .hour()
            .minute()
            .format(date)
    }

    static func makeCreateRequest(
        kind: ProactiveScheduleKind,
        title: String,
        prompt: String,
        dailyTime: Date,
        oneTimeFireAt: Date,
        frequency: ProactiveScheduleFrequency? = nil,
        timeZone: TimeZone = .current,
        calendar: Calendar = .current
    ) -> CreateProactiveScheduleRequestDTO {
        let tz = timeZone.identifier
        let trigger: ProactiveScheduleTriggerInput
        let deliveryMode = defaultDeliveryMode(for: kind)
        let resolvedFrequency = frequency ?? (kind == .brief ? .daily : .once)

        if kind != .followUp && resolvedFrequency == .daily {
            let comps = calendar.dateComponents([.hour, .minute], from: dailyTime)
            let minute = comps.minute ?? 0
            let hour = comps.hour ?? 8
            trigger = .cron(cronExpr: "\(minute) \(hour) * * *", timezone: tz)
        } else {
            trigger = .once(fireAt: oneTimeFireAt.ISO8601Format())
        }

        return CreateProactiveScheduleRequestDTO(
            kind: kind,
            title: title,
            prompt: prompt,
            trigger: trigger,
            timezone: tz,
            misfirePolicy: .coalesceLatest,
            deliveryMode: deliveryMode
        )
    }

    static func formattedCadence(for schedule: ProactiveScheduleDTO) -> String? {
        if let cron = schedule.cronExpr?.trimmingCharacters(in: .whitespacesAndNewlines), !cron.isEmpty {
            let parts = cron.split(whereSeparator: \.isWhitespace)
            if parts.count == 5,
               let minute = Int(parts[0]),
               let hour = Int(parts[1]),
               (0...59).contains(minute),
               (0...23).contains(hour),
               parts[2] == "*",
               parts[3] == "*",
               parts[4] == "*" {
                let hhmm = String(format: "%02d:%02d", hour, minute)
                return String(localized: "schedules.cadence.daily \(hhmm)", table: "Conversation")
            }
            return cron
        }
        if let interval = schedule.intervalSeconds, interval > 0 {
            if interval >= 3600, interval % 3600 == 0 {
                return String(localized: "schedules.cadence.every_hours \(interval / 3600)", table: "Conversation")
            }
            if interval >= 60 {
                return String(localized: "schedules.cadence.every_minutes \(max(1, interval / 60))", table: "Conversation")
            }
        }
        return nil
    }

    static func nextMorningNineAM(from now: Date = Date(), calendar: Calendar = .current) -> Date {
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now.addingTimeInterval(86_400)
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? now.addingTimeInterval(86_400)
    }

    static func displayResultText(for schedule: ProactiveScheduleDTO, run: ProactiveScheduleRunDTO) -> String? {
        if let detail = run.detailText?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
            return detail
        }
        if let summary = run.summaryText?.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty,
           summary != schedule.title.trimmingCharacters(in: .whitespacesAndNewlines) {
            return summary
        }
        return nil
    }

    static func localizedFailureReason(for reasonCode: String?) -> String? {
        guard let raw = reasonCode?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return String(localized: "schedules.failure.generic", table: "Conversation")
        }
        switch raw {
        case "budget_exceeded", "budget_halted":
            return String(localized: "schedules.failure.budget", table: "Conversation")
        case "model_unauthorized_tenant":
            return String(localized: "schedules.failure.unauthorized", table: "Conversation")
        case "recurring_real_model_unauthorized":
            return String(localized: "schedules.failure.recurring_unauthorized", table: "Conversation")
        case "model_timeout", "TIMEOUT", "lease_expired":
            return String(localized: "schedules.failure.timeout", table: "Conversation")
        case "model_unavailable", "PROVIDER_UNAVAILABLE", "model_gateway_unavailable", "JOB_UNAVAILABLE":
            return String(localized: "schedules.failure.provider_unavailable", table: "Conversation")
        default:
            return "\(String(localized: "schedules.failure.generic", table: "Conversation")) (\(raw))"
        }
    }
}

private struct CreateScheduleSheet: View {
    @Bindable var store: ProactiveScheduleStore
    @Binding var selectedKind: ProactiveScheduleKind
    @Binding var selectedFrequency: ProactiveScheduleFrequency
    @Binding var titleText: String
    @Binding var promptText: String
    @Binding var dailyTime: Date
    @Binding var oneTimeFireAt: Date
    let onCancel: () -> Void
    let onCreated: () -> Void

    @FocusState private var focusedField: ComposerField?

    private enum ComposerField {
        case title
        case prompt
    }

    private var effectiveFrequency: ProactiveScheduleFrequency {
        selectedKind == .followUp ? .once : selectedFrequency
    }

    private var trimmedTitle: String {
        titleText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedPrompt: String {
        promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isOneTimeInPast: Bool {
        effectiveFrequency == .once && oneTimeFireAt <= Date()
    }

    private var canCreate: Bool {
        !trimmedTitle.isEmpty
            && !trimmedPrompt.isEmpty
            && !isOneTimeInPast
            && !store.isCreating
            && !store.isEndpointUnavailable
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    Picker(
                        String(localized: "schedules.kind.label", table: "Conversation"),
                        selection: $selectedKind
                    ) {
                        Text("schedules.kind.brief", tableName: "Conversation")
                            .tag(ProactiveScheduleKind.brief)
                        Text("schedules.kind.follow_up", tableName: "Conversation")
                            .tag(ProactiveScheduleKind.followUp)
                        Text("schedules.kind.reminder", tableName: "Conversation")
                            .tag(ProactiveScheduleKind.reminder)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("schedules-kind-picker")

                    TextField(
                        String(localized: "schedules.composer.title_placeholder", table: "Conversation"),
                        text: $titleText
                    )
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .title)
                    .submitLabel(.next)
                    .onSubmit {
                        focusedField = .prompt
                    }
                    .accessibilityIdentifier("schedules-title-input")

                    TextField(
                        String(localized: "schedules.composer.prompt_placeholder", table: "Conversation"),
                        text: $promptText,
                        axis: .vertical
                    )
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .prompt)
                    .accessibilityIdentifier("schedules-prompt-input")

                    if selectedKind != .followUp {
                        Picker(
                            String(localized: "schedules.frequency.once", table: "Conversation"),
                            selection: $selectedFrequency
                        ) {
                            Text("schedules.frequency.once", tableName: "Conversation")
                                .tag(ProactiveScheduleFrequency.once)
                            Text("schedules.frequency.daily", tableName: "Conversation")
                                .tag(ProactiveScheduleFrequency.daily)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("schedules-frequency-picker")
                    }

                    if effectiveFrequency == .daily {
                        DatePicker(
                            String(localized: "schedules.composer.daily_time", table: "Conversation"),
                            selection: $dailyTime,
                            displayedComponents: .hourAndMinute
                        )
                        .font(.subheadline)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            DatePicker(
                                String(localized: "schedules.composer.fire_at", table: "Conversation"),
                                selection: $oneTimeFireAt,
                                in: Date()...,
                                displayedComponents: [.date, .hourAndMinute]
                            )
                            .font(.subheadline)

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    presetChip(titleKey: "schedules.preset.1m", identifier: "schedules-preset-1m") {
                                        oneTimeFireAt = Date().addingTimeInterval(65)
                                    }
                                    presetChip(titleKey: "schedules.preset.15m", identifier: "schedules-preset-15m") {
                                        oneTimeFireAt = Date().addingTimeInterval(15 * 60)
                                    }
                                    presetChip(titleKey: "schedules.preset.1h", identifier: "schedules-preset-1h") {
                                        oneTimeFireAt = Date().addingTimeInterval(3600)
                                    }
                                    presetChip(
                                        titleKey: "schedules.preset.tomorrow_9am",
                                        identifier: "schedules-preset-tomorrow-9am"
                                    ) {
                                        oneTimeFireAt = ProactiveSchedulesSheetView.nextMorningNineAM()
                                    }
                                }
                            }

                            if isOneTimeInPast {
                                Text("schedules.composer.past_time_hint", tableName: "Conversation")
                                    .font(.caption)
                                    .foregroundStyle(Color(uiColor: .systemOrange))
                                    .accessibilityIdentifier("schedules-past-time-hint")
                            }
                        }
                    }

                    Text(TimeZone.current.identifier)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)

                    if let error = store.errorMessage {
                        ScheduleErrorBanner(message: error, identifier: "schedules-create-error-notice")
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(EmberDesignTokens.surfaceCanvas)
            .navigationTitle(Text("schedules.add.action", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: selectedKind) { _, newKind in
                if newKind == .followUp {
                    selectedFrequency = .once
                }
                if effectiveFrequency == .once && oneTimeFireAt <= Date().addingTimeInterval(30) {
                    oneTimeFireAt = Date().addingTimeInterval(3600)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onCancel) {
                        Text("conversation.live.cancel", tableName: "Conversation")
                    }
                    .accessibilityIdentifier("schedules-create-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        focusedField = nil
                        let request = ProactiveSchedulesSheetView.makeCreateRequest(
                            kind: selectedKind,
                            title: trimmedTitle,
                            prompt: trimmedPrompt,
                            dailyTime: dailyTime,
                            oneTimeFireAt: oneTimeFireAt,
                            frequency: effectiveFrequency
                        )
                        Task {
                            if await store.create(request) {
                                onCreated()
                            }
                        }
                    } label: {
                        if store.isCreating {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("schedules.composer.create", tableName: "Conversation")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!canCreate)
                    .accessibilityIdentifier("schedules-create-button")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onDisappear {
            if !store.isCreating {
                store.clearError()
            }
        }
    }

    private func presetChip(
        titleKey: String.LocalizationValue,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(String(localized: titleKey, table: "Conversation"))
                .font(.caption.weight(.medium))
                .frame(minWidth: 44, minHeight: 44)
                .padding(.horizontal, 4)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier(identifier)
    }
}

private struct ScheduleErrorBanner: View {
    let message: String
    let identifier: String

    var body: some View {
        InlineNotice(
            title: LocalizedStringKey(
                String(localized: "schedules.error.title", table: "Conversation")
            ),
            message: LocalizedStringKey(message),
            tone: .warning
        )
        .accessibilityIdentifier(identifier)
    }
}
