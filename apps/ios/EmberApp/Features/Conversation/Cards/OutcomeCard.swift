import SwiftUI

/// Displays result content only when the caller supplies readable content from an actual source.
public struct OutcomeCard: View {
    private let title: String
    private let summary: String?
    private let readableContent: String?
    private let isMockOnly: Bool
    private let onCopy: (() -> Void)?

    public init(
        title: String,
        summary: String? = nil,
        readableContent: String? = nil,
        isMockOnly: Bool = false,
        onCopy: (() -> Void)? = nil
    ) {
        self.title = title
        self.summary = summary
        self.readableContent = readableContent
        self.isMockOnly = isMockOnly
        self.onCopy = onCopy
    }

    public var body: some View {
        ConversationCardSurface {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "doc.text.image")
                        .font(.title3)
                        .foregroundStyle(Color(uiColor: .systemGreen))
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Text("card.result", tableName: "ConversationCards")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            if isMockOnly {
                                ConversationMockTag()
                            }
                        }
                        Text(title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let summary, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if Self.hasReadableContent(readableContent), let readableContent {
                    ConversationMarkdownText(text: readableContent)
                        .font(.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(11)
                        .background(
                            EmberDesignTokens.surfaceSubtle,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(EmberDesignTokens.surfaceHairline, lineWidth: 1)
                        }

                    HStack(spacing: 8) {
                        if let onCopy {
                            Button(action: onCopy) {
                                Label {
                                    Text("card.copy", tableName: "ConversationCards")
                                } icon: {
                                    Image(systemName: "doc.on.doc")
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(.primary)
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("outcome-copy")
                        }

                        ShareLink(item: readableContent) {
                            Label {
                                Text("card.share", tableName: "ConversationCards")
                            } icon: {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(.primary)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("outcome-share")
                    }
                } else {
                    ConversationCardNotice(textKey: "card.result_unavailable", symbol: "doc.questionmark")
                        .accessibilityIdentifier("outcome-result-unavailable")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("outcome-card")
    }

    static func hasReadableContent(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

#Preview("Missing result · MOCK ONLY") {
    OutcomeCard(
        title: "Task result",
        summary: nil,
        readableContent: nil,
        isMockOnly: true
    )
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}

#Preview("Readable sample result · MOCK ONLY") {
    OutcomeCard(
        title: "Prepared outline",
        summary: "A short sample outline is available to read.",
        readableContent: "1. Confirm the goal\n2. Gather the needed details\n3. Review the next step",
        isMockOnly: true,
        onCopy: {}
    )
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
