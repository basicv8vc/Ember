import XCTest
@testable import Ember

final class FoundationSmokeTests: XCTestCase {
    func testMockNoticeClearlyDisclaimsRealAIExecution() {
        XCTAssertEqual(FoundationCopy.mockOnlyNotice, "MOCK ONLY · No real AI execution")
    }

    @MainActor
    func testDefaultCloudBaseURLUsesHTTPSStagingEndpoint() {
        XCTAssertEqual(
            AppCompositionRoot.defaultCloudBaseURL,
            "https://ember-cloud-api-staging.10kpaper.workers.dev"
        )
        XCTAssertEqual(URL(string: AppCompositionRoot.defaultCloudBaseURL)?.scheme, "https")
    }
}
