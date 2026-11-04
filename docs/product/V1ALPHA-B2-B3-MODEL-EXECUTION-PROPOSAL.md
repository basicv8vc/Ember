# V1 Alpha — Real Model Execution in Two Phases (B2 first, B3 second)

| field                      | value                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| status                     | **proposed — documentation/design baseline only; no implementation or activation authorization**                   |
| phase 1                    | **B2 — Real Assistant Turn** (Conversation-first, the Alpha milestone)                                             |
| phase 2                    | **B3 — Bounded Task Execution** (`notes.action_items`, invoked from Chat)                                          |
| audit of record            | `docs/product/V1ALPHA-MODEL-EXECUTION-AUDIT.md` (findings unchanged)                                               |
| wire authority             | ADR-0004 merged via PR #92; normative annex blob `2e06b47691b71b05e3903f0bd65d5b9f381776c0`                        |
| historical audit baseline  | `154860a` (`main` at the time of the original repository audit)                                                    |
| current main baseline      | `38dd69b38a3f9c2dad5730b6902080a1ca3b4c1a` (PR #97 / B1-1 merged 2026-11-04)                                       |
| branch                     | `cto/v1alpha-notes-action-items`                                                                                   |
| migrations on current main | `0001`–`0013`; **B2 takes `0014`, B3 takes `0015`**, subject to rechecking the sequence when implementation starts |
| external provider traffic  | **zero**. Not provisioned, not contacted, not enabled.                                                             |

## 0. Decision requested

Accept the **B2-first / B3-second sequencing and its safety architecture as the planning baseline**: the first real model-backed capability should be an assistant reply inside Chat; `notes.action_items` follows as a bounded capability Chat can invoke.

This is a documentation-only decision. Merging this proposal does **not** approve a provider/model, provision credentials, permit user-transcript egress, authorize paid calls, or activate `real` mode.

The following implementation and activation decisions remain open:

| #   | Decision                                 | Current proposal (not yet authorized for real-mode activation)                                   |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A   | Provider and model id                    | OpenAI as the proposed sole provider; exact dated model ID and real-mode approval remain pending |
| B   | Price sheet is provisional               | derive ceilings from a formula, then re-derive from an invoice-grade source before enablement    |
| C   | Per-user and per-tenant spend ceilings   | proposed per-user-day $0.25, per-tenant-day $1.00, global-day $5.00                              |
| D   | Conversation context leaves the platform | only a bounded transcript excerpt; retention/training terms must be verified in writing          |
| E   | Sentinel and credential model changes    | one narrow `model.infer` category, policy version 2, one credential binder and hard-coded origin |

**Not requested, and not done:** no provider account, no API key, no dependency added, no route, no
migration, no CI secret, no `fetch` to a model host, and no change to any executable file. This PR is
documentation only.

## 1. Why the re-scope is correct, and what it costs us

The audit was commissioned against a single capability (Notes → Action Items) and it did its job: it
found the invariants that any real model call must satisfy. It also, therefore, describes the
capability with the _fewest_ wire changes — which is exactly why it was the wrong thing to build
first. Building it first would have produced a correct, well-gated feature inside an app that still
had no assistant.

The B2-first order changes four things in the plan and nothing in the audit:

| Item                 | Old plan (notes-first)                           | Now                                                                   |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| First real call      | a Task step (`infer`) in the worker              | a **turn responder** in the worker, inside Chat                       |
| Wire surface touched | new Task kind + `task_events` payload vocabulary | **none** — B1 froze the turn and `ember` message shapes               |
| New tables           | 2 (`model_spend_*`)                              | 2 + 1 audit trail (`model_turn_attempts`)                             |
| Visible result       | typed JSON artifact + `task_results`             | assistant text in the transcript **and** duplicate-call cost evidence |

The second row is the important one. **B2 needs no new wire field at all**, because the frozen B1
contract already requires every assistant message to carry `model_label` and `simulated` (M-5, §9.4)
and already defines a three-state result resource with an `unavailable` branch reserved for
"artifact-only Task kinds" (X-4). That reservation is what makes B3 fit later without widening a
frozen shape. The old plan's hardest problem — inventing a vocabulary inside the `task_events`
payload allowlist — is now a B3 problem that must be implemented against the merged contract and
the Platform-owned runtime.

What the re-scope costs: B2 is useless on its own if B1 is late, and B2's correctness depends on a
schema we do not own. Both are stated as hard dependencies in §3 rather than absorbed as optimism.

## 2. The audit, in the form a reviewer needs

Full findings: `docs/product/V1ALPHA-MODEL-EXECUTION-AUDIT.md` §2–§4. The five that constrain every
line of this proposal:

| #   | Finding                                                                                                                                                                                                | Consequence for B2/B3                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | `sentinel-lite.ts` has a closed category set; `network.egress` and `credential.use` are hard-denied at step 6, before the allowlist is consulted; step 9 (`DENY_DEFAULT`) denies any non-mock category | A model call must become its **own** category with its **own** branch. Adding a string to the array alone yields `DENY_DEFAULT` |
| F-2 | `SentinelIntentSchema` is a `strictObject` and **requires `runId`**                                                                                                                                    | A turn has no `runId`. B2 must not fabricate one; §6.3 states the choice                                                        |
| F-3 | `migrations/0002` hard-codes four `mock.*` kinds and an event payload allowlist with `ELSE RETURN false`                                                                                               | B2 changes **no** kind and **no** payload key; B3 changes both, in `0015`, with the contract owner                              |
| F-4 | `budget-ledger.ts` aggregates per `(tenant, UTC day)` in _simulated work units_; `runBudgetedStep` settles the **full reservation**, not actual usage                                                  | Money needs its own ledger (`0014`); a token-priced call must settle actual cost                                                |
| F-5 | There is no credential store: authentication is dev bearer tokens; no code path holds a provider secret                                                                                                | B2 introduces the **first** server-side third-party secret. It gets one holder, one origin, one binding point (§6.4)            |

F-2 is new in this revision and it is not small. It is the reason §6.3 exists.

## 3. Implementation dependencies (explicit, ordered, each one a gate)

The contract and B1-1 persistence foundation have landed. The remaining B1 runtime slices are still
hard dependencies for the parts of B2/B3 that call them; a merged schema or interface is not a live
endpoint or worker capability.

| ID   | Dependency                                                                                                                                   | Owner          | Blocks                               | Current state / consequence                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | ADR-0004 approved and merged; immutable annex SHA recorded                                                                                   | CTO / Platform | Contract alignment                   | **Complete** — PR #92 merged at `8f7dc1934e508b9a7e6a551ef19fbe9cf6bc6026`; annex blob `2e06b47691b71b05e3903f0bd65d5b9f381776c0`.                                                                            |
| D-2  | B1 contract PR #92 merged                                                                                                                    | CTO            | Wire alignment                       | **Complete** — no B2/B3 work may invent or revise overlapping wire semantics.                                                                                                                                 |
| D-3a | B1-1 persistence foundation: migrations `0011`–`0013`, strict schemas and typed repository ports                                             | Platform       | B2 schema alignment                  | **Complete** — PR #97 merged at `38dd69b38a3f9c2dad5730b6902080a1ca3b4c1a`.                                                                                                                                   |
| D-3b | B1-2…B1-5 runtime: concrete repositories/transactions, session and Conversation/Message/Turn routes, responder seam, polling and T-1 sweeper | Platform       | B2-4                                 | **Not complete** — B2-4 cannot wire into a responder until the B1-5 seam and authoritative runtime transitions exist. B2-1/B2-2/B2-3 may be developed dark behind tests.                                      |
| D-4  | B1-6/B1-7 runtime: verified Message→Task linkage and Task Result write/read path                                                             | Platform       | B3                                   | **Not complete** — B3 waits; B2 remains independent.                                                                                                                                                          |
| D-5  | Migration order: B1 owns `0011`–`0013`; B2 takes `0014`; B3 takes `0015`                                                                     | Platform       | Migrations                           | **Current allocation** — recheck `main` migration inventory before creating each migration; renumber only if a preceding slice has legitimately consumed a slot.                                              |
| D-6  | Consumer identity mapping and authenticated principal semantics from ADR-0004 §5                                                             | Platform       | Per-user quota keying                | **Contract complete; runtime pending** — Alpha defines Consumer↔Tenant and Consumer↔Principal as 1:1, with owner role; `AuthContext` remains the server-derived identity boundary.                            |
| D-7  | CTO decisions in §14: C1–C6 for the relevant Sentinel/Gateway design; A1–A5 and B1–B4 before any real provider call                          | CTO            | Trusted-module changes / paid egress | Unresolved items remain explicit; until the real-call gate passes, `EMBER_MODEL_EXECUTION` stays `disabled` (or `fake` only in explicitly labelled tests).                                                    |
| D-8  | iOS #90 client integration plan and implementation                                                                                           | iOS Lead       | User-visible milestone               | Client work may proceed against the frozen contract; Live calls remain blocked until the corresponding B1 runtime and B2 real-model gates are deployed and approved. Mock/Live must never silently fall back. |

D-5 and D-6 record two important boundaries.

**D-5.** Migration numbers are a coordination artifact, not a preference. The current main tree contains
`0011`–`0013`; B2's proposed migration is `0014`, B3's is `0015`. Recheck the actual migration
inventory immediately before implementation—do not assume this proposal grants a slot if another
approved slice has consumed it.

**D-6.** ADR-0004 §5.1 settles the Alpha identity model: Consumer↔Tenant is 1:1 and Consumer↔Principal
is 1:1 with the owner role. The client cannot supply either identifier; session authentication
derives the unchanged `AuthContext { tenantId, principalId, policyVersion }`. Therefore `principalId`
is the correct server-side per-user spend key for Alpha. This is a **frozen contract decision**, not
yet a claim that production session/auth runtime has shipped or that a multi-user tenant is supported.

## 4. Phase 1 — B2: Real Assistant Turn

### 4.1 The definition

One authenticated user message produces one durable assistant reply whose text came from a real model,
whose status is authoritative on the server, and which survives force-quit, relaunch and a lost
response. Polling, not streaming.

### 4.2 What B2 adds, and what it refuses to add

| Adds                                                                                 | Refuses to add                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| A responder implementation behind B1-5's seam                                        | A conversation route, a message table, a turn table, a sequence rule         |
| `packages/model-gateway` (one package, two operations)                               | A multi-provider framework, a model registry, caller-chosen models           |
| Migration `0014`: Turn leases, attempts, spend; runtime kill switch separately gated | Any change to `tasks`, `task_events`, or `0002`'s kind and payload allowlist |
| Sentinel category `model.infer` + policy version 2                                   | Any relaxation of the `network.egress` or `credential.use` denials           |
| One provider adapter, one hard-coded origin                                          | Retries, redirects, proxies, streaming, tool calls, function calling         |

The refusal list is the architecture. Every item on it is something a model integration normally
grows in its first month, and each one re-opens a decision this proposal closes on purpose.

### 4.3 The seam: one interface, already frozen by B1

B1 §7 owns the source user message, one authoritative Assistant Turn, its terminal
statuses and one reply. B1-5 is expected to provide a deterministic responder seam.
B2 replaces only the responder, without adding a second Chat API or a second Turn state
machine. **A Turn is not a Task/Run.** The ability to claim and fence asynchronous
inference belongs to a narrowly reviewed B2 additive migration after the B1 Turn schema
is frozen; do not hold a PostgreSQL transaction open across the provider call.

```text
B1 POST message → commit user message + assistant_turn(running)
                         ↓
B2 short TX: claim turn, increment lease_epoch, commit/release locks
                         ↓
read bounded context + policy + quota + credential checks
                         ↓
short TX: reserve global/tenant/principal budget + persist attempt
                         ↓
external model call, NO database transaction held
                         ↓
short TX: verify same lease_epoch, nonterminal, not cancelled,
          unexpired turn and valid policy → commit ember reply +
          completed turn + attempt settlement atomically
```

If the worker loses its claim, cancellation wins, or the deadline expires, it
must discard the response and must **not** publish a reply. Any unobserved provider
charge stays reserved for reconciliation rather than being treated as free.

### 4.4 Flow, in order, with the failure branch of each step

The total authoritative B1 deadline is **60 seconds including queueing, both
possible provider calls, retries, and commit**. Each provider request has a
strict 20-second per-attempt timeout bounded by the remaining Turn deadline.

| #   | Action                                                                                                                                                                                 | Required failure behavior                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | B1 commits message + turn(running)                                                                                                                                                     | Return no false acknowledgement                               |
| 2   | Short TX claims eligible turn with FOR UPDATE SKIP LOCKED; atomically increments lease_epoch, records lease owner/deadline, then commits                                               | Lost claim → zero calls                                       |
| 3   | Validate deadline and remaining attempt budget ≤ 2                                                                                                                                     | Deadline/exhaustion → one terminal failure, guarded by claim  |
| 4   | Verify mode: disabled means no inference; fake means explicitly simulated                                                                                                              | disabled → no gateway call or fake output                     |
| 5   | Resolve server-owned principal/tenant/provider/policy/operation and closed Sentinel model.infer permission                                                                             | Deny → zero calls; no prompt logged                           |
| 6   | Validate approved credential and exact provider origin                                                                                                                                 | Missing/mismatch → zero calls, observable configuration error |
| 7   | Build same-tenant bounded context, run model-exact token preflight including system/serialization overhead                                                                             | Unverifiable/over cap → zero calls                            |
| 8   | Short TX reserves money across GLOBAL, TENANT, PRINCIPAL, writes unique attempt, commits                                                                                               | Any bucket exceeded/DB failure → zero calls                   |
| 9   | Release all DB locks; make one call under AbortSignal, per-call and overall deadline                                                                                                   | Failure recorded on attempt; no premature terminal Turn       |
| 10  | Retryable timeout/5xx/429: settle/retain billed-unknown attempt conservatively, then claim new attempt under same unexpired running Turn and fence                                     | Terminal state NEVER reopens                                  |
| 11  | Success: short TX checks lease_epoch, lease owner, status=running, cancellation and deadline using database time, then commits one ember message + completed Turn + attempt settlement | Stale/cancelled/swept → discard output; no new message        |
| 12  | Final provider failure or exhausted/deadline: short TX terminalizes failed once and records safe failure response under B1 T-2                                                         | No third attempt and no duplicate reply                       |

**Fencing protocol (B2 migration 0014, subject to B1 owner review):**
`assistant_turns` gains `lease_epoch bigint NOT NULL DEFAULT 0`,
`lease_owner`, `lease_expires_at` and a bounded claim/attempt counter.
Claims and reclaims use a short transaction; publishing checks the same
lease epoch/owner and that `status='running'` and `deadline_at > clock_timestamp()`.
Cancellation and the deadline sweeper win by changing terminal status; any
older claim then fails the guarded update. Do not fabricate a Run or reuse
Task lease columns without their ownership contract.

**Required adversarial tests:** simultaneous two-worker claim (one outbound call);
cancel while provider is in flight (no response); timeout/sweeper before provider
returns (no response); expired claim reclaimed by second worker (first cannot
publish); crash after provider response before commit (bounded second attempt);
first 5xx then second success (Turn never transiently failed, one final reply).

### 4.5 Bounded conversation context

| Rule                | Value                                                                                                 | Why                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Messages included   | last **8** from the same conversation                                                                 | enough for a follow-up, small enough to price  |
| Characters included | **12 000** total, oldest dropped first                                                                | hard cost bound independent of message count   |
| Always included     | the message being answered                                                                            | the turn must be about something               |
| Never included      | other conversations, `task_references`, task results, artifacts, workspace files, other tenants' rows | tenant isolation, and no silent data expansion |
| Roles sent          | `user`, and `assistant` from `ember` messages only                                                    | transcript kinds map 1:1 (B1 §6.2)             |
| Truncation          | oldest-first, never mid-message                                                                       | deterministic and testable                     |

Character budgeting is deliberate: token counts are an estimate we cannot verify offline, characters
we own. The gateway converts characters to tokens with a documented ratio, but the **hard** bound is
enforced in characters before a request is built.

### 4.6 Provider outcome → turn outcome

B1's Turn statuses `running | completed | failed | cancelled` are immutable
once terminal. **Attempt outcome is not Turn outcome.** A retryable provider
failure is saved on an internal attempt record while the Turn remains
`running`; only a success or a final, exhausted or expired attempt
transitions the Turn to terminal state.

| Provider outcome           | Attempt outcome_code | Turn while retry eligible           | Final turn outcome                      |
| -------------------------- | -------------------- | ----------------------------------- | --------------------------------------- |
| Successful response        | ok                   | running until atomic commit         | completed + exactly one ember reply     |
| 20-second attempt timeout  | model_timeout        | running if time and attempts remain | failed / timeout                        |
| Transport reset or 5xx     | model_unavailable    | running if time and attempts remain | failed / internal_error                 |
| Provider 429               | model_rate_limited   | running if time and attempts remain | failed / internal_error                 |
| Provider 401/403           | model_auth_failed    | no retry                            | failed / internal_error, alert operator |
| Malformed/refused response | model_invalid_output | no retry                            | failed / internal_error                 |
| User cancels               | client_cancelled     | no retry                            | cancelled, discard any in-flight output |

A Turn's **overall** 60-second deadline is authoritative and includes queueing,
both attempts, and final persistence; a 20-second provider timeout does not
extend it. A failed Turn gets B1's fixed user-safe reply, not a provider-specific
error body. First-call 5xx followed by a successful second call must yield
**one** completed Turn and **one** reply, never a terminal `failed` Turn
that is later resurrected.

### 4.7 What the user sees

An `ember` message with `simulated: false` and `model_label` set to the provider's pinned model id.
The client labels real output from the field, never from a heuristic (B1 M-5 / §9.4), and a test
asserts a real label never matches `/-(fake|echo)-/`.

## 5. Phase 2 — B3: Bounded Task Execution (`notes.action_items`)

### 5.1 What moves from the old plan, unchanged

The kind, the JSON artifact, the task/run lifecycle, the `infer` step, the retry policy and the
artifact retrieval are as audited (`V1ALPHA-MODEL-EXECUTION-AUDIT.md` §5.2–§5.8). Three things change:

1. **Invocation.** A Task is created by `POST /v1/tasks` with `kind: "notes.action_items"` and the
   B1 linkage fields `conversation_id` + `source_message_id` (§8.1). Chat is the entry point; there
   is no dedicated screen, no separate navigation, and no "Notes tab".
2. **It does not own a model client.** It calls `gateway.extractActionItems()` — the same package,
   the same gate chain, the same ledger. There is one place in the codebase that can reach a provider.
3. **The result does not widen `task_results`.** B1 §9.2 froze that shape to `summary_text` /
   `detail_text`, and X-4 already reserves `result_state: "unavailable"` for "an artifact-only Task
   kind". B3 therefore writes `unavailable` with an internal `reason_code`, and the typed JSON lives
   in the existing artifact store (`results/<taskId>.json`, immutable, addressable by
   `GET /v1/artifacts/:id`). This is the cleanest possible outcome: **B3 adds zero columns and zero
   wire fields to a frozen contract**, and the earlier open question "artifact-only vs `/result`"
   is answered by the contract, not by preference.

### 5.2 The result artifact

| Field           | Bound                                                      |
| --------------- | ---------------------------------------------------------- |
| `schemaVersion` | `1` (integer, closed)                                      |
| `taskId`        | uuid, must equal the containing task                       |
| `simulated`     | `false` (B3 refuses to run with the fake gateway)          |
| `truncated`     | boolean — output hit the token cap                         |
| `notesChars`    | integer, ≤ 8 000                                           |
| `usage`         | `{ inputTokens, outputTokens, costMicroUsd, rateVersion }` |
| `model`         | pinned model label                                         |
| `items`         | ≤ 20 × `{ text: string, ≤ 280 chars }`                     |

No `owner`, `dueDate`, `priority` or `estimate`: those are not derivable from a note and reading them
as authoritative is how an assistant quietly fabricates a deadline.

### 5.3 What makes B3 a migration and not a code change

| Object                                                  | Current state                                                             | Change, in `0015` only                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tasks.kind` CHECK (`0002:63-65`)                       | four `mock.*` kinds                                                       | add `notes.action_items`                                                  |
| `ember_task_event_payload_is_valid(jsonb)` (`0002:141`) | whitelists keys, kinds and all 15 `errorCode` values, `ELSE RETURN false` | add the B3 keys and two error codes `MODEL_UNAVAILABLE`, `MODEL_REJECTED` |
| `errorCode` mapping                                     | 15 values                                                                 | `MODEL_UNAVAILABLE` retryable, `MODEL_REJECTED` terminal                  |

Both edits are to a **fail-closed** function, so the migration must ship with tests that assert an
unknown key, an unknown kind and an unknown error code are still rejected. That is the B3 gate.

### 5.4 What B3 still does not get

`max_attempts` for this kind is **2**, not the platform default of 3, because a retried attempt can
re-bill a provider call (§10). Kept from the audit: no open-ended prompt, no caller-supplied model, no
streaming, no tools, and an 8 000-character notes limit.

## 6. The minimal Model Gateway

One package, `packages/model-gateway`, one interface, two operations, one provider. It is deliberately
smaller than a "provider abstraction": it is the shape of the two things Ember actually does.

### 6.1 The interface

```ts
// packages/model-gateway/src/types.ts
export type ModelOperation = 'conversation.turn' | 'task.action_items';
export type ModelProviderId = 'fake' | 'openai';

export const MODEL_LIMITS = Object.freeze({
  maxContextMessages: 8,
  maxContextChars: 12_000,
  maxOutputTokens: 512,
  deadlineMs: 20_000,
  maxActionItems: 20,
  maxActionItemChars: 280,
  maxNotesChars: 8_000,
});

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Integer micro-USD, computed from the approved rate row. Never a float. */
  readonly costMicroUsd: number;
  readonly rateVersion: string;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ConversationTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  /** Bounded, oldest-first; the last entry is the message being answered. */
  readonly context: readonly ModelMessage[];
  readonly maxOutputTokens: number;
}

export interface ConversationTurnOutput {
  readonly text: string;
  readonly finishReason: 'stop' | 'length';
}

export interface ActionItemsInput {
  readonly taskId: string;
  readonly runId: string;
  readonly notes: string;
  readonly maxOutputTokens: number;
}

export interface ActionItemsOutput {
  readonly items: readonly { readonly text: string }[];
  readonly truncated: boolean;
  readonly finishReason: 'stop' | 'length';
}

export interface ModelCallResult<T> {
  readonly output: T;
  readonly modelLabel: string;
  /** `true` only for the fake adapter. Asserted, not conventionally assumed. */
  readonly simulated: boolean;
  readonly usage: ModelUsage;
}

export interface ModelGateway {
  readonly providerId: ModelProviderId;
  readonly modelLabel: string;
  readonly operations: readonly ModelOperation[];
  generateConversationTurn(
    input: ConversationTurnInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>>;
  extractActionItems(
    input: ActionItemsInput,
    signal: AbortSignal,
  ): Promise<ModelCallResult<ActionItemsOutput>>;
}
```

Three properties of this shape matter more than any field:

1. **No input carries a model, a temperature, a system prompt, a tool list, a stop sequence or a
   provider.** The model is a property of the adapter, pinned at construction. A caller cannot widen
   the surface, so a later feature cannot smuggle capability in through a parameter.
2. **No output carries raw provider JSON.** Each operation returns the shape its consumer needs, so
   provider-format churn cannot reach the worker or the wire.
3. **`AbortSignal` is a parameter, not an option.** Cancellation and deadline are the same mechanism,
   so a slow provider and a user cancel take the same code path — the one that is tested.

### 6.2 What is deliberately absent, and why each omission is load-bearing

| Omitted                  | Why                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Streaming                | B1 T-3 says polling is the only progress signal; a stream would need a second wire contract |
| Tool / function calling  | Any tool call is `network.egress` or `host.exec`, both hard-denied (F-1)                    |
| Internal retries         | Retries multiply spend and hide failures; the turn has its own bounded attempt policy (§10) |
| Model registry / routing | One pinned model per adapter; routing is a cost decision nobody has approved                |
| Second provider          | Doubles credential, egress and retention review for zero Alpha value                        |
| Prompt templating layer  | Two fixed prompts live with their two operations, versioned in code                         |
| Response caching         | Caching user content creates a second copy of the transcript we would then have to delete   |

### 6.3 Admission: how `model.infer` enters Sentinel without breaking it

The existing Sentinel is a closed v1 evaluator. It requires `runId` and
hard-denies `network.egress`, `host.exec`, and `credential.use`. B2
introduces one **narrow** `model.infer` action; it must not make old v1
run admission silently fail or give any other action new authority.

**Strict intent union (normative design target):**

```ts
const RunIntent = z.strictObject({
  subjectKind: z.literal('run'),
  tenantId: Uuid,
  runId: Uuid,
  taskId: Uuid.optional(),
  actionId: Uuid.optional(),
  actionCategory: Category,
  policyVersion: Version,
});

const TurnIntent = z.strictObject({
  subjectKind: z.literal('turn'),
  tenantId: Uuid,
  turnId: Uuid,
  actionCategory: z.literal('model.infer'),
  policyVersion: z.literal(2),
  providerId: z.literal('openai'),
  operation: z.literal('conversation.turn'),
});

const SentinelIntentV2 = z.discriminatedUnion('subjectKind', [RunIntent, TurnIntent]);
```

Keep the **legacy v1 Run validator** available for existing callers until all
call sites are migrated, or add a lossless normalization adapter that injects
`subjectKind:'run'` from trusted internal code. Do not add optional `runId`
or allow both `runId` and `turnId` to be present. Existing policy-v1 mock
and Commitment tests MUST continue to pass. v1 policies never allow
`model.infer`; v2 must be explicitly provisioned by the platform.
The default policy cannot silently upgrade to a model-enabled policy.

The trusted admission layer derives tenant, provider, operation, policy version
and turn identity from authenticated server-side context and persisted rows.
Neither `providerId` nor `operation` is accepted from the user's chat message.
A candidate is permitted only when it is `model.infer`, policy version 2,
the trusted provider is in the **code-owned closed allowlist**, and that
tenant's matching current policy explicitly grants the action.

This new allow branch remains **after** the three pre-existing hard denies;
`network.egress`, `host.exec` and `credential.use` stay denied regardless
of any `model.infer` grant. Credential retrieval and TLS egress occur only
inside the separately reviewed pinned model adapter; they are not generic
Sentinel permissions.

Compatibility tests: every prior v1 vector unchanged; strict union rejects a
Turn with `runId`, a Run with `turnId`, missing discriminator and unknown
provider; v1+model.infer always denied; high-risk categories denied even under
a v2 policy granting model.infer; mismatched tenant or policy denied.

### 6.4 Credential and egress, authorized together (not one granting the other)

The CTO's constraint is that `model.infer` must not become a bypass of the existing credential and
egress denials. The design is **four independent locks, opened in order, none able to substitute for
another**, and every lock is a separate test.

| #   | Lock                                                                                   | Enforced by                             | If it fails                                  |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| L1  | Policy grants `model.infer` for this tenant, at the current policy version             | `evaluateSentinelPolicy` §6.3           | `POLICY_DENIED`, zero bytes sent             |
| L2  | `intent.providerId` ∈ frozen `APPROVED_MODEL_PROVIDERS`                                | same branch, before the allowlist check | `DENY_MODEL_PROVIDER_NOT_APPROVED`           |
| L3  | A credential is **bound**, non-empty, non-placeholder, for that same provider          | `ModelCredentialBinder`                 | boot failure (§6.5) or per-call `failed`     |
| L4  | The request targets the adapter's single hard-coded origin, TLS, no redirect, no proxy | provider adapter                        | impossible by construction; asserted by test |

Why L2 is not redundant with L1: an allowlist entry is tenant policy, and tenant policy is data. A
misconfigured tenant policy that grants `model.infer` must still not be able to point the gateway at a
host nobody reviewed. Provider identity is therefore checked against **code**, not against policy.

**The credential's blast radius.** This is the first server-side third-party secret in the codebase
(F-5). Its handling rules, all testable:

- exactly one secret per process per provider, read once at construction;
- held only by the provider adapter closure; it never appears in `ModelGateway`'s public types, so no
  caller can receive it, log it or serialize it;
- never written to `task_events`, artifacts, `platform_metadata`, logs or an error message — errors
  are mapped to the closed taxonomy of §4.6 _before_ they leave the adapter;
- placeholder detection at boot: a value equal to the documented placeholder, shorter than the
  provider's real key format, or still containing `CHANGEME` ⇒ refuse to start when the mode is
  `real` (fail-closed, and explicitly **not** a silent downgrade to `fake`);
- a missing secret in mode `fake` or `disabled` is fine, and is the default state of every
  environment, including CI.

**Egress, precisely.** The only module permitted to construct an outbound HTTP request is
`packages/model-gateway/src/providers/openai.ts`. Its origin is a module-level constant; there is no
env var, no base-URL override, no test hook that changes it in production builds. A unit test asserts
(1) the module exports exactly one origin, (2) redirect following is disabled, (3) proxy environment
variables are not consulted, (4) the request carries exactly the fields the contract needs and no
more, and (5) a second provider cannot be added without editing that list. Tests use a stubbed
`fetch`; CI never resolves a provider hostname.

**Neither lock implies the other.** `network.egress` and `credential.use` remain hard-denied at step 6
regardless of policy, and a test asserts that a policy granting `model.infer` still receives
`DENY_HIGH_RISK_EGRESS` for `network.egress` and `DENY_HIGH_RISK_CREDENTIAL` for `credential.use`.
That property is the reviewable answer to "did the new category widen anything?" — no: it added a
narrower category with its own branch, and the three Round-1 denials are untouched.

### 6.5 Two implementations, one config, and the boot rule

| Adapter              | Mode                                | Behaviour                                                                                                                           |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `FakeModelGateway`   | `disabled`, `fake` (default and CI) | deterministic canned reply per operation; `simulated: true`; `costMicroUsd: 0`; used by every unit, integration, chaos and e2e test |
| `OpenAiModelGateway` | `real` only                         | one pinned model, one origin, one call, 20 s deadline                                                                               |

`EMBER_MODEL_EXECUTION` is one of `disabled`, `fake`, `real`, default `disabled`. In `disabled` the service may boot but **must not invoke even the fake gateway or present a canned reply**; a pending Turn closes via the bounded B1 sweeper. In `fake`, a deterministic internal responder produces only explicitly labelled `simulated: true` output. Boot rules:

| Mode       | Key present | Sentinel allows `model.infer`           | Result                                                                      |
| ---------- | ----------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `disabled` | any         | any                                     | start; **no responder or inference calls**; turns fail by the B1 deadline   |
| `fake`     | any         | any                                     | start; fake adapter; exercises the full gate chain with zero cost           |
| `real`     | no          | —                                       | **refuse to start** (`POLICY_DENIED` at boot, with a content-free reason)   |
| `real`     | yes         | no enforceable model-policy integration | **refuse to start**; a particular tenant without a grant is denied per Turn |
| `real`     | yes         | yes                                     | start, and only then can a turn reach a provider                            |

The boot check validates presence of an enforceable trusted policy path, not a blanket grant to every tenant. Each Turn must separately resolve the current tenant policy and fail closed if it lacks `model.infer`. There is no row in that table that degrades `real` into `fake`. A process that was configured for real
inference and cannot deliver it must be dead and visible, because the alternative is an assistant that
silently answers with canned text while the UI says the model is real.

## 7. Quotas and spend: per-tenant and per-user are separate things

### 7.1 Two dimensions, never derived from each other

| Dimension | Question it answers                        | Key                                      | Ceiling                     |
| --------- | ------------------------------------------ | ---------------------------------------- | --------------------------- |
| Tenant    | how much may this workspace spend in a day | `(tenant_id, 'tenant', tenant_id)`       | money                       |
| User      | how much may this person consume in a day  | `(tenant_id, 'principal', principal_id)` | money **and** request count |

They are checked independently and **both must pass**. When they disagree, the smaller wins: an
allowance never overrides a ceiling. Neither value is computed from the other, and no code reads
`tenant_id` to infer a user.

### 7.2 What "per user" means under the frozen Alpha identity contract

ADR-0004 §5.1 defines Consumer↔Tenant as 1:1 and Consumer↔Principal as 1:1 with the owner role.
The session authenticator resolves the unchanged server-side `AuthContext { tenantId, principalId,
policyVersion }`; the caller cannot supply either identity. Therefore:

- the per-user ceiling is keyed on `principalId`, scoped by tenant; this matches the frozen Alpha identity model rather than relying on the current dev fixture's accidental 1:1 mapping;
- a tenant has one Alpha consumer/owner principal; shared or multi-user tenants are explicitly outside this contract;
- storage remains `(tenant_id, scope_kind, scope_id)` with `scope_kind IN ('tenant','principal')`; no speculative consumer scope is needed for Alpha;
- the contract decision is complete, but the production session/auth runtime is not shipped by B1-1. The B1-2 implementation and integration tests must prove that every issued session resolves the correct principal before a real model call can be enabled.

This settles the identity _model_ without overstating implementation readiness. The spend ledger must
not accept a caller-supplied principal ID, and no paid call may proceed if the authenticated
`AuthContext` or its policy version cannot be resolved.

### 7.3 Migration `0014` (sketch, not written)

B1 owns `0011`–`0013`; this is a **proposed** B2-only forward migration.
The previous sketch had two integrity failures: a platform-global budget
did not exist, and one spend-operation key could not represent both tenant
and principal postings. Replace it with **one canonical attempt/operation
row plus three locked aggregate buckets**, with no duplicated operation
row per scope:

```sql
-- 0014_model_execution.sql (PROPOSED; not executed or approved)
-- Additive B2 claim fields on the B1-owned assistant_turns table.
ALTER TABLE assistant_turns
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz;
-- A check/transaction must enforce both lease fields present or absent together.
-- The claim transaction is committed before any network call.

-- One single, shared cross-tenant platform-day spend counter.
CREATE TABLE model_global_spend_days (
  utc_day date PRIMARY KEY,
  reserved_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (reserved_micro_usd BETWEEN 0 AND 5000000),
  consumed_micro_usd bigint NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  CONSTRAINT global_consumption_within_reservation
    CHECK (consumed_micro_usd <= reserved_micro_usd)
);

-- Two independent per-tenant scopes, not inferred from one another.
CREATE TABLE model_spend_days (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant','principal')),
  scope_id uuid NOT NULL,
  utc_day date NOT NULL,
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd bigint NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  turns_started integer NOT NULL DEFAULT 0 CHECK (turns_started >= 0),
  PRIMARY KEY (tenant_id, scope_kind, scope_id, utc_day),
  CONSTRAINT scope_consumption_within_reservation
    CHECK (consumed_micro_usd <= reserved_micro_usd),
  CONSTRAINT scope_reserved_max CHECK (
    (scope_kind = 'tenant' AND reserved_micro_usd <= 1000000)
    OR (scope_kind = 'principal' AND reserved_micro_usd <= 250000)
  )
);

-- An attempt IS the canonical spend operation. No second operations
-- table with an unworkable (tenant_id,operation_id) primary key.
CREATE TABLE model_turn_attempts (
  tenant_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 2),
  operation_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  utc_day date NOT NULL,
  state text NOT NULL CHECK
    (state IN ('reserved','settled','unknown_billed','released')),
  outcome_code text,
  reserved_micro_usd bigint NOT NULL
    CHECK (reserved_micro_usd BETWEEN 1 AND 5000),
  applied_cost_micro_usd bigint
    CHECK (applied_cost_micro_usd IS NULL
           OR applied_cost_micro_usd BETWEEN 0 AND reserved_micro_usd),
  -- Preserve actual provider/invoice value even if above our reservation.
  observed_cost_micro_usd bigint CHECK
    (observed_cost_micro_usd IS NULL OR observed_cost_micro_usd >= 0),
  input_tokens integer,
  output_tokens integer,
  rate_version text NOT NULL,
  send_started_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  PRIMARY KEY (tenant_id, turn_id, attempt_no),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, turn_id)
    REFERENCES assistant_turns (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals (tenant_id,id) ON DELETE RESTRICT
);
```

**Atomic reservation:** within **one** short PostgreSQL transaction,
upsert the UTC global bucket, tenant bucket and principal bucket, then lock
in deterministic order **global day → tenant day → principal day →
canonical attempt**. An idempotent existing attempt returns its reservation
and never starts another provider call. New first attempts increment
`turns_started` once (not twice if retried); existing attempt uniqueness
and the bounded attempt number reject duplicates. Reject before commit
if _any_ bucket's new cumulative reserved amount exceeds its ceiling,
or the principal's 60-turn daily count is exceeded. Roll back all buckets
and the attempt on failure. Do not hold any budget lock across HTTP.

**Settlement:** update the same three buckets and attempt atomically under
the same lock order. `reserved_micro_usd` is a **monotonic pessimistic
commitment** for calls already sent; `consumed_micro_usd` reflects the
amount recognized against that reservation. If a call timed out or crashed
with uncertain provider billing, mark `unknown_billed` and keep the
reservation charged until verified reconciliation. Release only when no
outbound request could have been sent. The provider-reported/invoiced
actual is recorded in `observed_cost_micro_usd` without clamping; if it
exceeds the reserved estimate, fail closed for further egress, trigger
alert/reconciliation, and retain the overage evidence. A CHECK on
`applied_cost_micro_usd` cannot constrain an external invoice.

**Global concurrency test:** two _different_ tenants, on independent
PostgreSQL connections, both reserve the final available global budget.
Exactly one reservation commits; the other is refused; assert **zero**
extra gateway calls and the persisted global reserved total ≤ 5,000,000
µUSD. Also test tenant/principal caps, first/second attempts, settlement
replay, unknown-billed crash, and overage handling.

### 7.4 Ceilings, and which one binds first

These remain **provisional internal-pilot design targets**, not permission
to spend or proof of a provider-invoice hard cap:

| Scope                           | Provisional limit               | Gate                                                    |
| ------------------------------- | ------------------------------- | ------------------------------------------------------- |
| One provider attempt            | $0.005 reserved maximum         | Provider-verified token ceiling + overhead              |
| One Turn                        | ≤ 2 attempts; ≤ $0.010 reserved | Unique attempt_no 1 or 2                                |
| One principal per UTC day       | $0.25 and 60 paid Turns         | Independent principal bucket, counts first attempt only |
| One tenant per UTC day          | $1.00                           | Independent tenant bucket                               |
| Entire platform per UTC day     | $5.00                           | ONE shared global bucket across all tenants             |
| B3 Tasks, per principal per day | 20                              | Separate B3 counter when approved                       |

All three monetary buckets must pass atomically before one provider call.
B1's 200 **submitted chat messages** per rolling 24 hours and B2's 60
**paid Turns** per UTC day are separate limits; iOS should explain them
differently. They are not interchangeable and may reset on different
calendar boundaries.

The ledger enforces these amounts against **reserved rated costs**.
A strictly bounded actual invoice additionally depends on pinned
provider-side model/token limits, exact pricing, accurate rate rows and
provider account spend controls; we **must not claim a $5 invoice hard cap**
until that external enforcement is independently verified.

### 7.5 Fixing the settlement defect (F-4) rather than inheriting it

`runBudgetedStep` currently settles full _simulated work units_ for
existing Task kinds. B2's ordinary Chat Turn **does not use** that ledger:
it uses the independent model-money attempt ledger described in §7.3.

When B3 adds an infer Task step, an optional `consumedFor(result)` may
settle the _work-unit_ reservation correctly without changing existing
mock kinds, but it must not double-charge or replace the model-money
ledger. The model-money source of truth is the unique provider attempt,
not the worker step or a best-effort local estimate.

Never silently clamp an external provider's observed amount. If usage
exceeds the reserved bound, preserve the observed overage, freeze new
paid calls and surface an operational billing discrepancy. A CHECK
constraint protects our database accounting, not the invoice.

### 7.6 Stopping spend

Before each request: token/attempt cap → global/tenant/principal budget
reservation → current policy → scoped credential/origin gate. Any failure
means **zero** provider calls.

For an immediate operational stop, disable the model provider account's
own spend ability and/or revoke the scoped credential; process-level
`EMBER_MODEL_EXECUTION=disabled` takes effect only on restart and is
**not** an instantaneous stop. The optional reviewed runtime kill switch
must be tested for propagation and checked before every request if
enabled. Stop/alert on billing discrepancy, pricing mismatch, unknown
usage backlog or a shared global cap breach; do not silently use fake
output in real mode.

## 8. Model cost: envelope, arithmetic, and provisional prices

### 8.1 Provenance — read this before trusting any number below

On **2026-11-03** I tried to read primary price pages from this environment and **could not**:

| Source                                             | Result on 2026-11-03                           |
| -------------------------------------------------- | ---------------------------------------------- |
| `platform.openai.com/docs/pricing`                 | HTTP 403                                       |
| `developers.openai.com/api/docs/pricing`           | HTTP 403                                       |
| `platform.claude.com/docs/en/about-claude/pricing` | region-restricted interstitial, no price table |
| `ai.google.dev/gemini-api/docs/pricing`            | fetch timed out                                |

So the rate rows below are **secondary, dated and unverified**. They are not a quote; they are a
placeholder with provenance, and **approval item A2 is "confirm these from an invoice-grade source"**.
Anyone with console access can settle it in ten minutes. I cannot, and inventing confidence here would
be the single most damaging thing this document could do.

| Provider / model        | input $/1M | output $/1M | status         | observed via                             |
| ----------------------- | ---------- | ----------- | -------------- | ---------------------------------------- |
| `gpt-5-mini` (proposed) | 0.25       | 2.00        | **UNVERIFIED** | secondary aggregator pages, Oct–Nov 2026 |
| `gpt-4.1-mini`          | 0.40       | 1.60        | **UNVERIFIED** | secondary aggregator pages, Oct–Nov 2026 |
| `gpt-4o-mini`           | 0.15       | 0.60        | **UNVERIFIED** | secondary aggregator pages, Oct–Nov 2026 |

Two structural facts matter more than the numbers: the chosen model must support the **structured JSON
output** B3 needs, and it must be **pinned by dated id** so a provider-side update cannot change price
or behaviour under a running Alpha.

### 8.2 The arithmetic, which is ours and does not depend on the rate

The envelope comes from `MODEL_LIMITS` (§6.1), not from optimism. Tokens at 4 chars/token, rounded up **for the illustrative cost table only**. This is NOT a maximum or an admissible security/budget preflight; Unicode, model tokenizer differences, hidden/system/schema tokens and provider billing policies can invalidate it.

| Case                                       | input tokens | output tokens | cost at $0.25 / $2.00 | cost at $0.40 / $1.60 |
| ------------------------------------------ | ------------ | ------------- | --------------------- | --------------------- |
| B2 typical turn (short follow-up)          | ~770         | ~220          | $0.00063              | $0.00066              |
| B2 worst turn (8 messages, 12 000 chars)   | ~3 130       | 512           | $0.00181              | $0.00207              |
| B3 typical (2 000-char note, 12 items)     | ~600         | ~350          | $0.00085              | $0.00080              |
| B3 worst (8 000-char note, 512 tokens out) | ~2 150       | 512           | $0.00156              | $0.00168              |

Monthly per active user, 20 turns/day for 30 days: **$0.38 typical, $1.09 worst case** (B2 only).
Adding 10 note extractions a month: **+$0.02**. At 25 users that is **$10–28/month**, with the $5.00/day
global ceiling as the binding financial control at **$150/month** absolute worst case.

These are small numbers, and that is the point: the cost of the feature is not the risk. The risks are
an unbounded loop, a duplicated paid call and a leaked secret — which is why §7 and §10 exist, and why
the per-turn ceiling is ~2.8× the worst case rather than near the average.

### 8.3 What happens when the price sheet is wrong

Provisional ceiling choices in §7.4 are derived from an illustrative cost envelope. Before real mode, the request must pass a **pinned-model exact tokenizer or provider-verified preflight** that counts user/context text, fixed system prompt, serialization/JSON schema overhead and any provider-billed reasoning tokens. If exact provider input usage cannot be bounded, fail closed without egress. Server-side `max_output_tokens` must be enforced and verified with the selected API. 4 chars/token is never a hard reserve bound.

Every recognized model usage estimate is
`(inputTokens × r_in + outputTokens × r_out) / 10^6` computed from a **versioned, officially verified rate row**
(`rateVersion`, stored per attempt). A rate correction is therefore: add a new rate row with a new
version string, re-derive the ceilings in one commit, keep historical spend attributed to the rate it
was priced at. No schema change, no data migration, and no month in which a ceiling silently means
something different.

## 9. Provider data handling (a decision, not a detail)

Sending conversation context to a model provider moves user content off the platform. That is the
central trade of this proposal, so it gets its own section instead of a footnote.

| Item                          | Proposed position                                                                                                                                             | Status                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| What is sent                  | last ≤ 8 messages of **one** conversation, ≤ 12 000 chars, plus one fixed system prompt                                                                       | design                            |
| What is never sent            | other conversations, task results, artifacts, workspace files, tenant or user names, any identifier beyond an opaque request id                               | design                            |
| Provider retention / training | must be established **in writing** from current provider terms before enablement, and any no-retention or no-training setting must be switched on explicitly  | **unverified — approval item B2** |
| Our logging                   | content-free: turn id, attempt no, outcome code, token counts, cost. No prompt, no completion, no excerpt                                                     | design, testable                  |
| Storage of the reply          | the message row only (B1 M-7); never in `task_events`, logs or `platform_metadata`                                                                            | design, testable                  |
| Deletion                      | deleting the transcript deletes the reply (B1 C-6); the provider copy is governed by their retention terms — which is precisely why B2 precedes any Beta user | design + B2                       |
| Disclosure                    | privacy copy must state that replies are generated by a third-party model                                                                                     | product                           |

Two things I will not write down as done: "the provider does not retain prompts" and "the provider does
not train on our data". Both are contractual statements about a third party that cannot be established
from this repository or this environment. Approval item B2 requires a named source.

## 10. Duplicate paid-call risk (known, bounded, priced)

### 10.1 The actual failure window

The provider can complete and bill a response while the worker dies before the
assistant reply is committed. End-to-end exactly-once **billing** cannot be
assumed, and the database cannot roll back an external invoice.

### 10.2 One outbound start per durable attempt

An attempt identity is `(tenant_id,turn_id,attempt_no)`, with
`attempt_no IN (1,2)`. Before any network I/O the current lease holder
atomically changes `send_started_at` from NULL to a database timestamp
using a compare-and-set that also checks the current Turn lease epoch/owner,
nonterminal state, nonexpired deadline, active permission and reserved money.
Only that successful CAS grants the **one outbound start** for the attempt.
On claim expiry or process crash, another worker must **never** reuse an
attempt whose `send_started_at` is non-NULL; it may start the next numbered
attempt only if the Turn deadline and budget allow. Disable all automatic
retries inside the HTTP provider client and redirect handling.

A crash between CAS and actual network send spends a conservative attempt
without making a call. That is preferable to an undetectable third paid call.

### 10.3 Failure handling and financial truth

| Case                                            | Policy                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Crash before the send-start CAS                 | Attempt may be released only after proving zero provider egress                           |
| Crash after CAS, before provider reply/commit   | Attempt is billed-unknown; keep the full reservation and consume one of two attempts      |
| Provider timeout or abort with unknown usage    | Keep reserved amount; do not record zero cost                                             |
| Provider success and durable reply commit       | Settle observed usage and one terminal Turn atomically if the current fence still matches |
| Stale worker returns after cancellation/sweeper | Discard text; charge/retain cost evidence; never publish                                  |
| Provider bill exceeds our reserved estimate     | Preserve actual amount, stop new egress, alert, reconcile with invoice                    |

**At most two outbound request starts** follows only if the send-start CAS,
attempt uniqueness, lease check, and disabled HTTP automatic retry all hold.
The provisional `$0.010` is a **maximum aggregate reserved estimate**, not
a guarantee that an external provider cannot bill more. A proven invoice
cap also needs provider-side billing limits and verified rates.

### 10.4 B3 shares this guarantee

B3's provider calls need an equivalent one-send-per-attempt identity tied
to the Task/Run fence. The artifact is idempotent, but artifact idempotency
does not protect the provider invoice. The same conservative unknown-billing
and strict attempt limit apply. No separate user-visible mock is permitted
when the real gateway refuses execution.

## 11. Test plan (what must be green before any `real` mode)

All provider tests use an injected, offline stub with **zero network egress**;
the budget and lease tests use real PostgreSQL 17 and independent connections.

| ID  | Acceptance case                             | Required assertion                                                                             |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T1  | Legacy Sentinel compatibility               | Existing policy-v1 Run/Mock/Commitment vectors pass unchanged                                  |
| T2  | Strict new Sentinel intent                  | Run vs Turn discriminator; no mixed IDs; v1 cannot grant model.infer                           |
| T3  | High-risk action preservation               | network.egress / host.exec / credential.use remain DENIED in v2                                |
| T4  | Provider and origin                         | Only code-pinned provider, TLS origin, no proxy/redirect/retry; secrets never logged           |
| T5  | Disabled/fake/real modes                    | disabled = zero inference; fake labels simulated; invalid real refuses startup                 |
| T6  | Two workers race for same Turn              | Exactly one committed claim and one outbound start                                             |
| T7  | First provider 5xx, second succeeds         | Turn stays running between attempts; exactly one completed Turn + one ember reply              |
| T8  | Cancel during provider inference            | Current fence invalidated; one possible billed attempt, zero published assistant reply         |
| T9  | Turn deadline passes in flight              | No completion after sweeper/60 s; zero stale reply                                             |
| T10 | Lease expiry and reclaim                    | Old worker cannot publish; at most one send per attempt via send-start CAS                     |
| T11 | Crash after provider response before commit | No third paid start; unknown bill remains reserved; valid retry only if time remains           |
| T12 | Global spend concurrency                    | Different tenants race on final global budget; one wins, other makes zero gateway calls        |
| T13 | Tenant/principal independent caps           | Crossing either cap refuses before network, other tenant does not borrow quota                 |
| T14 | Unknown usage and billing overage           | Full pessimistic reservation retained; actual invoice overage recorded and new egress disabled |
| T15 | Tokenization worst cases                    | Unicode, system/schema overhead, model-specific tokenizer mismatch fail closed                 |
| T16 | Transcript privacy and tenant isolation     | No other tenant history, secrets, prompts or completions in logs/events                        |
| T17 | Provider output truthfulness                | Real label never contains fake/echo marker; simulated matches adapter                          |
| T18 | B3 kind/event allowlist                     | Unknown kind/payload/error still fails closed after 0015                                       |
| T19 | B3 artifact and Task result                 | Immutable typed artifact, terminal Task result unavailable, no fake success                    |

A dedicated fault-injection test must assert the **atomic** publication fence:
only the live claim owner can commit the response under a still-running,
nonexpired, noncancelled Turn. Also test two independent tenants against the
one genuinely global bucket; local per-tenant tests alone cannot prove it.

## 12. PR sequence

Each implementation PR must leave main green. The approved B1 contract and B1-1 persistence
foundation are already merged; this removes the old contract-freeze blocker, **not** the remaining
runtime, trusted-module or provider-activation gates. The PR numbers below are work items, not
existing PRs.

| Slice | Deliverable                                                                                                | Gate                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| B2-0  | This design proposal + preserved original audit, docs only                                                 | Merge accepts the sequencing/guardrails as a planning baseline only; unresolved §14 decisions remain open.               |
| B2-1  | Strict Run/Turn Sentinel intent, `model.infer` category, version-1 compatibility and negative tests        | Frozen B1 contract + CTO approval of C1–C3/C6; T1–T3.                                                                    |
| B2-2  | Gateway types, strict config, FakeModelGateway and offline error mapping                                   | T4–T5; no provider network egress, credentials or production routes.                                                     |
| B2-3  | Forward-only `0014`, durable Turn claim/fence, shared global + tenant/principal money ledgers, attempt CAS | B1-1 ports/schema; CTO approval of relevant limits; T6, T10–T15 and migration replay.                                    |
| B2-4  | Worker ModelTurnResponder behind the B1-5 responder seam; fenced publication, retries and sweeper          | B1-2…B1-5 runtime complete, including the real responder seam; T7–T11, T16–T17.                                          |
| B2-5  | One real provider adapter, pinned origin/model, merged dark and disabled                                   | Separate approval of A1–A5 and B1–B4; verified model/pricing, data terms/DPA, billing controls and operator stop/alerts. |
| B2-6  | Runbook, account spend-limit check, 80% warning destination, emergency stop and billing reconciliation     | Named operational owner; operator dry run.                                                                               |
| B3-1  | `0015` Task kind/event payload/error vocabulary and fail-closed tests                                      | B1-6/B1-7 Task linkage/Result runtime; C4 approval; T18.                                                                 |
| B3-2  | Bounded action-item extraction via the same gateway, unique paid-attempt fence and immutable artifact      | T19 and safe cost accounting; same real-provider gate as B2-5.                                                           |
| B3-3  | iOS Task/Outcome card integrated into Conversation                                                         | iOS Lead; B1-6/B1-7 runtime and production truthfulness.                                                                 |

B2-1/B2-2/B2-3 are dark, non-provider work: they must not contact a provider, use a credential or
expose a real model-backed route. B2-4 remains blocked on the B1 responder runtime. B2-5 may be
merged dark, but **cannot be activated** by a documentation merge, an environment switch alone or a
per-tenant policy alone. The separate provider, data-protection, billing and operational acceptance
gate must pass first.

## 13. Explicitly out of scope

| Item                                                           | Reason                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Token streaming / SSE for turns                                | B1 T-3 chose polling; a second transport is a second contract                        |
| Conversation history search / summarisation / long-term memory | not needed for the vertical slice, and each one changes what gets sent to a provider |
| Multiple providers or automatic failover                       | doubles credential, egress and retention review                                      |
| Tool use, browsing, connectors, code execution                 | every one of them is an egress category that is hard-denied today                    |
| Device tokens / push notifications                             | orthogonal to the turn lifecycle                                                     |
| Billing, subscriptions, per-user plans                         | the ceilings are safety limits, not a pricing model                                  |
| Voice input / output                                           | not part of B2 acceptance                                                            |
| Second conversation or multi-agent orchestration               | B1 C-1 freezes one main conversation                                                 |
| Account deletion                                               | gated separately by B1 R-4 before TestFlight                                         |
| Fine-tuning, embeddings, RAG over user content                 | each adds a store of user content that must be deletable                             |
| Prompt A/B testing in production                               | unreviewable change surface for a call that costs money                              |

## 14. Approval checklist

Everything below is a proposal. None of it is enabled, provisioned or paid for.

### 14.1 Model, money and operations (must be answered by the CTO)

| ID  | Question                                                    | Proposal                                                                               | Consequence if wrong                                              |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A1  | Provider and pinned model id                                | one provider; one small-tier model pinned by dated id                                  | a silent model update changes price and behaviour under the Alpha |
| A2  | Price sheet                                                 | confirm §8.1 rows from an invoice-grade source                                         | every ceiling in §7.4 is mis-scaled                               |
| A3  | Ceilings                                                    | per-turn $0.005, per-user-day $0.25 / 60 turns, per-tenant-day $1.00, global-day $5.00 | too low breaks the Alpha; too high removes the financial stop     |
| A4  | Who owns the **global** ceiling when it trips               | an on-call operator, kill switch documented in the runbook                             | spend stops silently and nobody notices, or nobody can stop it    |
| A5  | Alert routing for `model_auth_failed` and daily spend ≥ 80% | one named channel                                                                      | a revoked key looks like "the assistant is broken" for a day      |

### 14.2 Third-party data handling (must be answered before `real`)

| ID  | Question                                                                                                           | Proposal                             |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| B1  | Is sending ≤ 8 messages of transcript to a provider acceptable for Alpha, and is it in the privacy copy?           | yes, scoped as §9 describes          |
| B2  | Provider retention and training terms — named source, dated                                                        | required in writing; no assumption   |
| B3  | Is a content-free audit trail (`turn id`, tokens, cost, outcome) sufficient, or is an external audit log required? | sufficient for Alpha                 |
| B4  | Must the provider's data-processing addendum be executed before any real user?                                     | yes, before TestFlight at the latest |

### 14.3 Changes that touch trusted modules

| ID  | Question                                                                                                         | Proposal                                    | Rejected alternative                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| C1  | Is `model.infer` the right category name and the right place in the branch ladder?                               | after the step-6 hard denies, before step 7 | reusing `network.egress`, which would require deleting a Round-1 denial |
| C2  | Is a **turn-scoped** Sentinel intent (`subjectKind: 'turn'`) acceptable?                                         | yes, discriminator required                 | fabricating a run per turn                                              |
| C3  | May `SentinelIntentSchema` gain `providerId`, and may the policy version go to 2?                                | yes                                         | provider identity taken from policy data                                |
| C4  | Are `MODEL_UNAVAILABLE` / `MODEL_REJECTED` the right B3 codes, and may `0002`'s allowlist be replaced in `0015`? | yes, with fail-closed tests                 | reusing an existing code for a different cause                          |
| C5  | Is the bounded duplicate paid call (§10) acceptable for Alpha?                                                   | yes: ≤ 2 calls, ≤ $0.010, observable        | a provider-side idempotency claim we cannot verify                      |
| C6  | Is "refuse to boot" correct for `real` without a key or without policy?                                          | yes                                         | silent downgrade to fake                                                |

### 14.4 Cross-team questions resolved by ADR-0004 / B1-1

The following items appeared as open questions in the original review. They are now settled by the
merged contract and B1-1 implementation; they must not be reopened in B2/B3 implementation PRs:

| Former question                                        | Frozen resolution                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Consumer identity vs `AuthContext.principalId`         | ADR-0004 §5.1: Consumer↔Tenant and Consumer↔Principal are each 1:1 in Alpha; principal is server-derived and has owner role. |
| Composite identity for Assistant Turns                 | B1-1 implements `UNIQUE (tenant_id, id)`; B2 must use this tenant-qualified identity.                                        |
| Whether the 60 s Turn budget includes queueing/retries | Yes. The full deadline includes queueing and retries; B2 must not start a new attempt after it expires.                      |
| 200 messages / rolling 24 h vs 60 paid Turns / UTC day | Separate limits with different purposes and windows; do not collapse them into one quota.                                    |
| Whether B3 may start without transcript linkage        | No for the initial iOS path: B3 depends on verified Conversation/Message linkage and B1-6/B1-7.                              |

These are contract/design resolutions, not proof that the corresponding B1 runtime routes or
transactions have shipped. Runtime acceptance remains tracked in §3.

### 14.5 What to review first

1. §6.3 (C2) — the turn-scoped intent, because it touches the module everything else trusts.
2. §6.4 — that `model.infer` is a _narrower_ category, not a widening of the three Round-1 denials.
3. §7.1 and §7.2 — that per-tenant and per-user are genuinely independent, and honestly labelled.
4. §8.1 — that the prices are unverified, and that fact is visible rather than buried.
5. §5.1 item 3 — that B3 needs no widening of `task_results`, because B1's X-4 already allows it.

## 15. CTO Round 2 correction matrix (2026-11-03)

This is the authoritative summary of the five corrections requested in
the [CTO Round 1 review of PR #93](https://github.com/basicv8vc/Ember/pull/93#issuecomment-6595496208).
These design corrections are **not** permission for production model egress.

| CTO finding                                    | Correction in this proposal                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Terminal state cannot be retried               | §4.4/§4.6: retry failure is attempt-only; Turn remains running until definitive finalization                  |
| Database locks cannot span provider I/O        | §4.3/§4.4: short claim TX + lease epoch + guarded publication + one-send CAS                                  |
| Global cap missing and operation key collision | §7.3: one shared global bucket; distinct tenant/principal buckets; attempt is one canonical operation         |
| Token heuristics and unknown invoices          | §7.3–§8, §10: verified token preflight, pessimistic unknown charges, no claim of invoice-hard cap             |
| Sentinel compatibility and mode ambiguity      | §6.3/§6.5: strict intent union, policy-v1 tests, legacy admission preserved, disabled means no fake inference |

**Cross-team resolutions:** ADR-0004 and its normative annex are frozen and merged in PR #92;
B1-1 is implemented and merged in PR #97. The live database now enforces
`assistant_turns UNIQUE (tenant_id,id)`, so B2 must use that composite
identity. ADR-0004 §5.1 freezes the Alpha Consumer↔Tenant and
Consumer↔Principal mappings as server-derived 1:1 relationships with the
owner role; caller-supplied identity is forbidden. The B1 Turn 60-second
deadline includes queueing and retries. B1's 200 submitted messages per
rolling 24 h is distinct from 60 paid Turns per UTC day. B3's initial iOS
path requires verified Conversation/Message linkage.

**Still blocked:** B1-2…B1-7 runtime implementation (including auth/session,
Conversation/Message/Turn routes, responder seam, Task linkage and Result
writer/read path); exact pinned provider/model and invoice-grade pricing;
provider prompt retention/training terms and applicable DPA; provider-side
billing controls; operator alert destination/runbook; and separate CTO
authorization for any real-mode activation.

## Appendix A — planned file inventory for B2/B3 implementation slices (not created by this proposal)

| PR   | Files                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B2-1 | `packages/execution/src/sentinel-lite.ts` (category array, version, branch, reason codes, intent schema) + a new sentinel test file                          |
| B2-2 | `packages/model-gateway/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/limits.ts,src/errors.ts,src/config.ts,src/fake.ts}` + tests                |
| B2-3 | `migrations/0014_model_execution.sql`, `packages/postgres/src/model-execution/*.ts`, `tests/integration/model-spend.test.ts`                                 |
| B2-4 | `apps/worker/src/model-turn-responder.ts`, `apps/worker/src/turn-claim.ts`, worker wiring, `tests/chaos/model-turn-crash.test.ts`                            |
| B2-5 | `packages/model-gateway/src/providers/openai.ts`, `apps/cli/src/model-smoke/cli.ts`, tests with a stubbed `fetch`                                            |
| B2-6 | `apps/cli/src/model-usage/cli.ts`, `docs/runbooks/MODEL-EXECUTION.md`, plus `0016` **only if** the runtime flag is approved                                  |
| B3-1 | `migrations/0015_notes_action_items.sql`, `tests/integration/kind-vocabulary.test.ts`                                                                        |
| B3-2 | `packages/model-gateway/src/action-items/*`, `apps/worker/src/durable-run-handler.ts` (`infer` step + `consumedFor`), `tests/e2e/notes-action-items.test.ts` |

As of current main `38dd69b`, none of the B2/B3 implementation files in this appendix has been
created. This PR remains documentation-only and changes no executable directory.

---

Status: **PROPOSED — documentation/design baseline only**. This PR changes documentation only:
no executable code, dependency, secret, migration file, provider contact or model spend. D-1/D-2
(the approved B1 contract) and B1-1 are complete. B2-1/B2-2/B2-3 may proceed only as dark,
non-provider implementation slices after their relevant CTO design decisions and tests are approved.
B2-4 additionally requires B1-2…B1-5 runtime and the responder seam. B2-5 real mode requires all
A1–A5 and B1–B4 approvals plus verified provider, pricing, data-protection, billing and operational
controls. B3 additionally requires B1-6/B1-7 runtime and C4 approval. Merging this document grants
none of those implementation or activation permissions.
