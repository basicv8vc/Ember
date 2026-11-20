import Foundation

public struct DeviceBenchmarkCaseResult: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let iterations: Int
    public let p50Ms: Double
    public let p95Ms: Double
    public let maxMs: Double
    public let meanMs: Double
    public let peakMemoryDeltaBytes: Int64
    public let notes: String

    public var id: String { name }
}

public struct DeviceBenchmarkReport: Codable, Equatable, Sendable {
    public let generatedAt: String
    public let deviceModelIdentifier: String
    public let osVersion: String
    public let thermalState: DeviceThermalLevel
    public let isLowPowerModeEnabled: Bool
    public let cases: [DeviceBenchmarkCaseResult]

    public func markdownSummary() -> String {
        var lines: [String] = [
            "# iPhone Native Executor Benchmark Report",
            "- Generated: \(generatedAt)",
            "- Device: `\(deviceModelIdentifier)`",
            "- OS: `\(osVersion)`",
            "- Thermal: `\(thermalState.rawValue)` · Low Power: `\(isLowPowerModeEnabled)`",
            "",
            "| Case | Iterations | P50 (ms) | P95 (ms) | Max (ms) | Mean (ms) | Memory Delta (KiB) | Notes |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
        ]
        for item in cases {
            let deltaKiB = String(format: "%.1f", Double(item.peakMemoryDeltaBytes) / 1024.0)
            lines.append(
                String(
                    format: "| %@ | %d | %.2f | %.2f | %.2f | %.2f | %@ | %@ |",
                    item.name,
                    item.iterations,
                    item.p50Ms,
                    item.p95Ms,
                    item.maxMs,
                    item.meanMs,
                    deltaKiB,
                    item.notes
                )
            )
        }
        return lines.joined(separator: "\n")
    }
}

/// Reproducible native workload benchmark suite for validating real iPhone performance.
public enum DeviceExecutorBenchmark {
    public static func runSuite(iterations: Int = 5) async throws -> DeviceBenchmarkReport {
        let count = max(1, iterations)
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("EmberBench-\(UUID().uuidString.lowercased())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        let journal = DeviceExecutionJournal(directory: tempRoot)
        let workspace = DeviceSandboxWorkspace(rootDirectory: tempRoot)
        let executor = DeviceTaskExecutor(journal: journal, workspace: workspace)

        let baselineSnapshot = await DeviceResourceMonitor.capture(includeBattery: false)

        let sampleNotes = (0..<120).map { idx in
            "- [ ] Action item #\(idx): verify on-device Swift execution latency and sandbox confinement"
        }.joined(separator: "\n")

        let sampleJSONItems: [DeviceJSONValue] = (0..<1_000).map { (idx: Int) -> DeviceJSONValue in
            let category: String = switch idx % 3 {
            case 0: "compute"
            case 1: "file"
            default: "text"
            }
            let latency = Double((idx % 50) + 1) * 0.75
            let dict: [String: DeviceJSONValue] = [
                "id": .int(Int64(idx)),
                "category": .string(category),
                "latency_ms": .double(latency),
                "ok": .bool(idx % 10 != 0),
            ]
            return .object(dict)
        }
        let sampleJSONString = try DeviceJSONValue.array(sampleJSONItems).canonicalJSONString(prettyPrinted: false)

        var cases: [DeviceBenchmarkCaseResult] = []

        // 1. Native Text Processing (NLTokenizer + Action Item Extraction)
        cases.append(try await measureCase(name: "text_stats_and_extract", iterations: count, notes: "120 lines NLTokenizer + extraction") { iter in
            let submission = DeviceTaskSubmission(
                idempotencyKey: "bench-text-\(iter)-\(UUID().uuidString)",
                title: "Bench Text",
                steps: [
                    DeviceToolStep(stepID: "s1", tool: .textProcess, arguments: ["op": .string("stats"), "text": .string(sampleNotes)]),
                    DeviceToolStep(stepID: "s2", tool: .textProcess, arguments: ["op": .string("extract_action_items"), "text": .string(sampleNotes)]),
                ]
            )
            let outcome = try await executor.executeAndWait(submission)
            guard outcome.status == .completed else {
                throw DeviceExecutorError.invalidArgument("Benchmark text task failed.")
            }
            return outcome.metrics?.memoryDeltaBytes ?? 0
        })

        // 2. Native JSON Aggregate + CSV Conversion (1,000 objects)
        cases.append(try await measureCase(name: "json_1k_aggregate_csv", iterations: count, notes: "1,000 JSON objects filter+group+CSV") { iter in
            let submission = DeviceTaskSubmission(
                idempotencyKey: "bench-json-\(iter)-\(UUID().uuidString)",
                title: "Bench JSON 1k",
                steps: [
                    DeviceToolStep(
                        stepID: "agg",
                        tool: .jsonProcess,
                        arguments: [
                            "op": .string("aggregate"),
                            "json": .string(sampleJSONString),
                            "group_by": .string("category"),
                            "value_field": .string("latency_ms"),
                        ]
                    ),
                    DeviceToolStep(
                        stepID: "csv",
                        tool: .jsonProcess,
                        arguments: [
                            "op": .string("to_csv"),
                            "json": .string(sampleJSONString),
                            "columns": .array([.string("id"), .string("category"), .string("latency_ms"), .string("ok")]),
                        ]
                    ),
                ]
            )
            let outcome = try await executor.executeAndWait(submission)
            guard outcome.status == .completed else {
                throw DeviceExecutorError.invalidArgument("Benchmark JSON task failed.")
            }
            return outcome.metrics?.memoryDeltaBytes ?? 0
        })

        // 3. Sandboxed File Generation (Markdown + CSV + Native PDF)
        cases.append(try await measureCase(name: "file_generate_md_csv_pdf", iterations: count, notes: "Atomic MD + CSV + UIGraphicsPDFRenderer") { iter in
            let submission = DeviceTaskSubmission(
                idempotencyKey: "bench-file-\(iter)-\(UUID().uuidString)",
                title: "Bench File Gen",
                steps: [
                    DeviceToolStep(
                        stepID: "md",
                        tool: .fileGenerate,
                        arguments: [
                            "filename": .string("summary-\(iter).md"),
                            "title": .string("Ember Device Report"),
                            "content": .string(sampleNotes),
                        ]
                    ),
                    DeviceToolStep(
                        stepID: "csv",
                        tool: .fileGenerate,
                        arguments: [
                            "filename": .string("summary-\(iter).csv"),
                            "headers": .array([.string("step"), .string("node"), .string("status")]),
                            "rows": .array([
                                .array([.string("text"), .string("iphone"), .string("ok")]),
                                .array([.string("json"), .string("iphone"), .string("ok")]),
                            ]),
                        ]
                    ),
                    DeviceToolStep(
                        stepID: "pdf",
                        tool: .fileGenerate,
                        arguments: [
                            "filename": .string("summary-\(iter).pdf"),
                            "title": .string("Ember Device PDF"),
                            "content": .string(sampleNotes),
                        ]
                    ),
                ]
            )
            let outcome = try await executor.executeAndWait(submission)
            guard outcome.status == .completed, outcome.artifacts.count == 3 else {
                throw DeviceExecutorError.invalidArgument("Benchmark file task failed.")
            }
            return outcome.metrics?.memoryDeltaBytes ?? 0
        })

        // 4. Cold-Start Journal Recovery Latency
        cases.append(try await measureCase(name: "cold_journal_recovery", iterations: count, notes: "Recover queued+running+terminal records") { _ in
            let recoveryDir = tempRoot.appendingPathComponent("recovery-\(UUID().uuidString.lowercased())", isDirectory: true)
            let oldExecutor = DeviceTaskExecutor(
                journal: DeviceExecutionJournal(directory: recoveryDir),
                workspace: DeviceSandboxWorkspace(rootDirectory: recoveryDir),
                bootSessionID: UUID()
            )
            _ = try await oldExecutor.submitTask(
                DeviceTaskSubmission(
                    idempotencyKey: "rec-q-\(UUID().uuidString)",
                    steps: [DeviceToolStep(tool: .textProcess, arguments: ["op": .string("stats"), "text": .string("hello")])]
                ),
                startImmediately: false
            )
            let newExecutor = DeviceTaskExecutor(
                journal: DeviceExecutionJournal(directory: recoveryDir),
                workspace: DeviceSandboxWorkspace(rootDirectory: recoveryDir),
                bootSessionID: UUID()
            )
            let report = try await newExecutor.recoverAndResumeIfNeeded(autoStart: false)
            guard report.recoveredQueuedCount == 1 else {
                throw DeviceExecutorError.invalidArgument("Expected 1 recovered queued task.")
            }
            return 0
        })

        let endSnapshot = await DeviceResourceMonitor.capture(includeBattery: false)

        return DeviceBenchmarkReport(
            generatedAt: DeviceWireDate.format(Date()),
            deviceModelIdentifier: endSnapshot.deviceModelIdentifier,
            osVersion: endSnapshot.osVersion,
            thermalState: endSnapshot.thermalState,
            isLowPowerModeEnabled: baselineSnapshot.isLowPowerModeEnabled || endSnapshot.isLowPowerModeEnabled,
            cases: cases
        )
    }

    private static func measureCase(
        name: String,
        iterations: Int,
        notes: String,
        block: (Int) async throws -> Int64
    ) async throws -> DeviceBenchmarkCaseResult {
        var samplesMs: [Double] = []
        var maxDeltaBytes: Int64 = 0

        for idx in 0..<iterations {
            let start = DispatchTime.now().uptimeNanoseconds
            let memDelta = try await block(idx)
            let elapsedNs = DispatchTime.now().uptimeNanoseconds - start
            samplesMs.append(Double(elapsedNs) / 1_000_000.0)
            if memDelta > maxDeltaBytes {
                maxDeltaBytes = memDelta
            }
        }

        let sorted = samplesMs.sorted()
        let p50 = percentile(sorted, p: 0.50)
        let p95 = percentile(sorted, p: 0.95)
        let maxVal = sorted.last ?? 0
        let meanVal = sorted.reduce(0, +) / Double(max(1, sorted.count))

        return DeviceBenchmarkCaseResult(
            name: name,
            iterations: iterations,
            p50Ms: p50,
            p95Ms: p95,
            maxMs: maxVal,
            meanMs: meanVal,
            peakMemoryDeltaBytes: maxDeltaBytes,
            notes: notes
        )
    }

    private static func percentile(_ sorted: [Double], p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let idx = min(sorted.count - 1, max(0, Int(ceil(Double(sorted.count) * p)) - 1))
        return sorted[idx]
    }
}
