import XCTest
@testable import Ember

/// The isolated Live authentication entry point. It must never claim that chat works, must separate a
/// cancellation from a failure, and must not allow a second submission while one is in flight.
@MainActor
final class LiveAuthEntryModelTests: XCTestCase {
    func testIdleStateInvitesSignInWithoutPromisingChat() {
        let model = LiveAuthEntryModel { AuthFixture.me() }

        XCTAssertEqual(model.phase, .idle)
        XCTAssertFalse(model.isBusy)
        XCTAssertNil(model.signedInProfile)
        XCTAssertTrue(model.statusMessage.contains("Sign in with Apple"))
    }

    func testSuccessfulSignInShowsTheServerAuthoritativeProfile() async {
        let model = LiveAuthEntryModel { AuthFixture.me(transcriptEpoch: 4) }

        await model.signIn()

        let profile = model.signedInProfile
        XCTAssertEqual(profile?.conversation.transcriptEpoch, 4)
        XCTAssertEqual(profile?.agent.displayName, "Ember")
        XCTAssertEqual(model.phase, .signedIn(AuthFixture.me(transcriptEpoch: 4)))
        // The copy must not imply that Live conversation is available at L1.
        XCTAssertTrue(model.statusMessage.contains("Live chat is not enabled"))
    }

    func testCancellationIsNotReportedAsFailure() async {
        let model = LiveAuthEntryModel { throw AuthError.appleCancelled }

        await model.signIn()

        XCTAssertEqual(model.phase, .cancelled)
        XCTAssertFalse(model.statusMessage.lowercased().contains("failed"))
    }

    func testFailureSurfacesTheTypedReasonAndRecoveryAdvice() async {
        let model = LiveAuthEntryModel { throw AuthError.offline }

        await model.signIn()

        XCTAssertEqual(model.phase, .failed(.offline))
        XCTAssertTrue(model.statusMessage.contains("could not reach the server"))
    }

    func testLockedKeychainExplainsThatTheSessionWasNotSaved() async {
        let model = LiveAuthEntryModel { throw AuthError.keychainUnavailable }

        await model.signIn()

        XCTAssertEqual(model.phase, .failed(.keychainUnavailable))
        XCTAssertTrue(model.statusMessage.contains("keychain"))
    }

    func testANonAuthErrorIsReportedAsATransportFailure() async {
        struct Unexpected: Error {}
        let model = LiveAuthEntryModel { throw Unexpected() }

        await model.signIn()

        XCTAssertEqual(model.phase, .failed(.transportFailure))
    }

    func testCancellationOfTheEnclosingTaskIsTreatedAsCancellation() async {
        let model = LiveAuthEntryModel { throw CancellationError() }

        await model.signIn()

        XCTAssertEqual(model.phase, .cancelled)
    }

    func testASecondTapWhileBusyIsIgnored() async {
        let started = expectation(description: "action started")
        let release = AsyncGate()
        let calls = Counter()

        let model = LiveAuthEntryModel {
            calls.increment()
            started.fulfill()
            await release.wait()
            return AuthFixture.me()
        }

        let first = Task { await model.signIn() }
        await fulfillment(of: [started], timeout: 5)
        XCTAssertTrue(model.isBusy)

        // A second tap must not start a second sign-in.
        await model.signIn()
        XCTAssertEqual(calls.value, 1)

        await release.open()
        await first.value
        XCTAssertEqual(model.phase, .signedIn(AuthFixture.me()))
    }

    func testClearingANoticeReturnsToIdle() async {
        let model = LiveAuthEntryModel { throw AuthError.appleCancelled }

        await model.signIn()
        XCTAssertEqual(model.phase, .cancelled)

        model.clearNotice()
        XCTAssertEqual(model.phase, .idle)
    }

    func testClearingASignedInStateIsNotAllowed() async {
        let model = LiveAuthEntryModel { AuthFixture.me() }

        await model.signIn()
        model.clearNotice()

        // A signed-in entry point has no notice to dismiss; the session stays on screen.
        XCTAssertEqual(model.phase, .signedIn(AuthFixture.me()))
    }

    func testAccessDeniedExplainsEnvironmentAuthorization() async {
        let model = LiveAuthEntryModel { throw AuthError.accessDenied }

        await model.signIn()

        XCTAssertEqual(model.phase, .failed(.accessDenied))
        XCTAssertTrue(model.statusMessage.contains("not authorized"))
    }
}
