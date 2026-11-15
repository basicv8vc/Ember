import SwiftUI

struct TaskInboxView: View {
    private enum Mode {
        case legacyDemo(TaskJourneySession, () -> Void)
        case sessionTasks(SessionTaskStore, (UUID) -> Void)
    }

    private let mode: Mode

    init(session: TaskJourneySession, onSelectTask: @escaping () -> Void) {
        self.mode = .legacyDemo(session, onSelectTask)
    }

    init(store: SessionTaskStore, onOpenTask: @escaping (UUID) -> Void) {
        self.mode = .sessionTasks(store, onOpenTask)
    }

    var body: some View {
        switch mode {
        case .legacyDemo(let session, let onSelectTask):
            LegacyDemoTaskInboxView(session: session, onSelectTask: onSelectTask)
        case .sessionTasks(let store, let onOpenTask):
            SessionTaskInboxContent(store: store, onOpenTask: onOpenTask)
        }
    }
}

private struct SessionTaskInboxContent: View {
    @Bindable var store: SessionTaskStore
    let onOpenTask: (UUID) -> Void

    private var needsIntervention: [SessionTaskDTO] {
        store.tasks(in: .needsIntervention)
    }

    private var inProgress: [SessionTaskDTO] {
        store.tasks(in: .inProgress)
    }

    private var completed: [SessionTaskDTO] {
        store.tasks(in: .completed)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                if store.isMockOnly {
                    MockOnlyBanner()
                }

                if store.isLoadingList && store.orderedTasks.isEmpty {
                    LoadingPlaceholder(title: "placeholder.loading")
                        .accessibilityIdentifier("tasks-loading")
                } else if let error = store.listErrorMessage, store.orderedTasks.isEmpty {
                    ErrorPlaceholder(
                        title: LocalizedStringKey("tasks.error.title"),
                        message: LocalizedStringKey(error),
                        retryTitle: LocalizedStringKey("placeholder.retry")
                    ) {
                        Task { await store.refreshAll() }
                    }
                    .accessibilityIdentifier("tasks-error-state")
                } else {
                    if let error = store.listErrorMessage {
                        InlineNotice(
                            title: LocalizedStringKey("tasks.error.title"),
                            message: LocalizedStringKey(error),
                            tone: .warning
                        )
                    } else if store.listEndpointUnavailable {
                        InlineNotice(
                            title: LocalizedStringKey("tasks.endpoint_unavailable.title"),
                            message: LocalizedStringKey("tasks.endpoint_unavailable.message"),
                            tone: .neutral
                        )
                        .accessibilityIdentifier("tasks-endpoint-unavailable")
                    }

                    if store.orderedTasks.isEmpty && !store.isLoadingList {
                        EmptyPlaceholder(
                            title: LocalizedStringKey("tasks.empty.title"),
                            message: LocalizedStringKey("tasks.empty.message"),
                            systemImage: "checklist"
                        )
                        .accessibilityIdentifier("tasks-empty-state")
                    } else {
                        if !needsIntervention.isEmpty {
                            taskSection(
                                title: SessionTaskStatusGroup.needsIntervention.localizedSectionTitle,
                                tasks: needsIntervention,
                                sectionIdentifier: "tasks-section-needs-intervention"
                            )
                        }
                        if !inProgress.isEmpty {
                            taskSection(
                                title: SessionTaskStatusGroup.inProgress.localizedSectionTitle,
                                tasks: inProgress,
                                sectionIdentifier: "tasks-section-in-progress"
                            )
                        }
                        if !completed.isEmpty {
                            taskSection(
                                title: SessionTaskStatusGroup.completed.localizedSectionTitle,
                                tasks: completed,
                                sectionIdentifier: "tasks-section-completed"
                            )
                        }

                        if let loadMoreError = store.loadMoreErrorMessage {
                            InlineNotice(
                                title: LocalizedStringKey("tasks.error.title"),
                                message: LocalizedStringKey(loadMoreError),
                                tone: .warning
                            )
                        }

                        if store.hasMoreTasks {
                            if let cursor = store.nextTasksCursor, !cursor.isEmpty {
                                VStack(spacing: 8) {
                                    Button {
                                        Task { await store.loadMoreTasks() }
                                    } label: {
                                        HStack(spacing: 8) {
                                            if store.isLoadingMoreTasks {
                                                ProgressView()
                                            }
                                            Text("tasks.action.load_more", tableName: "Conversation")
                                                .font(.subheadline.weight(.semibold))
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(store.isLoadingMoreTasks || store.isLoadingList)
                                    .accessibilityIdentifier("tasks-load-more-button")

                                    Text("tasks.pagination.more_available", tableName: "Conversation")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .multilineTextAlignment(.center)
                                }
                                .padding(.top, 4)
                            } else {
                                InlineNotice(
                                    title: LocalizedStringKey("tasks.pagination.partial_title"),
                                    message: LocalizedStringKey("tasks.pagination.partial_message"),
                                    tone: .neutral
                                )
                                .accessibilityIdentifier("tasks-partial-notice")
                            }
                        }
                    }
                }
            }
            .padding(EmberDesignTokens.standardSpacing)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(EmberDesignTokens.groupedBackground)
        .navigationTitle(Text("tab.tasks", tableName: "Conversation"))
        .navigationBarTitleDisplayMode(.large)
        .accessibilityIdentifier("tasks-inbox-screen")
        .refreshable {
            await store.refreshAll()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refreshAll() }
                } label: {
                    if store.isLoadingList {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .accessibilityLabel(Text("tasks.action.refresh", tableName: "Conversation"))
                    }
                }
                .disabled(store.isLoadingList)
                .accessibilityIdentifier("tasks-refresh-button")
            }
        }
    }

    private func taskSection(
        title: String,
        tasks: [SessionTaskDTO],
        sectionIdentifier: String
    ) -> some View {
        VStack(alignment: .leading, spacing: EmberDesignTokens.compactSpacing + 2) {
            HStack {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()
                Text(tasks.count, format: .number)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)

            ForEach(tasks) { task in
                SessionTaskInboxRow(
                    task: task,
                    hasResult: store.resultsByTaskID[task.taskID]?.resultState == .available
                        || task.resultState == .available,
                    isMockOnly: store.isMock(task, result: store.resultsByTaskID[task.taskID]),
                    onTap: { onOpenTask(task.taskID) }
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(sectionIdentifier)
    }
}

private struct SessionTaskInboxRow: View {
    let task: SessionTaskDTO
    let hasResult: Bool
    let isMockOnly: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(task.kind.localizedDisplayTitle)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            if isMockOnly {
                                ConversationMockTag()
                            }
                        }

                        Text(task.displayTitle)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                        .accessibilityHidden(true)
                }

                HStack(spacing: 8) {
                    TaskStatusBadge(status: task.status)
                    Spacer(minLength: 0)
                    if hasResult {
                        Label {
                            Text("tasks.row.result_ready", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "doc.text")
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color(uiColor: .systemGreen))
                    } else if task.cancelRequested && !task.status.isTerminal {
                        Text("card.cancel_pending", tableName: "ConversationCards")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let updatedAt = ConversationCardFormatting.date(from: task.updatedAt) {
                        Text(updatedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(EmberDesignTokens.standardSpacing)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                EmberDesignTokens.cardBackground,
                in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
            )
            .contentShape(RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks-row-\(task.taskID.uuidString.lowercased())")
    }
}

private struct LegacyDemoTaskInboxView: View {
    @Bindable var session: TaskJourneySession
    let onSelectTask: () -> Void

    private var sessionRecords: [TaskJourneyRecord] {
        session.records.filter { $0.origin == .createdInThisSession }
    }

    private var fixtureRecords: [TaskJourneyRecord] {
        session.records.filter {
            if case .fixture = $0.origin { return true }
            return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                if let startupError = session.startupError {
                    contentNotice(title: "演示未就绪", message: startupError, symbol: "exclamationmark.triangle")
                } else {
                    inboxState
                }

                fixtureSection
                demoStateControls
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("我的承诺")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("显示空历史", systemImage: "tray") { session.showInboxMode(.noHistory) }
                    Button("显示需要登录状态", systemImage: "person.crop.circle.badge.exclamationmark") {
                        session.showInboxMode(.unauthorized)
                    }
                    Button("显示任务不可见状态", systemImage: "questionmark.folder") {
                        session.showInboxMode(.notFound)
                    }
                    Button("显示离线状态", systemImage: "wifi.slash") { session.showInboxMode(.offline) }
                    Button("返回演示列表", systemImage: "arrow.uturn.backward") {
                        session.showInboxMode(.localSession)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .accessibilityLabel("更多演示状态")
                }
                .accessibilityIdentifier("inbox-demo-states-menu")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("本次演示会话")
                .font(.title2.weight(.semibold))
            Text("任务只保存在本机内存中，不会同步到云端或其他设备。下方是互不关联的固定演示样例。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var inboxState: some View {
        switch session.inboxMode {
        case .localSession:
            if sessionRecords.isEmpty {
                contentNotice(
                    title: "本次会话还没有新任务",
                    message: "可以从“新任务”提交笔记，或查看下方独立的演示样例。",
                    symbol: "tray"
                )
                .accessibilityIdentifier("inbox-empty-state")
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("本机会话任务")
                        .font(.headline)
                    ForEach(sessionRecords) { record in
                        taskRow(record, sourceLabel: "本机模拟 · 本次会话")
                    }
                }
            }
        case .noHistory:
            contentNotice(
                title: "没有可恢复的历史任务",
                message: "本机演示没有云端历史记录或持久化记录。返回后可查看固定样例。",
                symbol: "tray"
            )
            .accessibilityIdentifier("inbox-empty-state")
        case .unauthorized:
            contentNotice(
                title: "此状态需要登录",
                message: "这里只展示提示样式，没有发出登录或认证请求。",
                symbol: "person.crop.circle.badge.exclamationmark"
            )
            .accessibilityIdentifier("inbox-401-state")
        case .notFound:
            contentNotice(
                title: "任务不可见或不存在",
                message: "没有权限查看或无此任务时，只会说明不可见，不提供可猜测的信息。",
                symbol: "questionmark.folder"
            )
            .accessibilityIdentifier("inbox-404-state")
        case .offline:
            contentNotice(
                title: "网络不可用",
                message: "演示的离线提示，没有发起真实网络请求。当前只能查看内存里的固定样例。",
                symbol: "wifi.slash"
            )
            .accessibilityIdentifier("inbox-offline-state")
        }
    }

    private var fixtureSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("固定演示样例")
                .font(.headline)
            ForEach(fixtureRecords) { record in
                taskRow(record, sourceLabel: "固定样例 · 不代表真实处理结果")
            }
        }
    }

    private var demoStateControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("其他状态示例")
                .font(.headline)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { stateButtons }
                VStack(alignment: .leading, spacing: 8) { stateButtons }
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder
    private var stateButtons: some View {
        Button("空历史") { session.showInboxMode(.noHistory) }
            .buttonStyle(.bordered)
        Button("需要登录") { session.showInboxMode(.unauthorized) }
            .buttonStyle(.bordered)
        Button("任务不可见") { session.showInboxMode(.notFound) }
            .buttonStyle(.bordered)
        Button("离线") { session.showInboxMode(.offline) }
            .buttonStyle(.bordered)
    }

    private func taskRow(_ record: TaskJourneyRecord, sourceLabel: String) -> some View {
        Button {
            session.select(taskID: record.id)
            onSelectTask()
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol(for: record.task.status))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(color(for: record.task.status))
                    .frame(width: 30, height: 32)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text(record.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Text(TaskJourneySession.statusTitle(record.task.status))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(sourceLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 5)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 15))
            .contentShape(RoundedRectangle(cornerRadius: 15))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("inbox-task-\(record.id.uuidString)")
        .accessibilityHint("查看任务详情")
    }

    private func contentNotice(title: String, message: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if session.inboxMode != .localSession {
                Button("返回演示列表") { session.showInboxMode(.localSession) }
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private func symbol(for status: TaskStatus) -> String {
        switch status {
        case .queued: "tray.and.arrow.down"
        case .running: "arrow.trianglehead.2.clockwise.rotate.90"
        case .waitingApproval: "hand.raised"
        case .retryableFailed: "clock.badge.exclamationmark"
        case .completed: "checkmark.circle"
        case .failed: "xmark.circle"
        case .cancelled: "stop.circle"
        }
    }

    private func color(for status: TaskStatus) -> Color {
        switch status {
        case .queued, .running: .blue
        case .waitingApproval: .orange
        case .retryableFailed: .orange
        case .completed: .green
        case .failed, .cancelled: .secondary
        }
    }
}
