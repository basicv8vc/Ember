# iOS Cloud API Handoff — B1 Conversation

- **Audience:** iOS Live client lead
- **Contract:** ADR-0004 and [B1 Platform Contract](../product/B1_PLATFORM_CONTRACT.md)
- **Runtime baseline:** `main@699fc8371069f68b28e7567f6c1f20d1226bbf01` (PR #120 merged); process E2E uses real Node API/Worker processes and PostgreSQL 17.
- **Evidence boundary:** The process harness verifies Ember Session behavior using the explicitly loopback-only `dev` identity. Apple assertion verification has a separate real HTTP/PostgreSQL test with a deterministic local JWK fixture; this does not claim validation against Apple's live service.

This is the B1 Cloud Conversation surface for the Live repository. IDs, message sequence, transcript epoch and Turn status returned by the server are authoritative. Values below are sanitized examples; bearer tokens, message text and IDs are placeholders.

## Endpoints and observed behavior

| Operation                  | Request                                                                                                                    | Verified response                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create session             | `POST /v1/auth/session` with `{ "provider": "apple", "identity_token": "<apple-identity-token>", "nonce": "<raw-nonce>" }` | `201`, `{ "session_id": "<uuid>", "consumer_id": "<uuid>", "access_token": "<redacted ems token>", "expires_at": "<UTC timestamp>" }`. The server provisions/reuses the durable Consumer, default Agent and main Conversation. |
| Current identity/bootstrap | `GET /v1/me`, `Authorization: Bearer <access_token>`                                                                       | `200`, consumer, default Agent, main Conversation, and current `transcript_epoch`. Re-authenticating the same identity reuses those durable IDs.                                                                               |
| Refresh / logout           | `POST /v1/auth/session/refresh` / `DELETE /v1/auth/session`, bearer only                                                   | Refresh `200` returns a rotated session DTO. Reusing a rotated token is rejected with `401`; logout returns `204`. Never resend the Apple assertion to refresh or logout.                                                      |
| Send message               | `POST /v1/conversations/{conversation_id}/messages`, bearer + JSON below                                                   | New commit `201`; identical replay `200`; both return the same canonical receipt. A conflicting reuse or stale epoch returns `409 IDEMPOTENCY_CONFLICT`.                                                                       |
| History page               | `GET /v1/conversations/{conversation_id}/messages?after=0&limit=50`                                                        | `200`; messages are in ascending server sequence. Defaults are `after=0`, `limit=50`; page size is 1–100. Continue with the prior response's `next_after`.                                                                     |
| Unknown ACK                | `GET /v1/message-submissions/{client_submission_id}`                                                                       | `200` returns the same canonical receipt as POST; unknown or foreign ID is `404`.                                                                                                                                              |
| Poll Turn                  | `GET /v1/conversations/{conversation_id}/turns/{turn_id}`                                                                  | `200` authoritative Turn DTO. B1 polling cadence is at most once per second per conversation; no SSE/WebSocket endpoint exists for Assistant Turns.                                                                            |
| Cancel Turn                | `POST /v1/conversations/{conversation_id}/turns/{turn_id}/cancel`, no body                                                 | `200` authoritative terminal DTO. Repeating cancellation returns the same terminal state.                                                                                                                                      |

### Send and canonical receipt

Generate one UUIDv4 `client_submission_id` per user intent, persist it with the exact text and current `transcript_epoch` before sending, and reuse it for retries of that same intent. Do not send `Idempotency-Key` on this route.

```http
POST /v1/conversations/<conversation-uuid>/messages
Authorization: Bearer <redacted>
Content-Type: application/json

{
  "client_submission_id": "<uuid-v4>",
  "text": "<private message redacted>",
  "transcript_epoch": 0
}
```

```json
{
  "message": {
    "message_id": "<server-message-uuid>",
    "conversation_id": "<conversation-uuid>",
    "sequence": 1,
    "kind": "user",
    "text": "<private message redacted>",
    "client_submission_id": "<same uuid-v4>",
    "created_at": "<UTC timestamp>"
  },
  "turn": {
    "turn_id": "<turn-uuid>",
    "status": "running",
    "created_at": "<UTC timestamp>"
  },
  "transcript_epoch": 0
}
```

The POST receipt does not contain assistant text or a later Turn status. Poll the Turn and fetch transcript history. A completed simulated response appears as a `kind: "ember"` message with `simulated: true` and a fake/simulated `model_label`; the UI must label it as simulated.

### History, Turn and errors

History page shape:

```json
{
  "conversation_id": "<conversation-uuid>",
  "transcript_epoch": 0,
  "messages": [
    {
      "message_id": "<uuid>",
      "sequence": 1,
      "kind": "user",
      "text": "<redacted>",
      "client_submission_id": "<uuid-v4>",
      "created_at": "<UTC timestamp>"
    },
    {
      "message_id": "<uuid>",
      "sequence": 2,
      "kind": "ember",
      "text": "[Simulated reply ...]",
      "model_label": "<fake responder label>",
      "simulated": true,
      "created_at": "<UTC timestamp>"
    }
  ],
  "next_after": 2,
  "has_more": false
}
```

Turn DTO shape is `{ "turn_id", "conversation_id", "source_message_id", "status", "created_at", "updated_at", "response_message_id", "failure_reason" }`. `status` is `running | completed | failed | cancelled`. Failure uses `failure_reason: "timeout" | "internal_error"` and includes the safe failure response message; cancellation has no failure reason. Do not infer assistant completion from HTTP 201 or the POST receipt.

Errors use the closed shape `{"error":{"code":"...","message":"...","request_id":"..."}}`; the request ID may be absent. Verified mappings relevant to Live are:

| HTTP | Code                   | Client action                                                                                                                                                               |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_ARGUMENT`     | Surface a request/client issue; do not retry unchanged.                                                                                                                     |
| 401  | `UNAUTHENTICATED`      | Refresh/sign in through the session flow. Invalid, expired and revoked sessions all use this response. Do not log or expose the bearer token.                               |
| 404  | `NOT_FOUND`            | Treat foreign and nonexistent resources identically; do not probe IDs.                                                                                                      |
| 409  | `IDEMPOTENCY_CONFLICT` | Reload `/v1/me` and history, reconcile the outbox and preserve unsent text for an explicit user action. This also covers stale transcript epochs.                           |
| 429  | `BUDGET_EXCEEDED`      | Stop automatic retries and show the bounded-use state.                                                                                                                      |
| 503  | `DB_UNAVAILABLE`       | Show temporary service unavailability. The response omits SQL/driver details, credentials and request content. Retry with the same submission ID only after reconciliation. |

## Unknown ACK and restart recovery

If a send times out or the connection drops, query Unknown ACK before deciding whether to resend. `200` means adopt the returned message and Turn IDs. On `404`, call `/v1/me`: resend the same intent, ID and epoch only if the epoch is unchanged. If it changed, discard the stale outbox entry before rendering the transcript. On app resume, page history and reconcile optimistic rows only by `client_submission_id`, never by text or timestamp. The API/Worker restart process E2E confirms that acknowledged history remains readable and a durable pending Turn can finish after Worker restart.

## iOS integration notes

- The existing UI/repository path is Mock-only. The open [iOS L1 authentication PR #119](https://github.com/basicv8vc/Ember/pull/119) adds a session foundation but explicitly does not enable Live Chat; no B1 Live Conversation repository is included in that scope.
- The current in-memory repository assigns client message IDs/sequences. A Live adapter must adopt server-issued message IDs and sequence numbers and retain `client_submission_id` plus `transcript_epoch` in a protected outbox.
- Keep Assistant Turn state separate from Task state. B1 Turn delivery is polling at no more than 1 Hz per conversation; Task SSE is not an Assistant stream.
- Never silently fall back from Live to fixtures, and never present `simulated: true` output as model-generated content.
- A 503 may happen after a write outcome is unknown. Use Unknown ACK reconciliation; do not mint a new submission ID or blindly duplicate the send.
- Redact Authorization, identity assertions, private prompts and error diagnostics from logs. The tested server error bodies/logging do not return database driver diagnostics.

## Verification references

- Independent process lifecycle: `tests/e2e/b1-cloud-process-lifecycle.test.ts` (real API and Worker child processes, PostgreSQL 17, loopback HTTP).
- Bounded database fault injection: `tests/e2e/stress/b1-worker-db-resilience.stress.ts` (separate from normal CI to avoid unbounded stress).
- Apple local-fixture/session HTTP behavior: `tests/e2e/b1-2c-session-http.test.ts`.
- Historical intermittent Worker failure on the pre-fix runtime: [GitHub Actions run 41989278252](https://github.com/basicv8vc/Ember/actions/runs/41989278252). Worker PostgreSQL recovery was fixed in PR #120 and merged to the acceptance baseline above. The independent post-fix verification, including three complete stress runs, is recorded in [PR #117](https://github.com/basicv8vc/Ember/pull/117).
