# Ember B1 — Platform Contract (iPhone-only Personal Agent Alpha)

> **Status: APPROVED DESIGN — CTO 2026-11-03, ADR-0004. Implementation gated by merge and per-slice tests.**
> This PR adds no routes, no migrations, no auth implementation, no provider credentials, no
> model spend and no APNs. Capabilities below are labelled **EXISTING**, **PROPOSED** or
> **DEFERRED** as _implementation states_; design approval does not make a route live.
>
> **Audit baseline:** `main` @ `154860a82402648ce0548573a3db1a85b5b45e37` (2026-11-03).
> Evidence was read from `apps/api/src/**`, `apps/worker/src/**`, `packages/contracts/src/**`,
> `packages/domain/src/**`, `packages/postgres/src/**`, `migrations/**`, `tests/**` and
> `apps/ios/EmberApp/Domain/**` at that commit. "EXISTING" means code plus its contract exist in
> this tree; it does **not** assert deployment, load, or consumer readiness.
>
> **Supersedes:** `docs/product/ios/IOS_M3_CONVERSATION_API_PROPOSAL.md` for every surface it
> overlaps. The divergences and their reasons are enumerated in §4.4; where the two disagree, this
> document is authoritative. `IOS_CONTRACT_FREEZE.md` is unaffected: no existing endpoint changes.
>
> **Normative status (Issue #91):** the versioned CTO decision record is
> `docs/adr/0004-beta-v1-live-platform-contract.md` (ADR-0004). **This file is that ADR's normative
> annex**, pinned by its git blob SHA. The ADR owns scope, decisions and approval; this file owns wire
> detail. There is no third contract: where this annex and the ADR could be read differently, the ADR
> wins and this annex is corrected in the same PR. `IOS_M3_CONVERSATION_API_PROPOSAL.md` is not an
> authority for any surface listed here (§4.4).
>
> **Round 1 review:** the CTO review on PR #92 requested five P0 corrections. All are applied in this
> revision and indexed in §17.2, which maps each review item to the section that now answers it.

> **CTO amendment (2026-11-04):**
> [Decision 0002](../decisions/0002-b1-1-tenant-wide-submission-uniqueness.md) supersedes the
> original submission-ID uniqueness scope in §6.4, §11.2 and D-6. The original annex blob
> `2e06b47691b71b05e3903f0bd65d5b9f381776c0` remains preserved in Git history; no HTTP route or
> DTO has changed.

## 1. Executive summary

The Alpha question this contract answers is narrow:

> Can one invited person, on one iPhone, sign in, hold **one persistent conversation** with one
> default Ember Agent, ask for bounded work, and after force-quitting and relaunching, still see
> the same messages, the same linked Task, and a truthful Task result — with no cross-tenant
> visibility and no content in logs?

Everything required for that loop is specified here; everything else is deferred with a reason.

What already exists and is reused unchanged: tenant-scoped bearer auth, `AuthContext`, one closed
error taxonomy with one HTTP mapping table; Task create/read/events/SSE/cancel with
`Idempotency-Key` semantics; durable artifacts, approvals, commitments, consents and forward-only
migrations 0001–0010; an iOS conversation domain model and repository protocol (local/Mock only,
no wire contract).

What B1 adds: **11 new endpoints, 2 additive field sets on existing endpoints, 7 new tables,
3 forward-only migrations, zero new error codes and zero new error fields**. Section 4 is the complete
delta. The one deliberately mandatory new field is `transcript_epoch` on send (§6.7): it is the fence
that stops a stale outbox from resurrecting deleted text, and it is required rather than optional
precisely because an absent epoch cannot be distinguished from a stale one.

**The Alpha cannot show a real model answer until B2 approves a Model Gateway (§2.2).** B1 makes
the loop testable with a deterministic, explicitly-simulated responder; it does not make the
assistant real, and the contract forbids labelling it as real.

## 2. Scope, non-goals, trust model

### 2.1 In scope (Alpha vertical slice)

1. Consumer identity and mobile session (sign-in, refresh, logout, session-authoritative tenant).
2. One default Ember Agent and one main Conversation per consumer, resolved server-side.
3. Persistent transcript: append, page, replay after relaunch.
4. Idempotent send with unknown-ACK recovery.
5. Assistant-turn lifecycle, independent of Task lifecycle.
6. Message → Task linkage without duplicating Task state.
7. Authenticated Task result retrieval with explicit availability states.
8. Retention, deletion, tenant isolation, content-safe logging.

### 2.2 Non-goals (deferred, with the blocking reason)

| Deferred capability                                | Why it is not in B1                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Model Gateway, provider keys, prompt egress, spend | B2 CTO gate; no provider integration or spend is authorized by this contract      |
| Token streaming / SSE for assistant text           | B2; B1 turn status is poll-only, which is sufficient for the Alpha loop           |
| APNs / notifications                               | Separate CTO gate; must not be faked before it                                    |
| Long-term memory and its consent controls          | B4; chat retention is not memory                                                  |
| Commitment references inside the transcript        | B3; the wire enum is frozen now (§6.2) so B3 needs no contract change             |
| Attachments, uploads, images                       | No storage path and no content-scanning story                                     |
| Second device, uninstall/reinstall recovery        | M4; B1 guarantees only same-installation recovery                                 |
| Multi-agent, personas, agent switching             | One partner first (roadmap principle 1)                                           |
| Account deletion and data export                   | **Must land before external TestFlight** (Apple 5.1.1(v)); see §10.4 and risk R-4 |
| Reverse (`before`) transcript pagination           | §6.5 — bounded by retention; a second cursor contract for no Alpha value          |

### 2.3 Trust model

Three parties, kept distinct:

1. **Consumer** — the human on the iPhone. Owns exactly one tenant at Alpha.
2. **Ember platform** — authenticates the consumer, maps the session to a tenant, and is the only
   authority for status, ordering, retention and deletion.
3. **Identity provider** — Apple. Proves _who_ the consumer is; it never decides _which tenant_,
   which Agent, or what may be read.

The Apple identity token is an **input to** session minting, never a bearer credential for Ember
APIs. No Ember endpoint accepts a provider token after `POST /v1/auth/session` (I-7).

## 3. Verified EXISTING baseline

| Capability                                             | Source of truth (verified)                                                    | Label                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------- |
| Bearer auth, fail-closed, dev tokens                   | `apps/api/src/auth/*.ts`                                                      | EXISTING — **development only**         |
| `AuthContext { tenantId, principalId, policyVersion }` | `packages/domain/src/types.ts`                                                | EXISTING                                |
| Closed error codes + HTTP table, cross-tenant = 404    | `packages/domain/src/errors.ts`, `apps/api/src/http/error-mapping.ts`         | EXISTING                                |
| Raw-stream body caps, `Idempotency-Key` schema         | `apps/api/src/http/bounded-body.ts`, `packages/contracts/src/task-schemas.ts` | EXISTING                                |
| Agents create/get (tenant-scoped)                      | `apps/api/src/agents/routes.ts`                                               | EXISTING — no "my default Agent"        |
| Tasks create/get/events/SSE/cancel                     | `apps/api/src/tasks/routes.ts`, `apps/api/src/tasks/constants.ts`             | EXISTING                                |
| Task idempotency (202 new / 200 replay / 409 mismatch) | `apps/api/src/tasks/task-store.ts`, `migrations/0002`                         | EXISTING                                |
| Task status vocabulary (7 states)                      | `migrations/0002` CHECK                                                       | EXISTING                                |
| Task events: closed payload allowlist, no free text    | `migrations/0002`, `packages/contracts/src/event-schemas.ts`                  | EXISTING                                |
| Artifacts (metadata + authenticated bytes)             | `apps/api/src/artifacts/routes.ts`, `migrations/0005`                         | EXISTING                                |
| Approvals (mock)                                       | `apps/api/src/approvals/routes.ts`, `migrations/0007`                         | EXISTING — mock semantics               |
| Commitments + outcomes                                 | `apps/api/src/commitments/routes.ts`, `migrations/0008`–`0009`                | EXISTING                                |
| Consents                                               | `apps/api/src/consents/routes.ts`, `migrations/0010`                          | EXISTING                                |
| Durable worker execution (mock kinds)                  | `apps/worker/src/durable-run-handler.ts`                                      | EXISTING — simulated outputs            |
| Forward-only migrations, checksum, advisory lock       | `migrations/0001`–`0010`, `packages/postgres/src/migrator.ts`                 | EXISTING                                |
| iOS conversation domain + repository protocol          | `apps/ios/EmberApp/Domain/Conversation/*.swift`                               | EXISTING — local only, no wire contract |
| Consumer identity / mobile session                     | —                                                                             | **GAP**                                 |
| Conversation / message / turn persistence              | —                                                                             | **GAP**                                 |
| Readable Task result (persisted text)                  | `packages/execution/src/fake-llm.ts` returns text **in memory only**          | **GAP**                                 |

Two baseline facts drive several decisions:

- **`TaskEvent` payloads are allowlisted to enums/UUIDs/integers/booleans — no free text**
  (`migrations/0002`). Assistant text therefore cannot ride on the existing event stream; it needs
  its own table (§11).
- **`fake-llm` text is never persisted.** A result contract cannot be implemented by pointing at
  current worker output; a durable result row is genuinely new (§9, §11).

## 4. EXISTING → PROPOSED delta (complete)

### 4.1 New endpoints

All are tenant-authenticated except `POST /v1/auth/session`, which is public by design (I-6).

| #   | Method + path                                                     | Purpose                                      | Level    |
| --- | ----------------------------------------------------------------- | -------------------------------------------- | -------- |
| 1   | `POST /v1/auth/session`                                           | Mint session from provider assertion         | PROPOSED |
| 2   | `POST /v1/auth/session/refresh`                                   | Rotate the presented session token           | PROPOSED |
| 3   | `DELETE /v1/auth/session`                                         | Revoke the presented session                 | PROPOSED |
| 4   | `GET /v1/me`                                                      | Identity + default Agent + main Conversation | PROPOSED |
| 5   | `POST /v1/conversations/{conversation_id}/messages`               | Idempotent append of user message + turn     | PROPOSED |
| 6   | `GET /v1/conversations/{conversation_id}/messages`                | Ascending page by `after` cursor             | PROPOSED |
| 7   | `GET /v1/message-submissions/{client_submission_id}`              | Unknown-ACK lookup, no body needed           | PROPOSED |
| 8   | `GET /v1/conversations/{conversation_id}/turns/{turn_id}`         | Authoritative turn state                     | PROPOSED |
| 9   | `POST /v1/conversations/{conversation_id}/turns/{turn_id}/cancel` | Stop the response, never the Task            | PROPOSED |
| 10  | `DELETE /v1/me/conversation/messages`                             | Delete transcript, keep durable work         | PROPOSED |
| 11  | `GET /v1/tasks/{task_id}/result`                                  | Typed result availability + content          | PROPOSED |

### 4.2 Additive changes to EXISTING endpoints (backwards compatible)

| Surface                  | Change                                                                                                                                                                                    | Compat             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `POST /v1/tasks` body    | `+ conversation_id?: uuid`, `+ source_message_id?: uuid` (both-or-neither; §8)                                                                                                            | Additive, optional |
| `POST /v1/tasks` receipt | `+ linked_message_id?: uuid`, `+ linked_message_sequence?: integer`, present only when linkage was requested                                                                              | Additive, optional |
| `TaskReceiptDtoSchema`   | two optional strict fields; internal `TaskReceiptSchema` unchanged                                                                                                                        | Additive           |
| Error responses          | No new codes and **no new fields**. `IDEMPOTENCY_CONFLICT` (409) is shared by the three conflict causes (§10.3); `BUDGET_EXCEEDED` (429) is reused for the per-conversation message quota | Reuse              |

`POST /v1/tasks`, `GET /v1/tasks/:id`, events, SSE, cancel, artifacts, approvals, commitments and
consents are otherwise **unchanged**: same status codes, same bodies, same idempotency rules. A
client that never sends the two new fields observes no difference.

The two reuses are deliberate. `BUDGET_EXCEEDED` is the platform's only 429 and the Alpha message
quota is a spend/abuse guard, so the client already knows how to treat it (soft limit, no retry loop);
inventing `RATE_LIMITED` would mean a new code in `DOMAIN_ERROR_CODES` and a new row in the HTTP
mapping table for a limit the Alpha does not need.

### 4.3 New persistence

`0011_identity_session.sql` (`consumers`, `consumer_identities`, `consumer_sessions`),
`0012_conversation.sql` (`conversations`, `conversation_messages`, `assistant_turns`),
`0013_task_results.sql` (`task_results`). **No change to `tasks`, `task_events`, `runs`,
`artifacts`, `commitments` or `consents`.** Sketch in §11.

### 4.4 Divergences from `ios/IOS_M3_CONVERSATION_API_PROPOSAL.md`

| Proposal                                            | This contract                                         | Reason                                                            |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `GET .../messages?before={cursor}`                  | `?after={sequence}` only                              | Recovery and initial load become one ascending replay; one cursor |
| `POST /v1/conversations` (create main conversation) | No create route; provisioned at sign-in (I-4)         | Removes an entire "conversation missing" client state             |
| Turn status `streaming`                             | `running`                                             | No B1 transport can produce "streaming" truthfully                |
| Generic link endpoint(s)                            | Link is atomic inside `POST /v1/tasks`; no link route | One round trip, no orphaned-Task window                           |
| Result states `available`/`missing`/`failed`        | `pending`/`available`/`unavailable` + `task_status`   | Failure reason lives in the Task resource; do not duplicate       |
| Separate `conversation.store` consent               | Not added                                             | Alpha uses first-run disclosure; §16 D-5                          |

## 5. Identity and session (normative)

### 5.1 Invariants

| ID  | Invariant (normative)                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1 | The tenant is **server-owned**. No body, query parameter or header may supply `tenant_id` or `principal_id`; arriving values are rejected by strict schemas, never ignored.                                                       |
| I-2 | At Alpha, consumer ↔ tenant is **1:1** and consumer ↔ principal is 1:1 with role `owner`. Tenants cannot be shared or joined from the client.                                                                                     |
| I-3 | The Apple `sub` claim (provider + subject) is the only identity key. Display name and email are **not** identity and are never stored from the token.                                                                             |
| I-4 | **A valid session token implies** an existing tenant, principal, default Ember Agent and main Conversation. Provisioning happens inside the session-creation transaction; if it fails, no token is issued (503 `DB_UNAVAILABLE`). |
| I-5 | Session tokens are opaque, ≥256 bits of CSPRNG entropy, prefixed `ems_`, sent only in `Authorization: Bearer`, stored server-side **only** as SHA-256 (existing dev-token precedent).                                             |
| I-6 | `POST /v1/auth/session` is the only unauthenticated `/v1` route besides `/healthz` and `/readyz`.                                                                                                                                 |
| I-7 | A provider assertion is accepted **only** at `POST /v1/auth/session`. `refresh` and `logout` authenticate with the current Ember session token alone and never re-read an Apple assertion (§5.3).                                 |
| I-8 | Tokens never appear in URLs, logs, error bodies, analytics or crash reports. iOS stores them in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.                                                             |
| I-9 | `AuthContext` shape is unchanged. Session authentication resolves `{tenantId, principalId, policyVersion}` exactly like dev auth, where `policyVersion` comes from the default Agent row.                                         |

I-9 is the load-bearing decision: **identity work terminates at `AuthContext`.** No task,
commitment, consent, approval or artifact route changes.

### 5.2 `POST /v1/auth/session`

Request (strict object, 8 KiB cap):

```json
{ "provider": "apple", "identity_token": "<jwt>", "nonce": "<client nonce>" }
```

| Rule                | Value                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel             | `provider` is a closed enum: `apple` (B1's only real provider) or `dev` (non-production only, §5.5 and Q-1). Any other value → 400 `INVALID_ARGUMENT`.                                                      |
| Provider validation | Apple JWKS signature, `iss=https://appleid.apple.com`, `aud` = Ember bundle id, `exp`/`iat` within ±5 min skew, `nonce` hash matches. Any failure → 401 `UNAUTHENTICATED` with one fixed message.           |
| Failure cost        | Every rejection path is indistinguishable; no "unknown user" vs "bad signature" difference.                                                                                                                 |
| Status              | **201, always.** Every call mints a new session; repeat sign-in still creates no second tenant, Agent or Conversation (I-4). Only the digest is stored, so a previously issued token can never be returned. |

Response:

```json
{
  "session_id": "uuid",
  "consumer_id": "uuid",
  "access_token": "ems_...",
  "expires_at": "2026-12-03T10:00:00Z"
}
```

`tenant_id`, `principal_id` and internal policy fields are **not** returned (I-1).

With `provider: "dev"` the same body shape applies: `identity_token` is any non-empty string that the
dev verifier maps deterministically to a subject, and `nonce` is ignored. The route is otherwise
identical, which is why T-1 and T-3 exercise the real provisioning path instead of a test-only
shortcut (§5.5).

### 5.3 Refresh, logout, TTL

| Operation | Semantics                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refresh   | `POST /v1/auth/session/refresh` with the current token → 200 with a new `access_token`; the presented session is revoked atomically with reason `rotated` and records `rotated_from_session_id`. |
| Reuse     | Presenting an already-rotated token revokes **all** sessions of that consumer and returns 401. This is the only replay defence B1 needs, and it costs one indexed lookup.                        |
| Logout    | `DELETE /v1/auth/session` → 204, idempotent, revokes only the presented session.                                                                                                                 |
| TTL       | Absolute 30 days, idle 14 days (sliding `last_seen_at`, updated at most once per hour). Expired → 401 `UNAUTHENTICATED`.                                                                         |
| Scope     | Refresh/logout never affect other sessions; B1 has no "sign out everywhere" operation.                                                                                                           |

### 5.4 `GET /v1/me`

```json
{
  "consumer_id": "uuid",
  "agent": { "agent_id": "uuid", "display_name": "Ember" },
  "conversation": {
    "conversation_id": "uuid",
    "transcript_epoch": 0,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Pure read: every field is guaranteed to exist by I-4, so `GET /v1/me` has no "not provisioned" or
"create" branch. It is the single bootstrap call the app makes after sign-in and on every cold
start. `agent.display_name` maps to the existing `agents.name` column; no rename and no new column.

`conversation.transcript_epoch` is the deletion generation (§6.7). It is a server-owned integer the
client stores with its outbox and echoes on every send; `GET /v1/me` is the call that refreshes it
after a cold start or a `409` fence rejection.

### 5.5 Development and test authentication (Q-1, conditional)

`dev_auth` stays as-is and remains how current E2E tests authenticate. B1 adds one parallel path
for tests: `provider: "dev"` on `POST /v1/auth/session`, accepted **only** under all three of the
following conditions, which the CTO's Q-1 answer makes mandatory:

1. an explicit non-production configuration (`NODE_ENV !== 'production'` **and** an opt-in flag — the
   existing dev-auth config only supplies the first half);
2. a **loopback-only listener** for the API process, so the route is unreachable from another host even
   on a developer machine or in CI;
3. the run is an isolated local/test/CI environment, never a shared staging deployment.

When any condition fails the route does not exist (404, identical to an unknown path) rather than
returning 403, so a misconfigured staging box does not advertise the capability. `R-9` records the risk
and the boot test that asserts both refusals.

It exercises the identical session, provisioning and `AuthContext` code path, so an E2E test proves the
real contract rather than a shortcut. Arbitrary subject strings therefore never mint real consumer
sessions anywhere except an isolated run.

## 6. Conversation and messages (normative)

### 6.1 Conversation

| ID  | Invariant                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | Exactly one Conversation of `kind = "main"` per Agent: `UNIQUE (tenant_id, agent_id, kind)`. B1 has no create, list or rename route.                            |
| C-2 | A Conversation is created only by provisioning (I-4), never by a client request.                                                                                |
| C-3 | `conversation_id` is opaque. A conversation owned by another tenant answers 404 `NOT_FOUND`, never 403 — the API must not confirm existence outside the tenant. |
| C-4 | `conversation.updated_at` advances on every append and is the only ordering signal exposed for the conversation itself.                                         |
| C-5 | Every message read and write is scoped by `tenant_id = <AuthContext.tenantId> AND conversation_id = <path id>`. Tenant is never inferred from the path.         |
| C-6 | Deleting transcript content (§10.4) never deletes Tasks, Task events, results or artifacts.                                                                     |
| C-7 | `conversation.transcript_epoch` is server-owned, monotonic and part of the conversation resource (§6.7). No request may set it; every send must echo it.        |

### 6.2 Message model (frozen closed enum)

Wire `kind` ↔ iOS `ConversationMessageKind` mapping is 1:1 with
`apps/ios/EmberApp/Domain/Conversation/ConversationModels.swift`.

| Wire `kind`            | Body fields                        | Produced in B1 | iOS case                  |
| ---------------------- | ---------------------------------- | -------------- | ------------------------- |
| `user`                 | `text`                             | yes            | `.user(text:)`            |
| `ember`                | `text`, `model_label`, `simulated` | yes            | `.ember(text:)`           |
| `activity`             | `text`, `source`                   | **no** (B3)    | `.activity(_)`            |
| `task_reference`       | `task_id`                          | yes            | `.taskReference(_)`       |
| `commitment_reference` | `commitment_id`                    | **no** (B3)    | `.commitmentReference(_)` |
| `outcome_reference`    | `outcome` (tagged union, §6.6)     | **no** (B3)    | `.outcomeReference(_)`    |

| ID  | Invariant                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-1 | The enum is **closed**. An unknown `kind` is a contract violation: the iOS adapter must reject the page, never coerce the message into prose.    |
| M-2 | `user`, `ember` and `activity` carry bounded text only; they never carry `task_id`, `commitment_id` or a status.                                 |
| M-3 | Reference kinds carry an identifier only. Task/Commitment status is **never** copied into a message; the owning API stays authoritative (§8.3).  |
| M-4 | `ember` text is assistant-authored output, `activity` text is platform-authored factual prose (B3). Neither may impersonate a Task state change. |
| M-5 | `model_label` and `simulated` are mandatory on every `ember` message (§9.4).                                                                     |
| M-6 | Text limits: `user.text` ≤ 4096 chars, `ember.text` ≤ 8192, `activity.text` ≤ 280. Over-limit → 400 `INVALID_ARGUMENT`.                          |
| M-7 | Message text is business data: it lives in the message row and is never copied into `task_events`, logs or `platform_metadata`.                  |

### 6.3 Ordering and the `sequence` cursor

| ID  | Invariant                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O-1 | `sequence` is **server-assigned**, starts at 1, and is gap-free and strictly increasing within one conversation.                                                                     |
| O-2 | Assignment happens in the same transaction that inserts the message, under `SELECT ... FOR UPDATE` on the conversation row, so gap-freedom holds for concurrent senders and replays. |
| O-3 | `sequence` is per conversation: never global, never reused, never recomputed.                                                                                                        |
| O-4 | Client ordering uses `sequence` only. `created_at` is display metadata and must not be used for ordering.                                                                            |
| O-5 | A page returns messages in ascending `sequence`; `next_after` is the last returned `sequence`, or the request's `after` when the page is empty.                                      |

### 6.4 `POST /v1/conversations/{conversation_id}/messages`

Headers: `Authorization: Bearer <session>`, `Content-Type: application/json`. Cap: 16 KiB.

```json
{
  "client_submission_id": "uuid v4",
  "text": "Book me a table for two on Friday",
  "transcript_epoch": 0,
  "client_created_at": "2026-11-03T09:58:11Z"
}
```

| Field                  | Type    | Rule                                                                                            |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `client_submission_id` | uuid    | Required. Generated before the first attempt; **the** dedupe key for the send.                  |
| `text`                 | string  | Required, 1–4096 chars after trim, must contain a non-whitespace character.                     |
| `transcript_epoch`     | integer | **Required**, ≥ 0. The `transcript_epoch` the client last read (§6.7). Stale value → 409 fence. |
| `client_created_at`    | RFC3339 | Optional, echo-only for diagnostics; never used for ordering (O-4).                             |

The message route deliberately takes **no** `Idempotency-Key`. Message idempotency must be
_recoverable_: after a lost response the client asks `GET /v1/message-submissions/{id}` (§10.1) and a
header key cannot answer that. Two keys for one write would also create a mismatch state that no
constraint can resolve, so `client_submission_id` is the tenant-wide dedupe key and it is stored
in the row (`UNIQUE (tenant_id, client_submission_id)`, §11.2). Tasks keep their EXISTING header
semantics unchanged (N-6).

`transcript_epoch` is required rather than optional because an omitted epoch is indistinguishable from
a stale one: a request that survived a transcript deletion without saying which transcript it belongs to
cannot be fenced (§6.7). Making it required costs the client one integer it already holds from
`GET /v1/me` and every page it has read.

Response `201` (new submission) or `200` (replay of the same `client_submission_id` and same text):

```json
{
  "message": {
    "message_id": "uuid",
    "conversation_id": "uuid",
    "sequence": 12,
    "kind": "user",
    "text": "Book me a table for two on Friday",
    "client_submission_id": "uuid v4",
    "created_at": "2026-11-03T09:58:12Z"
  },
  "turn": {
    "turn_id": "uuid",
    "status": "running",
    "created_at": "2026-11-03T09:58:12Z"
  },
  "transcript_epoch": 0
}
```

The envelope echoes `transcript_epoch` so a client that never calls `GET /v1/me` still converges on the
current generation, and so a `409` fence is always repairable in one extra round trip.

| ID  | Invariant                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | The user message row and the `assistant_turns` row are created in **one** transaction; no observable state has a message without a turn.                                                                                                                                                                                              |
| S-2 | Same `client_submission_id` + same conversation + same `text` + same current epoch → 200 with the identical `message_id`, `sequence` and `turn_id`. Nothing new is written, no turn is restarted.                                                                                                                                     |
| S-3 | Same `client_submission_id` + different `text` or conversation (any epoch) → 409 `IDEMPOTENCY_CONFLICT`, body shaped like the existing Task conflict body.                                                                                                                                                                            |
| S-4 | `201` is returned only after commit, so a 201 always means the message is readable by `GET .../messages`.                                                                                                                                                                                                                             |
| S-5 | A per-conversation quota is enforced (Alpha: 200 messages / rolling 24 h, Q-2). Exceeded → 429 `BUDGET_EXCEEDED`, no rows written.                                                                                                                                                                                                    |
| S-6 | The route never creates a Task. Task creation stays an explicit, separate `POST /v1/tasks` call (§8).                                                                                                                                                                                                                                 |
| S-7 | A request whose `transcript_epoch` is **older** than the conversation's current epoch → 409 `IDEMPOTENCY_CONFLICT`, no rows written, and the client's text is never re-inserted (§6.7). The 409 body is the EXISTING one for this code — same `code`, same fixed `message` — so no new error code, field or body shape is introduced. |

### 6.5 `GET /v1/conversations/{conversation_id}/messages`

Query: `after` (integer ≥ 0, default `0`) and `limit` (1–100, default 50). Strict schema: any other
parameter → 400 `INVALID_ARGUMENT`.

```json
{
  "conversation_id": "uuid",
  "transcript_epoch": 0,
  "messages": [
    {
      "message_id": "uuid",
      "sequence": 11,
      "kind": "ember",
      "text": "…",
      "model_label": "ember-fake-llm-1",
      "simulated": true,
      "created_at": "…"
    },
    {
      "message_id": "uuid",
      "sequence": 12,
      "kind": "user",
      "text": "…",
      "client_submission_id": "uuid v4",
      "created_at": "…"
    },
    {
      "message_id": "uuid",
      "sequence": 13,
      "kind": "task_reference",
      "task_id": "uuid",
      "created_at": "…"
    }
  ],
  "next_after": 13,
  "has_more": false
}
```

| ID   | Invariant                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RD-1 | `after=0` is the canonical initial load; the same call with the last `next_after` is forward recovery. One code path for both.                                                                     |
| RD-2 | Deleted messages are absent from pages, so `sequence` legitimately has gaps **after** a deletion (§10.4). Gap-freedom (O-1) describes assignment, not post-deletion reads.                         |
| RD-3 | `has_more` is computed with a `limit + 1` probe; `next_after` is the last returned `sequence`.                                                                                                     |
| RD-4 | A page never mixes tenants and never returns a message whose conversation the caller does not own.                                                                                                 |
| RD-5 | `client_submission_id` is returned on **every** `kind = "user"` message (and only there), so N-9 reconciliation is a field match, not a guess. It is the caller's own UUID, never a server secret. |
| RD-6 | The page carries `transcript_epoch`. If it is newer than the epoch the client holds, the client drops its optimistic rows and its outbox before rendering (§6.7).                                  |

The `RD-` prefix is deliberate: `R-1…R-9` are risks (§13), and one identifier space per kind of statement
is cheaper than remembering which `R-5` a row means. Read the page invariants as "read" and the risk
table as "risk".

### 6.6 `outcome_reference` union (frozen shape, unused in B1)

Referenced here so the wire format is frozen once; production is deferred to B3, which must not
reshape it.

```json
{ "kind": "outcome_reference", "outcome": { "outcome_kind": "meaningful_change" | "no_change" | "failed" | "denied", "task_id": "uuid", "commitment_id": "uuid|null" } }
```

`outcome_kind` reuses the EXISTING `OUTCOME_RESULT_STATUSES` enum
(`packages/contracts/src/commitment-schemas.ts`, `commitment_outcomes.result_status`) verbatim: B1
freezes the shape so B3 inherits a vocabulary that already exists instead of inventing a parallel one.
No free text, no timestamps, no status beyond those four tags.

### 6.7 Transcript epochs and deletion fencing (normative)

Deleting the transcript destroys rows, so any key or receipt that pointed at them is destroyed with
them. Without a fence, an outbox entry written before the deletion — or an old retry that never got an
answer — would silently re-insert deleted text on its next attempt. B1 therefore gives every
conversation a monotonic **deletion generation** and requires every send to declare it.

| ID   | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TE-1 | `conversations.transcript_epoch` is a server-owned `bigint NOT NULL DEFAULT 0`. Clients can never set it; it is only returned.                                                                                                                                                                                                                                                                                                                                 |
| TE-2 | It increases by exactly 1 inside the deletion transaction (§10.4), in the same commit that removes messages and turns. It never decreases and is never reused.                                                                                                                                                                                                                                                                                                 |
| TE-3 | `POST .../messages` must carry the epoch it was composed against. `epoch < current` (a send composed before a deletion) and `epoch > current` (a client that invented a value) are both rejected with the EXISTING 409 `IDEMPOTENCY_CONFLICT`, nothing written. The two causes differ only in a content-free server-side log field, never on the wire — the wire body is byte-identical to today's 409, and the client's recovery is the same for both (N-11). |
| TE-4 | The check is done under the same `SELECT … FOR UPDATE` on the conversation row that assigns `sequence` (O-2), so a delete cannot interleave between the fence check and the insert.                                                                                                                                                                                                                                                                            |
| TE-5 | No deleted content is retained anywhere to make this work: the fence is one integer on a row that already exists. **No tombstone table** of submission IDs, keys or text is created, so the fence costs no per-message growth (D-6).                                                                                                                                                                                                                           |
| TE-6 | `GET /v1/message-submissions/{client_submission_id}` (§10.1) is epoch-blind by construction: after a deletion the row is gone and the route answers 404, and the client must **not** turn that 404 into a retry with a stale epoch — the retry is what the fence rejects.                                                                                                                                                                                      |

The client procedure this implies (N-11 in §10.2) is short: store the epoch with every outbox entry;
on deletion, clear the outbox and any in-flight submission; on a fenced `409`, refetch `GET /v1/me`,
discard the queued entry, and keep the user's text **only** in the composer as an unsent draft with an
explicit "chat was cleared" notice — resending is a deliberate user action with a fresh
`client_submission_id`, never an automatic one.

Worked example, because this is the exact sequence that used to resurrect deleted text:

```text
epoch=0  POST {sub: S1, text: "secret lunch plan"}  -> 201, sequence 5      (client never sees ACK)
         DELETE /v1/me/conversation/messages                            -> 200, transcript_epoch = 1
         client relaunches with a stale outbox entry {S1, epoch 0}
epoch=1  POST {sub: S1, text: "secret lunch plan", transcript_epoch: 0}
                                                                    -> 409 IDEMPOTENCY_CONFLICT
                                                                       (same body as any conflict; 0 rows written)
         client clears outbox, GET /v1/me -> transcript_epoch 1
         user taps "Send" again: POST {sub: S2, text: …, transcript_epoch: 1} -> 201
```

Both halves matter: the stale write fails closed **and** the deleted text stays deleted. The user keeps
the ability to send a new, deliberate message.

## 7. Turn lifecycle (normative)

A **turn** is "the assistant is preparing a response to one user message". It is a UI concept with
a server-side record; it is **not** a Task and carries no execution semantics.

### 7.1 State machine (closed enum: `running`, `completed`, `failed`, `cancelled`)

| From      | To          | Trigger                                                                                |
| --------- | ----------- | -------------------------------------------------------------------------------------- |
| `running` | `completed` | The responder finished and its `ember` message committed in the same transaction.      |
| `running` | `failed`    | The responder raised; a fixed user-safe `ember` message is committed with the failure. |
| `running` | `cancelled` | `POST .../turns/{id}/cancel`, or the client's message was deleted (§10.4).             |
| terminal  | —           | Terminal states are final. No retry, no resurrection, no re-open.                      |

| ID  | Invariant                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1 | A turn stays `running` for a bounded budget (Alpha: 60 s); exceeding it becomes `failed` with reason `timeout`, deterministically, on read or by a sweeper.                                                                                                                                                                                                                |
| T-2 | The terminal transition and the resulting `ember` message commit in **one** transaction, so `completed` ⟺ **exactly one** response message — an `ember` message in the _same_ conversation, referenced by at most one turn (enforced by §11.2 constraints `assistant_turns_response_unique` + `assistant_turns_response_fk`). `failed` also gets exactly one safe message. |
| T-3 | `GET .../turns/{turn_id}` polling is the only progress signal in B1: no WebSocket, no SSE, no long-poll for turns.                                                                                                                                                                                                                                                         |
| T-4 | Cancel affects the turn only. It never cancels, mutates or delays a Task the message caused.                                                                                                                                                                                                                                                                               |
| T-5 | A turn ID is stable for the life of its message; the client stores it beside the local transcript row.                                                                                                                                                                                                                                                                     |
| T-6 | Clients poll at most once every 1000 ms per conversation. This is a client obligation, not a new error path: the poll is one indexed row read, and B1 adds **no** rate-limit error code (§4.2).                                                                                                                                                                            |

### 7.2 `GET /v1/conversations/{conversation_id}/turns/{turn_id}`

```json
{
  "turn_id": "uuid",
  "conversation_id": "uuid",
  "source_message_id": "uuid",
  "status": "completed",
  "created_at": "2026-11-03T09:58:12Z",
  "updated_at": "2026-11-03T09:58:19Z",
  "response_message_id": "uuid",
  "failure_reason": null
}
```

`failure_reason` is a closed enum (`timeout`, `internal_error`), `null` unless `status = "failed"`,
and never a free-text error channel. Cancellation is expressed by `status = "cancelled"` alone —
it is not a failure, so it carries no reason (§11.2 enforces both rules in one `CHECK`).

### 7.3 `POST /v1/conversations/{conversation_id}/turns/{turn_id}/cancel`

No body. `200` with the turn body when it was `running`; `200` with the unchanged turn when it was
already terminal (idempotent — never 409). Unknown or foreign turn → 404 `NOT_FOUND`.

### 7.4 Turn versus Task (the boundary clients must respect)

| Question                             | Turn                                | Task                                          |
| ------------------------------------ | ----------------------------------- | --------------------------------------------- |
| Represents                           | Assistant composing a reply         | Durable work with side effects                |
| State owner                          | `assistant_turns`                   | `tasks` + `task_events`                       |
| Authoritative read                   | `GET .../turns/{turn_id}`           | `GET /v1/tasks/{id}`                          |
| User-visible failure                 | Reply failure                       | Task status                                   |
| Cancellable                          | Yes (`.../cancel`)                  | Yes (`POST /v1/tasks/{id}/cancel`, EXISTING)  |
| May set Task status                  | **No**                              | Yes                                           |
| Survives transcript deletion (§10.4) | No — turns belong to the transcript | Yes — durable work is not user-editable state |
| Retry policy                         | None; the user sends a new message  | EXISTING durable retry semantics              |

### 7.5 What the database enforces, and what the transaction enforces

T-2 is only credible if the reader can tell where each guarantee lives. "A `CHECK` cannot inspect
another row" is a real limit, so this table is normative: an implementation may not claim a guarantee
that its constraint does not actually provide.

| Claim                                                       | Enforced by                                                                                                                            | Kind                         | Test |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---- |
| `sequence` gap-free per conversation (O-1)                  | `UNIQUE (tenant_id, conversation_id, sequence)` + `SELECT … FOR UPDATE` on the conversation row in the insert txn                      | SQL + transaction            | T-12 |
| A turn's response message is in the **same conversation**   | Composite FK `(tenant_id, conversation_id, response_message_id)` → `conversation_messages (tenant_id, conversation_id, ember_only_id)` | SQL (FK)                     | T-17 |
| A turn's response message is `kind = 'ember'`               | Same FK, through the generated column `conversation_messages.ember_only_id`, which is non-null only for `ember` rows                   | SQL (FK on generated column) | T-17 |
| A message is the response of **at most one** turn (T-2)     | `UNIQUE (tenant_id, response_message_id)` on `assistant_turns`                                                                         | SQL (unique)                 | T-17 |
| A turn's source message is in the same conversation (L-2)   | Composite FK `(tenant_id, conversation_id, source_message_id)` → `conversation_messages (tenant_id, conversation_id, id)`              | SQL (FK)                     | T-17 |
| `completed` ⇒ response message exists (T-2)                 | `CHECK`: `status <> 'completed' OR response_message_id IS NOT NULL`                                                                    | SQL (CHECK)                  | T-12 |
| `completed` was reached **atomically with** that message    | The single transaction in §7.1; no constraint can prove two writes happened together                                                   | Transaction invariant        | T-6  |
| `failed` ⇒ exactly one safe message, `failure_reason` set   | `CHECK` on reason/status pairing + the same transaction                                                                                | SQL (CHECK) + transaction    | T-12 |
| A `task_reference` message always implies a real Task (L-5) | `CHECK` on the message shape + the FK to `tasks` + the linkage transaction (§8.1)                                                      | SQL + transaction            | T-7  |
| Exactly one consumer per tenant (I-2)                       | `UNIQUE (tenant_id)` on `consumers`                                                                                                    | SQL (unique)                 | T-17 |
| Message text never leaves the message row (M-7)             | No write path targets `task_events`; asserted, not constrained                                                                         | Test invariant               | T-13 |

Two consequences are load-bearing for the review:

1. **`kind = 'ember'` is now a database guarantee**, not a convention: the generated column makes a
   non-`ember` message un-referenceable by a turn. A `CHECK` could not have done this.
2. Where the table says "transaction invariant", the guarantee is real but lives in one code path, so it
   is covered by a test that fails if the two writes are ever split. Concurrency and isolation tests for
   the same rows are T-17.

## 8. Message → Task linkage (normative)

### 8.1 Request addition to `POST /v1/tasks`

Two optional, additive fields on the existing strict body schema:

```json
{
  "agent_id": "uuid",
  "kind": "…",
  "input": { "…": "…" },
  "conversation_id": "uuid",
  "source_message_id": "uuid"
}
```

| ID   | Invariant                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L-1  | `conversation_id` and `source_message_id` are **both-or-neither**. Exactly one present → 400 `INVALID_ARGUMENT` with a dedicated, stable message.                                                                                                                                                                                                                                                            |
| L-2  | The message must belong to the caller's tenant **and** to the given `conversation_id`. Otherwise 404 `NOT_FOUND` — never 403, never 400 (no existence oracle).                                                                                                                                                                                                                                               |
| L-3  | The message's `kind` must be `user`. Linking an `ember` or reference message → 400 `INVALID_ARGUMENT`.                                                                                                                                                                                                                                                                                                       |
| L-4  | Many Tasks may reference one message; a Task references at most one message.                                                                                                                                                                                                                                                                                                                                 |
| L-5  | The `task_reference` message row is created in the same transaction as the Task, so no window exists where a Task is real but invisible in the transcript.                                                                                                                                                                                                                                                   |
| L-6  | An idempotent replay (same `Idempotency-Key`, same digest) returns the **same** `linked_message_id` / `linked_message_sequence` and never writes a second reference message.                                                                                                                                                                                                                                 |
| L-7  | `tasks.digest` (EXISTING) is unchanged: linkage is normalized out before digesting, so an existing client's idempotency behaviour is byte-identical and no digest row is migrated.                                                                                                                                                                                                                           |
| L-8  | Linkage is **frozen by first persistence**. The reference row is the only record of it, and it is immutable: nothing in B1 updates or deletes an individual reference message except transcript deletion.                                                                                                                                                                                                    |
| L-9  | On replay the server compares the **requested** linkage with the persisted one inside the same transaction (`SELECT … FROM conversation_messages WHERE tenant_id=$1 AND task_id=$2 FOR SHARE`). Equal (both absent, or same `conversation_id` + `source_message_id`) → replay. Any difference → 409 `IDEMPOTENCY_CONFLICT` (existing body, no new code or field), and the original Task is **not** modified. |
| L-10 | The comparison covers all four directions explicitly: **none → some** (creation had no linkage, retry adds it) → conflict; **some → none** → conflict; **some → different message** → conflict; **different conversation, same message id** → conflict. A Task is never silently attached to, moved to, or detached from a message.                                                                          |
| L-11 | If the transcript was deleted after linkage, the persisted reference is gone, so a replay that _requests_ linkage now conflicts (L-9, fail closed) and a replay that requests none replays normally. The deleted message is not recreated either way.                                                                                                                                                        |

L-7 and L-9 are a pair, and the split is deliberate. The **digest** must describe the business request,
otherwise a client recovering a lost ACK with linkage attached would get a spurious conflict — that was
the original intent and it stands. But a digest is not a record of what was persisted, so the digest
cannot be the thing that decides where a Task appears in the transcript. The **equality check** supplies
that, transactionally, without changing EXISTING Task idempotency rows or behaviour.

The rejected alternative was to fold linkage into `tasks.digest`. It looks simpler, but it changes the
meaning of every existing digest, makes "same key, no linkage, retry with linkage" indistinguishable
from "different request", and forces a data migration on a table this contract promised not to touch.

### 8.2 Receipt addition

The existing `TaskReceiptDto` gains two optional fields, present only when linkage was requested:

```json
{
  "task": { "…": "…" },
  "linked_message_id": "uuid",
  "linked_message_sequence": 14
}
```

`GET /v1/tasks/{task_id}` is unchanged: it does **not** return reverse links. The two fields are
present only when the first persisted request carried linkage; they are absent (not `null`) otherwise,
including on a replay that requests none after the transcript was deleted (L-11).

### 8.3 Why the reference is a message, not a status copy

| Option                                  | Verdict                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Copy Task status into the message text  | Rejected (M-3): guarantees drift and forces transcript rewrites on every state change.                    |
| Push Task events into the transcript    | Rejected: `task_events` payloads are allowlisted and cannot carry text (§3); it would also duplicate SSE. |
| Reference message + on-demand Task read | **Chosen**: transcript stays append-only; the Task resource remains the single source of truth.           |

### 8.4 Client procedure (normative)

1. `POST .../messages` with a fresh `client_submission_id`; keep `message_id` and the returned
   `transcript_epoch`.
2. If a Task is required, `POST /v1/tasks` with `conversation_id` + `source_message_id` and a fresh
   `Idempotency-Key`. On 202/200 store `linked_message_id`.
3. Render Task state only from `GET /v1/tasks/{id}` or the existing SSE stream. A reference message
   never implies a status.
4. Decide the linkage **before** the first Task attempt and never change it. A retry of the same
   `Idempotency-Key` must resend the same linkage; a `409 linkage_mismatch` (L-9/L-10) is a client bug
   that must be surfaced, never repaired by issuing a second `POST /v1/tasks` under a new key — that
   would create a duplicate Task.

A message with no linked Task is legal and shows no Task UI.

## 9. Task result retrieval (normative)

### 9.1 Problem the contract must solve

Today the worker's LLM output exists only in memory (`packages/execution/src/fake-llm.ts`), so
"show me the answer" is unimplementable. B1 defines a durable result resource; producing _real_
model output is B2 work, but the _shape_ is frozen now.

### 9.2 `GET /v1/tasks/{task_id}/result`

```json
{
  "task_id": "uuid",
  "task_status": "completed",
  "result_state": "available",
  "result": {
    "summary_text": "I found three options…",
    "detail_text": "…",
    "model_label": "ember-fake-llm-1",
    "simulated": true,
    "produced_at": "2026-11-03T09:58:19Z"
  }
}
```

| ID  | Invariant                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X-1 | `result_state` is a closed enum: `pending` (Task not terminal), `available` (terminal, text stored), `unavailable` (terminal, no text will ever exist).                                                                                                                 |
| X-2 | `result` is `null` unless `result_state = "available"`. No empty-object or empty-string sentinels.                                                                                                                                                                      |
| X-3 | `task_status` is always present and authoritative. `result_state` never encodes failure reasons; that is `task_status`'s job (`unavailable` + `failed`).                                                                                                                |
| X-4 | `unavailable` is a legitimate outcome (e.g. an artifact-only Task kind). It is **200**, not 404.                                                                                                                                                                        |
| X-5 | Unknown or foreign `task_id` → 404 `NOT_FOUND`; the route is tenant-scoped exactly like `GET /v1/tasks/{id}`.                                                                                                                                                           |
| X-6 | Text limits: `summary_text` ≤ 2048, `detail_text` ≤ 16384. At write time over-limit text is truncated and flagged internally; the wire never exceeds the limit.                                                                                                         |
| X-7 | Results are immutable once `available`. Re-running a Task creates a new Task.                                                                                                                                                                                           |
| X-8 | `model_label` and `simulated` follow M-5, so the client can label simulated output without heuristics.                                                                                                                                                                  |
| X-9 | A **terminal** `task_status` never maps to `result_state = "pending"`. If no `task_results` row exists for a terminal Task (§9.3 W-2), the route derives `unavailable` from the authoritative status and returns `result: null` — 200, never `pending`, never an error. |

### 9.3 Write path (who fills `task_results`)

Every path that terminalizes a Task writes exactly one `task_results` row in the same transaction as
its terminal status: the worker on `task_completed` / `task_failed`, and cancellation, deadline sweep,
reaper and recovery on `cancelled` / `failed`. The route is still a pure reader, and X-9 keeps the read
side correct if a row is ever missing.

| ID  | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-1 | Writing a result is **idempotent on `task_id`** (`UNIQUE (tenant_id, task_id)`); a retried durable run cannot duplicate text.                                                                                                                                                                                                                                                                                                                                         |
| W-2 | **Every terminalizer** covers the row, not only the worker's result-commit path: worker completion/failure writes `available`/`unavailable`; cancellation, deadline sweep, reaper and recovery terminalization write `unavailable` (`reason_code = 'no_text_output'`) **in the same transaction that sets the terminal status**. If a row is nonetheless missing, X-9 defines the read behaviour, so `pending` strictly means "not terminal yet" even after a defect. |
| W-3 | The worker never writes `available` for text exceeding X-6; it truncates and records that fact.                                                                                                                                                                                                                                                                                                                                                                       |
| W-4 | `task_results` is never written by an API route — readers only.                                                                                                                                                                                                                                                                                                                                                                                                       |
| W-5 | Deleting the transcript (§10.4) does not touch `task_results` (C-6).                                                                                                                                                                                                                                                                                                                                                                                                  |
| W-6 | The terminal status is **authoritative over** the result row. `GET result` always returns the Task's live status (X-3) and never a cached copy, so a late terminalizer cannot leave the result contract describing a stale state.                                                                                                                                                                                                                                     |

`reason_code` and `truncated` are **internal** columns: §9.2 deliberately exposes neither, because the
user-facing reason for a Task is `task_status` (X-3) and truncated text is already bounded on the wire
(X-6). They exist so operators can tell "no text existed" apart from "text was cut".

### 9.4 Simulated output must be self-declaring

Every produced text carries `model_label` and `simulated`. A simulated responder MUST set
`simulated: true` and a label containing `-fake-` or `-echo-`. The existing generator already reports
`FAKE_LLM_MODEL = 'ember-fake-llm-1'` (`packages/execution/src/fake-llm.ts`), so the rule holds by
construction rather than by convention. No configuration may make simulated text indistinguishable
from real model output; this is the Alpha anti-misrepresentation rule and is asserted in test T-6 (§12).

## 10. Reliability, deletion, isolation and privacy (normative)

### 10.1 Idempotent send and unknown-ACK recovery

| ID  | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-1 | A client-generated `client_submission_id` is written **before** the first attempt and reused on every retry of the same message.                                                                                                                                                                                                                                                                                                                                |
| N-2 | `GET /v1/message-submissions/{client_submission_id}` returns 200 with the identical `POST` body (message + turn) when the submission exists, and 404 `NOT_FOUND` when it never committed. No body, no `Idempotency-Key`.                                                                                                                                                                                                                                        |
| N-3 | Recovery procedure: on timeout or transport error call N-2. 200 → adopt the existing message; 404 → retry `POST` with the same `client_submission_id`.                                                                                                                                                                                                                                                                                                          |
| N-4 | A `409 IDEMPOTENCY_CONFLICT` from the POST means either the ID was reused with different text (S-3) or the send is fenced by a transcript deletion (S-7). In **both** cases the client stops retrying and surfaces the conflict; it must **not** silently mint a new ID and resend the same intent, because that can duplicate a message. Resending is an explicit user decision ("Send as new message"), and only then is a new `client_submission_id` minted. |
| N-5 | Submissions are tenant-scoped; a foreign or unknown ID answers 404, never 403.                                                                                                                                                                                                                                                                                                                                                                                  |
| N-6 | Tasks keep the EXISTING `Idempotency-Key` discipline, extended by the linkage freeze L-8/L-9.                                                                                                                                                                                                                                                                                                                                                                   |

### 10.2 Client-side ordering and reconciliation

| ID   | Invariant                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-7  | The client keeps a local outbox keyed by `client_submission_id`; an entry leaves the outbox only after a 200/201 carrying a `sequence`.                                                                                                               |
| N-8  | Optimistic rows carry `sequence: null`, order after confirmed rows by local timestamp, and never claim a server sequence.                                                                                                                             |
| N-9  | On resume the client calls `GET .../messages?after=<last seen>` and reconciles **by field**: rows whose `kind = "user"` carries the outbox `client_submission_id` (RD-5) replace the optimistic row. There is no text, timestamp or length heuristic. |
| N-10 | Duplicate deliveries are impossible: writes dedupe on `client_submission_id`, and reads are a pure function of `sequence`.                                                                                                                            |
| N-11 | Every outbox entry stores the `transcript_epoch` it was composed against. Deleting the transcript **clears the outbox and retires in-flight submissions**; nothing queued before a deletion may be retried (TE-3, §10.4).                             |
| N-12 | Reconciliation never infers "gone" from absence: a 404 from N-2 plus a stale epoch is a deletion, not a lost ACK, and is resolved by N-11 rather than by retrying.                                                                                    |

### 10.3 Failure semantics (client-visible)

| Situation                                                                                          | Server response                                    | Client behaviour                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session expired / revoked                                                                          | 401 `UNAUTHENTICATED`                              | Refresh once, then sign in again; never retry blindly                                                                                                                                                    |
| Conversation not owned / unknown                                                                   | 404 `NOT_FOUND`                                    | Fatal for that conversation; re-bootstrap with `GET /v1/me`                                                                                                                                              |
| Message text too long                                                                              | 400 `INVALID_ARGUMENT`                             | Block the send locally (M-6 should have caught it)                                                                                                                                                       |
| `client_submission_id` reused, or send fenced by a deletion, or Task replay with different linkage | 409 `IDEMPOTENCY_CONFLICT` (one identical body)    | Stop retrying; refetch `GET /v1/me` + the page, clear the outbox entry, keep the text as an unsent draft, surface the conflict. Never auto-resend, never re-POST a Task under a new key (N-4, N-11, L-9) |
| Per-conversation quota                                                                             | 429 `BUDGET_EXCEEDED`                              | Show a soft limit message; no retry loop                                                                                                                                                                 |
| Turn polled too often                                                                              | No server error (T-6)                              | Honour the 1000 ms cadence; a hot loop is a client bug                                                                                                                                                   |
| Turn exceeded budget                                                                               | 200, `status: "failed"`, reason `timeout`          | Show a retryable failure inside the transcript                                                                                                                                                           |
| Task terminal but no result row (defect)                                                           | 200, `result_state: "unavailable"`, `result: null` | Render `task_status`; `pending` is never faked (X-9)                                                                                                                                                     |
| Server unavailable                                                                                 | 503 `DB_UNAVAILABLE` / 5xx                         | Retry with jittered backoff using the same submission ID **and the same epoch**                                                                                                                          |

The single-409 row is deliberate. All three conflict causes require the _same_ client action, so
distinguishing them on the wire would add a field to a `strictObject` error body (breaking every
existing parser) to enable behaviour the client must not perform anyway. The server records the cause in
a content-free log field (G-1); the wire stays byte-identical to today's 409.

### 10.4 Deletion and retention

| Surface                               | Rule                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /v1/me/conversation/messages` | Deletes all `conversation_messages` and `assistant_turns` of the caller's main Conversation **and increments `transcript_epoch` by 1 in the same transaction**. `200 {"deleted_messages": <n>, "deleted_turns": <n>, "transcript_epoch": <new>}`; idempotent (second call deletes nothing and still increments, which is why the response always carries the current epoch). |
| Not deleted by that route             | Tasks, `task_events`, runs, `task_results`, artifacts, commitments, outcomes, consents, the conversation row itself, and the consumer record.                                                                                                                                                                                                                                |
| Turns running at deletion time        | Transitioned to `cancelled` in the same transaction; no response message is written (T-2 exemption).                                                                                                                                                                                                                                                                         |
| Pre-deletion sends                    | Fenced, not tombstoned: a submission composed against an older epoch is rejected with 409 (TE-3/S-7) and its text is never re-inserted. The client clears its outbox (N-11). No per-message tombstone table exists (TE-5).                                                                                                                                                   |
| User-visible confirmation             | Clearing the transcript is **not** account or data deletion. The iOS confirmation must say so explicitly and name what remains: Tasks, their results and artifacts are kept (Q-3). This is a truthfulness requirement, not a copy detail.                                                                                                                                    |
| Retention — transcript                | Deleted immediately on request; otherwise kept for the life of the account (no automatic expiry in B1).                                                                                                                                                                                                                                                                      |
| Retention — `consumer_sessions`       | Expired and revoked rows purged after 30 days by a maintenance job.                                                                                                                                                                                                                                                                                                          |
| Retention — `task_results`            | Kept as long as the Task; deleting a Task is not a B1 capability.                                                                                                                                                                                                                                                                                                            |
| Retention — logs                      | Content-free by construction (§10.6); 30-day operational retention.                                                                                                                                                                                                                                                                                                          |
| Account deletion / data export        | **DEFERRED (B2)** — see R-4: mandatory before any external TestFlight build (Apple 5.1.1(v)).                                                                                                                                                                                                                                                                                |

The deliberate split: **the transcript is user-owned and deletable; durable work is not.** A user
can clear what they see without destroying approvals, artifacts or commitments that other records
reference.

### 10.5 Tenant isolation

| ID    | Invariant                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISO-1 | Every new table carries `tenant_id NOT NULL` as its first column; every index is tenant-prefixed.                                                |
| ISO-2 | No route reads a tenant from path, query, body or header (I-1).                                                                                  |
| ISO-3 | Cross-tenant access is indistinguishable from non-existence: 404 with the same body as a genuinely missing resource.                             |
| ISO-4 | Foreign keys are composite where practical — `(tenant_id, conversation_id)` — so another tenant's row cannot be joined in, even by a future bug. |
| ISO-5 | Background jobs (turn sweeper, session purge) iterate per tenant and never query across tenants without an explicit `tenant_id` predicate.       |
| ISO-6 | Integration tests assert isolation for every new endpoint in both directions (A→B and B→A) — §12 row T-5.                                        |

### 10.6 Content-safe logging

| ID  | Invariant                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 | Logs may contain: request id, route template, HTTP status, `error_code`, `tenant_id` **hashed**, `consumer_id` hashed, `conversation_id`, `message_id`, `turn_id`, `task_id`, `sequence`, durations, byte counts. |
| G-2 | Logs must never contain: message `text`, result `summary_text`/`detail_text`, session tokens, provider assertions, or Apple identity claims.                                                                      |
| G-3 | `Authorization` is redacted in the existing request-logging path; new routes inherit it and it is asserted by a test.                                                                                             |
| G-4 | Error bodies never echo request bodies back on 400/409 (existing error mapper already satisfies this; new routes must not bypass it).                                                                             |
| G-5 | Structured log fields are allowlisted per route, so a new field must be added deliberately rather than derived from the payload.                                                                                  |
| G-6 | Debug-level logging of payloads is forbidden in every environment, including development (`NODE_ENV=development` included).                                                                                       |

## 11. Migration sketches (PROPOSED — not written)

All three follow existing conventions: header comment, `CREATE TABLE IF NOT EXISTS`, composite
`(tenant_id, id)` uniques, composite tenant FKs, `CHECK` enums instead of Postgres `ENUM`, partial
indexes, and `DO $$` guards for any `ALTER`. Forward-only; ids `0011`–`0013` are unique.

### 11.1 `0011_identity_session.sql`

```sql
-- 0011_identity_session.sql
-- B1: consumer identity + mobile session. Additive only. 0001-0010 immutable.
--
-- Design notes:
--   * A `consumer` is a human; a `tenant` is the isolation boundary. Alpha is 1:1.
--   * Identity keys are provider subjects. Display name/email are NOT identity and are not stored.
--   * Session tokens are opaque; only the SHA-256 digest is stored (dev-token precedent).

CREATE TABLE IF NOT EXISTS consumers (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  principal_id uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumers_tenant_id_id_unique UNIQUE (tenant_id, id),
  -- I-2: tenant ↔ consumer is 1:1, not just "a consumer belongs to a tenant". Without this
  -- the claimed invariant only held in the provisioning code, never in the database.
  CONSTRAINT consumers_one_per_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT consumers_tenant_principal_unique UNIQUE (tenant_id, principal_id),
  CONSTRAINT consumers_principal_fk FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS consumer_identities (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  consumer_id        uuid        NOT NULL,
  provider           text        NOT NULL,
  provider_subject   text        NOT NULL,   -- Apple `sub`; the only identity key
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_identities_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT consumer_identities_provider_unique UNIQUE (provider, provider_subject),
  CONSTRAINT consumer_identities_consumer_fk FOREIGN KEY (tenant_id, consumer_id)
    REFERENCES consumers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT consumer_identities_provider_check CHECK (provider IN ('apple', 'dev'))
);

CREATE TABLE IF NOT EXISTS consumer_sessions (
  id                      uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  consumer_id             uuid        NOT NULL,
  token_digest            bytea       NOT NULL,   -- sha256(token); never the token
  issued_at               timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  idle_expires_at         timestamptz NOT NULL,
  revoked_at              timestamptz,
  revocation_reason       text,
  rotated_from_session_id uuid,
  CONSTRAINT consumer_sessions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT consumer_sessions_digest_unique UNIQUE (token_digest),
  CONSTRAINT consumer_sessions_consumer_fk FOREIGN KEY (tenant_id, consumer_id)
    REFERENCES consumers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT consumer_sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revocation_reason IN ('logout', 'rotated', 'reuse_detected'))
  ),
  CONSTRAINT consumer_sessions_expiry_order_check CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS consumer_sessions_active_idx
  ON consumer_sessions (tenant_id, consumer_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS consumer_sessions_purge_idx
  ON consumer_sessions (expires_at)
  WHERE revoked_at IS NOT NULL;
```

Backfill: none. Existing dev-auth tenants are untouched; a dev session is created on demand.

### 11.2 `0012_conversation.sql`

```sql
-- 0012_conversation.sql
-- B1: conversation, message and turn persistence. Additive only.
--
-- Design notes:
--   * One `main` conversation per agent (C-1). Provisioned in the sign-up transaction (I-4).
--   * `sequence` is per conversation and assigned under a row lock on `conversations` (O-2).
--   * Message bodies are business data: bounded text plus a closed `kind` CHECK (M-1/M-6).
--   * `assistant_turns` carries no execution authority; Tasks are the only execution record.

CREATE TABLE IF NOT EXISTS conversations (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  agent_id         uuid        NOT NULL,
  kind             text        NOT NULL DEFAULT 'main',
  last_sequence    bigint      NOT NULL DEFAULT 0,
  transcript_epoch bigint      NOT NULL DEFAULT 0,   -- deletion generation (§6.7)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT conversations_one_per_kind_unique UNIQUE (tenant_id, agent_id, kind),
  CONSTRAINT conversations_agent_fk FOREIGN KEY (tenant_id, agent_id)
    REFERENCES agents (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversations_kind_check CHECK (kind IN ('main')),
  CONSTRAINT conversations_sequence_non_negative_check CHECK (last_sequence >= 0),
  CONSTRAINT conversations_epoch_non_negative_check CHECK (transcript_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  conversation_id       uuid        NOT NULL,
  sequence              bigint      NOT NULL,
  kind                  text        NOT NULL,
  text                  text,
  model_label           text,
  simulated             boolean,
  source                text,
  task_id               uuid,
  commitment_id         uuid,
  outcome              jsonb,
  client_submission_id  uuid,
  -- FK target that is non-NULL only for `ember` rows, so `assistant_turns` cannot reference
  -- any other kind. A CHECK cannot inspect the referenced row's kind; an FK on a generated
  -- column can (T-2, §7.5).
  ember_only_id         uuid        GENERATED ALWAYS AS (CASE WHEN kind = 'ember' THEN id END) STORED,
  -- Same trick for the user message a turn answers (S-1).
  user_only_id          uuid        GENERATED ALWAYS AS (CASE WHEN kind = 'user' THEN id END) STORED,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT conversation_messages_tenant_conversation_id_unique
    UNIQUE (tenant_id, conversation_id, id),
  CONSTRAINT conversation_messages_sequence_unique UNIQUE (tenant_id, conversation_id, sequence),
  CONSTRAINT conversation_messages_tenant_submission_unique
    UNIQUE (tenant_id, client_submission_id),
  CONSTRAINT conversation_messages_ember_target_unique
    UNIQUE (tenant_id, conversation_id, ember_only_id),
  CONSTRAINT conversation_messages_user_target_unique
    UNIQUE (tenant_id, conversation_id, user_only_id),
  CONSTRAINT conversation_messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  -- L-5: a `task_reference` points at a real Task in the same tenant.
  CONSTRAINT conversation_messages_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_kind_check CHECK (
    kind IN ('user', 'ember', 'activity', 'task_reference',
             'commitment_reference', 'outcome_reference')
  ),
  -- M-2/M-3 closed union: each variant names every other variant's fields as NULL, so a
  -- reference row cannot carry `model_label`/`simulated`/`source`/`client_submission_id`, and a
  -- text row cannot carry a reference. The `OR` chain is the whole point: without it PostgreSQL
  -- rejects the DDL, which is what B1-1's migration smoke test proves.
  CONSTRAINT conversation_messages_shape_check CHECK (
    (kind = 'user'
      AND text IS NOT NULL AND client_submission_id IS NOT NULL
      AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'ember'
      AND text IS NOT NULL AND model_label IS NOT NULL AND simulated IS NOT NULL
      AND client_submission_id IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'activity'
      AND text IS NOT NULL AND source IS NOT NULL
      AND model_label IS NULL AND simulated IS NULL AND client_submission_id IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND outcome IS NULL)
    OR
    (kind = 'task_reference'
      AND task_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND commitment_id IS NULL AND outcome IS NULL AND client_submission_id IS NULL)
    OR
    (kind = 'commitment_reference'
      AND commitment_id IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND outcome IS NULL AND client_submission_id IS NULL)
    OR
    (kind = 'outcome_reference'
      AND outcome IS NOT NULL
      AND text IS NULL AND model_label IS NULL AND simulated IS NULL AND source IS NULL
      AND task_id IS NULL AND commitment_id IS NULL AND client_submission_id IS NULL)
  ),
  -- M-6: per-kind bounds replace one global bound, so an `activity` line cannot be 8 KiB.
  CONSTRAINT conversation_messages_text_bounds_check CHECK (
    (kind = 'user' AND char_length(text) BETWEEN 1 AND 4096)
    OR (kind = 'ember' AND char_length(text) BETWEEN 1 AND 8192)
    OR (kind = 'activity' AND char_length(text) BETWEEN 1 AND 280)
    OR kind IN ('task_reference', 'commitment_reference', 'outcome_reference')
  )
);

CREATE INDEX IF NOT EXISTS conversation_messages_page_idx
  ON conversation_messages (tenant_id, conversation_id, sequence);

-- L-4/L-9: one Task is referenced by at most one message, and the linkage equality check plus
-- the reverse read are a single indexed lookup.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_task_link_unique
  ON conversation_messages (tenant_id, task_id)
  WHERE task_id IS NOT NULL;
```

Turns:

```sql
CREATE TABLE IF NOT EXISTS assistant_turns (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  conversation_id     uuid        NOT NULL,
  source_message_id   uuid        NOT NULL,
  response_message_id uuid,
  status              text        NOT NULL DEFAULT 'running',
  failure_reason      text,
  deadline_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_turns_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT assistant_turns_source_unique UNIQUE (tenant_id, source_message_id),
  -- T-2: one message is the response of at most one turn.
  CONSTRAINT assistant_turns_response_unique UNIQUE (tenant_id, response_message_id),
  CONSTRAINT assistant_turns_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  -- S-1/T-2, enforced by the database rather than by convention: the source message must be a
  -- `user` message and the response message must be an `ember` message, and both must live in
  -- this turn's conversation. The referenced targets are generated columns, so any other kind
  -- has no match and the insert fails.
  CONSTRAINT assistant_turns_source_message_fk
    FOREIGN KEY (tenant_id, conversation_id, source_message_id)
    REFERENCES conversation_messages (tenant_id, conversation_id, user_only_id) ON DELETE CASCADE,
  CONSTRAINT assistant_turns_response_message_fk
    FOREIGN KEY (tenant_id, conversation_id, response_message_id)
    REFERENCES conversation_messages (tenant_id, conversation_id, ember_only_id) ON DELETE CASCADE,
  CONSTRAINT assistant_turns_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT assistant_turns_failure_reason_check CHECK (
    (status = 'failed' AND failure_reason IN ('timeout', 'internal_error')) OR
    (status = 'cancelled' AND failure_reason IS NULL) OR
    (status IN ('running', 'completed') AND failure_reason IS NULL)
  ),
  -- T-2: `completed` always has a response message. Uniqueness and kind are the FK above.
  CONSTRAINT assistant_turns_completed_response_check CHECK (
    status <> 'completed' OR response_message_id IS NOT NULL
  ),
  -- A cancelled or failed turn may or may not have produced a message; a running one never has.
  CONSTRAINT assistant_turns_running_response_check CHECK (
    status <> 'running' OR response_message_id IS NULL
  )
);

CREATE INDEX IF NOT EXISTS assistant_turns_due_idx
  ON assistant_turns (deadline_at)
  WHERE status = 'running';
```

Provisioning (`POST /v1/auth/session`, one transaction, I-4):

```text
BEGIN;
  upsert consumer + consumer_identity   (provider, provider_subject) -> consumer_id
  ensure principal (role = 'owner')     -> principal_id
  ensure agent (name = 'Ember', policy_version = 1)
  ensure conversation (kind = 'main')   -> conversation_id
  insert consumer_session (sha256(token), expires_at, idle_expires_at)
COMMIT;
```

Every step is `INSERT ... ON CONFLICT DO NOTHING` + `SELECT`, so re-running sign-in for an existing
consumer is a no-op and never creates a second Agent or Conversation.

### 11.3 `0013_task_results.sql`

```sql
-- 0013_task_results.sql
-- B1: durable, readable Task results. Additive only.
--
-- Design notes:
--   * `task_results` is written ONLY by the worker, in the same transaction that appends the
--     terminal task event (W-1/W-4). API routes are readers.
--   * `unavailable` is a stored state, not an absent row: `pending` therefore always means
--     "the task has not reached a terminal state yet" (W-2).
--   * Text is bounded and truncation is recorded, never silently applied (X-6/W-3).
--   * No credential or provider payload is stored here.

CREATE TABLE IF NOT EXISTS task_results (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  task_id        uuid        NOT NULL,
  result_state   text        NOT NULL,
  reason_code    text,
  summary_text   text,
  detail_text    text,
  truncated      boolean     NOT NULL DEFAULT false,
  model_label    text,
  simulated      boolean,
  produced_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_results_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT task_results_task_unique UNIQUE (tenant_id, task_id),
  CONSTRAINT task_results_task_fk FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT task_results_state_check CHECK (
    result_state IN ('pending', 'available', 'unavailable')
  ),
  CONSTRAINT task_results_shape_check CHECK (
    (result_state = 'pending' AND summary_text IS NULL AND detail_text IS NULL
      AND model_label IS NULL AND simulated IS NULL AND produced_at IS NULL)
    OR
    (result_state = 'available' AND summary_text IS NOT NULL AND produced_at IS NOT NULL
      AND model_label IS NOT NULL AND simulated IS NOT NULL AND reason_code IS NULL)
    OR
    (result_state = 'unavailable' AND summary_text IS NULL AND detail_text IS NULL
      AND reason_code IS NOT NULL)
  ),
  CONSTRAINT task_results_bounds_check CHECK (
    (summary_text IS NULL OR char_length(summary_text) <= 2048) AND
    (detail_text  IS NULL OR char_length(detail_text)  <= 16384)
  ),
  -- `reason_code` explains an *absent* text without duplicating `task_status` (X-3): the closed
  -- enum stays at one value in B1 and grows only if a genuinely new cause appears.
  CONSTRAINT task_results_reason_check CHECK (
    reason_code IS NULL OR reason_code = 'no_text_output'
  )
);

CREATE INDEX IF NOT EXISTS task_results_tenant_listing_idx
  ON task_results (tenant_id, created_at DESC, id DESC);
```

### 11.4 Migration rules

| Rule                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forward-only, immutable once merged, checksum-verified by the existing runner.                                                                                                              |
| No destructive change to a table that existed before `0011`.                                                                                                                                |
| Each migration must be applied and re-applied (idempotent `IF NOT EXISTS`) in `tests/integration/migrations.test.ts`.                                                                       |
| **The sketch must parse and apply on real PostgreSQL 17 before it is considered a contract.** B1-1's gate is a real parse + apply + constraint-behaviour run, not a review of the SQL text. |
| No backfill: all seven new tables start empty, which is why `0011`–`0013` are safe on a live Alpha database.                                                                                |
| Rollback is "restore from backup": a documented, reviewed operation, not a down-migration.                                                                                                  |

**Round 1 evidence (recorded here so the claim is auditable).** The SQL in §11.1–§11.3 was extracted
verbatim from this document and executed against a scratch PostgreSQL 17.11 database created by
applying the repository's real `migrations/0001`–`0010` in order:

| Check                                                                   | Result                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `0011`–`0013` sketch applies cleanly on top of `0001`–`0010`            | 7 tables + 6 indexes created, 0 errors                       |
| Re-applying the same sketch is a no-op (idempotency of `IF NOT EXISTS`) | 0 errors, no duplicate objects                               |
| A turn whose response message is a `user` message                       | rejected by `assistant_turns_response_message_fk`            |
| A turn whose response message belongs to another tenant's conversation  | rejected by `assistant_turns_response_message_fk`            |
| Two turns sharing one response message                                  | rejected by `assistant_turns_response_unique`                |
| `task_reference` carrying `model_label`                                 | rejected by `conversation_messages_shape_check`              |
| `user` message without `client_submission_id`                           | rejected by `conversation_messages_shape_check`              |
| `ember` message without `model_label`                                   | rejected by `conversation_messages_shape_check`              |
| `activity` line of 281 characters                                       | rejected by `conversation_messages_text_bounds_check`        |
| Second `consumers` row for the same tenant                              | rejected by `consumers_one_per_tenant_unique`                |
| `running` turn that already has a response message                      | rejected by `assistant_turns_running_response_check`         |
| `completed` turn with no response message                               | rejected by `assistant_turns_completed_response_check`       |
| Duplicate tenant-wide submission ID                                     | rejected by `conversation_messages_tenant_submission_unique` |

This is a design-time proof that the sketch is executable and that the claimed constraints exist; it is
**not** a substitute for T-10/T-12/T-17 in CI, which must reproduce it through the migration runner and
the test suite.

## 12. Test matrix (PROPOSED, required for acceptance)

Naming follows the existing layout: `tests/integration/*.test.ts` against a real Postgres, and
`tests/e2e/b-tNN-*.test.ts` through `tests/e2e/support/e2e-cluster.ts` against the real HTTP app.
Numbering continues at **`b-t29`** because `b-t25`–`b-t28` are already taken by `tests/chaos/*`;
file names are the identifier, so a reused number would make two different tests look like one.

| ID   | Test                                     | Level       | Asserts                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `b-t29-auth-session.test.ts`             | e2e         | Sign-in creates tenant + owner principal + Agent + main Conversation in one transaction; always 201; no `tenant_id` in the body; repeat sign-in creates no second Agent or Conversation                                                                                                        |
| T-2  | `b-t30-session-rotation.test.ts`         | e2e         | Refresh rotates; the rotated token → 401 and all sessions revoked; logout 204 and idempotent; expired token → 401                                                                                                                                                                              |
| T-3  | `b-t31-conversation-send.test.ts`        | e2e         | `POST .../messages` 201; message + turn both exist; `sequence` 1 then 2; ordering by `sequence` only                                                                                                                                                                                           |
| T-4  | `b-t32-conversation-idempotency.test.ts` | e2e         | Same `client_submission_id` + same text + same epoch → 200 with identical ids, no second row, turn not restarted; different text → 409; `GET /v1/message-submissions/{id}` recovers the 201 body and 404s for an unknown id; missing `transcript_epoch` → 400                                  |
| T-5  | `b-t33-conversation-isolation.test.ts`   | e2e         | Tenant B reading A's conversation/messages/turn/submission/result → 404 with the same body as a genuinely missing resource, in both directions                                                                                                                                                 |
| T-6  | `b-t34-turn-lifecycle.test.ts`           | e2e         | `running` → `completed` with exactly one `ember` message; simulated `ember` always carries `simulated: true` and a `-fake-`/`-echo-` label; cancel is idempotent and never touches the Task                                                                                                    |
| T-7  | `b-t35-message-task-linkage.test.ts`     | e2e         | Linkage writes exactly one `task_reference`; both-or-neither 400; linking an `ember` message 400; replay with the same linkage returns the same `linked_message_id`; `tasks.digest` unchanged (L-7); none→some, some→none, some→different-message all → 409 with the Task unchanged (L-9/L-10) |
| T-8  | `b-t36-task-result.test.ts`              | e2e         | `pending` → `available`; `unavailable` returns 200 with `result: null`; result immutable after `available`; foreign task → 404; a Task terminalized by **cancel** (no worker write) returns `unavailable`, never `pending` (X-9)                                                               |
| T-9  | `result-commit.test.ts` (extend)         | integration | Worker writes `task_results` in the terminal-event transaction; a retried run does not duplicate; truncation recorded; canceller and reaper write `unavailable` in their own terminalization transaction (W-2)                                                                                 |
| T-10 | `migrations.test.ts` (extend)            | integration | `0011`–`0013` apply on a real PostgreSQL 17, re-apply idempotently and stay checksum-stable; `0010` and earlier unchanged; the §11.4 constraint table is reproduced (shape/FK/unique rejections)                                                                                               |
| T-11 | `b-t37-transcript-deletion.test.ts`      | e2e         | Delete removes messages + turns but keeps Tasks/events/results/artifacts/commitments; a running turn becomes `cancelled`; `transcript_epoch` increments; a second call deletes nothing and still increments                                                                                    |
| T-12 | `conversation-postgres.test.ts`          | integration | `sequence` gap-freedom under concurrent appends; per-tenant uniqueness prevents cross-tenant collision; `CHECK` shapes reject malformed kinds                                                                                                                                                  |
| T-13 | `b-t38-content-safe-logging.test.ts`     | e2e         | Captured logs contain ids but never message text, result text, tokens or provider assertions; `Authorization` redacted                                                                                                                                                                         |
| T-14 | `b-t40-deletion-fence.test.ts`           | e2e         | The §6.7 sequence end-to-end: an unseen 201, a deletion, then the stale outbox retry → 409 with 0 rows written and the deleted text absent from every page; a deliberate new send with a fresh id and the current epoch → 201; the `GET /v1/message-submissions/{id}` lookup stays 404         |
| T-15 | `b-t41-reconciliation-field.test.ts`     | e2e         | `GET .../messages` returns `client_submission_id` on every `user` message and on no other kind (RD-5); a client can reconcile an optimistic row without matching text; the page carries the current `transcript_epoch` (RD-6)                                                                  |
| T-16 | `b-t42-linkage-freeze.test.ts`           | e2e         | The four L-10 directions in both orders, each → 409 and the original Task row, digest and reference message unchanged; a same-linkage replay is 200 with identical link fields; after transcript deletion a link-requesting replay conflicts and no message is recreated (L-11)                |
| T-17 | `conversation-invariants.test.ts`        | integration | Database-level guarantees of §7.5: response message must be `ember` and in the same conversation, one response per message, one turn per source message, `UNIQUE (tenant_id)` consumer; run under two concurrent transactions to prove the constraints, not the code, reject the second writer |

Rules: a contract property (isolation, ordering, idempotency) may never pass by mocking the store —
those run against real Postgres. Failure injection reuses `tests/chaos/harness`.

Counts for the acceptance review: 17 rows, of which **17 must be green before B1 is complete**; rows
T-1…T-13 were the original set and T-14…T-17 exist because the Round 1 review found the gaps they
cover. `b-t29`…`b-t42` remain collision-free with `tests/chaos/*` (`b-t25`…`b-t28`).

## 13. Risks and open questions

| ID  | Risk                                                                                                           | Impact | Mitigation / state                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | Apple Sign In verification needs a real `aud`/team configuration; a wrong `aud` silently rejects every sign-in | High   | Boot-time config validation that refuses production start with a placeholder `aud`; T-1 asserts the 401 shape.                                                                                     |
| R-2 | Conversation growth is unbounded over time                                                                     | Medium | Alpha quota (S-5), `limit` ≤ 100 (M-6), index-only pagination by `sequence`. Archival is B4.                                                                                                       |
| R-3 | Turn polling can hammer the API from a foregrounded app                                                        | Medium | T-6 client cadence (≥ 1000 ms per conversation); the poll is a single indexed read, so a runaway client costs one row scan.                                                                        |
| R-4 | **Apple 5.1.1(v) requires in-app account deletion** for apps that create accounts                              | High   | **DEFERRED but gating**: must land before any external TestFlight build; recorded in §10.4.                                                                                                        |
| R-5 | Two new dense write paths (messages, results) could add contention on the conversation row                     | Medium | The row lock covers one insert plus one counter bump; measured in T-12; fallback is a per-conversation advisory lock.                                                                              |
| R-6 | Simulated output could be mistaken for real model output                                                       | High   | M-5 + X-8 + T-6: `simulated` is a required wire field, never a heuristic.                                                                                                                          |
| R-7 | Transcript deletion is destructive and has no export path in B1                                                | Medium | Client confirmation required and must state that Tasks/results remain (Q-3); the API is idempotent, reports counts and fences stale sends (§6.7).                                                  |
| R-8 | Session reuse detection can sign a legitimate user out after a lost refresh response                           | Low    | Rotation happens only on `refresh`; the client retries once, then re-signs in.                                                                                                                     |
| R-9 | `provider: "dev"` reachable outside an isolated environment would let arbitrary subjects mint real sessions    | High   | Q-1's double guard: explicit config **and** loopback-only listener; a boot test asserts it refuses a non-loopback bind in production and refuses to start in production with the provider enabled. |

**Q-1…Q-3 are ANSWERED (CTO, PR #92 Round 1).** The answers are normative and already folded into the
sections named below; they are recorded here verbatim in intent so the contract cannot drift from the
decision.

| Q   | CTO decision                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Where it lands  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Q-1 | **Conditional YES for `provider: "dev"`.** It may exercise the production-like provisioning path **only** in isolated local/test/CI environments, guarded by explicit config **and** a loopback-only listener. It must be unavailable on any publicly reachable staging, non-loopback deployment or production, and must never let arbitrary subjects create real consumer sessions in a shared live environment. Dev bearer tokens remain for route-independent tests. | §5.5            |
| Q-2 | **APPROVED: 200 messages per rolling 24 h per conversation** as the internal-Alpha safety quota, evaluated atomically and tenant-scoped. This is **not** model billing. B2 needs a separate measured per-user/global inference spend cap before any provider egress.                                                                                                                                                                                                    | §6.4 S-5, §4.2  |
| Q-3 | **APPROVED: keep `task_results` when _only the transcript_ is cleared**, with an explicit, truthful iOS confirmation that Tasks, results and artifacts remain. Clearing chat is not account/data deletion; full account deletion stays a release gate before external beta (Apple 5.1.1(v)).                                                                                                                                                                            | §10.4, §15, R-4 |

Two consequences the CTO attached to these answers, both now in the contract: the dev provider needs a
hard environment guard (an obvious implementation trap), and Q-3 is a _copy truthfulness_ requirement,
so it is testable in T-11/T-14 rather than a matter of wording.

## 14. Implementation PR breakdown (order is the dependency order)

| PR   | Scope                                                                                                             | Depends on | Gate                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| B1-1 | `0011`–`0013` migrations + repository interfaces (no routes)                                                      | this doc   | `migrations.test.ts` on real PostgreSQL 17 incl. the §11.4 constraint table, T-10, T-17 |
| B1-2 | Session service + `POST`/`refresh`/`DELETE` + provisioning transaction + `GET /v1/me`                             | B1-1       | T-1, T-2, R-9 dev-provider guard                                                        |
| B1-3 | Conversation writes: `POST .../messages` (+ turn creation), sequence assignment, quota, epoch fence               | B1-2       | T-3, T-4, T-12                                                                          |
| B1-4 | Conversation reads: `GET .../messages`, `GET /v1/message-submissions/{id}`                                        | B1-3       | T-4, T-5, T-15                                                                          |
| B1-5 | Turns: fake-echo responder, `GET .../turns/{id}`, cancel, sweeper for T-1                                         | B1-3       | T-6                                                                                     |
| B1-6 | Linkage: additive `POST /v1/tasks` fields, `task_reference` write, transactional linkage equality check (L-8/L-9) | B1-3       | T-7, T-16                                                                               |
| B1-7 | Results: worker result write + every other terminalizer + `GET /v1/tasks/{id}/result`                             | B1-6       | T-8, T-9                                                                                |
| B1-8 | Deletion + epoch fence + content-safe logging audit                                                               | B1-5       | T-11, T-13, T-14                                                                        |

Each PR is independently revertable; B1-1 introduces no behaviour and no route, which is what makes
the series safe to land against the existing suite.

## 15. End-to-end Alpha acceptance test (the definition of done)

One test, `tests/e2e/b-t39-alpha-happy-path.test.ts`, with no store mocks and no direct SQL:

```text
sign in (dev provider)                       -> 201, access_token, consumer_id
GET /v1/me                                   -> agent + main conversation_id + transcript_epoch 0
POST messages "hello" (epoch 0)               -> 201, sequence 1, turn running, client_submission_id echoed
poll turn until completed (<= 60 s)          -> completed, response_message_id set
GET messages?after=0                         -> user(1), ember(2), ember.simulated === true,
                                                 user(1).client_submission_id matches the sent id
POST /v1/tasks (mock.chat, linked to msg 1)  -> 202, linked_message_id, linked_message_sequence 3
GET messages?after=2                         -> task_reference(3) with that task_id
GET /v1/tasks/{id} until terminal             -> completed
GET /v1/tasks/{id}/result                     -> available, non-empty summary_text
GET /v1/tasks/{id}/result (again)             -> byte-identical result (immutability)
POST messages "lost" (epoch 0)                -> 201 sequence 4 (the ACK is deliberately discarded)
DELETE /v1/me/conversation/messages           -> 200, counts > 0, transcript_epoch 1
GET messages?after=0                          -> empty page, transcript_epoch 1
GET /v1/tasks/{id}                            -> still terminal (durable work survived, Q-3)
GET /v1/tasks/{id}/result                     -> still available (results survived, Q-3)
POST messages {sub: S_lost, text: "lost", transcript_epoch: 0}
                                              -> 409, 0 rows written, "lost" absent from every page
POST messages {fresh id, transcript_epoch: 1} -> 201 (a deliberate new message is allowed)
```

The last two lines are the point of this test, and they are the Round 1 correction. `client_submission_id`
uniqueness is scoped to the conversation **row**, and deletion removes the row, so an ID becomes reusable
after deletion — that stays true. But reuse is only safe because the **epoch fence** rejects the stale
attempt first (§6.7): the old outbox entry cannot resurrect deleted text, and the user can still send a
new, deliberate message. The alternative — a tombstone table remembering every deleted submission id —
buys nothing this fence does not already provide and costs a permanent write-amplification path (D-6).

## 16. Decision log

| ID   | Decision                                                                                                                                            | Rejected alternative                         | Reason                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Identity terminates at `AuthContext`; no existing route changes                                                                                     | Per-route consumer plumbing                  | One integration seam, zero blast radius, testable in isolation                                                                                                                 |
| D-2  | Assistant text gets its own table, never `task_events`                                                                                              | Extend the event allowlist                   | The allowlist is a security property (§3); widening it puts text into the event stream                                                                                         |
| D-3  | Linkage is atomic inside `POST /v1/tasks`                                                                                                           | Separate link endpoint                       | No orphaned-Task window, one round trip, idempotency stays in a single digest                                                                                                  |
| D-4  | Turns are polled; Tasks keep SSE                                                                                                                    | Turn SSE / WebSocket                         | No truthful `streaming` state in B1; a poll is one indexed row read with a documented cadence                                                                                  |
| D-5  | No `conversation.store` consent at Alpha                                                                                                            | New consent kind                             | The transcript is the product's core function; a consent that cannot be refused is theatre                                                                                     |
| D-6  | `client_submission_id` is tenant-wide unique while a row exists, reusable after transcript deletion — **and `transcript_epoch` fences stale sends** | Tombstone table of deleted submission ids    | The fence is one integer on a row that already exists; a tombstone table costs permanent write amplification and still cannot distinguish "deleted" from "never seen"          |
| D-7  | Failure reasons stay in `task_status`; `result_state` stays three-valued                                                                            | A duplicated `failed` state                  | Two sources of truth for one fact is the classic drift bug                                                                                                                     |
| D-8  | No account deletion in B1                                                                                                                           | Ship it with B1                              | It is a B2-sized feature; gating it on TestFlight (R-4) is honest about the cost                                                                                               |
| D-9  | `POST .../messages` dedupes on `client_submission_id` only; no `Idempotency-Key` header                                                             | Reuse the Task header key                    | Recoverable idempotency needs a key the client can re-query; two keys for one write can disagree                                                                               |
| D-10 | Task linkage is frozen by first persistence and compared transactionally on replay (L-8/L-9), while `tasks.digest` stays unchanged (L-7)            | Fold linkage into the digest                 | The digest must describe the request; the _persisted_ link must decide provenance. Changing digest semantics would migrate EXISTING rows and still not record what was written |
| D-11 | Every send carries `transcript_epoch`; stale or invented epochs are rejected with the existing 409                                                  | Optional epoch / server-side heuristics      | An omitted epoch is indistinguishable from a stale one, and no heuristic can tell a resurrected draft from a new message                                                       |
| D-12 | Conflict causes share one 409 body; the discriminator stays server-side                                                                             | Add `details.reason` to `ErrorResponse`      | `ErrorResponse` is a `strictObject`; adding a field breaks every existing parser to enable behaviour the client must not attempt anyway                                        |
| D-13 | `client_submission_id` is part of the user-message DTO (RD-5)                                                                                       | Bind reconciliation to the lookup route only | One page read must be enough to reconcile; a per-row lookup route would be N requests and a new failure mode                                                                   |
| D-14 | `GET result` derives `unavailable` from an authoritative terminal status when no row exists (X-9)                                                   | Require every terminalizer to write the row  | The row is still written by every terminalizer (W-2); X-9 makes a defect a degraded read instead of a stuck spinner                                                            |
| D-15 | `docs/adr/0004-beta-v1-live-platform-contract.md` is the single versioned decision record; this file is its annex                                   | Two parallel authoritative documents         | Issue #91 named the ADR path; duplication would guarantee drift, so the ADR pins this annex by blob SHA and owns approval                                                      |

### 16.1 Invariants a reviewer should check first

| Invariant                                                                       | Where it is enforced                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| I-1 / ISO-2: the tenant is never client-supplied                                | Strict schemas + `AuthContext` only                                                       |
| I-2: one consumer per tenant                                                    | `UNIQUE (tenant_id)` on `consumers` (§11.1) + T-17                                        |
| I-4: a session token implies a fully provisioned world                          | `0011`/`0012` provisioning transaction                                                    |
| I-7: only session creation accepts a provider assertion                         | §5.2 route table; `refresh`/`logout` take the session token only                          |
| I-9: `AuthContext` unchanged                                                    | No diff in task/commitment/consent/approval routes                                        |
| M-1/M-3: the transcript never carries state                                     | Closed `kind` `CHECK` + reference-only message rows (§11.2)                               |
| O-1/O-2: gap-free per-conversation `sequence`                                   | `SELECT ... FOR UPDATE` on `conversations` + unique constraint                            |
| T-2: a completed turn has exactly one `ember` response in the same conversation | Composite FK on `ember_only_id` + `UNIQUE (tenant_id, response_message_id)` (§11.2, §7.5) |
| S-1/S-4: no message without a turn; no 201 before commit                        | Composite FK on `user_only_id` + one transaction, commit-then-respond                     |
| S-7/TE-3: a pre-deletion send cannot resurrect text                             | `transcript_epoch` fence under the sequence row lock (§6.7) + T-14                        |
| L-9/L-10: a Task's link never silently moves                                    | Transactional linkage equality check (§8.1) + T-16                                        |
| X-2/X-4/X-9: no sentinel results; terminal is never `pending`                   | `CHECK` shape + status-derived `result_state` (§9.2/§9.3)                                 |
| C-6/Q-3: durable work survives transcript deletion                              | Deletion touches only `conversation_messages` and `assistant_turns`                       |
| RD-5: reconciliation has a field, not a heuristic                               | `client_submission_id` on user messages (§6.5) + T-15                                     |

## 17. Approval

Status: **APPROVED DESIGN — CTO 2026-11-03, ADR-0004.** This document contains no code,
no migration, no route and no schema change; implementing it requires the merged ADR and B1-1's own verified PR. Reviewing means
checking §16.1 and reading §17.2, which maps every Round 1 review item to the section that answers it.

### 17.1 Change log

- `2026-11-03` — initial B1 platform contract against `main` @ `154860a` (PR #92, head `1c665a1`).
- `2026-11-03` — **Round 1 corrections** (this revision). No scope expansion, no new endpoints, no new
  tables, no new error codes:

| Review item (PR #92 Round 1)                                                                  | Fix in this revision                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. §11.2 migration sketch cannot execute: missing `OR`; variants do not reject foreign fields | `conversation_messages_shape_check` rewritten as an explicit `OR` chain with full per-variant field isolation; per-kind text bounds; sketch executed on real PostgreSQL 17 with a recorded pass table (§11.4)                      |
| 2. §8 L-5/L-7 linkage idempotency unsound (none→some accepted, retry can move a link)         | L-7 keeps the digest unchanged, L-8…L-11 add first-persistence freezing + transactional equality check + four conflict directions; §8.4 step 4 tells the client never to repair it                                                 |
| 3. Deletion can resurrect text through an old outbox/unknown-ACK retry                        | New §6.7 `transcript_epoch` fence (TE-1…TE-6), `S-7`, `N-11`/`N-12`, epoch in `GET /v1/me`, page and send responses, fenced deletion rules in §10.4, T-14                                                                          |
| 4. Reconciliation needs `client_submission_id`; N-4 must not silently re-mint                 | `RD-5`/`RD-6` + DTO fields in §6.4/§6.5, N-9 rewritten as a field match, N-4 rewritten to stop and surface, one shared 409 body (D-12)                                                                                             |
| 5. DB invariants claimed stronger than the constraints                                        | `UNIQUE (tenant_id)` on `consumers`; turn→message FKs through generated `ember_only_id`/`user_only_id` columns; `UNIQUE (tenant_id, response_message_id)`; §7.5 enforcement matrix separating SQL, transaction and test guarantees |
| Contract alignment: Issue #91 named `docs/adr/0004-…`                                         | ADR-0004 added; it pins this annex by blob SHA, owns approval and records Q-1…Q-3 (D-15)                                                                                                                                           |
| §5 I-7 vs §5.3 refresh contradiction                                                          | I-7 now says refresh/logout use the session token only, no provider assertion                                                                                                                                                      |
| §9 W-2 overstated ("every terminal Task always has a row")                                    | W-2 now covers every terminalizer transactionally; new X-9 defines the read derivation so a terminal Task is never `pending`                                                                                                       |
| §10 ISO-6 pointed at T-2 instead of T-5                                                       | ISO-6 now points at T-5                                                                                                                                                                                                            |

### 17.2 What the reviewer should confirm

1. §16.1 — every invariant still holds after the edits, especially T-2 (now a database constraint, not a
   comment) and S-7/TE-3 (a new negative path that fails closed).
2. §11.4 — the sketch is executable, and the evidence table names the exact constraint that rejects each
   malformed write.
3. §8.1 — L-7/L-9 together: the digest stays EXISTING, the linkage check is additive and transactional,
   and all four conflict directions are explicit.
4. §6.7 — the fence costs one integer, adds no tombstone table and no new error body.
5. §13 — Q-1…Q-3 answers are recorded as decisions, with the dev-provider guard and the Q-3 copy
   requirement turned into tests (R-9, T-11) rather than prose.

Nothing outside this document and the new ADR changed. B1-1 must not start before the ADR is merged.
