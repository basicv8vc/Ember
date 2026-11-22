import Foundation
import XCTest
@testable import Ember

@MainActor
final class PersonalMemoryTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        sessions.removeAll()
        registrations.removeAll()
        try await super.tearDown()
    }

    func testLiveRepositoryListSaveDeleteRoundTripAgainstV2Contract() async throws {
        let memoryID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        let memoryIDLower = memoryID.uuidString.lowercased()
        let savedPayload = LockedString("")

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path == "/v2/memories" {
                return .json(statusCode: 200, body: """
                {
                  "items": [
                    {
                      "memory_id": "\(memoryIDLower)",
                      "kind": "preference",
                      "key": "brief.format",
                      "content": "Use concise bullets",
                      "provenance": {
                        "source": "explicit_user_request",
                        "conversation_id": null,
                        "message_id": null
                      },
                      "created_at": "2026-11-20T08:00:00Z",
                      "updated_at": "2026-11-20T08:05:00Z"
                    }
                  ],
                  "limits": {
                    "max_items": 50,
                    "max_content_chars": 500
                  }
                }
                """)
            }
            if request.httpMethod == "POST" && path == "/v2/memories" {
                if let body = request.httpBody, let text = String(data: body, encoding: .utf8) {
                    savedPayload.value = text
                }
                return .json(statusCode: 201, body: """
                {
                  "item": {
                    "memory_id": "\(memoryIDLower)",
                    "kind": "fact",
                    "key": null,
                    "content": "Based in Shanghai (UTC+8)",
                    "provenance": {
                      "source": "user_settings",
                      "conversation_id": null,
                      "message_id": null
                    },
                    "created_at": "2026-11-20T09:00:00Z",
                    "updated_at": "2026-11-20T09:00:00Z"
                  },
                  "created": true
                }
                """)
            }
            if request.httpMethod == "PATCH" && path == "/v2/memories/\(memoryIDLower)" {
                return .json(statusCode: 200, body: """
                {
                  "item": {
                    "memory_id": "\(memoryIDLower)",
                    "kind": "preference",
                    "key": null,
                    "content": "Based in Shanghai (UTC+8) — prefer metric units",
                    "provenance": {
                      "source": "user_settings",
                      "conversation_id": null,
                      "message_id": null
                    },
                    "created_at": "2026-11-20T09:00:00Z",
                    "updated_at": "2026-11-20T09:15:00Z"
                  }
                }
                """)
            }
            if request.httpMethod == "DELETE" && path == "/v2/memories/\(memoryIDLower)" {
                return .json(statusCode: 200, body: """
                {
                  "deleted": true,
                  "memory_id": "\(memoryIDLower)"
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let repo = try makeLiveRepository()
        let list = try await repo.listMemories()
        XCTAssertEqual(list.items.count, 1)
        XCTAssertEqual(list.items[0].memoryID, memoryID)
        XCTAssertEqual(list.items[0].kind, .preference)
        XCTAssertEqual(list.items[0].key, "brief.format")
        XCTAssertEqual(list.limits.maxItems, 50)
        XCTAssertEqual(list.limits.maxContentChars, 500)

        let saveResult = try await repo.saveMemory(SavePersonalMemoryRequestDTO(
            kind: .fact,
            content: "Based in Shanghai (UTC+8)",
            provenance: PersonalMemoryProvenanceDTO(source: .userSettings)
        ))
        XCTAssertTrue(saveResult.created)
        XCTAssertEqual(saveResult.item.kind, .fact)
        XCTAssertTrue(savedPayload.value.contains("\"source\":\"user_settings\""))

        let updateResult = try await repo.updateMemory(
            id: memoryID,
            UpdatePersonalMemoryRequestDTO(
                kind: .preference,
                content: "Based in Shanghai (UTC+8) — prefer metric units"
            )
        )
        XCTAssertEqual(updateResult.item.kind, .preference)
        XCTAssertEqual(updateResult.item.content, "Based in Shanghai (UTC+8) — prefer metric units")
        XCTAssertEqual(updateResult.item.createdAt, "2026-11-20T09:00:00Z")

        let deleteResult = try await repo.deleteMemory(id: memoryID)
        XCTAssertTrue(deleteResult.deleted)
        XCTAssertEqual(deleteResult.memoryID, memoryID)
    }

    func testLiveRepository404MapsToEndpointNotReadyForV1Compatibility() async throws {
        register { _ in .json(statusCode: 404, body: "{}") }

        let store = PersonalMemoryStore(repository: try makeLiveRepository())
        await store.refresh()

        XCTAssertTrue(store.isEndpointUnavailable)
        XCTAssertNil(store.errorMessage)
        XCTAssertTrue(store.items.isEmpty)
    }

    func testLiveRepository429BudgetExceededMapsToLimitReached() async throws {
        register { _ in
            .json(
                statusCode: 429,
                body: #"{"error":{"code":"BUDGET_EXCEEDED","message":"personal memory item limit reached"}}"#
            )
        }

        let store = PersonalMemoryStore(repository: try makeLiveRepository())
        let saved = await store.save(kind: .fact, content: "One item over the 50-item cap")

        XCTAssertFalse(saved)
        XCTAssertEqual(
            store.errorMessage,
            String(localized: "memory.error.limit_reached", table: "Conversation")
        )
    }

    func testStoreSaveInspectDeleteAndSignOutClear() async throws {
        let repo = InMemoryPersonalMemoryRepository(items: [])
        let store = PersonalMemoryStore(repository: repo)

        await store.refresh()
        XCTAssertTrue(store.items.isEmpty)

        let saved = await store.save(kind: .preference, content: "Prefer Chinese for daily summaries")
        XCTAssertTrue(saved)
        XCTAssertEqual(store.items.count, 1)
        let savedID = try XCTUnwrap(store.items.first?.memoryID)
        let originalCreatedAt = store.items.first?.createdAt
        XCTAssertEqual(store.items.first?.provenance.source, .userSettings)

        let updated = await store.update(
            id: savedID,
            kind: .fact,
            content: "Prefer concise Chinese bullet summaries"
        )
        XCTAssertTrue(updated)
        XCTAssertEqual(store.items.first?.kind, .fact)
        XCTAssertEqual(store.items.first?.content, "Prefer concise Chinese bullet summaries")
        XCTAssertEqual(store.items.first?.createdAt, originalCreatedAt)
        XCTAssertEqual(store.items.first?.provenance.source, .userSettings)

        await store.delete(id: savedID)
        XCTAssertTrue(store.items.isEmpty)

        let savedAgain = await store.save(kind: .fact, content: "Primary device is iPhone")
        XCTAssertTrue(savedAgain)
        XCTAssertEqual(store.items.count, 1)

        // Sign-out clears in-memory state immediately.
        store.clear()
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.isEndpointUnavailable)
    }

    func testInMemoryRepositoryDeduplicatesUnkeyedSaves() async throws {
        let repo = InMemoryPersonalMemoryRepository(items: [])
        let store = PersonalMemoryStore(repository: repo)

        let first = await store.save(kind: .preference, content: "Keep briefs concise")
        XCTAssertTrue(first)
        XCTAssertEqual(store.items.count, 1)
        let originalID = store.items[0].memoryID

        let duplicate = await store.save(kind: .preference, content: "  Keep briefs concise  ")
        XCTAssertTrue(duplicate)
        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.items[0].memoryID, originalID)

        // Unkeyed UI save matching an existing keyed memory updates in place rather than duplicating.
        let keyedRepo = InMemoryPersonalMemoryRepository(items: [
            PersonalMemoryItemDTO(
                memoryID: originalID,
                kind: .preference,
                key: "briefs",
                content: "Keep briefs concise",
                provenance: PersonalMemoryProvenanceDTO(source: .explicitUserRequest),
                createdAt: "2026-11-21T00:00:00Z",
                updatedAt: "2026-11-21T00:00:00Z"
            )
        ])
        let keyedStore = PersonalMemoryStore(repository: keyedRepo)
        await keyedStore.refresh()
        let dedupKeyed = await keyedStore.save(kind: .preference, content: "Keep briefs concise")
        XCTAssertTrue(dedupKeyed)
        XCTAssertEqual(keyedStore.items.count, 1)
        XCTAssertEqual(keyedStore.items[0].memoryID, originalID)
        XCTAssertEqual(keyedStore.items[0].key, "briefs")
    }

    func testStoreSaveReusesClientRequestIDAcrossRetryAfterUnknownOutcomeAndRemovesNotFoundOnUpdate() async throws {
        let attempts = LockedInt(0)
        let capturedClientRequestIDs = LockedStringArray()
        let memoryID = UUID(uuidString: "55555555-6666-4777-8888-999999999999")!
        let memoryIDLower = memoryID.uuidString.lowercased()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" && path == "/v2/memories" {
                let count = attempts.increment()
                if let body = request.httpBody,
                   let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                   let reqID = json["client_request_id"] as? String {
                    capturedClientRequestIDs.append(reqID)
                }
                if count == 1 {
                    return .json(statusCode: 503, body: #"{"error":{"code":"DB_UNAVAILABLE"}}"#)
                }
                return .json(statusCode: 200, body: """
                {
                  "item": {
                    "memory_id": "\(memoryIDLower)",
                    "kind": "preference",
                    "key": null,
                    "content": "Prefer brief answers",
                    "provenance": {
                      "source": "user_settings",
                      "conversation_id": null,
                      "message_id": null
                    },
                    "created_at": "2026-11-21T00:00:00Z",
                    "updated_at": "2026-11-21T00:00:00Z"
                  },
                  "created": false
                }
                """)
            }
            if request.httpMethod == "PATCH" && path == "/v2/memories/\(memoryIDLower)" {
                return .json(statusCode: 404, body: #"{"error":{"code":"NOT_FOUND"}}"#)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let store = PersonalMemoryStore(repository: try makeLiveRepository())

        let firstTry = await store.save(kind: .preference, content: "Prefer brief answers")
        XCTAssertFalse(firstTry)
        XCTAssertNotNil(store.errorMessage)

        let secondTry = await store.save(kind: .preference, content: "Prefer brief answers")
        XCTAssertTrue(secondTry)
        XCTAssertEqual(store.items.count, 1)
        let ids = capturedClientRequestIDs.values
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1])
        XCTAssertEqual(ids[0], ids[0].lowercased())

        // A subsequent different save uses a fresh client_request_id.
        _ = await store.save(kind: .fact, content: "Based in Kyoto")
        let allIDs = capturedClientRequestIDs.values
        XCTAssertEqual(allIDs.count, 3)
        XCTAssertNotEqual(allIDs[2], allIDs[0])

        // Updating a memory deleted remotely removes the stale row locally.
        let updateMissing = await store.update(
            id: memoryID,
            kind: .preference,
            content: "Prefer 2-bullet answers"
        )
        XCTAssertFalse(updateMissing)
        XCTAssertFalse(store.items.contains(where: { $0.memoryID == memoryID }))
        XCTAssertEqual(
            store.errorMessage,
            String(localized: "memory.error.not_found", table: "Conversation")
        )
    }

    func testLiveRepositoryWrite401MapsRequestRejectedBeforeExecutionToUnauthenticated() async throws {
        let memoryID = UUID(uuidString: "77777777-8888-4999-8000-111111111111")!
        let memoryIDLower = memoryID.uuidString.lowercased()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET" && path == "/v2/memories" {
                return .json(statusCode: 200, body: """
                {
                  "items": [
                    {
                      "memory_id": "\(memoryIDLower)",
                      "kind": "preference",
                      "key": null,
                      "content": "Existing memory",
                      "provenance": {
                        "source": "user_settings",
                        "conversation_id": null,
                        "message_id": null
                      },
                      "created_at": "2026-11-21T00:00:00Z",
                      "updated_at": "2026-11-21T00:00:00Z"
                    }
                  ],
                  "limits": {
                    "max_items": 50,
                    "max_content_chars": 500
                  }
                }
                """)
            }
            return .json(statusCode: 401, body: #"{"error":{"code":"UNAUTHENTICATED"}}"#)
        }

        let repo = try makeLiveRepository()
        let store = PersonalMemoryStore(repository: repo)
        await store.refresh()
        XCTAssertEqual(store.items.count, 1)

        let expectedUnauthMessage = String(localized: "memory.error.unauthenticated", table: "Conversation")

        let saveSucceeded = await store.save(kind: .fact, content: "Should require sign in")
        XCTAssertFalse(saveSucceeded)
        XCTAssertEqual(store.errorMessage, expectedUnauthMessage)

        store.clearError()
        XCTAssertNil(store.errorMessage)

        let updateSucceeded = await store.update(id: memoryID, kind: .preference, content: "Updated")
        XCTAssertFalse(updateSucceeded)
        XCTAssertEqual(store.errorMessage, expectedUnauthMessage)
        XCTAssertEqual(store.items.count, 1)

        store.clearError()
        await store.delete(id: memoryID)
        XCTAssertEqual(store.errorMessage, expectedUnauthMessage)
        XCTAssertEqual(store.items.count, 1)
    }

    private func makeLiveRepository() throws -> LivePersonalMemoryRepository {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        return LivePersonalMemoryRepository(auth: auth)
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}

private final class LockedString: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: String

    init(_ initial: String) {
        self.storage = initial
    }

    var value: String {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class LockedInt: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Int

    init(_ initial: Int) {
        self.storage = initial
    }

    func increment() -> Int {
        lock.withLock {
            storage += 1
            return storage
        }
    }
}

private final class LockedStringArray: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] {
        lock.withLock { storage }
    }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
    }
}
