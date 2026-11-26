import SwiftUI

public struct LoadingPlaceholder: View {
    private let title: LocalizedStringKey

    public init(title: LocalizedStringKey = "placeholder.loading") {
        self.title = title
    }

    public var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .accessibilityHidden(true)

            Text(title)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 112)
        .accessibilityElement(children: .combine)
    }
}

public struct EmptyPlaceholder: View {
    private let title: LocalizedStringKey
    private let message: LocalizedStringKey?
    private let systemImage: String

    public init(
        title: LocalizedStringKey,
        message: LocalizedStringKey? = nil,
        systemImage: String = "tray"
    ) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
    }

    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 144)
        .emberCardSurface(cornerRadius: EmberDesignTokens.cardCornerRadius)
        .accessibilityElement(children: .combine)
    }
}

public struct ErrorPlaceholder: View {
    private let title: LocalizedStringKey
    private let message: LocalizedStringKey
    private let retryTitle: LocalizedStringKey
    private let onRetry: (() -> Void)?

    public init(
        title: LocalizedStringKey = "placeholder.error_title",
        message: LocalizedStringKey,
        retryTitle: LocalizedStringKey = "placeholder.retry",
        onRetry: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.retryTitle = retryTitle
        self.onRetry = onRetry
    }

    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityHidden(true)

            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let onRetry {
                Button(action: onRetry) {
                    Text(retryTitle)
                        .font(.subheadline.weight(.semibold))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .tint(.primary)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 176)
        .emberCardSurface(cornerRadius: EmberDesignTokens.cardCornerRadius)
        .accessibilityElement(children: .contain)
    }
}

#Preview("Loading / Empty / Error") {
    VStack(spacing: 12) {
        LoadingPlaceholder()
        EmptyPlaceholder(title: "placeholder.no_result_title", message: "placeholder.no_result_message")
        ErrorPlaceholder(message: "placeholder.offline_error", onRetry: {})
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
