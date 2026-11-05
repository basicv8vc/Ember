import AuthenticationServices
import XCTest
@testable import Ember

/// The attempt ledger is the part of Sign in with Apple that can be tested without an Apple account,
/// and it is where "a stale callback must never be accepted" actually lives.
private struct FixedRandomSource: SecureRandomByteSource {
    let byte: UInt8
    func randomBytes(count: Int) throws -> Data {
        Data(Array(repeating: byte, count: count))
    }
}

final class AppleSignInAttemptLedgerTests: XCTestCase {
    private let issuedAt = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeNonce(
        byte: UInt8 = 0x01,
        now: Date? = nil,
        lifetime: TimeInterval = 60
    ) throws -> AppleNonce {
        try AppleNonceGenerator.make(
            source: FixedRandomSource(byte: byte),
            now: now ?? issuedAt,
            lifetime: lifetime
        )
    }

    func testBeginExposesOnePendingAttempt() throws {
        var ledger = AppleSignInAttemptLedger()
        XCTAssertFalse(ledger.hasPendingAttempt)

        let attempt = try ledger.begin(nonce: makeNonce())

        XCTAssertTrue(ledger.hasPendingAttempt)
        XCTAssertEqual(ledger.pending?.id, attempt.id)
    }

    func testSecondConcurrentAttemptIsRefused() throws {
        var ledger = AppleSignInAttemptLedger()
        _ = try ledger.begin(nonce: makeNonce())

        XCTAssertThrowsError(try ledger.begin(nonce: makeNonce(byte: 0x02))) { error in
            XCTAssertEqual(error as? AuthError, .appleAuthorizationInProgress)
        }
    }

    func testCompletionConsumesTheAttempt() throws {
        var ledger = AppleSignInAttemptLedger()
        let attempt = try ledger.begin(nonce: makeNonce())

        let completed = try ledger.complete(attemptID: attempt.id, at: issuedAt.addingTimeInterval(1))

        XCTAssertEqual(completed.id, attempt.id)
        XCTAssertFalse(ledger.hasPendingAttempt)

        // A duplicated delegate callback cannot be honoured twice.
        XCTAssertThrowsError(try ledger.complete(attemptID: attempt.id, at: issuedAt)) { error in
            XCTAssertEqual(error as? AuthError, .appleAttemptExpired)
        }
    }

    func testCompletionForAnUnknownAttemptIsRefusedWithoutDisturbingTheLiveOne() throws {
        var ledger = AppleSignInAttemptLedger()
        let attempt = try ledger.begin(nonce: makeNonce())

        XCTAssertThrowsError(try ledger.complete(attemptID: UUID(), at: issuedAt)) { error in
            XCTAssertEqual(error as? AuthError, .appleAttemptExpired)
        }

        // The refused callback must not have cancelled the real attempt.
        XCTAssertEqual(ledger.pending?.id, attempt.id)
    }

    func testCompletionAfterTheNonceLifetimeIsRefused() throws {
        var ledger = AppleSignInAttemptLedger()
        let attempt = try ledger.begin(nonce: makeNonce(lifetime: 30))

        XCTAssertThrowsError(
            try ledger.complete(attemptID: attempt.id, at: issuedAt.addingTimeInterval(31))
        ) { error in
            XCTAssertEqual(error as? AuthError, .appleAttemptExpired)
        }

        XCTAssertFalse(ledger.hasPendingAttempt)
    }

    func testAnOldAttemptCannotCompleteANewerOne() throws {
        var ledger = AppleSignInAttemptLedger()
        let first = try ledger.begin(nonce: makeNonce(byte: 0x0A))
        ledger.cancel(attemptID: first.id)

        // A fresh authorization starts while the first controller's delegate is still alive.
        let second = try ledger.begin(nonce: makeNonce(byte: 0x0B))

        XCTAssertThrowsError(try ledger.complete(attemptID: first.id, at: issuedAt)) { error in
            XCTAssertEqual(error as? AuthError, .appleAttemptExpired)
        }
        XCTAssertEqual(ledger.pending?.id, second.id)

        // ...and the newer attempt still completes normally.
        XCTAssertEqual(
            try ledger.complete(attemptID: second.id, at: issuedAt.addingTimeInterval(2)).id,
            second.id
        )
    }

    func testCancellingAnUnknownAttemptIsANoOp() throws {
        var ledger = AppleSignInAttemptLedger()
        let attempt = try ledger.begin(nonce: makeNonce())

        ledger.cancel(attemptID: UUID())

        XCTAssertEqual(ledger.pending?.id, attempt.id)
    }

    func testCancellationThatRacesACompletionLeavesACleanLedger() throws {
        var ledger = AppleSignInAttemptLedger()
        let attempt = try ledger.begin(nonce: makeNonce())

        _ = try ledger.complete(attemptID: attempt.id, at: issuedAt)
        ledger.cancel(attemptID: attempt.id)

        XCTAssertFalse(ledger.hasPendingAttempt)
        // The ledger can start again immediately; a cancellation must not wedge it.
        XCTAssertNoThrow(try ledger.begin(nonce: makeNonce(byte: 0x03)))
    }

    func testEachAttemptCarriesItsOwnNonce() throws {
        var ledger = AppleSignInAttemptLedger()
        let first = try ledger.begin(nonce: makeNonce(byte: 0x10))
        ledger.cancel(attemptID: first.id)
        let second = try ledger.begin(nonce: makeNonce(byte: 0x20))

        XCTAssertNotEqual(first.nonce.rawValue, second.nonce.rawValue)
        XCTAssertNotEqual(first.id, second.id)
    }
}

final class AppleCredentialValidatorTests: XCTestCase {
    func testMissingIdentityTokenIsRejected() {
        XCTAssertThrowsError(try AppleCredentialValidator.identityToken(from: nil)) { error in
            XCTAssertEqual(error as? AuthError, .appleCredentialInvalid)
        }
    }

    func testEmptyIdentityTokenIsRejected() {
        XCTAssertThrowsError(try AppleCredentialValidator.identityToken(from: Data())) { error in
            XCTAssertEqual(error as? AuthError, .appleCredentialInvalid)
        }
    }

    func testWhitespaceOnlyIdentityTokenIsRejected() {
        XCTAssertThrowsError(
            try AppleCredentialValidator.identityToken(from: Data(" \n\t ".utf8))
        ) { error in
            XCTAssertEqual(error as? AuthError, .appleCredentialInvalid)
        }
    }

    func testNonUTF8IdentityTokenIsRejected() {
        XCTAssertThrowsError(
            try AppleCredentialValidator.identityToken(from: Data([0xFF, 0xFE, 0xFD]))
        ) { error in
            XCTAssertEqual(error as? AuthError, .appleCredentialInvalid)
        }
    }

    func testValidIdentityTokenIsReturnedTrimmed() throws {
        let token = try AppleCredentialValidator.identityToken(from: Data("  header.payload.sig\n".utf8))
        XCTAssertEqual(token, "header.payload.sig")
    }
}

final class AppleAuthorizationCancellationTests: XCTestCase {
    func testAuthorizationCancellationIsRecognised() {
        let error = NSError(
            domain: AppleAuthorizationCancellation.domain,
            code: ASAuthorizationError.canceled.rawValue
        )

        XCTAssertTrue(AppleAuthorizationCancellation.isCancellation(error))
    }

    func testSameCodeInAnotherDomainIsNotTreatedAsCancellation() {
        let error = NSError(domain: "com.example.unrelated", code: 1001)
        XCTAssertFalse(AppleAuthorizationCancellation.isCancellation(error))
    }

    func testOtherAuthorizationFailuresAreNotCancellation() {
        let error = NSError(
            domain: AppleAuthorizationCancellation.domain,
            code: ASAuthorizationError.failed.rawValue
        )
        XCTAssertFalse(AppleAuthorizationCancellation.isCancellation(error))
    }
}
