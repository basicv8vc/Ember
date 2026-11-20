import Foundation
import NaturalLanguage

/// Apple-native text processing tool powered by Foundation and NaturalLanguage.
public struct NativeTextTool: NativeTool {
    public let name: DeviceToolName = .textProcess

    public init() {}

    public func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        try context.checkCancellation()

        let text = try context.resolveStringArgument("text", in: arguments, defaultToPreviousOutput: true) ?? ""
        let textBytes = Data(text.utf8)
        guard textBytes.count <= context.policy.maxInputBytes else {
            throw DeviceExecutorError.payloadTooLarge(
                "Text input (\(textBytes.count) bytes) exceeds limit \(context.policy.maxInputBytes)."
            )
        }

        let op = (arguments["op"]?.stringValue ?? "stats").lowercased()
        switch op {
        case "stats":
            return try runStats(text: text, byteCount: textBytes.count, context: context)
        case "extract_action_items":
            return try runExtractActionItems(text: text, context: context)
        case "extract_headings":
            return try runExtractHeadings(text: text, context: context)
        case "regex_match", "regex_replace":
            throw DeviceExecutorError.invalidArgument(
                "Regex operations ('\(op)') are disabled in M2-C1."
            )
        case "normalize":
            return try runNormalize(text: text, arguments: arguments, context: context)
        case "summarize_lines":
            return try runSummarizeLines(text: text, arguments: arguments, context: context)
        default:
            throw DeviceExecutorError.invalidArgument("Unsupported text operation '\(op)'.")
        }
    }

    private func runStats(
        text: String,
        byteCount: Int,
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        try context.checkCancellation()

        let lines = text.isEmpty ? [] : text.components(separatedBy: .newlines)
        let nonEmptyLines = lines.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let unicodeScalarCount = text.unicodeScalars.count
        let lfLineCount = text.isEmpty ? 0 : 1 + text.utf8.reduce(0) { count, byte in
            byte == 0x0A ? count + 1 : count
        }

        let wordTokenizer = NLTokenizer(unit: .word)
        wordTokenizer.string = text
        var wordCount = 0
        wordTokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { _, _ in
            wordCount += 1
            return wordCount < 250_000
        }

        try context.checkCancellation()

        let sentenceTokenizer = NLTokenizer(unit: .sentence)
        sentenceTokenizer.string = text
        var sentenceCount = 0
        sentenceTokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { _, _ in
            sentenceCount += 1
            return sentenceCount < 100_000
        }

        let recognizer = NLLanguageRecognizer()
        recognizer.processString(String(text.prefix(4096)))
        let language = recognizer.dominantLanguage?.rawValue ?? "und"
        let sha256 = DeviceSandboxCrypto.sha256Hex(Data(text.utf8))

        let structured: DeviceJSONValue = .object([
            "line_count": .int(Int64(lines.count)),
            "lf_line_count": .int(Int64(lfLineCount)),
            "non_empty_line_count": .int(Int64(nonEmptyLines.count)),
            "word_count": .int(Int64(wordCount)),
            "sentence_count": .int(Int64(sentenceCount)),
            "character_count": .int(Int64(text.count)),
            "unicode_scalars": .int(Int64(unicodeScalarCount)),
            "utf8_bytes": .int(Int64(byteCount)),
            "dominant_language": .string(language),
            "sha256": .string(sha256),
        ])
        let outputText = try structured.canonicalJSONString(prettyPrinted: true)
        return NativeToolOutput(
            summaryText: "Analyzed \(wordCount) words across \(lines.count) lines (\(language)).",
            outputText: boundText(outputText, maxBytes: context.policy.maxOutputTextBytes),
            structuredData: structured
        )
    }

    private func runExtractActionItems(
        text: String,
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let lines = text.components(separatedBy: .newlines)
        var items: [String] = []
        for (index, rawLine) in lines.enumerated() {
            if index % 64 == 0 {
                try context.checkCancellation()
            }
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let lower = trimmed.lowercased()
            if trimmed.hasPrefix("- [ ] ") || trimmed.hasPrefix("* [ ] ") {
                items.append(String(trimmed.dropFirst(6)).trimmingCharacters(in: .whitespaces))
            } else if lower.hasPrefix("todo:") {
                items.append(String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            } else if lower.hasPrefix("action:") {
                items.append(String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces))
            } else if lower.hasPrefix("- todo ") || lower.hasPrefix("* todo ") {
                items.append(String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces))
            }
        }

        let formatted = items.isEmpty
            ? "No action items found."
            : items.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        let structured: DeviceJSONValue = .object([
            "count": .int(Int64(items.count)),
            "items": .array(items.map { .string($0) }),
        ])
        return NativeToolOutput(
            summaryText: "Extracted \(items.count) action item(s) locally.",
            outputText: boundText(formatted, maxBytes: context.policy.maxOutputTextBytes),
            structuredData: structured
        )
    }

    private func runExtractHeadings(
        text: String,
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let lines = text.components(separatedBy: .newlines)
        var headings: [DeviceJSONValue] = []
        var formattedLines: [String] = []

        for (index, rawLine) in lines.enumerated() {
            if index % 64 == 0 {
                try context.checkCancellation()
            }
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("#") else { continue }
            let hashes = trimmed.prefix(while: { $0 == "#" })
            guard !hashes.isEmpty, hashes.count <= 6 else { continue }
            let remainder = trimmed.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
            guard !remainder.isEmpty else { continue }

            headings.append(.object([
                "level": .int(Int64(hashes.count)),
                "line": .int(Int64(index + 1)),
                "title": .string(remainder),
            ]))
            formattedLines.append("\(hashes) \(remainder)")
        }

        return NativeToolOutput(
            summaryText: "Extracted \(headings.count) Markdown heading(s).",
            outputText: boundText(formattedLines.joined(separator: "\n"), maxBytes: context.policy.maxOutputTextBytes),
            structuredData: .object([
                "count": .int(Int64(headings.count)),
                "headings": .array(headings),
            ])
        )
    }

    private func runNormalize(
        text: String,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let sortLines = arguments["sort_lines"]?.boolValue ?? false
        let uniqueLines = arguments["unique_lines"]?.boolValue ?? false
        let dropEmpty = arguments["drop_empty_lines"]?.boolValue ?? false

        let unix = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        var normalizedLines: [String] = []
        var seen = Set<String>()
        var previousBlank = false

        for (index, rawLine) in unix.components(separatedBy: "\n").enumerated() {
            if index % 128 == 0 {
                try context.checkCancellation()
            }
            let trimmedRight = trimTrailingSpacesAndTabs(rawLine)
            if trimmedRight.isEmpty {
                if dropEmpty || previousBlank {
                    continue
                }
                previousBlank = true
                normalizedLines.append("")
            } else {
                previousBlank = false
                if uniqueLines {
                    if seen.insert(trimmedRight).inserted {
                        normalizedLines.append(trimmedRight)
                    }
                } else {
                    normalizedLines.append(trimmedRight)
                }
            }
        }

        if sortLines {
            normalizedLines.sort()
        }

        let output = normalizedLines.joined(separator: "\n")
        return NativeToolOutput(
            summaryText: "Normalized text into \(normalizedLines.count) line(s).",
            outputText: boundText(output, maxBytes: context.policy.maxOutputTextBytes),
            structuredData: .object([
                "line_count": .int(Int64(normalizedLines.count)),
                "sorted": .bool(sortLines),
                "unique": .bool(uniqueLines),
            ])
        )
    }

    private func runSummarizeLines(
        text: String,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let maxLines = min(max(arguments["max_lines"]?.intValue ?? 20, 1), 200)
        let keyword = arguments["keyword"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)

        let allLines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        try context.checkCancellation()

        let filtered: [String]
        if let keyword, !keyword.isEmpty {
            filtered = allLines.filter { $0.localizedCaseInsensitiveContains(keyword) }
        } else {
            filtered = allLines
        }

        let selected = Array(filtered.prefix(maxLines))
        let summaryText = selected.joined(separator: "\n")
        return NativeToolOutput(
            summaryText: "Selected \(selected.count) of \(filtered.count) matching line(s).",
            outputText: boundText(summaryText, maxBytes: context.policy.maxOutputTextBytes),
            structuredData: .object([
                "total_non_empty_lines": .int(Int64(allLines.count)),
                "matching_lines": .int(Int64(filtered.count)),
                "returned_lines": .int(Int64(selected.count)),
            ])
        )
    }

    private func trimTrailingSpacesAndTabs(_ line: String) -> String {
        var end = line.endIndex
        while end > line.startIndex {
            let prev = line.index(before: end)
            let ch = line[prev]
            if ch == " " || ch == "\t" {
                end = prev
            } else {
                break
            }
        }
        return String(line[..<end])
    }

    private func boundText(_ text: String, maxBytes: Int) -> String {
        let data = Data(text.utf8)
        guard data.count > maxBytes else { return text }
        var prefixCount = maxBytes
        while prefixCount > 0 && String(data: data.prefix(prefixCount), encoding: .utf8) == nil {
            prefixCount -= 1
        }
        let prefix = String(data: data.prefix(prefixCount), encoding: .utf8) ?? ""
        return prefix + "\n...[truncated at \(maxBytes) bytes]"
    }
}
