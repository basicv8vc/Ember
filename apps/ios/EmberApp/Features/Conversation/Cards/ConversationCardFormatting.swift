import Foundation
import SwiftUI

enum ConversationCardFormatting {
    private final class MarkdownBlocksBox: NSObject {
        let blocks: [ConversationMarkdownBlock]
        init(_ blocks: [ConversationMarkdownBlock]) { self.blocks = blocks }
    }

    private final class AttributedStringBox: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private static let formatterLock = NSLock()
    private static let fractionalISOFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plainISOFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static let durationFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute, .second]
        formatter.unitsStyle = .short
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        return formatter
    }()
    /// Cap both cache entry size and total byte cost so long messages or repeated turns
    /// cannot cause unbounded memory growth. In-progress streaming text bypasses both caches.
    static let maxCacheableEntryBytes = 64 * 1024
    static let markdownBlocksCacheTotalCostLimit = 2 * 1024 * 1024
    static let attributedMarkdownCacheTotalCostLimit = 2 * 1024 * 1024

    private static let dateCache: NSCache<NSString, NSDate> = {
        let cache = NSCache<NSString, NSDate>()
        cache.countLimit = 512
        return cache
    }()
    private static let markdownBlocksCache: NSCache<NSString, MarkdownBlocksBox> = {
        let cache = NSCache<NSString, MarkdownBlocksBox>()
        cache.countLimit = 256
        cache.totalCostLimit = markdownBlocksCacheTotalCostLimit
        return cache
    }()
    private static let attributedMarkdownCache: NSCache<NSString, AttributedStringBox> = {
        let cache = NSCache<NSString, AttributedStringBox>()
        cache.countLimit = 256
        cache.totalCostLimit = attributedMarkdownCacheTotalCostLimit
        return cache
    }()

    static func clearCaches() {
        dateCache.removeAllObjects()
        markdownBlocksCache.removeAllObjects()
        attributedMarkdownCache.removeAllObjects()
    }

    static func hasCachedMarkdownBlocks(for rawText: String) -> Bool {
        guard !rawText.isEmpty else { return false }
        return markdownBlocksCache.object(forKey: rawText as NSString) != nil
    }

    static func hasCachedAttributedMarkdown(for rawText: String) -> Bool {
        guard !rawText.isEmpty else { return false }
        return attributedMarkdownCache.object(forKey: rawText as NSString) != nil
    }

    static func date(from value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        let key = value as NSString
        if let cached = dateCache.object(forKey: key) {
            return cached as Date
        }
        formatterLock.lock()
        let parsed = fractionalISOFormatter.date(from: value) ?? plainISOFormatter.date(from: value)
        formatterLock.unlock()
        if let parsed {
            dateCache.setObject(parsed as NSDate, forKey: key)
        }
        return parsed
    }

    static func duration(seconds: Int) -> String? {
        guard seconds > 0 else { return nil }
        formatterLock.lock()
        let formatted = durationFormatter.string(from: TimeInterval(seconds))
        formatterLock.unlock()
        return formatted
    }

    static func attributedMarkdown(for rawText: String, useCache: Bool = true) -> AttributedString? {
        guard !rawText.isEmpty else { return nil }
        let utf8ByteCount = rawText.utf8.count
        let shouldCache = useCache && utf8ByteCount <= maxCacheableEntryBytes
        if shouldCache {
            let key = rawText as NSString
            if let cached = attributedMarkdownCache.object(forKey: key) {
                return cached.value
            }
        }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard let parsed = try? AttributedString(markdown: rawText, options: options) else {
            return nil
        }
        if shouldCache {
            let cost = max(1, utf8ByteCount * 4)
            attributedMarkdownCache.setObject(AttributedStringBox(parsed), forKey: rawText as NSString, cost: cost)
        }
        return parsed
    }

    static func cachedMarkdownBlocks(for rawText: String, useCache: Bool = true) -> [ConversationMarkdownBlock] {
        guard !rawText.isEmpty else { return [] }
        let utf8ByteCount = rawText.utf8.count
        let shouldCache = useCache && utf8ByteCount <= maxCacheableEntryBytes
        if shouldCache {
            let key = rawText as NSString
            if let cached = markdownBlocksCache.object(forKey: key) {
                return cached.blocks
            }
        }
        let parsed = ConversationMarkdownBlock.parse(rawText)
        if shouldCache {
            let cost = max(1, utf8ByteCount * 2)
            markdownBlocksCache.setObject(MarkdownBlocksBox(parsed), forKey: rawText as NSString, cost: cost)
        }
        return parsed
    }
}

enum ConversationMarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case bulletItem(text: String)
    case numberedItem(prefix: String, text: String)
    case codeBlock(language: String?, code: String)
    case paragraph(text: String)

    static func parse(_ rawText: String) -> [ConversationMarkdownBlock] {
        let normalized = rawText
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard !normalized.isEmpty else { return [] }

        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [ConversationMarkdownBlock] = []
        var paragraphLines: [String] = []
        var index = 0

        func flushParagraph() {
            guard !paragraphLines.isEmpty else { return }
            let joined = paragraphLines.joined(separator: "\n")
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.paragraph(text: joined))
            }
            paragraphLines.removeAll(keepingCapacity: true)
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flushParagraph()
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                index += 1
                var closed = false
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        closed = true
                        index += 1
                        break
                    }
                    codeLines.append(lines[index])
                    index += 1
                }
                if closed {
                    blocks.append(.codeBlock(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
                } else {
                    blocks.append(.paragraph(text: ([line] + codeLines).joined(separator: "\n")))
                }
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let heading = parseHeading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                index += 1
                continue
            }

            if let bullet = parseBullet(trimmed) {
                flushParagraph()
                blocks.append(bullet)
                index += 1
                continue
            }

            if let numbered = parseNumberedItem(trimmed) {
                flushParagraph()
                blocks.append(numbered)
                index += 1
                continue
            }

            paragraphLines.append(line)
            index += 1
        }

        flushParagraph()
        return blocks
    }

    private static func parseHeading(_ line: String) -> ConversationMarkdownBlock? {
        var level = 0
        for ch in line where ch == "#" {
            level += 1
            if level > 6 { return nil }
        }
        guard level > 0, line.count > level else { return nil }
        let afterHashes = line.index(line.startIndex, offsetBy: level)
        guard line[afterHashes] == " " else { return nil }
        let title = String(line[line.index(after: afterHashes)...]).trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return nil }
        return .heading(level: min(level, 3), text: title)
    }

    private static func parseBullet(_ line: String) -> ConversationMarkdownBlock? {
        guard line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") else { return nil }
        let content = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return .bulletItem(text: content)
    }

    private static func parseNumberedItem(_ line: String) -> ConversationMarkdownBlock? {
        guard let dotIndex = line.firstIndex(of: "."), dotIndex > line.startIndex else { return nil }
        let digits = line[..<dotIndex]
        guard digits.count <= 3, digits.allSatisfy(\.isNumber) else { return nil }
        let afterDot = line.index(after: dotIndex)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        let content = String(line[line.index(after: afterDot)...]).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return .numberedItem(prefix: "\(digits).", text: content)
    }
}

struct ConversationMarkdownText: View {
    let text: String
    var cachesParsedMarkdown: Bool = true

    var body: some View {
        let blocks = ConversationCardFormatting.cachedMarkdownBlocks(
            for: text,
            useCache: cachesParsedMarkdown
        )
        if blocks.isEmpty {
            inlineText(text, useCache: cachesParsedMarkdown)
        } else {
            let lastBlockIndex = blocks.count - 1
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { offset, block in
                    // During streaming, skip caching the whole growing text and the actively
                    // mutating final block, while allowing completed earlier blocks to reuse
                    // the cost-bounded inline Markdown cache to avoid O(N^2) reparsing hitches.
                    blockView(block, useInlineCache: cachesParsedMarkdown || offset < lastBlockIndex)
                }
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ConversationMarkdownBlock, useInlineCache: Bool) -> some View {
        switch block {
        case .heading(let level, let title):
            inlineText(title, useCache: useInlineCache)
                .font(headingFont(for: level))
                .padding(.top, level == 1 ? 4 : 2)
        case .bulletItem(let itemText):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(verbatim: "•")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                inlineText(itemText, useCache: useInlineCache)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .numberedItem(let prefix, let itemText):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: prefix)
                    .font(.callout.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                inlineText(itemText, useCache: useInlineCache)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .codeBlock(let language, let code):
            VStack(alignment: .leading, spacing: 4) {
                if let language {
                    Text(verbatim: language)
                        .font(.caption2.monospaced().weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(verbatim: code)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .paragraph(let bodyText):
            inlineText(bodyText, useCache: useInlineCache)
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.bold)
        case 2: .headline.weight(.semibold)
        default: .subheadline.weight(.semibold)
        }
    }

    @ViewBuilder
    private func inlineText(_ raw: String, useCache: Bool) -> some View {
        if let attributed = ConversationCardFormatting.attributedMarkdown(
            for: raw,
            useCache: useCache
        ) {
            Text(attributed)
        } else {
            Text(verbatim: raw)
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
