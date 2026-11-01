import SwiftUI

/// A persistent disclosure for mock-only surfaces.
public struct MockOnlyBanner: View {
    public init() {}

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "testtube.2")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color(uiColor: .systemOrange))
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text("mock_only.title")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)

                Text("mock_only.message")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Color(uiColor: .systemOrange).opacity(0.1), in: RoundedRectangle(cornerRadius: EmberDesignTokens.noticeCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: EmberDesignTokens.noticeCornerRadius)
                .strokeBorder(Color(uiColor: .systemOrange).opacity(0.24), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("mock-only-banner")
    }
}

#Preview("MOCK ONLY disclosure") {
    MockOnlyBanner()
        .padding()
        .background(EmberDesignTokens.groupedBackground)
}
