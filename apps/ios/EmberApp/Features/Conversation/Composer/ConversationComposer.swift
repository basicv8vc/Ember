import SwiftUI

struct ConversationComposer: View {
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let onSend: (String) -> Void

    private var submission: ConversationComposerSubmission? {
        ConversationInteractionRules.submission(for: draft, isGenerating: isGenerating)
    }

    private var canSend: Bool {
        submission != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(
                String(localized: "conversation.composer.placeholder", table: "Conversation"),
                text: $draft,
                axis: .vertical
            )
            .font(.body)
            .lineLimit(1...6)
            .textFieldStyle(.plain)
            .focused(focused)
            .submitLabel(.send)
            .onSubmit(sendIfPossible)
            .accessibilityLabel(Text("conversation.composer.accessibility", tableName: "Conversation"))
            .accessibilityIdentifier("conversation-composer-input")

            HStack(alignment: .center, spacing: 12) {
                Text("conversation.composer.local_note", tableName: "Conversation")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: sendIfPossible) {
                    Label {
                        Text("conversation.composer.send", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    } icon: {
                        Image(systemName: "arrow.up")
                            .font(.subheadline.weight(.bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 46)
                    .background(Color.accentColor, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.55)
                .accessibilityHint(Text("conversation.composer.send_hint", tableName: "Conversation"))
                .accessibilityIdentifier("conversation-send")
            }
        }
        .padding(14)
        .frame(maxWidth: 680)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
    }

    private func sendIfPossible() {
        guard let submission else { return }
        draft = submission.draftAfterSubmission
        focused.wrappedValue = submission.composerShouldFocusAfterSubmission
        onSend(submission.message)
    }
}
