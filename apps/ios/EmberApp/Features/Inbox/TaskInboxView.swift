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
                    Button("演示空历史", systemImage: "tray") { session.showInboxMode(.noHistory) }
                    Button("演示 401 · 需要认证", systemImage: "person.crop.circle.badge.exclamationmark") {
                        session.showInboxMode(.unauthorized)
                    }
                    Button("演示 404 · 任务不可见", systemImage: "questionmark.folder") {
                        session.showInboxMode(.notFound)
                    }
                    Button("演示离线", systemImage: "wifi.slash") { session.showInboxMode(.offline) }
                    Button("返回本地演示列表", systemImage: "arrow.uturn.backward") {
                        session.showInboxMode(.localSession)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .accessibilityLabel("演示异常状态")
                }
                .accessibilityIdentifier("inbox-demo-states-menu")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("当前安装 / 演示会话")
                .font(.title2.weight(.semibold))
            Text("这里不是云端完整 Inbox，也不跨设备同步。新建任务只保存在本次内存会话；下方状态样例是各自独立的模拟 fixture。")
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
                    message: "可以从“新任务”提交一个本地 mock 回执，或选择下面独立的状态 fixture。",
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
                message: "这个演示没有云端 Inbox 或持久化记录。返回后可查看本机 fixture 样例。",
                symbol: "tray"
            )
            .accessibilityIdentifier("inbox-empty-state")
        case .unauthorized:
            contentNotice(
                title: "401 · 需要重新认证",
                message: "这是 UI 状态演示，没有发出认证请求。当前 mock 合同不包含登录或刷新会话能力。",
                symbol: "person.crop.circle.badge.exclamationmark"
            )
            .accessibilityIdentifier("inbox-401-state")
        case .notFound:
            contentNotice(
                title: "404 · 任务不可见或已失效",
                message: "演示不推断其他用户或租户是否存在该任务，也没有真实查询请求。",
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
            Text("独立状态 fixture")
                .font(.headline)
            Text("每一行都是单独的固定样例，不代表同一个新任务自动推进。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(fixtureRecords) { record in
                taskRow(record, sourceLabel: "模拟 fixture")
            }
        }
    }

    private var demoStateControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("异常状态演示")
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
        Button("401") { session.showInboxMode(.unauthorized) }
            .buttonStyle(.bordered)
        Button("404") { session.showInboxMode(.notFound) }
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
        .accessibilityHint("打开模拟任务详情")
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
                Button("返回本地演示列表") { session.showInboxMode(.localSession) }
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
