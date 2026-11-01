import SwiftUI

@MainActor
struct MockReceiptAcknowledgementView: View {
    @Environment(\.locale) private var locale

    let taskID: UUID
    let onContinue: () -> Void

    private var usesSimplifiedChinese: Bool {
        locale.identifier.lowercased().hasPrefix("zh")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            MockOnlyBanner()

            VStack(alignment: .leading, spacing: 10) {
                Label(title, systemImage: "checkmark.circle.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.green)

                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Task ID · \(taskID.uuidString)")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("mock-receipt-task-id")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("mock-receipt-confirmation")

            Spacer(minLength: 8)

            Button(action: onContinue) {
                Text(continueTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("mock-receipt-continue")
        }
        .padding(24)
        .frame(maxWidth: 560, maxHeight: .infinity, alignment: .topLeading)
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled()
    }

    private var title: String {
        usesSimplifiedChinese ? "本机模拟回执" : "Local mock receipt"
    }

    private var message: String {
        usesSimplifiedChinese
            ? "FakeTaskRepository 已在本机返回这项模拟任务的回执。这不代表任务已完成，也没有上传笔记或调用 AI 服务。"
            : "FakeTaskRepository returned a receipt for this local mock task. The task is not complete, and no note was uploaded or sent to an AI service."
    }

    private var continueTitle: String {
        usesSimplifiedChinese ? "在 Inbox 查看任务" : "View the task in Inbox"
    }
}
