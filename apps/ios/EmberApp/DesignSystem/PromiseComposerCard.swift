import SwiftUI

/// A bound task-input card. Submission is delegated to the caller and has no network behavior.
public struct PromiseComposerCard: View {
    @Binding private var text: String
    @FocusState private var isInputFocused: Bool

    private let isSubmitting: Bool
    private let onSubmit: () -> Void

    public init(
        text: Binding<String>,
        isSubmitting: Bool = false,
        onSubmit: @escaping () -> Void
    ) {
        _text = text
        self.isSubmitting = isSubmitting
        self.onSubmit = onSubmit
    }

    private var canSubmit: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
            VStack(alignment: .leading, spacing: 6) {
                Text("composer.title")
                    .font(.headline)
                    .foregroundStyle(.primary)

                Text("composer.supporting_text")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            TextField("composer.placeholder", text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(4...8)
                .textFieldStyle(.plain)
                .focused($isInputFocused)
                .submitLabel(.send)
                .onSubmit(submitIfPossible)
                .accessibilityLabel(Text("composer.title"))
                .accessibilityIdentifier("promise-composer-input")

            HStack(alignment: .center, spacing: 12) {
                Text("composer.local_only_note")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: submitIfPossible) {
                    HStack(spacing: 8) {
                        if isSubmitting {
                            ProgressView()
                                .tint(.white)
                                .accessibilityHidden(true)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.bold))
                                .accessibilityHidden(true)
                        }

                        Text(isSubmitting ? "composer.submitting" : "composer.submit")
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 48)
                    .background(Color.accentColor, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .opacity(canSubmit ? 1 : 0.55)
                .accessibilityHint(Text("composer.submit_hint"))
                .accessibilityIdentifier("promise-composer-submit")
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
    }

    private func submitIfPossible() {
        guard canSubmit else { return }
        onSubmit()
    }
}

private struct PromiseComposerPreviewHarness: View {
    @State private var text: String

    init(text: String) {
        _text = State(initialValue: text)
    }

    var body: some View {
        PromiseComposerCard(text: $text, onSubmit: {})
            .padding(16)
            .frame(width: 320)
            .background(EmberDesignTokens.groupedBackground)
    }
}

#Preview("Composer · empty") {
    PromiseComposerPreviewHarness(text: "")
}

#Preview("Composer · long text · narrow screen") {
    PromiseComposerPreviewHarness(text: "Please review these meeting notes, group the action items by priority, mark any missing owner or deadline, and summarize the three most useful next steps. Include enough context to make each action understandable without the original notes.")
}
