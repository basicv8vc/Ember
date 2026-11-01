import SwiftUI

struct FoundationLaunchView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "sparkle")
                .font(.system(size: 36, weight: .regular))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            Text("Ember")
                .font(.largeTitle.weight(.semibold))

            Text("Native iOS foundation")
                .font(.body)
                .foregroundStyle(.secondary)

            Text(FoundationCopy.mockOnlyNotice)
                .font(.footnote.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.orange.opacity(0.14), in: Capsule())
                .accessibilityIdentifier("mock-only-label")
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}

#Preview {
    FoundationLaunchView()
}
