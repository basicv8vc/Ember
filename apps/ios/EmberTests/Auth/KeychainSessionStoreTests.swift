import XCTest
@testable import Ember

/// Credential storage behaviour. The in-memory store covers the coordinator-facing contract; the
/// Keychain cases exercise the real `SecItem` implementation on the simulator, and are skipped rather
/// than failed when the host keychain is not usable.
final class KeychainSessionStoreTests: XCTestCase {
    private var stores: [KeychainSessionStore] = []

    override func tearDown() async throws {
        for store in stores {
            try? await store.delete()
        }
        stores.removeAll()
        try await super.tearDown()
    }

    // MARK: In-memory store

    func testInMemoryStoreRoundTripsARecord() async throws {
        let store = InMemoryEmberSessionStore()
        let record = AuthFixture.record()

        let initiallyStored = await store.currentRecord()
        XCTAssertNil(initiallyStored)

        try await store.save(record)
        let loaded = try await store.load()
        XCTAssertEqual(loaded, record)

        try await store.delete()
        let afterDelete = try await store.load()
        XCTAssertNil(afterDelete)
    }

    func testInMemoryStoreReplacesDuringRotation() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        let rotated = AuthFixture.record(tokenSuffix: "rotated")

        try await store.replace(rotated)

        let loaded = try await store.load()
        let replaceCount = await store.replaceCount
        XCTAssertEqual(loaded?.accessToken, rotated.accessToken)
        XCTAssertEqual(replaceCount, 1)
    }

    func testInMemoryStoreDistinguishesUnavailableFromEmpty() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        await store.setUnavailable(true)

        // The distinction the coordinator depends on: this throws, it does not return nil.
        do {
            let loaded = try await store.load()
            XCTFail("expected keychainUnavailable, got \(String(describing: loaded))")
        } catch let error as AuthError {
            XCTAssertEqual(error, .keychainUnavailable)
        }

        await store.setUnavailable(false)
        let recovered = try await store.load()
        XCTAssertEqual(recovered, AuthFixture.record())
    }

    func testInMemoryStoreReportsDeleteFailure() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        await store.setDeleteFailure(.keychainUnavailable)

        do {
            try await store.delete()
            XCTFail("expected keychainUnavailable")
        } catch let error as AuthError {
            XCTAssertEqual(error, .keychainUnavailable)
        }
    }

    func testDeletingAnAbsentRecordIsSuccess() async throws {
        let store = InMemoryEmberSessionStore()

        try await store.delete()

        let loaded = try await store.load()
        XCTAssertNil(loaded)
    }

    // MARK: Real Keychain

    func testKeychainStoreRoundTripsARecord() async throws {
        let store = makeKeychainStore()
        let record = AuthFixture.record(tokenSuffix: "keychain-roundtrip")

        do {
            let initiallyStored = try await store.load()
            XCTAssertNil(initiallyStored)

            try await store.save(record)

            let loaded = try await store.load()
            XCTAssertEqual(loaded?.accessToken, record.accessToken)
            XCTAssertEqual(loaded?.sessionID, record.sessionID)
            XCTAssertEqual(loaded?.consumerID, record.consumerID)
            XCTAssertEqual(
                loaded?.expiresAt.timeIntervalSince1970 ?? 0,
                record.expiresAt.timeIntervalSince1970,
                accuracy: 0.001
            )
        } catch let error as AuthError where error == .keychainUnavailable {
            throw XCTSkip("Keychain is not available in this host context: \(error)")
        }
    }

    func testKeychainStoreReplacesInPlace() async throws {
        let store = makeKeychainStore()
        let first = AuthFixture.record(tokenSuffix: "first")
        let second = AuthFixture.record(tokenSuffix: "second")

        do {
            try await store.save(first)
            try await store.replace(second)

            let loaded = try await store.load()
            XCTAssertEqual(loaded?.accessToken, second.accessToken)
        } catch let error as AuthError where error == .keychainUnavailable {
            throw XCTSkip("Keychain is not available in this host context: \(error)")
        }
    }

    func testKeychainStoreDeleteIsIdempotent() async throws {
        let store = makeKeychainStore()

        do {
            try await store.save(AuthFixture.record())
            try await store.delete()

            let afterDelete = try await store.load()
            XCTAssertNil(afterDelete)

            // A second delete of an absent item must not throw.
            try await store.delete()
        } catch let error as AuthError where error == .keychainUnavailable {
            throw XCTSkip("Keychain is not available in this host context: \(error)")
        }
    }

    // MARK: Security properties

    func testStoredTokenIsNotRecoverableFromDescriptions() {
        let record = AuthFixture.record(tokenSuffix: "devicestore-secret")

        for representation in [
            String(describing: record),
            String(reflecting: record),
            record.description,
            record.debugDescription,
        ] {
            XCTAssertFalse(representation.contains("devicestore-secret"))
        }

        let mirrored = Mirror(reflecting: record).children.map { String(describing: $0.value) }
        XCTAssertTrue(mirrored.contains("<redacted>"))
        XCTAssertFalse(mirrored.contains { $0.contains("devicestore-secret") })
    }

    func testExpiryHelpersUseTheProvidedClock() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let record = AuthFixture.record(expiresIn: 100, now: now)

        XCTAssertFalse(record.isExpired(at: now))
        XCTAssertTrue(record.isExpired(at: now.addingTimeInterval(100)))
        XCTAssertFalse(record.needsRefresh(at: now, leeway: 60))
        XCTAssertTrue(record.needsRefresh(at: now.addingTimeInterval(50), leeway: 60))
    }

    private func makeKeychainStore() -> KeychainSessionStore {
        // A per-test namespace keeps cases independent without touching the live app's item.
        let store = KeychainSessionStore(
            configuration: .init(
                service: "com.basicv8vc.ember.tests.\(UUID().uuidString)",
                account: "ember.session.test"
            )
        )
        stores.append(store)
        return store
    }
}
