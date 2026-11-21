import SwiftUI

struct ProactiveSchedulesSheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var store: ProactiveScheduleStore
    var onOpenChat: (() -> Void)? = nil

    @State private var selectedKind: ProactiveScheduleKind = .brief
    @State private var titleText = ""
    @State private var promptText = ""
    @State private var dailyTime = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var oneTimeFireAt = Date().addingTimeInterval(3600)
    @State private var pendingCancelSchedule: ProactiveScheduleDTO?

    private var trimmedTitle: String {
        titleText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedPrompt: String {
        promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isOneTimeInPast: Bool {
        selectedKind != .brief && oneTimeFireAt <= Date()
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
                    if store.isMockOnly {
                        MockOnlyBanner()
                    }

                    Text("schedules.subtitle", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

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
                        composerCard
                    }

                    if let error = store.errorMessage {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "schedules.error.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(error),
                            tone: .warning
                        )
                        .accessibilityIdentifier("schedules-error-notice")
                    }

                    if store.isLoading && store.schedules.isEmpty {
                        LoadingPlaceholder(title: "placeholder.loading")
                            .accessibilityIdentifier("schedules-loading")
                    } else if store.schedules.isEmpty && !store.isEndpointUnavailable {
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
                    } else if !store.schedules.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("schedules.list.section_title", tableName: "Conversation")
                                .font(.headline)

                            ForEach(store.schedules) { schedule in
                                scheduleRow(schedule)
                            }
                        }
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background(EmberDesignTokens.groupedBackground)
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
            .onChange(of: selectedKind) { _, newKind in
                if newKind != .brief && oneTimeFireAt <= Date().addingTimeInterval(30) {
                    oneTimeFireAt = Date().addingTimeInterval(3600)
                }
            }
            .toolbar {
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
                    Text("conversation.live.cancel", tableName: "Conversation")
                }
                Button(role: .destructive) {
                    if let target = pendingCancelSchedule {
                        pendingCancelSchedule = nil
                        Task { await store.cancel(id: target.scheduleId) }
                    }
                } label: {
                    Text("schedules.action.cancel", tableName: "Conversation")
                }
            } message: {
                Text("schedules.cancel.confirm_message", tableName: "Conversation")
            }
        }
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
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
            .accessibilityIdentifier("schedules-title-input")

            TextField(
                String(localized: "schedules.composer.prompt_placeholder", table: "Conversation"),
                text: $promptText,
                axis: .vertical
            )
            .lineLimit(2...4)
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("schedules-prompt-input")

            if selectedKind == .brief {
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
                                oneTimeFireAt = Self.nextMorningNineAM()
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

            HStack {
                Text(TimeZone.current.identifier)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    let request = buildCreateRequest()
                    Task {
                        if await store.create(request) {
                            titleText = ""
                            promptText = ""
                            if oneTimeFireAt <= Date().addingTimeInterval(60) {
                                oneTimeFireAt = Date().addingTimeInterval(3600)
                            }
                        }
                    }
                } label: {
                    if store.isCreating {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("schedules.composer.create", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canCreate)
                .accessibilityIdentifier("schedules-create-button")
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
        )
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
        timeZone: TimeZone = .current,
        calendar: Calendar = .current
    ) -> CreateProactiveScheduleRequestDTO {
        let tz = timeZone.identifier
        let trigger: ProactiveScheduleTriggerInput
        let deliveryMode = defaultDeliveryMode(for: kind)

        if kind == .brief {
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

    private func buildCreateRequest() -> CreateProactiveScheduleRequestDTO {
        Self.makeCreateRequest(
            kind: selectedKind,
            title: trimmedTitle,
            prompt: trimmedPrompt,
            dailyTime: dailyTime,
            oneTimeFireAt: oneTimeFireAt
        )
    }

    private func scheduleRow(_ schedule: ProactiveScheduleDTO) -> some View {
        let isMutating = store.mutatingIDs.contains(schedule.scheduleId)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text(kindLabel(schedule.kind), tableName: "Conversation")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())

                Text(statusLabel(schedule.status), tableName: "Conversation")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(statusColor(schedule.status))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(statusColor(schedule.status).opacity(0.12), in: Capsule())

                Spacer(minLength: 8)

                if let cron = schedule.cronExpr {
                    Text(cron)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            Text(schedule.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)

            Text(schedule.prompt)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let nextFireAt = schedule.nextFireAt,
               let date = ConversationCardFormatting.date(from: nextFireAt) {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.caption2)
                    Text("schedules.next_run", tableName: "Conversation")
                    Text(Self.formatNextFireAt(date, timezoneID: schedule.timezone))
                    Text("(\(schedule.timezone))")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if let latestRun = schedule.latestRun {
                if latestRun.status == "queued" || latestRun.status == "running" {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.mini)
                        Text(
                            latestRun.status == "queued"
                                ? String(localized: "schedules.run.queued", table: "Conversation")
                                : String(localized: "schedules.run.running", table: "Conversation")
                        )
                    }
                    .font(.caption)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityIdentifier("schedule-run-in-flight-\(schedule.scheduleId.uuidString.lowercased())")
                } else if latestRun.status == "failed" || latestRun.status == "retryable_failed" {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.caption2)
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
                } else if let completedAt = latestRun.completedAt,
                          let completedDate = ConversationCardFormatting.date(from: completedAt) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle")
                            .font(.caption2)
                        Text("schedules.last_run", tableName: "Conversation")
                        Text(Self.formatNextFireAt(completedDate, timezoneID: schedule.timezone))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if let resultText = Self.displayResultText(for: schedule, run: latestRun) {
                    Text(resultText)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(EmberDesignTokens.groupedBackground, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("schedule-result-\(schedule.scheduleId.uuidString.lowercased())")
                }
            }

            if !schedule.status.isTerminal || (schedule.latestRun?.resultMessageId != nil && onOpenChat != nil) {
                HStack(spacing: 8) {
                    if schedule.status == .active {
                        Button {
                            Task { await store.pause(id: schedule.scheduleId) }
                        } label: {
                            Text("schedules.action.pause", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .disabled(isMutating)
                        .accessibilityIdentifier("schedule-pause-\(schedule.scheduleId.uuidString.lowercased())")
                    } else if schedule.status == .paused {
                        Button {
                            Task { await store.resume(id: schedule.scheduleId) }
                        } label: {
                            Text("schedules.action.resume", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .disabled(isMutating)
                        .accessibilityIdentifier("schedule-resume-\(schedule.scheduleId.uuidString.lowercased())")
                    }

                    if !schedule.status.isTerminal {
                        Button(role: .destructive) {
                            pendingCancelSchedule = schedule
                        } label: {
                            Text("schedules.action.cancel", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .disabled(isMutating)
                        .accessibilityIdentifier("schedule-cancel-\(schedule.scheduleId.uuidString.lowercased())")
                    }

                    if schedule.latestRun?.resultMessageId != nil, let onOpenChat {
                        Button {
                            onOpenChat()
                        } label: {
                            Text("schedules.action.view_in_chat", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("schedule-open-chat-\(schedule.scheduleId.uuidString.lowercased())")
                    }

                    if isMutating {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("schedule-item-\(schedule.scheduleId.uuidString.lowercased())")
    }

    private func kindLabel(_ kind: ProactiveScheduleKind) -> LocalizedStringKey {
        switch kind {
        case .brief: "schedules.kind.brief"
        case .followUp: "schedules.kind.follow_up"
        case .reminder: "schedules.kind.reminder"
        }
    }

    private func statusLabel(_ status: ProactiveScheduleStatus) -> LocalizedStringKey {
        switch status {
        case .active: "schedules.status.active"
        case .paused: "schedules.status.paused"
        case .completed: "schedules.status.completed"
        case .cancelled: "schedules.status.cancelled"
        }
    }

    private func statusColor(_ status: ProactiveScheduleStatus) -> Color {
        switch status {
        case .active: Color(uiColor: .systemGreen)
        case .paused: Color(uiColor: .systemOrange)
        case .completed: Color.secondary
        case .cancelled: Color(uiColor: .systemRed)
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
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityIdentifier(identifier)
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
        case "model_timeout", "TIMEOUT", "lease_expired":
            return String(localized: "schedules.failure.timeout", table: "Conversation")
        case "model_unavailable", "PROVIDER_UNAVAILABLE", "model_gateway_unavailable", "JOB_UNAVAILABLE":
            return String(localized: "schedules.failure.provider_unavailable", table: "Conversation")
        default:
            return "\(String(localized: "schedules.failure.generic", table: "Conversation")) (\(raw))"
        }
    }
}
