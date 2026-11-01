import XCTest
@testable import Ember

final class FoundationSmokeTests: XCTestCase {
    func testMockNoticeClearlyDisclaimsRealAIExecution() {
        XCTAssertEqual(FoundationCopy.mockOnlyNotice, "MOCK ONLY · No real AI execution")
    }
}
