import XCTest
@testable import Ember

/// A deterministic stand-in for `SecRandomCopyBytes`, so a nonce assertion is exact rather than
/// probabilistic.
private struct FixedRandomSource: SecureRandomByteSource {
    let bytes: [UInt8]
    var failure: SecureRandomFailure?

    func randomBytes(count: Int) throws -> Data {
        if let failure { throw failure }
        guard bytes.count == count else { throw SecureRandomFailure.invalidLength }
        return Data(bytes)
    }
}

final class AppleNonceTests: XCTestCase {
    private let issuedAt = Date(timeIntervalSince1970: 1_800_000_000)

    func testNonceUsesThirtyTwoRandomBytesRenderedAsHex() throws {
        let source = FixedRandomSource(bytes: Array(repeating: 0xAB, count: 32))

        let nonce = try AppleNonceGenerator.make(source: source, now: issuedAt)

        XCTAssertEqual(nonce.rawValue.count, 64)
        XCTAssertEqual(nonce.rawValue, String(repeating: "ab", count: 32))
        XCTAssertEqual(nonce.rawValue, nonce.rawValue.lowercased())
    }

    func testNonceEntropyIsAtLeast256Bits() {
        // 32 bytes x 8 bits: the same order of magnitude as the session token in annex §5.1 I-5.
        XCTAssertEqual(AppleNonceGenerator.byteCount * 8, 256)
    }

    func testHashMatchesSHA256OfTheRawNonce() throws {
        let source = FixedRandomSource(bytes: Array(repeating: 0x01, count: 32))
        let nonce = try AppleNonceGenerator.make(source: source, now: issuedAt)

        XCTAssertEqual(nonce.hashedValue, AppleNonceGenerator.sha256Hex(nonce.rawValue))
        XCTAssertNotEqual(nonce.hashedValue, nonce.rawValue)
    }

    func testHashMatchesAKnownSHA256Vector() {
        // SHA-256("abc"), so a swapped or truncated digest is caught rather than self-consistent.
        XCTAssertEqual(
            AppleNonceGenerator.sha256Hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    }

    func testTwoNoncesDifferWhenTheRandomSourceDiffers() throws {
        let first = try AppleNonceGenerator.make(
            source: FixedRandomSource(bytes: Array(repeating: 0x11, count: 32)),
            now: issuedAt
        )
        let second = try AppleNonceGenerator.make(
            source: FixedRandomSource(bytes: Array(repeating: 0x22, count: 32)),
            now: issuedAt
        )

        XCTAssertNotEqual(first.rawValue, second.rawValue)
        XCTAssertNotEqual(first.hashedValue, second.hashedValue)
    }

    func testSystemSecureRandomProducesDistinctNonces() throws {
        // Two live mints must not collide; a 256-bit collision would indicate a broken source.
        let first = try AppleNonceGenerator.make(now: issuedAt)
        let second = try AppleNonceGenerator.make(now: issuedAt)

        XCTAssertEqual(first.rawValue.count, 64)
        XCTAssertNotEqual(first.rawValue, second.rawValue)
    }

    func testRandomSourceFailureIsReportedRatherThanRetried() {
        let source = FixedRandomSource(bytes: [], failure: .unavailable)

        XCTAssertThrowsError(try AppleNonceGenerator.make(source: source, now: issuedAt)) { error in
            XCTAssertEqual(error as? SecureRandomFailure, .unavailable)
        }
    }

    func testNonceLifetimeBoundsAcceptance() throws {
        let source = FixedRandomSource(bytes: Array(repeating: 0x7F, count: 32))
        let nonce = try AppleNonceGenerator.make(source: source, now: issuedAt, lifetime: 60)

        XCTAssertTrue(nonce.isValid(at: issuedAt))
        XCTAssertTrue(nonce.isValid(at: issuedAt.addingTimeInterval(59)))
        XCTAssertTrue(nonce.isValid(at: issuedAt.addingTimeInterval(60)))
        XCTAssertFalse(nonce.isValid(at: issuedAt.addingTimeInterval(61)))
        // A clock that moved backwards must not extend a nonce's life.
        XCTAssertFalse(nonce.isValid(at: issuedAt.addingTimeInterval(-1)))
    }

    func testRawNonceAndHashAreRedactedFromEveryDescription() throws {
        let source = FixedRandomSource(bytes: Array(repeating: 0xC3, count: 32))
        let nonce = try AppleNonceGenerator.make(source: source, now: issuedAt)

        for representation in [
            String(describing: nonce),
            String(reflecting: nonce),
            nonce.description,
            nonce.debugDescription,
        ] {
            XCTAssertFalse(representation.contains(nonce.rawValue))
            XCTAssertFalse(representation.contains(nonce.hashedValue))
        }

        let mirrored = Mirror(reflecting: nonce).children.compactMap { $0.value as? String }
        XCTAssertTrue(mirrored.allSatisfy { $0 == "<redacted>" })
    }
}
