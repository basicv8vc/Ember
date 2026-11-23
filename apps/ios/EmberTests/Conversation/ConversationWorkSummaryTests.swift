import XCTest
@testable import Ember

final class ConversationWorkSummaryTests: XCTestCase {
    func testHidesWhenNoKnownActiveOrAttentionTasks() {
        XCTAssertNil(ConversationWorkSummary(needsAttentionCount: 0, activeCount: 0))
        XCTAssertNil(ConversationWorkSummary(needsAttentionCount: -1, activeCount: 0))
        XCTAssertNil(ConversationWorkSummary(needsAttentionCount: 1, activeCount: -1))
    }

    func testPreservesDistinctAttentionAndActiveCounts() throws {
        let attentionOnly = try XCTUnwrap(
            ConversationWorkSummary(needsAttentionCount: 2, activeCount: 0)
        )
        XCTAssertEqual(attentionOnly.needsAttentionCount, 2)
        XCTAssertEqual(attentionOnly.activeCount, 0)

        let activeOnly = try XCTUnwrap(
            ConversationWorkSummary(needsAttentionCount: 0, activeCount: 3)
        )
        XCTAssertEqual(activeOnly.needsAttentionCount, 0)
        XCTAssertEqual(activeOnly.activeCount, 3)

        let both = try XCTUnwrap(
            ConversationWorkSummary(needsAttentionCount: 1, activeCount: 2)
        )
        XCTAssertEqual(both.needsAttentionCount, 1)
        XCTAssertEqual(both.activeCount, 2)
    }
}
