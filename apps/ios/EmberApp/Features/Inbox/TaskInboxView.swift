import SwiftUI

struct TaskInboxView: View {
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
                title: "任务当前不可见",
                message: "本机演示没有查询其他用户的任务，也没有发出查询请求。",
                symbol: "questionmark.folder"
            )
            .accessibilityIdentifier("inbox-404-state")
        case .offline:
            contentNotice(
                title: "连接中断",
                message: "连接状态与任务状态分开显示。任务可能仍在进行；此处只演示文案，没有连接真实服务端。",
                symbol: "wifi.slash"
            )
            .accessibilityIdentifier("inbox-offline-state")
        }
    }

    private var fixtureSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("独立演示样例")
                .font(.headline)
            Text("每一项都是单独的固定情景，不代表你提交的任务会自动进入这些状态。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(fixtureRecords) { record in
                taskRow(record, sourceLabel: "固定演示样例")
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
