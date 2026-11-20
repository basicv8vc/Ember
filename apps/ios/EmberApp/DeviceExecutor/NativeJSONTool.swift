import Foundation

/// Apple-native JSON validation, query, aggregation, and tabular conversion tool.
public struct NativeJSONTool: NativeTool {
    public let name: DeviceToolName = .jsonProcess

    public init() {}

    public func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput {
        try context.checkCancellation()

        let root = try resolveJSONInput(context: context, arguments: arguments)
        let op = (arguments["op"]?.stringValue ?? "validate").lowercased()

        switch op {
        case "validate":
            return try runValidate(root: root, arguments: arguments, context: context)
        case "query":
            return try runQuery(root: root, arguments: arguments, context: context)
        case "aggregate":
            return try runAggregate(root: root, arguments: arguments, context: context)
        case "pick_keys":
            return try runPickKeys(root: root, arguments: arguments, context: context)
        case "to_csv":
            return try runToCSV(root: root, arguments: arguments, context: context)
        default:
            throw DeviceExecutorError.invalidArgument("Unsupported JSON operation '\(op)'.")
        }
    }

    private func resolveJSONInput(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) throws -> DeviceJSONValue {
        if let rawValue = arguments["json"] {
            switch rawValue {
            case .string(let text):
                let resolvedText = try resolveTemplateString(text, context: context)
                return try DeviceJSONValue.parse(
                    from: resolvedText,
                    maxBytes: context.policy.maxInputBytes,
                    maxDepth: context.policy.maxJSONDepth
                )
            default:
                guard rawValue.maxDepth <= context.policy.maxJSONDepth else {
                    throw DeviceExecutorError.jsonDepthExceeded(
                        "JSON nesting depth \(rawValue.maxDepth) exceeds limit \(context.policy.maxJSONDepth)."
                    )
                }
                return rawValue
            }
        }

        if let dataValue = arguments["data"] {
            guard dataValue.maxDepth <= context.policy.maxJSONDepth else {
                throw DeviceExecutorError.jsonDepthExceeded(
                    "JSON nesting depth \(dataValue.maxDepth) exceeds limit \(context.policy.maxJSONDepth)."
                )
            }
            return dataValue
        }

        if let prev = context.lastStepOutput {
            if let structured = prev.structuredData {
                return structured
            }
            return try DeviceJSONValue.parse(
                from: prev.outputText,
                maxBytes: context.policy.maxInputBytes,
                maxDepth: context.policy.maxJSONDepth
            )
        }

        throw DeviceExecutorError.invalidArgument("JSON tool requires a 'json' or 'data' argument.")
    }

    private func resolveTemplateString(_ raw: String, context: NativeToolExecutionContext) throws -> String {
        if raw == "{{prev.json}}" {
            guard let data = context.lastStepOutput?.structuredData else {
                throw DeviceExecutorError.invalidArgument("Missing previous step JSON for '{{prev.json}}'.")
            }
            return try data.canonicalJSONString(prettyPrinted: false)
        }
        if raw == "{{prev.text}}" {
            guard let text = context.lastStepOutput?.outputText else {
                throw DeviceExecutorError.invalidArgument("Missing previous step text for '{{prev.text}}'.")
            }
            return text
        }
        return raw
    }

    private func runValidate(
        root: DeviceJSONValue,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        try context.checkCancellation()
        let pretty = arguments["pretty"]?.boolValue ?? true
        let canonical = try root.canonicalJSONString(prettyPrinted: pretty)
        let depth = root.maxDepth

        let rootType: String
        let itemCount: Int
        switch root {
        case .object(let dict):
            rootType = "object"
            itemCount = dict.count
        case .array(let items):
            rootType = "array"
            itemCount = items.count
        case .string:
            rootType = "string"
            itemCount = 1
        case .int, .double:
            rootType = "number"
            itemCount = 1
        case .bool:
            rootType = "boolean"
            itemCount = 1
        case .null:
            rootType = "null"
            itemCount = 0
        }

        let summaryPayload: DeviceJSONValue = .object([
            "valid": .bool(true),
            "root_type": .string(rootType),
            "top_level_count": .int(Int64(itemCount)),
            "max_depth": .int(Int64(depth)),
            "canonical_bytes": .int(Int64(Data(canonical.utf8).count)),
        ])

        return NativeToolOutput(
            summaryText: "Validated JSON \(rootType) (\(itemCount) top-level item(s), depth \(depth)).",
            outputText: canonical,
            structuredData: summaryPayload
        )
    }

    private func runQuery(
        root: DeviceJSONValue,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        guard let path = arguments["path"]?.stringValue, !path.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw DeviceExecutorError.invalidArgument("JSON query requires a non-empty 'path'.")
        }
        try context.checkCancellation()
        let tokens = try parsePath(path)
        let matches = try evaluatePath(tokens, on: root, context: context)

        let resultValue: DeviceJSONValue = matches.count == 1 ? matches[0] : .array(matches)
        let outputText = try resultValue.canonicalJSONString(prettyPrinted: true)
        return NativeToolOutput(
            summaryText: "JSON path '\(path)' matched \(matches.count) value(s).",
            outputText: outputText,
            structuredData: .object([
                "path": .string(path),
                "match_count": .int(Int64(matches.count)),
                "result": resultValue,
            ])
        )
    }

    private func runAggregate(
        root: DeviceJSONValue,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let records = try extractArrayTarget(root: root, path: arguments["path"]?.stringValue, context: context)
        let filtered = try applyFilter(records: records, whereSpec: arguments["where"]?.objectValue, context: context)
        let groupBy = arguments["group_by"]?.stringValue
        let valueField = arguments["value_field"]?.stringValue

        if let groupBy, !groupBy.isEmpty {
            var groups: [String: [DeviceJSONValue]] = [:]
            for (index, item) in filtered.enumerated() {
                if index % 128 == 0 {
                    try context.checkCancellation()
                }
                let key = stringKey(for: fieldValue(named: groupBy, in: item))
                groups[key, default: []].append(item)
            }

            var groupSummaries: [String: DeviceJSONValue] = [:]
            for key in groups.keys.sorted() {
                let items = groups[key] ?? []
                groupSummaries[key] = computeStats(items: items, valueField: valueField)
            }

            let structured: DeviceJSONValue = .object([
                "total_records": .int(Int64(records.count)),
                "matched_records": .int(Int64(filtered.count)),
                "group_by": .string(groupBy),
                "groups": .object(groupSummaries),
            ])
            return NativeToolOutput(
                summaryText: "Aggregated \(filtered.count) record(s) into \(groupSummaries.count) group(s).",
                outputText: try structured.canonicalJSONString(prettyPrinted: true),
                structuredData: structured
            )
        } else {
            let stats = computeStats(items: filtered, valueField: valueField)
            let structured: DeviceJSONValue = .object([
                "total_records": .int(Int64(records.count)),
                "matched_records": .int(Int64(filtered.count)),
                "stats": stats,
            ])
            return NativeToolOutput(
                summaryText: "Aggregated \(filtered.count) record(s).",
                outputText: try structured.canonicalJSONString(prettyPrinted: true),
                structuredData: structured
            )
        }
    }

    private func runPickKeys(
        root: DeviceJSONValue,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        guard let keyValues = arguments["keys"]?.arrayValue else {
            throw DeviceExecutorError.invalidArgument("pick_keys requires a 'keys' string array.")
        }
        let keys = keyValues.compactMap(\.stringValue)
        guard !keys.isEmpty else {
            throw DeviceExecutorError.invalidArgument("pick_keys 'keys' array cannot be empty.")
        }

        let target: DeviceJSONValue
        if let path = arguments["path"]?.stringValue, !path.isEmpty {
            let tokens = try parsePath(path)
            let matched = try evaluatePath(tokens, on: root, context: context)
            target = matched.count == 1 ? matched[0] : .array(matched)
        } else {
            target = root
        }

        let projected: DeviceJSONValue
        switch target {
        case .object(let dict):
            projected = project(dict: dict, keys: keys)
        case .array(let items):
            var projectedItems: [DeviceJSONValue] = []
            projectedItems.reserveCapacity(items.count)
            for (index, item) in items.enumerated() {
                if index % 128 == 0 {
                    try context.checkCancellation()
                }
                if case .object(let dict) = item {
                    projectedItems.append(project(dict: dict, keys: keys))
                }
            }
            projected = .array(projectedItems)
        default:
            throw DeviceExecutorError.invalidArgument("pick_keys target must be a JSON object or array of objects.")
        }

        return NativeToolOutput(
            summaryText: "Projected \(keys.count) key(s) from JSON payload.",
            outputText: try projected.canonicalJSONString(prettyPrinted: true),
            structuredData: projected
        )
    }

    private func runToCSV(
        root: DeviceJSONValue,
        arguments: [String: DeviceJSONValue],
        context: NativeToolExecutionContext
    ) throws -> NativeToolOutput {
        let records = try extractArrayTarget(root: root, path: arguments["path"]?.stringValue, context: context)
        let rows: [[String: DeviceJSONValue]] = records.compactMap(\.objectValue)
        guard !rows.isEmpty else {
            throw DeviceExecutorError.invalidArgument("to_csv requires a non-empty array of JSON objects.")
        }

        let columns: [String]
        if let explicitColumns = arguments["columns"]?.arrayValue?.compactMap(\.stringValue), !explicitColumns.isEmpty {
            columns = explicitColumns
        } else {
            var columnSet = Set<String>()
            for row in rows {
                columnSet.formUnion(row.keys)
            }
            columns = columnSet.sorted()
        }

        var lines: [String] = [columns.map(escapeCSVField).joined(separator: ",")]
        lines.reserveCapacity(rows.count + 1)

        for (index, row) in rows.enumerated() {
            if index % 128 == 0 {
                try context.checkCancellation()
            }
            let cells = columns.map { column in
                let value = row[column] ?? .null
                return escapeCSVField(stringCell(for: value))
            }
            lines.append(cells.joined(separator: ","))
        }

        let csvText = lines.joined(separator: "\n")
        return NativeToolOutput(
            summaryText: "Converted \(rows.count) JSON record(s) into \(columns.count)-column CSV.",
            outputText: csvText,
            structuredData: .object([
                "row_count": .int(Int64(rows.count)),
                "columns": .array(columns.map { .string($0) }),
            ])
        )
    }

    private enum PathToken {
        case key(String)
        case index(Int)
        case wildcard
    }

    private func parsePath(_ rawPath: String) throws -> [PathToken] {
        var cleaned = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("$.") {
            cleaned = String(cleaned.dropFirst(2))
        } else if cleaned == "$" {
            return []
        } else if cleaned.hasPrefix("$") {
            cleaned = String(cleaned.dropFirst(1))
        }

        var tokens: [PathToken] = []
        let segments = cleaned.split(separator: ".", omittingEmptySubsequences: true)
        for segment in segments {
            var remaining = String(segment)
            while !remaining.isEmpty {
                if remaining == "*" {
                    tokens.append(.wildcard)
                    break
                }
                if let bracketStart = remaining.firstIndex(of: "[") {
                    let prefix = String(remaining[..<bracketStart])
                    if !prefix.isEmpty {
                        tokens.append(.key(prefix))
                    }
                    guard let bracketEnd = remaining[bracketStart...].firstIndex(of: "]") else {
                        throw DeviceExecutorError.invalidArgument("Unclosed '[' in JSON path '\(rawPath)'.")
                    }
                    let indexContent = String(remaining[remaining.index(after: bracketStart)..<bracketEnd])
                    if indexContent == "*" {
                        tokens.append(.wildcard)
                    } else if let idx = Int(indexContent), idx >= 0 {
                        tokens.append(.index(idx))
                    } else {
                        throw DeviceExecutorError.invalidArgument("Invalid array index '[\(indexContent)]' in JSON path.")
                    }
                    remaining = String(remaining[remaining.index(after: bracketEnd)...])
                } else {
                    tokens.append(.key(remaining))
                    break
                }
            }
        }
        return tokens
    }

    private func evaluatePath(
        _ tokens: [PathToken],
        on root: DeviceJSONValue,
        context: NativeToolExecutionContext
    ) throws -> [DeviceJSONValue] {
        var current: [DeviceJSONValue] = [root]
        for token in tokens {
            try context.checkCancellation()
            var next: [DeviceJSONValue] = []
            for value in current {
                switch (token, value) {
                case (.key(let key), .object(let dict)):
                    if let found = dict[key] {
                        next.append(found)
                    }
                case (.index(let index), .array(let items)):
                    if index < items.count {
                        next.append(items[index])
                    }
                case (.wildcard, .array(let items)):
                    next.append(contentsOf: items)
                case (.wildcard, .object(let dict)):
                    for key in dict.keys.sorted() {
                        if let item = dict[key] {
                            next.append(item)
                        }
                    }
                default:
                    break
                }
            }
            current = next
        }
        return current
    }

    private func extractArrayTarget(
        root: DeviceJSONValue,
        path: String?,
        context: NativeToolExecutionContext
    ) throws -> [DeviceJSONValue] {
        let target: DeviceJSONValue
        if let path, !path.isEmpty {
            let tokens = try parsePath(path)
            let matches = try evaluatePath(tokens, on: root, context: context)
            if matches.count == 1, case .array(let items) = matches[0] {
                return items
            }
            return matches
        } else {
            target = root
        }

        guard case .array(let items) = target else {
            throw DeviceExecutorError.invalidArgument("Expected JSON array for operation.")
        }
        return items
    }

    private func applyFilter(
        records: [DeviceJSONValue],
        whereSpec: [String: DeviceJSONValue]?,
        context: NativeToolExecutionContext
    ) throws -> [DeviceJSONValue] {
        guard let whereSpec,
              let field = whereSpec["field"]?.stringValue,
              !field.isEmpty
        else {
            return records
        }

        var result: [DeviceJSONValue] = []
        for (index, item) in records.enumerated() {
            if index % 128 == 0 {
                try context.checkCancellation()
            }
            let actual = fieldValue(named: field, in: item)
            if let equalsValue = whereSpec["equals"] {
                if actual == equalsValue {
                    result.append(item)
                }
            } else if let containsText = whereSpec["contains"]?.stringValue {
                if let actualText = actual?.stringValue, actualText.localizedCaseInsensitiveContains(containsText) {
                    result.append(item)
                }
            } else if let gt = whereSpec["gt"]?.doubleValue {
                if let actualNum = actual?.doubleValue, actualNum > gt {
                    result.append(item)
                }
            } else if let lt = whereSpec["lt"]?.doubleValue {
                if let actualNum = actual?.doubleValue, actualNum < lt {
                    result.append(item)
                }
            } else {
                result.append(item)
            }
        }
        return result
    }

    private func computeStats(items: [DeviceJSONValue], valueField: String?) -> DeviceJSONValue {
        var result: [String: DeviceJSONValue] = [
            "count": .int(Int64(items.count)),
        ]
        if let valueField, !valueField.isEmpty {
            let numbers = items.compactMap { fieldValue(named: valueField, in: $0)?.doubleValue }
            result["numeric_count"] = .int(Int64(numbers.count))
            if !numbers.isEmpty {
                let sum = numbers.reduce(0, +)
                let avg = sum / Double(numbers.count)
                let minVal = numbers.min() ?? 0
                let maxVal = numbers.max() ?? 0
                result["sum"] = .double(sum)
                result["avg"] = .double(avg)
                result["min"] = .double(minVal)
                result["max"] = .double(maxVal)
            }
        }
        return .object(result)
    }

    private func fieldValue(named field: String, in item: DeviceJSONValue) -> DeviceJSONValue? {
        guard case .object(let dict) = item else { return nil }
        return dict[field]
    }

    private func project(dict: [String: DeviceJSONValue], keys: [String]) -> DeviceJSONValue {
        var projected: [String: DeviceJSONValue] = [:]
        for key in keys {
            if let val = dict[key] {
                projected[key] = val
            }
        }
        return .object(projected)
    }

    private func stringKey(for value: DeviceJSONValue?) -> String {
        guard let value else { return "null" }
        switch value {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .double(let d): return String(d)
        case .string(let s): return s
        case .array, .object: return (try? value.canonicalJSONString()) ?? "complex"
        }
    }

    private func stringCell(for value: DeviceJSONValue) -> String {
        switch value {
        case .null: return ""
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .double(let d): return String(d)
        case .string(let s): return s
        case .array, .object: return (try? value.canonicalJSONString()) ?? ""
        }
    }

    private func escapeCSVField(_ value: String) -> String {
        let needsQuoting = value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")
        guard needsQuoting else { return value }
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}
