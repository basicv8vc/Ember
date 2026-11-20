import SwiftUI
import UIKit

/// Interactive Workbench for running, cancelling, recovering, and benchmarking
/// the M2-C1 iPhone Native Executor on simulator or physical iPhone.
/// Accessible via `--ember-device-executor` launch argument.
@MainActor @Observable
final class DeviceExecutorWorkbenchModel {
    let executor: DeviceTaskExecutor
    let taskStore: SessionTaskStore
    let cloudMonitor: CloudDeviceAdapterMonitor

    private(set) var isRunningTask = false
    private(set) var isRunningBenchmark = false
    private(set) var lastRecoverySummary: String?
    private(set) var lastOutcomeMetrics: DeviceExecutionMetrics?
    private(set) var benchmarkReport: DeviceBenchmarkReport?
    private(set) var statusMessage: String?

    init(
        executor: DeviceTaskExecutor = DeviceTaskExecutor(),
        cloudMonitor: CloudDeviceAdapterMonitor = CloudDeviceAdapterMonitor()
    ) {
        self.executor = executor
        self.taskStore = SessionTaskStore(
            repository: DeviceSessionTaskRepository(executor: executor)
        )
        self.cloudMonitor = cloudMonitor
    }

    func bootstrap() async {
        do {
            let report = try await executor.recoverAndResumeIfNeeded(autoStart: true)
            lastRecoverySummary = "Queued: \(report.recoveredQueuedCount) · Interrupted: \(report.recoveredInterruptedCount) · Cancelled: \(report.convergedCancelledCount) · Terminal: \(report.restoredTerminalCount)"
            await taskStore.refreshAll()
            if ProcessInfo.processInfo.arguments.contains("--ember-cloud-adapter-qa") {
                await cloudMonitor.connectFromQAFileIfPresent()
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func handleScenePhase(_ phase: ScenePhase) async {
        await executor.handleScenePhase(phase)
        if phase == .active {
            await taskStore.refreshAll()
        }
    }

    func runNotesToMarkdownAndPDFSample() async {
        let notes = """
        # Ember Q4 Mobile Execution Notes
        - [ ] Verify native Swift text & JSON tools inside iOS App Sandbox
        - [ ] Measure iPhone 12 Pro Max latency and memory footprint
        - [ ] Validate task cancellation and cold-start state recovery
        ACTION: Share generated PDF and Markdown artifacts with Agent F
        """
        let submission = DeviceTaskSubmission(
            idempotencyKey: "ui-notes-\(UUID().uuidString.lowercased())",
            title: "Extract Action Items → MD + PDF",
            steps: [
                DeviceToolStep(
                    stepID: "extract",
                    tool: .textProcess,
                    arguments: ["op": .string("extract_action_items"), "text": .string(notes)]
                ),
                DeviceToolStep(
                    stepID: "md",
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("action-items.md"),
                        "title": .string("Extracted Action Items"),
                        "content": .string("{{prev.text}}"),
                    ]
                ),
                DeviceToolStep(
                    stepID: "pdf",
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("action-items.pdf"),
                        "title": .string("Ember On-Device Action Items"),
                        "content": .string("{{steps.extract.text}}"),
                    ]
                ),
            ]
        )
        await runSubmission(submission)
    }

    func runJSONAggregateToCSVSample() async {
        let payload = """
        [
          {"node": "iphone", "tool": "text", "duration_ms": 4.2, "status": "ok"},
          {"node": "iphone", "tool": "json", "duration_ms": 6.8, "status": "ok"},
          {"node": "iphone", "tool": "file", "duration_ms": 11.4, "status": "ok"},
          {"node": "cloud", "tool": "python", "duration_ms": 420.0, "status": "ok"}
        ]
        """
        let submission = DeviceTaskSubmission(
            idempotencyKey: "ui-json-\(UUID().uuidString.lowercased())",
            title: "JSON Aggregate → CSV Export",
            steps: [
                DeviceToolStep(
                    stepID: "agg",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("aggregate"),
                        "json": .string(payload),
                        "where": .object(["field": .string("node"), "equals": .string("iphone")]),
                        "group_by": .string("tool"),
                        "value_field": .string("duration_ms"),
                    ]
                ),
                DeviceToolStep(
                    stepID: "csv",
                    tool: .jsonProcess,
                    arguments: [
                        "op": .string("to_csv"),
                        "json": .string(payload),
                        "columns": .array([.string("node"), .string("tool"), .string("duration_ms"), .string("status")]),
                    ]
                ),
                DeviceToolStep(
                    stepID: "file",
                    tool: .fileGenerate,
                    arguments: [
                        "filename": .string("device-metrics.csv"),
                        "content": .string("{{prev.text}}"),
                    ]
                ),
            ]
        )
        await runSubmission(submission)
    }

    func runBenchmark() async {
        guard !isRunningBenchmark else { return }
        isRunningBenchmark = true
        defer { isRunningBenchmark = false }
        do {
            benchmarkReport = try await DeviceExecutorBenchmark.runSuite(iterations: 5)
            statusMessage = "Benchmark completed on \(benchmarkReport?.deviceModelIdentifier ?? "device")."
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func runSubmission(_ submission: DeviceTaskSubmission) async {
        guard !isRunningTask else { return }
        isRunningTask = true
        defer { isRunningTask = false }
        do {
            let outcome = try await executor.executeAndWait(submission)
            lastOutcomeMetrics = outcome.metrics
            statusMessage = "Task \(outcome.status.rawValue) in \(outcome.metrics?.wallDurationMs ?? 0) ms."
            await taskStore.refreshAll()
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}

struct DeviceExecutorWorkbenchView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State var model: DeviceExecutorWorkbenchModel
    @State private var navigationPath: [UUID] = []

    var body: some View {
        NavigationStack(path: $navigationPath) {
            List {
                Section("Node Status & Recovery") {
                    LabeledContent("Executor", value: "iphone-native-executor-v1")
                    LabeledContent("Thermal", value: DeviceResourceMonitor.currentThermalLevel().rawValue)
                    if let recovery = model.lastRecoverySummary {
                        Text(recovery)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let status = model.statusMessage {
                        Text(status)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .accessibilityIdentifier("device-status-message")
                    }
                }

                Section("Run Native Tool Pipeline") {
                    Button {
                        Task { await model.runNotesToMarkdownAndPDFSample() }
                    } label: {
                        Label("Text Extract → Markdown + PDF", systemImage: "doc.richtext")
                    }
                    .disabled(model.isRunningTask)
                    .accessibilityIdentifier("device-run-notes-pdf")

                    Button {
                        Task { await model.runJSONAggregateToCSVSample() }
                    } label: {
                        Label("JSON Query/Aggregate → CSV", systemImage: "tablecells")
                    }
                    .disabled(model.isRunningTask)
                    .accessibilityIdentifier("device-run-json-csv")

                    Button {
                        Task { await model.runBenchmark() }
                    } label: {
                        HStack {
                            Label("Run On-Device Benchmark (5x)", systemImage: "speedometer")
                            if model.isRunningBenchmark {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(model.isRunningBenchmark)
                    .accessibilityIdentifier("device-run-benchmark")
                }

                Section("Persisted On-Device Tasks (\(model.taskStore.orderedTasks.count))") {
                    ForEach(model.taskStore.orderedTasks) { task in
                        Button {
                            navigationPath.append(task.taskID)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(task.displayTitle)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.primary)
                                    Text("\(task.status.rawValue) · attempt \(task.attemptCount)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .accessibilityIdentifier("device-task-row-\(task.taskID.uuidString.lowercased())")
                    }
                }

                if let metrics = model.lastOutcomeMetrics {
                    Section("Last Execution Telemetry") {
                        LabeledContent("Device", value: metrics.deviceModelIdentifier)
                        LabeledContent("Wall Latency", value: "\(metrics.wallDurationMs) ms")
                        LabeledContent("CPU (user/sys)", value: String(format: "%.2f / %.2f ms", metrics.cpuUserMs, metrics.cpuSystemMs))
                        LabeledContent("Memory After", value: ByteCountFormatter.string(fromByteCount: Int64(metrics.memoryFootprintAfterBytes), countStyle: .memory))
                    }
                }

                if let report = model.benchmarkReport {
                    Section("Benchmark Results (\(report.deviceModelIdentifier))") {
                        ForEach(report.cases) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(.subheadline.weight(.semibold))
                                Text(String(format: "P50: %.2f ms · P95: %.2f ms · Max: %.2f ms", item.p50Ms, item.p95Ms, item.maxMs))
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Button("Copy Markdown Report") {
                            UIPasteboard.general.string = report.markdownSummary()
                        }
                    }
                }

                Section("Cloud Device Adapter (M2-C2)") {
                    LabeledContent("Status", value: model.cloudMonitor.statusLabel)
                    if let deviceID = model.cloudMonitor.deviceID {
                        LabeledContent("Device ID", value: deviceID.uuidString.lowercased())
                    }
                    if let summary = model.cloudMonitor.summary {
                        Text("Committed: \(summary.committedCount) · Pending: \(summary.pendingCommitCount) · Fenced: \(summary.fencedCount)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let lastEvent = model.cloudMonitor.lastEvent {
                        Text(lastEvent)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        Task {
                            if model.cloudMonitor.isRunning {
                                await model.cloudMonitor.stop()
                            } else {
                                await model.cloudMonitor.connectFromQAFileIfPresent()
                            }
                        }
                    } label: {
                        Label(
                            model.cloudMonitor.isRunning ? "Stop Cloud Adapter" : "Connect Local V2 Relay",
                            systemImage: model.cloudMonitor.isRunning ? "stop.circle" : "antenna.radiowaves.left.and.right"
                        )
                    }
                    .accessibilityIdentifier("cloud-adapter-toggle")
                }
            }
            .navigationTitle("iPhone Native Executor")
            .navigationDestination(for: UUID.self) { taskID in
                TaskDetailView(taskID: taskID, store: model.taskStore)
            }
            .task {
                await model.bootstrap()
            }
            .onChange(of: scenePhase) { _, newPhase in
                Task { await model.handleScenePhase(newPhase) }
            }
        }
    }
}
