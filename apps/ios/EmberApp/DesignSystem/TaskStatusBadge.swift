import SwiftUI

/// A compact, accessible rendering of the server-reported task lifecycle status.
public struct TaskStatusBadge: View {
    private let status: TaskStatus

    public init(status: TaskStatus) {
        self.status = status
    }

    public var body: some View {
        HStack(spacing: 7) {
            Image(systemName: status.designSystemSymbol)
                .font(.subheadline.weight(.semibold))
                .accessibilityHidden(true)
                .foregroundStyle(status.designSystemColor)

            Text(status.designSystemLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(status.designSystemColor)
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(status.designSystemColor.opacity(0.1), in: Capsule())
        .overlay {
            Capsule().strokeBorder(status.designSystemColor.opacity(0.24), lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(status.designSystemLabel))
    }
}

#Preview("Task status badges") {
    VStack(alignment: .leading, spacing: 12) {
        ForEach(TaskStatus.allCases, id: \.self) { status in
            TaskStatusBadge(status: status)
        }
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
