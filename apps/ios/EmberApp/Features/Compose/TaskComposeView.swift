import SwiftUI

struct TaskComposeView: View {
    @Bindable var session: TaskJourneySession
    let onReceipt: (TaskReceiptDTO) -> Void

    @State private var submission = TaskComposeSubmissionModel()
    @State private var simulateLostReceipt = false

    private let exampleNote = "\"新 onboarding 先让用户完成一件小事，再解释权限。\n\n周五前和设计确认首屏文案。\n\n数据留存和删除规则还没定，需要 CTO review。\""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                introduction
                inputCard
                simulationCard

                if let message = submission.statusMessage {
                    Label(
                        message,
                        systemImage: submission.isAwaitingReceipt ? "questionmark.circle" : "exclamationmark.triangle"
                    )
                        .font(.subheadline)
                        .foregroundStyle(submission.isAwaitingReceipt ? .orange : .red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(
                            (submission.isAwaitingReceipt ? Color.orange : Color.red).opacity(0.10),
                            in: RoundedRectangle(cornerRadius: 14)
                        )
                        .accessibilityIdentifier("compose-status-message")
                }

                if case let .accepted(receipt) = submission.state {
                    receiptCard(receipt)
                }

                Button(action: submit) {
                    HStack(spacing: 9) {
                        if submission.isSubmitting {
                            ProgressView().tint(.white)
                        } else {
                            Image(
                                systemName: submission.isAwaitingReceipt || submission.hasDefiniteFailure
                                    ? "arrow.clockwise"
                                    : "paperplane.fill"
                            )
                        }
                        Text(submission.submitButtonTitle)
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    submission.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || submission.isSubmitting
                        || session.isCreating
                )
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
            Text("这是本机演示，尚未连接云端 AI。提交不会处理笔记或生成行动清单。")
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
                    submission.draft = exampleNote
                }
                .font(.subheadline.weight(.semibold))
                .disabled(!submission.canEditDraft)
            }

            TextEditor(text: $submission.draft)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(8)
                .frame(minHeight: 190)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .topLeading) {
                    if submission.draft.isEmpty {
                        Text("粘贴会议记录、学习笔记或工作想法…")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .disabled(!submission.canEditDraft || session.isCreating)
                .accessibilityLabel("笔记内容")
                .accessibilityIdentifier("compose-note-input")

            Text("空白内容不能提交。笔记只在内存中用于这次模拟；本机演示不会联网，也不会保留原文。")
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
            Text("云端处理功能尚未开放。当前不会上传笔记或生成行动清单；结果页展示的是固定演示样例，并非根据这次提交的笔记生成。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Toggle(isOn: $simulateLostReceipt) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("演示回执丢失")
                        .font(.subheadline.weight(.medium))
                    Text("模拟回执暂时未能确认；重试会沿用本次提交。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(!submission.canEditDraft || session.isCreating)
            .accessibilityIdentifier("compose-simulate-unknown-receipt")
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private func receiptCard(_ receipt: TaskReceiptDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(receipt.replayed ? "已接收 · 已确认之前的提交" : "已接收 · 本次提交", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
            Text("这只表示本机演示已收到提交，不表示任务已经完成。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("任务编号 · \(receipt.taskID.uuidString)")
                .font(.caption.monospaced())
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("compose-receipt")
    }

    private func submit() {
        let loseReceipt = simulateLostReceipt
        simulateLostReceipt = false
        guard let attempt = submission.beginSubmission(simulateUnknownReceipt: loseReceipt) else { return }

        Task {
            await submission.finishSubmission(attempt, in: session) { receipt in
                onReceipt(receipt)
            }
        }
    }
}
