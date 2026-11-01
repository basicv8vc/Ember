import SwiftUI

struct TaskComposeView: View {
    @Bindable var session: TaskJourneySession
    let onReceipt: (TaskReceiptDTO) -> Void

    @State private var draft = ""
    @State private var idempotencyKey = UUID().uuidString
    @State private var simulateLostReceipt = false
    @State private var awaitingReceipt = false
    @State private var receipt: TaskReceiptDTO?
    @State private var message: String?

    private let exampleNote = "\"新 onboarding 先让用户完成一件小事，再解释权限。\n\n周五前和设计确认首屏文案。\n\n数据留存和删除规则还没定，需要 CTO review。\""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                introduction
                inputCard
                simulationCard

                if let message {
                    Label(message, systemImage: awaitingReceipt ? "questionmark.circle" : "info.circle")
                        .font(.subheadline)
                        .foregroundStyle(awaitingReceipt ? .orange : .secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                        .accessibilityIdentifier("compose-status-message")
                }

                if let receipt {
                    receiptCard(receipt)
                }

                Button(action: submit) {
                    HStack(spacing: 9) {
                        if session.isCreating {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: awaitingReceipt ? "arrow.clockwise" : "paperplane.fill")
                        }
                        Text(session.isCreating ? "正在提交" : awaitingReceipt ? "用相同内容和键重试" : "提交模拟任务")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isCreating)
                .accessibilityIdentifier("compose-submit")
            }
            .padding(20)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("新任务")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("把零散笔记整理成行动清单")
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("这是本机交互演示。当前合同没有 notes-to-actions 任务类型，也没有真实执行能力。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("笔记")
                    .font(.headline)
                Spacer(minLength: 8)
                Button("填入示例") {
                    draft = exampleNote
                }
                .font(.subheadline.weight(.semibold))
                .disabled(awaitingReceipt)
            }

            TextEditor(text: $draft)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(8)
                .frame(minHeight: 190)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text("粘贴会议记录、学习笔记或工作想法…")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .disabled(awaitingReceipt || session.isCreating)
                .accessibilityLabel("笔记内容")
                .accessibilityIdentifier("compose-note-input")

            Text("空白内容不能提交。笔记只在内存中用于这次模拟；FakeTaskRepository 不联网，也不保留原文。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private var simulationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("提交前说明", systemImage: "lock.shield")
                .font(.headline)
            Text("未来如果笔记要送到云端处理，Ember 必须先明确说明处理方式与留存边界。本演示不会上传笔记，也不会生成真实行动清单。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Toggle(isOn: $simulateLostReceipt) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("演示回执丢失")
                        .font(.subheadline.weight(.medium))
                    Text("本机已接收，但界面暂时显示“尚未确认”；可用同一内容与幂等键重试。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(awaitingReceipt || session.isCreating)
            .accessibilityIdentifier("compose-simulate-unknown-receipt")
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private func receiptCard(_ receipt: TaskReceiptDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("已接收 · \(receipt.replayed ? "幂等重放 200" : "新建 202")", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
            Text("这只表示 FakeTaskRepository 接收了本机模拟请求，不表示任务已经完成。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Task ID · \(receipt.taskID.uuidString)")
                .font(.caption.monospaced())
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("compose-receipt")
    }

    private func submit() {
        let note = draft
        let key = idempotencyKey
        let loseReceipt = simulateLostReceipt
        simulateLostReceipt = false

        Task {
            do {
                let accepted = try await session.createNoteTask(
                    note: note,
                    idempotencyKey: key,
                    simulateUnknownReceipt: loseReceipt
                )
                receipt = accepted
                message = nil
                awaitingReceipt = false
                draft = ""
                idempotencyKey = UUID().uuidString
                onReceipt(accepted)
            } catch TaskJourneyDemoError.receiptUnknown {
                awaitingReceipt = true
                receipt = nil
                message = "尚未确认：本机模拟已接收，但回执未显示。草稿与重试键已保留；请用相同内容重试。"
            } catch {
                awaitingReceipt = true
                receipt = nil
                message = "提交失败或尚未确认。草稿与重试键已保留；请用相同内容重试。"
            }
        }
    }
}
