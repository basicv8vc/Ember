import SwiftUI

/// A permanently disabled placeholder until the reviewed ActionIntent contract exists.
public struct ApprovalCard: View {
    private let title: String
    private let detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    public var body: some View {
        ConversationCardSurface {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "hand.raised")
                        .foregroundStyle(Color(uiColor: .systemOrange))
                        .accessibilityHidden(true)
                    Text(title)
                        .font(.body.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    ConversationMockTag()
                }

                if let detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("card.approval_unavailable", tableName: "ConversationCards")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {} label: {
                    Label {
                        Text("card.approve", tableName: "ConversationCards")
                    } icon: {
                        Image(systemName: "checkmark")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .disabled(true)
                .accessibilityIdentifier("approval-disabled")
            }
        }
        .accessibilityIdentifier("approval-card-mock-only")
    }
}

#Preview("Approval placeholder · MOCK ONLY") {
    ApprovalCard(
        title: "Review a proposed action",
        detail: "The demo provides no reviewed action details."
    )
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
