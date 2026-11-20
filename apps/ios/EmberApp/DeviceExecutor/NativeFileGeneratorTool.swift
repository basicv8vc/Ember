import Foundation
import UIKit

/// Apple-native sandboxed file generation tool supporting TXT, Markdown, JSON, CSV, and PDF.
public struct NativeFileGeneratorTool: NativeTool {
    public let name: DeviceToolName = .fileGenerate

    public init() {}

    public func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        try context.checkCancellation()

        let requestedFilename = arguments["filename"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawFilename = requestedFilename, !rawFilename.isEmpty else {
            throw DeviceExecutorError.invalidArgument("file.generate requires a non-empty 'filename'.")
        }

        let rawValidated = try context.workspace.validateSafeRelativeFilename(rawFilename)
        let ext = URL(fileURLWithPath: rawValidated).pathExtension.lowercased()
        let explicitMediaType = arguments["media_type"]?.stringValue
        let inferredMediaType = ext.isEmpty ? nil : B3AttachmentLimits.mediaType(forFileExtension: ext)

        let mediaType: String
        let validatedFilename: String
        if let explicitMediaType {
            mediaType = B3AttachmentLimits.normalizedMediaType(explicitMediaType)
            guard !B3AttachmentLimits.blockedMediaTypes.contains(mediaType),
                  DeviceSandboxWorkspace.allowedOutputMediaTypes.contains(mediaType)
            else {
                throw DeviceExecutorError.blockedMediaType(mediaType)
            }
            if !ext.isEmpty {
                guard inferredMediaType == mediaType else {
                    throw DeviceExecutorError.invalidArgument(
                        "File extension '.\(ext)' does not match media_type '\(mediaType)'."
                    )
                }
                validatedFilename = rawValidated
            } else {
                let defaultExt = B3AttachmentLimits.defaultExtension(forMediaType: mediaType)
                validatedFilename = try context.workspace.validateSafeRelativeFilename("\(rawValidated).\(defaultExt)")
            }
        } else if !ext.isEmpty {
            guard let inferredMediaType else {
                throw DeviceExecutorError.blockedMediaType(ext)
            }
            mediaType = B3AttachmentLimits.normalizedMediaType(inferredMediaType)
            guard !B3AttachmentLimits.blockedMediaTypes.contains(mediaType),
                  DeviceSandboxWorkspace.allowedOutputMediaTypes.contains(mediaType)
            else {
                throw DeviceExecutorError.blockedMediaType(mediaType)
            }
            validatedFilename = rawValidated
        } else {
            mediaType = "text/plain"
            validatedFilename = try context.workspace.validateSafeRelativeFilename("\(rawValidated).txt")
        }

        let title = arguments["title"]?.stringValue
        let data: Data
        switch mediaType {
        case "application/json":
            data = try buildJSONData(context: context, arguments: arguments)
        case "text/csv":
            data = try buildCSVData(context: context, arguments: arguments)
        case "application/pdf":
            let textContent = try resolveTextContent(context: context, arguments: arguments)
            data = try buildPDFData(title: title ?? validatedFilename, body: textContent, context: context)
        case "text/markdown":
            let textContent = try resolveTextContent(context: context, arguments: arguments)
            let formatted: String
            if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !textContent.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("#") {
                formatted = "# \(title)\n\n\(textContent)"
            } else {
                formatted = textContent
            }
            data = Data(formatted.utf8)
        default:
            let textContent = try resolveTextContent(context: context, arguments: arguments)
            data = Data(textContent.utf8)
        }

        try context.checkCancellation()

        let artifact = try context.workspace.publishArtifact(
            taskID: context.taskID,
            requestedFilename: validatedFilename,
            mediaType: mediaType,
            data: data
        )

        let structured: DeviceJSONValue = .object([
            "artifact_id": .string(artifact.artifactID.uuidString.lowercased()),
            "filename": .string(artifact.filename),
            "media_type": .string(artifact.mediaType),
            "size_bytes": .int(Int64(artifact.sizeBytes)),
            "sha256": .string(artifact.sha256),
            "relative_path": .string(artifact.relativePath),
        ])

        return NativeToolOutput(
            summaryText: "Generated \(artifact.filename) (\(artifact.sizeBytes) bytes, \(artifact.mediaType)).",
            outputText: "Generated local artifact '\(artifact.filename)' (\(artifact.sizeBytes) bytes, sha256: \(artifact.sha256.prefix(12))…).",
            structuredData: structured,
            generatedArtifacts: [artifact]
        )
    }

    private func resolveTextContent(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) throws -> String {
        if let content = try context.resolveStringArgument("content", in: arguments, defaultToPreviousOutput: true) {
            return content
        }
        if let jsonValue = arguments["data"] {
            return try jsonValue.canonicalJSONString(prettyPrinted: true)
        }
        throw DeviceExecutorError.invalidArgument("file.generate requires 'content' or previous step output.")
    }

    private func buildJSONData(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) throws -> Data {
        let pretty = arguments["pretty"]?.boolValue ?? true
        if let dataArg = arguments["data"] {
            guard dataArg.maxDepth <= context.policy.maxJSONDepth else {
                throw DeviceExecutorError.jsonDepthExceeded("JSON nesting depth exceeds limit \(context.policy.maxJSONDepth).")
            }
            let text = try dataArg.canonicalJSONString(prettyPrinted: pretty)
            return Data(text.utf8)
        }

        let rawContent = try resolveTextContent(context: context, arguments: arguments)
        let parsed = try DeviceJSONValue.parse(
            from: rawContent,
            maxBytes: context.policy.maxInputBytes,
            maxDepth: context.policy.maxJSONDepth
        )
        let text = try parsed.canonicalJSONString(prettyPrinted: pretty)
        return Data(text.utf8)
    }

    private func buildCSVData(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) throws -> Data {
        if let headers = arguments["headers"]?.arrayValue?.compactMap(\.stringValue),
           let rows = arguments["rows"]?.arrayValue {
            var lines: [String] = [headers.map(escapeCSV).joined(separator: ",")]
            for (index, rowValue) in rows.enumerated() {
                if index % 128 == 0 {
                    try context.checkCancellation()
                }
                guard let rowArray = rowValue.arrayValue else {
                    throw DeviceExecutorError.invalidArgument("Each entry in 'rows' must be an array.")
                }
                let cells = (0..<headers.count).map { colIdx -> String in
                    guard colIdx < rowArray.count else { return "" }
                    return escapeCSV(csvCellString(rowArray[colIdx]))
                }
                lines.append(cells.joined(separator: ","))
            }
            return Data(lines.joined(separator: "\n").utf8)
        }

        let rawContent = try resolveTextContent(context: context, arguments: arguments)
        return Data(rawContent.utf8)
    }

    private func buildPDFData(
        title: String,
        body: String,
        context: NativeToolExecutionContext
    ) throws -> Data {
        let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792) // US Letter 72 dpi
        let margin: CGFloat = 44
        let contentWidth = pageRect.width - (margin * 2)

        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 18, weight: .bold),
            .foregroundColor: UIColor.label,
        ]
        let metaAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: UIColor.secondaryLabel,
        ]
        let bodyAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: UIColor.label,
        ]

        let headerTitle = NSAttributedString(string: title, attributes: titleAttributes)
        let metaString = NSAttributedString(
            string: "Generated by Ember iPhone Native Executor · \(DeviceWireDate.format(Date()))",
            attributes: metaAttributes
        )
        let bodyAttributed = NSAttributedString(string: body.isEmpty ? " " : body, attributes: bodyAttributes)

        let textStorage = NSTextStorage(attributedString: bodyAttributed)
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)

        let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
        var cancellationError: Error?

        let pdfData = renderer.pdfData { pdfContext in
            var pageIndex = 0
            var currentGlyphIndex = 0
            let totalGlyphs = layoutManager.numberOfGlyphs

            repeat {
                if Task.isCancelled {
                    cancellationError = DeviceExecutorError.cancelled
                    break
                }
                pdfContext.beginPage()
                var topY = margin

                if pageIndex == 0 {
                    let titleRect = CGRect(x: margin, y: topY, width: contentWidth, height: 28)
                    headerTitle.draw(in: titleRect)
                    topY += 26

                    let metaRect = CGRect(x: margin, y: topY, width: contentWidth, height: 16)
                    metaString.draw(in: metaRect)
                    topY += 22
                }

                let textHeight = pageRect.height - topY - margin
                let container = NSTextContainer(size: CGSize(width: contentWidth, height: textHeight))
                container.lineFragmentPadding = 0
                layoutManager.addTextContainer(container)

                let glyphRange = layoutManager.glyphRange(for: container)
                if glyphRange.length > 0 {
                    layoutManager.drawBackground(forGlyphRange: glyphRange, at: CGPoint(x: margin, y: topY))
                    layoutManager.drawGlyphs(forGlyphRange: glyphRange, at: CGPoint(x: margin, y: topY))
                }

                currentGlyphIndex = NSMaxRange(glyphRange)
                pageIndex += 1
                if glyphRange.length == 0 || pageIndex >= 64 {
                    break
                }
            } while currentGlyphIndex < totalGlyphs
        }

        if let cancellationError {
            throw cancellationError
        }
        try context.checkCancellation()
        return pdfData
    }

    private func csvCellString(_ value: DeviceJSONValue) -> String {
        switch value {
        case .null: ""
        case .bool(let b): b ? "true" : "false"
        case .int(let i): String(i)
        case .double(let d): String(d)
        case .string(let s): s
        case .array, .object: (try? value.canonicalJSONString()) ?? ""
        }
    }

    private func escapeCSV(_ value: String) -> String {
        let needsQuoting = value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")
        guard needsQuoting else { return value }
        return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}
