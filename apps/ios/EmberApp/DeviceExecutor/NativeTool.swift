import Foundation

/// Execution context passed to each NativeTool invocation.
public struct NativeToolExecutionContext: Sendable {
    public let taskID: UUID
    public let runID: UUID
    public let stepIndex: Int
    public let stepID: String
    public let workspace: DeviceSandboxWorkspace
    public let policy: DeviceSandboxPolicy
    public let previousStepOutputs: [String: NativeToolOutput]
    public let lastStepOutput: NativeToolOutput?
    private let cancellationProbe: @Sendable () throws -> Void

    public init(
        taskID: UUID,
        runID: UUID,
        stepIndex: Int,
        stepID: String,
        workspace: DeviceSandboxWorkspace,
        policy: DeviceSandboxPolicy,
        previousStepOutputs: [String: NativeToolOutput] = [:],
        lastStepOutput: NativeToolOutput? = nil,
        cancellationProbe: @escaping @Sendable () throws -> Void = { try Task.checkCancellation() }
    ) {
        self.taskID = taskID
        self.runID = runID
        self.stepIndex = stepIndex
        self.stepID = stepID
        self.workspace = workspace
        self.policy = policy
        self.previousStepOutputs = previousStepOutputs
        self.lastStepOutput = lastStepOutput
        self.cancellationProbe = cancellationProbe
    }

    public func checkCancellation() throws {
        try Task.checkCancellation()
        try cancellationProbe()
    }

    /// Resolves template references such as `{{prev.text}}`, `{{prev.json}}`,
    /// or `{{steps.<stepID>.text}}` / `{{steps.<stepID>.json}}`.
    public func resolveStringArgument(
        _ key: String,
        in arguments: [String: DeviceJSONValue],
        defaultToPreviousOutput: Bool = false
    ) throws -> String? {
        if let raw = arguments[key]?.stringValue {
            if raw == "{{prev.text}}" {
                guard let lastStepOutput else {
                    throw DeviceExecutorError.invalidArgument("Missing previous step output for '{{prev.text}}'.")
                }
                return lastStepOutput.outputText
            }
            if raw == "{{prev.json}}" {
                guard let json = lastStepOutput?.structuredData else {
                    throw DeviceExecutorError.invalidArgument("Missing previous step JSON output for '{{prev.json}}'.")
                }
                return try json.canonicalJSONString(prettyPrinted: false)
            }
            if raw.hasPrefix("{{steps."), raw.hasSuffix("}}") {
                let inner = String(raw.dropFirst(8).dropLast(2))
                let parts = inner.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2 {
                    let targetStepID = String(parts[0])
                    let field = String(parts[1])
                    guard let output = previousStepOutputs[targetStepID] else {
                        throw DeviceExecutorError.invalidArgument("Referenced step '\(targetStepID)' not found.")
                    }
                    if field == "text" {
                        return output.outputText
                    }
                    if field == "json", let data = output.structuredData {
                        return try data.canonicalJSONString(prettyPrinted: false)
                    }
                }
            }
            return raw
        }

        if defaultToPreviousOutput, let lastStepOutput {
            return lastStepOutput.outputText
        }
        return nil
    }
}

/// Protocol implemented by all Apple-native on-device tools.
public protocol NativeTool: Sendable {
    var name: DeviceToolName { get }
    func execute(
        context: NativeToolExecutionContext,
        arguments: [String: DeviceJSONValue]
    ) async throws -> NativeToolOutput
}

/// Registry mapping tool names to native Swift tool implementations.
public struct NativeToolRegistry: Sendable {
    private let toolsByName: [DeviceToolName: any NativeTool]

    public init(tools: [any NativeTool] = NativeToolRegistry.defaultTools()) {
        var map: [DeviceToolName: any NativeTool] = [:]
        for tool in tools {
            map[tool.name] = tool
        }
        self.toolsByName = map
    }

    public static func defaultTools() -> [any NativeTool] {
        [
            NativeTextTool(),
            NativeJSONTool(),
            NativeFileGeneratorTool(),
        ]
    }

    public var registeredToolNames: [DeviceToolName] {
        toolsByName.keys.sorted { $0.rawValue < $1.rawValue }
    }

    public func tool(named name: DeviceToolName) throws -> any NativeTool {
        guard let tool = toolsByName[name] else {
            throw DeviceExecutorError.unsupportedTool(name.rawValue)
        }
        return tool
    }
}
