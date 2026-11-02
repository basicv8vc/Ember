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
