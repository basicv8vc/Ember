import SwiftUI
import UIKit

struct TaskDetailView: View {
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
                    description: Text("从“我的承诺”选择一个本地任务或 fixture。")
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
            Text("复制的是独立的模拟 fixture 文本，不是服务端结果。")
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

            Text("状态只来自 TaskDTO / 固定 fixture；连接状态和取消命令单独显示。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledContent("任务类型", value: record.task.kind.rawValue)
            LabeledContent("尝试次数", value: String(record.task.attemptCount))
            LabeledContent("创建时间", value: record.task.createdAt)
            LabeledContent("Task ID", value: record.task.taskID.uuidString)
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
                Text("此 fixture 没有可显示的事件。")
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
                                Text("fixture 标记：simulated")
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
                Text("当前 ApprovalDTO 只有摘要哈希，缺少可读的动作与影响范围。详情不足，无法批准。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("批准") {}
                    .buttonStyle(.borderedProminent)
                    .disabled(true)
                    .accessibilityIdentifier("approval-disabled")
                Text("此按钮永久禁用；演示不会提交批准或拒绝操作。")
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
                Label("Outcome · 仅显示独立 fixture", systemImage: "doc.text")
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
                    Text("任务已完成，但成果暂不可读取。当前合同没有 Task Result API，因此这里不填入其他内容。")
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
            Label("本地命令", systemImage: "arrow.uturn.backward.circle")
                .font(.headline)
            if let message = session.cancelMessageByTaskID[record.id] {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("task-cancel-status")
            } else {
                Text("取消请求与最终任务状态分开。返回结果仍在 queued/running 时，只显示待确认，不提前标记已取消。")
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
                        Label("演示请求取消", systemImage: "stop.circle")
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
        case .idle: "连接尚未开始；这不是任务状态。"
        case .connecting: "正在演示本地重连状态；没有计时器，也没有真实网络请求。"
        case .connected: "这是本地 UI 状态。任务状态仍以固定 TaskDTO / fixture 为准。"
        case .disconnected: "连接中断，任务可能仍在进行。任务状态保持“\(TaskJourneySession.statusTitle(record.task.status))”。"
        }
    }

    private func eventTitle(_ phase: TaskEventPhase) -> String {
        switch phase {
        case .accepted: "已接收"
        case .leased: "已分配执行槽位"
        case .started: "已开始"
        case .progress: "进度事件"
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
