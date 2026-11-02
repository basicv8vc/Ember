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

                Text("任务编号 · \(taskID.uuidString)")
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
        usesSimplifiedChinese ? "本机演示回执" : "Local demo receipt"
    }

    private var message: String {
        usesSimplifiedChinese
            ? "本机演示已收到你的提交。任务尚未完成；笔记没有上传，也没有调用云端 AI。"
            : "The local demo received your submission. The task is not complete; your note was not uploaded or sent to cloud AI."
    }

    private var continueTitle: String {
        usesSimplifiedChinese ? "在 Inbox 查看任务" : "View the task in Inbox"
    }
}
