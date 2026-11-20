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
