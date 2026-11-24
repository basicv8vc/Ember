import Darwin
import XCTest
@testable import Ember

final class ConversationCardRendererTests: XCTestCase {
    func testTaskActivityPreservesQueuedRunningAndCompletedSnapshots() {
        for status in [TaskStatus.queued, .running, .completed] {
            let connection: ConnectionPhase = status == .running ? .connecting : .connected
            let command: TaskCommandInFlight? = status == .running ? .cancellingTask : nil
            let record = makeRecord(
                taskStatus: status,
                presentationStatus: status,
                connection: connection,
                command: command
            )

            let facts = TaskActivityCard.facts(
                for: record.task,
                presentation: record.presentation,
                cancelResponse: nil
            )

            XCTAssertEqual(facts.status, status)
            XCTAssertEqual(facts.connectionPhase, connection)
            XCTAssertEqual(facts.commandInFlight, command)
            XCTAssertFalse(facts.cancellationPending)
        }
    }

    func testTaskStatusRemainsIndependentFromConversationReplyState() {
        let conversationReplyState = ConversationReplyState.generating
        let record = makeRecord(
            taskStatus: .completed,
            presentationStatus: .queued,
            title: "The conversation is still waiting for a response"
        )

        let facts = TaskActivityCard.facts(
            for: record.task,
            presentation: record.presentation,
            cancelResponse: nil
        )

        XCTAssertEqual(conversationReplyState, .generating)
        XCTAssertEqual(facts.status, .completed)
        XCTAssertEqual(record.presentation.taskStatus, .queued)
    }

    func testActivityEventsRenderOnlySuppliedDTOsInSequenceOrder() {
        let last = makeEvent(sequence: 3, phase: .completed)
        let first = makeEvent(sequence: 1, phase: .accepted)
        let middle = makeEvent(
            sequence: 2,
            phase: .progress,
            payload: TaskEventPayloadDTO(
                attempt: 2,
                fromStatus: .running,
                toStatus: .running,
                simulated: true
            )
        )

        let ordered = ConversationCardRenderer.ActivityEvents.orderedEvents([last, first, middle])

        XCTAssertEqual(ordered, [first, middle, last])
        XCTAssertEqual(ordered.map(\.phase), [.accepted, .progress, .completed])
        XCTAssertEqual(ordered.count, 3, "Rendering must not add steps that are absent from the event DTOs")

        let progressFacts = ActivityEventRow.facts(for: ordered[1])
        XCTAssertEqual(progressFacts.titleKey, "card.event.progress")
        XCTAssertEqual(progressFacts.attempt, 2)
        XCTAssertEqual(progressFacts.fromStatus, .running)
        XCTAssertEqual(progressFacts.toStatus, .running)
        XCTAssertTrue(progressFacts.isMockOnly)
    }

    func testCommitmentUsesStableMockFixtureAndOmitsUnavailableSchedule() {
        let fixture = ConversationCardRenderer.commitmentFixture

        XCTAssertEqual(fixture.id, ConversationFixtures.commitmentID)
        XCTAssertEqual(fixture.title, "Review the weekly plan")
        XCTAssertEqual(fixture.status.rawValue, "active")
        XCTAssertTrue(fixture.isMockOnly)
        XCTAssertNil(fixture.schedule)
        XCTAssertNil(CommitmentCard.schedulePresentation(for: fixture.schedule))
    }

    func testOutcomeUsesReadableContentOnlyFromMockOutcomeFixture() {
        let fixture = MockOutcomeFixture(
            label: "固定演示清单",
            content: "固定演示结果，不来自当前对话。"
        )
        let record = makeRecord(
            taskStatus: .completed,
            presentationStatus: .running,
            outcomeFixture: fixture
        )

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, fixture.label)
        XCTAssertEqual(presentation.readableContent, fixture.content)
        XCTAssertTrue(presentation.isMockOnly)
    }

    func testOutcomeFixtureStaysUnavailableUntilTaskIsCompleted() {
        let staleFixture = MockOutcomeFixture(
            label: "旧的固定演示清单",
            content: "这份结果不能在任务完成前显示。"
        )
        let unavailableTitle = String(localized: "card.result", table: "ConversationCards")

        for status in [TaskStatus.queued, .running] {
            let record = makeRecord(taskStatus: status, outcomeFixture: staleFixture)

            let presentation = ConversationCardRenderer.outcomePresentation(for: record)

            XCTAssertEqual(presentation.title, unavailableTitle)
            XCTAssertNil(presentation.readableContent, "A stale fixture must not appear for a \(status.rawValue) Task")
            XCTAssertFalse(presentation.isMockOnly)
        }
    }

    func testMissingOutcomeFixtureShowsUnavailableResultWithoutSyntheticContent() {
        let record = makeRecord(
            taskStatus: .completed,
            outcomeFixture: nil,
            title: "Conversation text that must not become a result"
        )

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, String(localized: "card.result", table: "ConversationCards"))
        XCTAssertNil(presentation.readableContent)
        XCTAssertFalse(presentation.isMockOnly)
    }

    func testUnreadableOutcomeFixtureShowsUnavailableResultAndKeepsMockDisclosure() {
        let record = makeRecord(
            taskStatus: .completed,
            outcomeFixture: MockOutcomeFixture(label: "固定演示结果", content: " \n\t ")
        )

        let presentation = ConversationCardRenderer.outcomePresentation(for: record)

        XCTAssertEqual(presentation.title, "固定演示结果")
        XCTAssertNil(presentation.readableContent)
        XCTAssertTrue(presentation.isMockOnly)
    }

    func testStreamingMarkdownBypassesGlobalCachesWhileFinalizedMessagesCacheAndClear() {
        ConversationCardFormatting.clearCaches()
        defer { ConversationCardFormatting.clearCaches() }

        let streamingPrefix = "## Summary\n- **Item 1** with `inline_code`"
        let streamingBlocks = ConversationCardFormatting.cachedMarkdownBlocks(for: streamingPrefix, useCache: false)
        let streamingInline = ConversationCardFormatting.attributedMarkdown(for: "**Item 1** with `inline_code`", useCache: false)

        XCTAssertEqual(streamingBlocks.count, 2)
        XCTAssertNotNil(streamingInline)
        XCTAssertFalse(ConversationCardFormatting.hasCachedMarkdownBlocks(for: streamingPrefix))
        XCTAssertFalse(ConversationCardFormatting.hasCachedAttributedMarkdown(for: "**Item 1** with `inline_code`"))

        let finalizedText = "## Finalized\n- **Done** with `code`"
        let finalizedBlocks = ConversationCardFormatting.cachedMarkdownBlocks(for: finalizedText, useCache: true)
        let finalizedInline = ConversationCardFormatting.attributedMarkdown(for: "**Done** with `code`", useCache: true)

        XCTAssertEqual(finalizedBlocks.count, 2)
        XCTAssertNotNil(finalizedInline)
        XCTAssertTrue(ConversationCardFormatting.hasCachedMarkdownBlocks(for: finalizedText))
        XCTAssertTrue(ConversationCardFormatting.hasCachedAttributedMarkdown(for: "**Done** with `code`"))

        // Oversized entries (> maxCacheableEntryBytes) must still parse cleanly without entering the cache.
        let oversized = String(repeating: "a", count: ConversationCardFormatting.maxCacheableEntryBytes + 64)
        XCTAssertEqual(ConversationCardFormatting.cachedMarkdownBlocks(for: oversized, useCache: true).count, 1)
        XCTAssertFalse(ConversationCardFormatting.hasCachedMarkdownBlocks(for: oversized))

        ConversationCardFormatting.clearCaches()
        XCTAssertFalse(ConversationCardFormatting.hasCachedMarkdownBlocks(for: finalizedText))
        XCTAssertFalse(ConversationCardFormatting.hasCachedAttributedMarkdown(for: "**Done** with `code`"))
    }

    func testLongStreamingReplySkipsPrefixCachingAndBoundsMemory() {
        ConversationCardFormatting.clearCaches()
        defer { ConversationCardFormatting.clearCaches() }

        let deltaCount = 300
        let chunkTemplate = "Paragraph **segment** with `code_token` and details for streaming verification. "
        var accumulated = "# Long Streaming Reply\n\n"
        var prefixes: [String] = []
        prefixes.reserveCapacity(deltaCount)

        for index in 1...deltaCount {
            if index % 25 == 0 {
                accumulated += "\n\n## Section \(index / 25)\n- Bullet **\(index)**: \(chunkTemplate)"
            } else {
                accumulated += chunkTemplate
            }
            prefixes.append(accumulated)
        }
        XCTAssertGreaterThanOrEqual(accumulated.count, 10_000)

        let cachedBaselineFootprint = Self.currentResidentFootprintBytes()
        let cachedStart = ContinuousClock.now
        for prefix in prefixes {
            let blocks = ConversationCardFormatting.cachedMarkdownBlocks(for: prefix, useCache: true)
            for block in blocks {
                switch block {
                case .heading(_, let text), .bulletItem(let text), .numberedItem(_, let text), .paragraph(let text):
                    _ = ConversationCardFormatting.attributedMarkdown(for: text, useCache: true)
                case .codeBlock:
                    break
                }
            }
        }
        let cachedElapsed = cachedStart.duration(to: .now).components
        let cachedDurationMs = Double(cachedElapsed.seconds) * 1000.0 + Double(cachedElapsed.attoseconds) / 1e15
        let cachedAfterFootprint = Self.currentResidentFootprintBytes()
        let cachedDeltaMB = Double(Int64(cachedAfterFootprint) - Int64(cachedBaselineFootprint)) / (1024.0 * 1024.0)
        let retainedPrefixCountWithCache = prefixes.filter {
            ConversationCardFormatting.hasCachedMarkdownBlocks(for: $0)
        }.count

        ConversationCardFormatting.clearCaches()

        let baselineFootprint = Self.currentResidentFootprintBytes()
        let start = ContinuousClock.now
        for prefix in prefixes {
            let blocks = ConversationCardFormatting.cachedMarkdownBlocks(for: prefix, useCache: false)
            let lastIndex = blocks.count - 1
            for (offset, block) in blocks.enumerated() {
                let useInlineCache = offset < lastIndex
                switch block {
                case .heading(_, let text), .bulletItem(let text), .numberedItem(_, let text), .paragraph(let text):
                    _ = ConversationCardFormatting.attributedMarkdown(for: text, useCache: useInlineCache)
                case .codeBlock:
                    break
                }
            }
        }
        let elapsedMs = start.duration(to: .now).components
        let durationMs = Double(elapsedMs.seconds) * 1000.0 + Double(elapsedMs.attoseconds) / 1e15
        let afterStreamingFootprint = Self.currentResidentFootprintBytes()
        let deltaMB = Double(Int64(afterStreamingFootprint) - Int64(baselineFootprint)) / (1024.0 * 1024.0)

        print(
            String(
                format: "P1_LONG_STREAM_AB deltas=%d final_chars=%d cached_ms=%.2f cached_delta_mb=%.2f cached_retained=%d streaming_ms=%.2f streaming_delta_mb=%.2f streaming_retained=0",
                deltaCount,
                accumulated.count,
                cachedDurationMs,
                cachedDeltaMB,
                retainedPrefixCountWithCache,
                durationMs,
                deltaMB
            )
        )

        // None of the 300 accumulating prefixes should be retained in the whole-message blocks cache,
        // and the actively mutating final block must not be retained in the inline cache.
        for prefix in prefixes {
            XCTAssertFalse(ConversationCardFormatting.hasCachedMarkdownBlocks(for: prefix))
        }
        if case .bulletItem(let tailText) = ConversationMarkdownBlock.parse(accumulated).last {
            XCTAssertFalse(ConversationCardFormatting.hasCachedAttributedMarkdown(for: tailText))
        }
    }

    private static func currentResidentFootprintBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    private func makeRecord(
        taskStatus: TaskStatus,
        presentationStatus: TaskStatus? = nil,
        connection: ConnectionPhase = .connected,
        command: TaskCommandInFlight? = nil,
        events: [TaskEventDTO] = [],
        outcomeFixture: MockOutcomeFixture? = nil,
        title: String = "Task Activity · MOCK ONLY"
    ) -> TaskJourneyRecord {
        let task = TaskDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            agentID: UUID(uuidString: "00000000-0000-4000-8000-000000000201")!,
            kind: .mockChat,
            status: taskStatus,
            currentRunID: taskStatus == .running
                ? UUID(uuidString: "00000000-0000-4000-8000-000000000301")!
                : nil,
            attemptCount: taskStatus == .running ? 1 : 0,
            createdAt: "2026-11-02T00:00:00Z",
            updatedAt: "2026-11-02T01:00:00Z",
            deadlineAt: nil
        )

        return TaskJourneyRecord(
            title: title,
            task: task,
            events: events,
            presentation: TaskPresentationState(
                taskStatus: presentationStatus ?? taskStatus,
                connectionPhase: connection,
                commandInFlight: command,
                capability: .mockOnly
            ),
            origin: .createdInThisSession,
            outcomeFixture: outcomeFixture,
            approvalAvailability: .notApplicable
        )
    }

    private func makeEvent(
        sequence: Int,
        phase: TaskEventPhase,
        payload: TaskEventPayloadDTO = TaskEventPayloadDTO()
    ) -> TaskEventDTO {
        TaskEventDTO(
            taskID: UUID(uuidString: "00000000-0000-4000-8000-000000000101")!,
            sequence: sequence,
            phase: phase,
            occurredAt: "2026-11-02T01:00:00Z",
            traceID: UUID(uuidString: "00000000-0000-4000-8000-000000000301")!,
            payload: payload
        )
    }
}
