import SwiftUI
import UIKit

struct TaskDetailView: View {
    private enum Mode {
        case legacyDemo(TaskJourneySession)
        case sessionTask(UUID, SessionTaskStore)
    }

    private let mode: Mode

    init(session: TaskJourneySession) {
        self.mode = .legacyDemo(session)
    }

    init(taskID: UUID, store: SessionTaskStore) {
        self.mode = .sessionTask(taskID, store)
    }

    var body: some View {
        switch mode {
        case .legacyDemo(let session):
            LegacyDemoTaskDetailView(session: session)
        case .sessionTask(let taskID, let store):
            SessionTaskDetailContent(taskID: taskID, store: store)
        }
    }
}

private struct ArtifactPreviewPayload: Identifiable {
    let id: UUID
    let filename: String
    let text: String
}

private struct SessionTaskDetailContent: View {
    let taskID: UUID
    @Bindable var store: SessionTaskStore

    @State private var copiedResultAlert = false
    @State private var previewPayload: ArtifactPreviewPayload?

    private var task: SessionTaskDTO? {
        store.tasksByID[taskID]
    }

    private var events: [SessionTaskEventDTO] {
        store.eventsByTaskID[taskID] ?? []
    }

    private var result: SessionTaskResultDTO? {
        store.resultsByTaskID[taskID]
    }

    private var cancelResponse: TaskCancelDTO? {
        store.cancelResponseByTaskID[taskID]
    }

    private var isLoading: Bool {
        store.loadingDetailTaskIDs.contains(taskID)
    }

    private var isCancelling: Bool {
        store.cancellingTaskIDs.contains(taskID)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                if store.isMock(task, result: result) {
                    MockOnlyBanner()
                }

                if let task {
                    summaryCard(task)
                    interventionCardIfNeeded(task)
                    cancelSectionIfNeeded(task)
                    activitySection
                    resultSection(for: task)
                    artifactsSectionIfNeeded
                } else if isLoading {
                    LoadingPlaceholder(title: "placeholder.loading")
                } else if store.missingTaskIDs.contains(taskID) {
                    EmptyPlaceholder(
                        title: LocalizedStringKey("tasks.detail.not_found_title"),
                        message: LocalizedStringKey("tasks.detail.not_found_message"),
                        systemImage: "questionmark.folder"
                    )
                    .accessibilityIdentifier("task-detail-not-found")
                } else {
                    ErrorPlaceholder(
                        title: LocalizedStringKey("tasks.error.title"),
                        message: LocalizedStringKey(
                            store.detailErrorByTaskID[taskID] ?? String(localized: "tasks.error.detail_load", table: "Conversation")
                        ),
                        retryTitle: LocalizedStringKey("placeholder.retry")
                    ) {
                        Task { await store.loadDetail(taskID: taskID) }
                    }
                    .accessibilityIdentifier("task-detail-error")
                }
            }
            .padding(EmberDesignTokens.standardSpacing)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(EmberDesignTokens.groupedBackground)
        .navigationTitle(Text("tasks.detail.nav_title", tableName: "Conversation"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.loadDetail(taskID: taskID)
        }
        .task(id: taskID) {
            await store.loadDetail(taskID: taskID)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.loadDetail(taskID: taskID) }
                } label: {
                    if isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .accessibilityLabel(Text("tasks.action.refresh", tableName: "Conversation"))
                    }
                }
                .disabled(isLoading)
                .accessibilityIdentifier("task-detail-refresh")
            }
        }
        .alert(
            Text("tasks.detail.copied_title", tableName: "Conversation"),
            isPresented: $copiedResultAlert
        ) {
            Button(role: .cancel) {} label: {
                Text("tasks.detail.ok", tableName: "Conversation")
            }
        }
        .sheet(item: $previewPayload) { payload in
            NavigationStack {
                ScrollView([.vertical, .horizontal]) {
                    Text(payload.text)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .padding(EmberDesignTokens.standardSpacing)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(EmberDesignTokens.groupedBackground)
                .navigationTitle(payload.filename)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            previewPayload = nil
                        } label: {
                            Text("tasks.detail.close", tableName: "Conversation")
                        }
                    }
                    if let fileURL = store.downloadedArtifactFileByID[payload.id] {
                        ToolbarItem(placement: .topBarTrailing) {
                            ShareLink(item: fileURL) {
                                Image(systemName: "square.and.arrow.up")
                                    .accessibilityLabel(Text("tasks.artifacts.export", tableName: "Conversation"))
                            }
                        }
                    }
                }
            }
        }
    }

    private func summaryCard(_ task: SessionTaskDTO) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.kind.localizedDisplayTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(task.displayTitle)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                TaskStatusBadge(status: task.status)
            }

            Text("tasks.detail.server_truth_note", tableName: "Conversation")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let detailError = store.detailErrorByTaskID[taskID] {
                InlineNotice(
                    title: LocalizedStringKey("tasks.error.title"),
                    message: LocalizedStringKey(detailError),
                    tone: .warning
                )
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                if let updatedAt = ConversationCardFormatting.date(from: task.updatedAt) {
                    LabeledContent {
                        Text(updatedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                    } label: {
                        Text("tasks.detail.updated_at", tableName: "Conversation")
                    }
                    .font(.footnote)
                }
                if let createdAt = ConversationCardFormatting.date(from: task.createdAt) {
                    LabeledContent {
                        Text(createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                    } label: {
                        Text("tasks.detail.created_at", tableName: "Conversation")
                    }
                    .font(.footnote)
                }
                LabeledContent {
                    Text(task.attemptCount, format: .number)
                } label: {
                    Text("tasks.detail.attempts", tableName: "Conversation")
                }
                .font(.footnote)

                LabeledContent {
                    Text(task.taskID.uuidString.lowercased())
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                } label: {
                    Text("tasks.detail.task_id", tableName: "Conversation")
                }
                .font(.footnote)
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task-detail-summary")
    }

    @ViewBuilder
    private func interventionCardIfNeeded(_ task: SessionTaskDTO) -> some View {
        if task.status == .waitingApproval {
            InlineNotice(
                title: LocalizedStringKey("tasks.detail.waiting_approval_title"),
                message: LocalizedStringKey("tasks.detail.waiting_approval_message"),
                tone: .warning
            )
            .accessibilityIdentifier("task-detail-waiting-approval")
        } else if task.status == .retryableFailed {
            InlineNotice(
                title: LocalizedStringKey("tasks.detail.retry_scheduled_title"),
                message: LocalizedStringKey("tasks.detail.retry_scheduled_message"),
                tone: .warning
            )
            .accessibilityIdentifier("task-detail-retry-scheduled")
        }
    }

    @ViewBuilder
    private func cancelSectionIfNeeded(_ task: SessionTaskDTO) -> some View {
        if !task.status.isTerminal {
            VStack(alignment: .leading, spacing: 10) {
                Label {
                    Text("tasks.detail.cancel_section_title", tableName: "Conversation")
                } icon: {
                    Image(systemName: "arrow.uturn.backward.circle")
                }
                .font(.headline)

                if let cancelError = store.cancelErrorByTaskID[taskID] {
                    Text(cancelError)
                        .font(.subheadline)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("task-cancel-status")
                } else if (cancelResponse?.cancelRequested == true && cancelResponse?.terminal == false) || task.cancelRequested {
                    Text("card.cancel_pending", tableName: "ConversationCards")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("task-cancel-status")
                } else {
                    Text("tasks.detail.cancel_honest_note", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(role: .destructive) {
                    Task { await store.cancelTask(taskID: taskID) }
                } label: {
                    if isCancelling {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label {
                            Text("tasks.detail.cancel_button", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "stop.circle")
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .disabled(isCancelling || task.cancelRequested)
                .accessibilityIdentifier("task-cancel")
            }
            .padding(EmberDesignTokens.standardSpacing)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                EmberDesignTokens.cardBackground,
                in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
            )
        }
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("tasks.detail.activity_title", tableName: "Conversation")
                .font(.headline)

            if events.isEmpty {
                Text(
                    store.eventsUnavailableTaskIDs.contains(taskID)
                        ? "tasks.detail.activity_unavailable"
                        : "tasks.detail.activity_empty",
                    tableName: "Conversation"
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            } else {
                ConversationCardRenderer.ActivityEvents(
                    events: events.map { $0.asTaskEventDTO() }
                )
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task-detail-timeline")
    }

    private func resultSection(for task: SessionTaskDTO) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("tasks.detail.result_section_title", tableName: "Conversation")
                .font(.headline)

            if !task.status.isTerminal {
                InlineNotice(
                    title: LocalizedStringKey("tasks.detail.result_pending_title"),
                    message: LocalizedStringKey("tasks.detail.result_pending_message"),
                    tone: .neutral
                )
                .accessibilityIdentifier("task-outcome-pending")
            } else if let resultError = store.resultErrorByTaskID[taskID], result == nil {
                ErrorPlaceholder(
                    title: LocalizedStringKey("tasks.error.title"),
                    message: LocalizedStringKey(resultError),
                    retryTitle: LocalizedStringKey("placeholder.retry")
                ) {
                    Task { await store.loadDetail(taskID: taskID) }
                }
            } else {
                let payload = result?.resultState == .available ? result?.result : nil
                let summary: String? = payload.flatMap { textResult in
                    if let detail = textResult.detailText, OutcomeCard.hasReadableContent(detail) {
                        return textResult.summaryText
                    }
                    return nil
                }
                let readable: String? = payload.map { textResult in
                    if let detail = textResult.detailText, OutcomeCard.hasReadableContent(detail) {
                        return detail
                    }
                    return textResult.summaryText
                }

                OutcomeCard(
                    title: task.displayTitle,
                    summary: summary,
                    readableContent: readable,
                    isMockOnly: store.isMock(task, result: result),
                    onCopy: readable.map { content in
                        {
                            UIPasteboard.general.string = content
                            copiedResultAlert = true
                        }
                    }
                )

                if let payload {
                    HStack(spacing: 12) {
                        Label(payload.modelLabel, systemImage: "cpu")
                        if let producedAt = ConversationCardFormatting.date(from: payload.producedAt) {
                            Text(producedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task-detail-outcome")
    }

    @ViewBuilder
    private var artifactsSectionIfNeeded: some View {
        let artifacts = store.artifactsByTaskID[taskID] ?? []
        let isLoadingArtifacts = store.loadingArtifactsTaskIDs.contains(taskID)
        let listError = store.artifactListErrorByTaskID[taskID]

        if !artifacts.isEmpty || isLoadingArtifacts || listError != nil {
            VStack(alignment: .leading, spacing: 12) {
                Text("tasks.artifacts.section_title", tableName: "Conversation")
                    .font(.headline)

                if isLoadingArtifacts && artifacts.isEmpty {
                    ProgressView()
                } else if let listError, artifacts.isEmpty {
                    ErrorPlaceholder(
                        title: LocalizedStringKey("tasks.error.title"),
                        message: LocalizedStringKey(listError),
                        retryTitle: LocalizedStringKey("placeholder.retry")
                    ) {
                        Task { await store.loadDetail(taskID: taskID) }
                    }
                } else {
                    ForEach(artifacts) { item in
                        artifactRow(item)
                    }
                }
            }
            .padding(EmberDesignTokens.standardSpacing)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                EmberDesignTokens.cardBackground,
                in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("task-detail-artifacts")
        }
    }

    private func artifactRow(_ item: TaskArtifactItemDTO) -> some View {
        let isDownloading = store.downloadingArtifactIDs.contains(item.artifactID)
        let downloadedURL = store.downloadedArtifactFileByID[item.artifactID]
        let previewText = store.downloadedArtifactPreviewByID[item.artifactID]
        let downloadError = store.artifactDownloadErrorByID[item.artifactID]

        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: item.createdBy == .user ? "doc.text" : "doc.badge.gearshape")
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.displayFilename)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        Text(
                            item.createdBy == .user
                                ? "tasks.artifacts.source_user"
                                : "tasks.artifacts.source_run",
                            tableName: "Conversation"
                        )
                        Text("·")
                        Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)
            }

            if let downloadedURL {
                HStack(spacing: 8) {
                    if let previewText {
                        Button {
                            previewPayload = ArtifactPreviewPayload(
                                id: item.artifactID,
                                filename: item.displayFilename,
                                text: previewText
                            )
                        } label: {
                            Label {
                                Text("tasks.artifacts.preview", tableName: "Conversation")
                            } icon: {
                                Image(systemName: "eye")
                            }
                        }
                        .buttonStyle(.bordered)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("task-artifact-preview-\(item.artifactID.uuidString.lowercased())")
                    }

                    ShareLink(item: downloadedURL) {
                        Label {
                            Text("tasks.artifacts.export", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("task-artifact-export-\(item.artifactID.uuidString.lowercased())")
                }
            } else {
                Button {
                    Task { await store.downloadArtifact(item) }
                } label: {
                    if isDownloading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label {
                            Text("tasks.artifacts.download", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "arrow.down.circle")
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .disabled(isDownloading)
                .accessibilityIdentifier("task-artifact-download-\(item.artifactID.uuidString.lowercased())")
            }

            if let downloadError {
                Text(downloadError)
                    .font(.caption)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(EmberDesignTokens.groupedBackground, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct LegacyDemoTaskDetailView: View {
    @Bindable var session: TaskJourneySession
    @State private var copiedOutcome = false

    var body: some View {
        ScrollView {
            if let record = session.selectedRecord {
                VStack(alignment: .leading, spacing: 16) {
                    taskSummary(record)
                    connectionCard(record)
                    timeline(record)
                    approvalCard(record)
                    outcomeCard(record)
                    commandCard(record)
                }
                .padding(20)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            } else {
                ContentUnavailableView(
                    "还没有选中的任务",
                    systemImage: "tray",
                    description: Text("从“我的承诺”选择一项任务。")
                )
                .padding(24)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("任务详情")
        .navigationBarTitleDisplayMode(.inline)
        .alert("样例已复制", isPresented: $copiedOutcome) {
            Button("好", role: .cancel) {}
        } message: {
            Text("复制的是预先准备的演示样例，并非根据本次提交的笔记生成。")
        }
    }

    private func taskSummary(_ record: TaskJourneyRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: statusSymbol(record.task.status))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(statusColor(record.task.status))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(record.title)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(TaskJourneySession.statusTitle(record.task.status))
                        .font(.headline)
                }
            }

            Text("任务状态来自本机演示数据；连接状态和取消请求分别显示。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledContent("创建时间", value: record.task.createdAt)
            LabeledContent("任务编号", value: record.task.taskID.uuidString)
                .font(.caption.monospaced())
                .textSelection(.enabled)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityIdentifier("task-detail-summary")
    }

    private func connectionCard(_ record: TaskJourneyRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("连接状态 · \(connectionTitle(record.presentation.connectionPhase))", systemImage: connectionSymbol(record.presentation.connectionPhase))
                .font(.headline)
            Text(connectionMessage(record))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { connectionButtons(for: record) }
                VStack(alignment: .leading, spacing: 8) { connectionButtons(for: record) }
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder
    private func connectionButtons(for record: TaskJourneyRecord) -> some View {
        Button("断开演示连接") {
            session.setConnectionPhase(.disconnected, taskID: record.id)
        }
        .buttonStyle(.bordered)
        Button("开始重连") {
            session.setConnectionPhase(.connecting, taskID: record.id)
        }
        .buttonStyle(.bordered)
        Button("完成重连并刷新") {
            Task {
                session.setConnectionPhase(.connecting, taskID: record.id)
                do {
                    try await session.refresh(taskID: record.id)
                    session.setConnectionPhase(.connected, taskID: record.id)
                } catch {
                    session.setConnectionPhase(.disconnected, taskID: record.id)
                }
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(session.cancellingTaskID == record.id)
    }

    private func timeline(_ record: TaskJourneyRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("活动时间线")
                .font(.headline)
            if record.events.isEmpty {
                Text("暂无活动记录。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(record.events, id: \.sequence) { event in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "circle.inset.filled")
                            .font(.caption)
                            .foregroundStyle(.tint)
                            .padding(.top, 4)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(eventTitle(event.phase))
                                .font(.subheadline.weight(.semibold))
                            Text(event.occurredAt)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            if event.payload.simulated == true {
                                Text("固定演示记录")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityIdentifier("task-detail-timeline")
    }

    @ViewBuilder
    private func approvalCard(_ record: TaskJourneyRecord) -> some View {
        if record.task.status == .waitingApproval {
            VStack(alignment: .leading, spacing: 10) {
                Label("等待审批", systemImage: "hand.raised")
                    .font(.headline)
                Text("这条示例没有提供可供审核的操作详情，因此无法进行确认。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("批准") {}
                    .buttonStyle(.borderedProminent)
                    .disabled(true)
                    .accessibilityIdentifier("approval-disabled")
                Text("本机演示不会发送批准或拒绝请求。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        }
    }

    @ViewBuilder
    private func outcomeCard(_ record: TaskJourneyRecord) -> some View {
        if record.task.status == .completed {
            VStack(alignment: .leading, spacing: 12) {
                Label("结果 · 固定演示样例", systemImage: "doc.text")
                    .font(.headline)

                if let outcome = record.outcomeFixture {
                    Text(outcome.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(outcome.content)
                        .font(.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 12))

                    HStack(spacing: 10) {
                        Button {
                            UIPasteboard.general.string = outcome.content
                            copiedOutcome = true
                        } label: {
                            Label("复制样例", systemImage: "doc.on.doc")
                        }
                        .buttonStyle(.bordered)
                        ShareLink(item: outcome.content) {
                            Label("分享样例", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.bordered)
                    }
                } else {
                    Text("此示例显示任务已完成，但没有可查看的结果。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("task-outcome-missing")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
            .accessibilityIdentifier("task-detail-outcome")
        }
    }

    private func commandCard(_ record: TaskJourneyRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("取消任务", systemImage: "arrow.uturn.backward.circle")
                .font(.headline)
            if let message = session.cancelMessageByTaskID[record.id] {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("task-cancel-status")
            } else {
                Text("收到取消请求不代表任务已取消；任务仍在等待或处理中时，会继续显示当前状态。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if record.task.status == .queued || record.task.status == .running || record.task.status == .retryableFailed {
                Button {
                    Task { await session.cancel(taskID: record.id) }
                } label: {
                    if session.cancellingTaskID == record.id {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("模拟取消任务", systemImage: "stop.circle")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .disabled(session.cancellingTaskID == record.id)
                .accessibilityIdentifier("task-cancel")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private func connectionTitle(_ phase: ConnectionPhase) -> String {
        switch phase {
        case .idle: "未连接"
        case .connecting: "重新连接中"
        case .connected: "已连接"
        case .disconnected: "已断开"
        }
    }

    private func connectionSymbol(_ phase: ConnectionPhase) -> String {
        switch phase {
        case .idle: "network"
        case .connecting: "arrow.triangle.2.circlepath"
        case .connected: "checkmark.icloud"
        case .disconnected: "wifi.slash"
        }
    }

    private func connectionMessage(_ record: TaskJourneyRecord) -> String {
        switch record.presentation.connectionPhase {
        case .idle: "连接状态尚未开始；它与任务进度分开显示。"
        case .connecting: "正在模拟重新连接；没有真实网络请求。"
        case .connected: "这是本机演示状态，不代表正在连接云端服务。"
        case .disconnected: "连接中断，任务可能仍在进行。任务状态保持“\(TaskJourneySession.statusTitle(record.task.status))”。"
        }
    }

    private func eventTitle(_ phase: TaskEventPhase) -> String {
        switch phase {
        case .accepted: "已接收"
        case .leased: "已安排处理"
        case .started: "已开始"
        case .progress: "进度已更新"
        case .waitingApproval: "等待确认"
        case .approvalGranted: "确认已通过"
        case .approvalDenied: "确认被拒绝"
        case .retryScheduled: "安排重试"
        case .completed: "处理结束"
        case .failed: "处理失败"
        case .cancelled: "已取消"
        }
    }

    private func statusSymbol(_ status: TaskStatus) -> String {
        switch status {
        case .queued: "tray.and.arrow.down.fill"
        case .running: "arrow.triangle.2.circlepath"
        case .waitingApproval: "hand.raised.fill"
        case .retryableFailed: "clock.badge.exclamationmark"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .cancelled: "stop.circle.fill"
        }
    }

    private func statusColor(_ status: TaskStatus) -> Color {
        switch status {
        case .queued, .running: .blue
        case .waitingApproval, .retryableFailed: .orange
        case .completed: .green
        case .failed, .cancelled: .secondary
        }
    }
}
