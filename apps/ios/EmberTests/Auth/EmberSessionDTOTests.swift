import XCTest
@testable import Ember

/// Strict decoding of the two frozen B1 identity DTOs. A response that violates the contract must fail
/// loudly, because the alternative is installing a credential the server did not intend to issue.
final class EmberSessionDTOTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func date(_ raw: String) throws -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: raw) { return parsed }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return try XCTUnwrap(plain.date(from: raw))
    }

    // MARK: Session response

    func testValidSessionResponseDecodes() throws {
        let dto = try decode(EmberSessionResponseDTO.self, AuthFixture.sessionJSON(tokenSuffix: "alpha"))

        XCTAssertEqual(dto.sessionID, AuthFixture.sessionID)
        XCTAssertEqual(dto.consumerID, AuthFixture.consumerID)
        XCTAssertEqual(dto.accessToken.rawValue, "ems_alpha")
        XCTAssertEqual(dto.expiresAt, try date("2026-12-03T10:00:00Z"))
    }

    func testFractionalSecondsAndExplicitOffsetAreAccepted() throws {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha",
              "expires_at": "2026-12-03T18:00:00.750+08:00"
            }
            """

        let dto = try decode(EmberSessionResponseDTO.self, json)
        XCTAssertEqual(dto.expiresAt, try date("2026-12-03T10:00:00.75Z"))
    }

    func testUnknownSessionFieldIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha",
              "expires_at": "2026-12-03T10:00:00Z",
              "tenant_id": "99999999-9999-4999-8999-999999999999"
            }
            """
        // A server that starts leaking a tenant id must break the client, not be quietly tolerated.
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testMissingSessionFieldIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "access_token": "ems_alpha",
              "expires_at": "2026-12-03T10:00:00Z"
            }
            """
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testTokenWithoutTheEmberPrefixIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "not-an-ember-token",
              "expires_at": "2026-12-03T10:00:00Z"
            }
            """
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testTokenWithIllegalCharactersIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha beta/../evil",
              "expires_at": "2026-12-03T10:00:00Z"
            }
            """
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testBarePrefixTokenIsRejected() {
        XCTAssertNil(EmberAccessToken("ems_"))
        XCTAssertNil(EmberAccessToken(""))
        XCTAssertNil(EmberAccessToken("EMS_ALPHA"))
    }

    func testInvalidSessionUUIDIsRejected() {
        let json = """
            {
              "session_id": "not-a-uuid",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha",
              "expires_at": "2026-12-03T10:00:00Z"
            }
            """
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testUnparsableTimestampIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha",
              "expires_at": "3rd of December"
            }
            """
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    func testTimestampWithoutAnOffsetIsRejected() {
        let json = """
            {
              "session_id": "11111111-1111-4111-8111-111111111111",
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "access_token": "ems_alpha",
              "expires_at": "2026-12-03T10:00:00"
            }
            """
        // The contract requires an offset; a naive local time would be ambiguous across regions.
        XCTAssertThrowsError(try decode(EmberSessionResponseDTO.self, json))
    }

    // MARK: Me response

    func testValidMeResponseDecodes() throws {
        let dto = try decode(EmberMeDTO.self, AuthFixture.meJSON)

        XCTAssertEqual(dto.consumerID, AuthFixture.consumerID)
        XCTAssertEqual(dto.agent.agentID, AuthFixture.agentID)
        XCTAssertEqual(dto.agent.displayName, "Ember")
        XCTAssertEqual(dto.conversation.conversationID, AuthFixture.conversationID)
        XCTAssertEqual(dto.conversation.transcriptEpoch, 0)
        XCTAssertEqual(dto.conversation.updatedAt, try date("2026-12-03T10:00:00.25Z"))
    }

    func testUnknownAgentFieldIsRejected() throws {
        var json = AuthFixture.meJSON
        json = json.replacingOccurrences(
            of: "\"display_name\": \"Ember\"",
            with: "\"display_name\": \"Ember\", \"policy_version\": 3"
        )

        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testEmptyDisplayNameIsRejected() {
        let json = AuthFixture.meJSON.replacingOccurrences(
            of: "\"display_name\": \"Ember\"",
            with: "\"display_name\": \"\""
        )
        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testOverlongDisplayNameIsRejected() {
        let json = AuthFixture.meJSON.replacingOccurrences(
            of: "\"display_name\": \"Ember\"",
            with: "\"display_name\": \"\(String(repeating: "e", count: 129))\""
        )
        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testNegativeTranscriptEpochIsRejected() {
        let json = AuthFixture.meJSON.replacingOccurrences(
            of: "\"transcript_epoch\": 0",
            with: "\"transcript_epoch\": -1"
        )
        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testNonIntegerTranscriptEpochIsRejected() {
        let json = AuthFixture.meJSON.replacingOccurrences(
            of: "\"transcript_epoch\": 0",
            with: "\"transcript_epoch\": 1.5"
        )
        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testMissingConversationIsRejected() {
        let json = """
            {
              "consumer_id": "22222222-2222-4222-8222-222222222222",
              "agent": { "agent_id": "33333333-3333-4333-8333-333333333333", "display_name": "Ember" }
            }
            """
        // There is no "not provisioned" branch: I-4 guarantees a Conversation exists.
        XCTAssertThrowsError(try decode(EmberMeDTO.self, json))
    }

    func testNonObjectBodyIsRejected() {
        XCTAssertThrowsError(try decode(EmberMeDTO.self, "[]"))
        XCTAssertThrowsError(try decode(EmberMeDTO.self, "\"ok\""))
    }

    // MARK: Request body

    func testCreateSessionRequestUsesTheFrozenFieldNames() throws {
        let request = EmberSessionCreateRequest.apple(identityToken: "jwt", nonce: "raw")
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), ["provider", "identity_token", "nonce"])
        XCTAssertEqual(object["provider"] as? String, "apple")
        XCTAssertEqual(object["identity_token"] as? String, "jwt")
        XCTAssertEqual(object["nonce"] as? String, "raw")
        // I-1: the client never sends identity scope fields.
        XCTAssertNil(object["tenant_id"])
        XCTAssertNil(object["principal_id"])
        XCTAssertNil(object["policy_version"])
    }

    // MARK: Redaction

    func testAccessTokenIsRedactedFromEveryDescription() throws {
        let token = try XCTUnwrap(EmberAccessToken("ems_never_log_this_secret"))

        for representation in [
            String(describing: token), String(reflecting: token), token.description,
        ] {
            XCTAssertFalse(representation.contains("never_log_this_secret"))
            XCTAssertTrue(representation.contains("<redacted>"))
        }
    }

    func testRecordDescriptionKeepsTheTokenOut() {
        let record = AuthFixture.record(tokenSuffix: "never_log_this_secret")

        for representation in [
            String(describing: record), String(reflecting: record), record.debugDescription,
        ] {
            XCTAssertFalse(representation.contains("never_log_this_secret"))
        }
    }
}
