import SwiftUI

public enum InlineNoticeTone {
    case neutral
    case success
    case warning
    case error

    fileprivate var color: Color {
        switch self {
        case .neutral: Color(uiColor: .systemBlue)
        case .success: Color(uiColor: .systemGreen)
        case .warning: Color(uiColor: .systemOrange)
        case .error: Color(uiColor: .systemRed)
        }
    }

    fileprivate var defaultSymbol: String {
        switch self {
        case .neutral: "info.circle"
        case .success: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "xmark.octagon"
        }
    }
}

/// A compact, recoverable message surface. It never performs an action itself.
public struct InlineNotice: View {
    private let title: LocalizedStringKey
    private let message: LocalizedStringKey?
    private let tone: InlineNoticeTone
    private let systemImage: String?

    public init(
        title: LocalizedStringKey,
        message: LocalizedStringKey? = nil,
        tone: InlineNoticeTone = .neutral,
        systemImage: String? = nil
    ) {
        self.title = title
        self.message = message
        self.tone = tone
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage ?? tone.defaultSymbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(tone.color)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                if let message {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(tone.color.opacity(0.08), in: RoundedRectangle(cornerRadius: EmberDesignTokens.noticeCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: EmberDesignTokens.noticeCornerRadius)
                .strokeBorder(tone.color.opacity(0.2), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Inline notices") {
    VStack(spacing: 12) {
        InlineNotice(title: "notice.info_title", message: "notice.info_message")
        InlineNotice(title: "notice.success_title", tone: .success)
        InlineNotice(title: "notice.warning_title", tone: .warning)
        InlineNotice(title: "notice.error_title", message: "notice.error_message", tone: .error)
    }
    .padding()
    .background(EmberDesignTokens.groupedBackground)
}
