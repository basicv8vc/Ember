import Foundation
import SwiftUI

enum ConversationCardFormatting {
    static func date(from value: String) -> Date? {
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractionalFormatter.date(from: value) {
            return date
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func duration(seconds: Int) -> String? {
        guard seconds > 0 else { return nil }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute, .second]
        formatter.unitsStyle = .short
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        return formatter.string(from: TimeInterval(seconds))
    }

    static func attributedMarkdown(for rawText: String) -> AttributedString? {
        guard !rawText.isEmpty else { return nil }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return try? AttributedString(markdown: rawText, options: options)
    }
}

struct ConversationMarkdownText: View {
    let text: String

    var body: some View {
        if let attributed = ConversationCardFormatting.attributedMarkdown(for: text) {
            Text(attributed)
        } else {
            Text(verbatim: text)
        }
    }
}

struct ConversationCardSurface<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
            }
    }
}

struct ConversationMockTag: View {
    var body: some View {
        Text(verbatim: "MOCK ONLY")
            .font(.caption2.weight(.bold))
            .foregroundStyle(Color(uiColor: .systemOrange))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(Color(uiColor: .systemOrange).opacity(0.1), in: Capsule())
            .accessibilityLabel(Text("card.mock_accessibility", tableName: "ConversationCards"))
    }
}

struct ConversationCardNotice: View {
    let textKey: String
    let symbol: String

    var body: some View {
        Label {
            Text(LocalizedStringKey(textKey), tableName: "ConversationCards")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .accessibilityHidden(true)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}
