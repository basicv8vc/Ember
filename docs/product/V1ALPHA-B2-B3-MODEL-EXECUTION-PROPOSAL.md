# V1 Alpha — Real Model Execution in Two Phases (B2 first, B3 second)

| field                     | value                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| status                    | **proposed — awaiting CTO review; no code, no key, no egress**                          |
| phase 1                   | **B2 — Real Assistant Turn** (Conversation-first, the Alpha milestone)                  |
| phase 2                   | **B3 — Bounded Task Execution** (`notes.action_items`, invoked from Chat)               |
| audit of record           | `docs/product/V1ALPHA-MODEL-EXECUTION-AUDIT.md` (findings unchanged)                    |
| wire authority            | `docs/adr/0004-beta-v1-live-platform-contract.md` (Issue #91), contract draft in PR #92 |
| base commit               | `154860a` (`main` HEAD at branch time)                                                  |
| branch                    | `cto/v1alpha-notes-action-items`                                                        |
| migrations on base        | `0001`–`0010`; B1 reserves `0011`–`0013`; **B2 takes `0014`, B3 takes `0015`**          |
| external provider traffic | **zero**. Not provisioned, not contacted, not enabled.                                  |

## 0. Decision requested

Approve a **two-phase plan** in which the first paid, externally-visible model call powers an
assistant reply inside Chat, and `notes.action_items` follows as a capability Chat can invoke.

Concretely, five decisions:

| #   | Decision                                 | Default if the CTO says "yes to the proposal"                                              |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| A   | Provider and model id                    | one provider, one pinned model, proapproved small tier (A1 below)                          |
| B   | Price sheet is provisional               | ceilings derived from a formula, re-derived from an invoice-grade source before enablement |
| C   | Per-user and per-tenant spend ceilings   | per-user-day $0.25, per-tenant-day $1.00, global-day $5.00 (proposed)                      |
| D   | Conversation context leaves the platform | transcript excerpt sent to the provider, retention terms verified in writing first         |
| E   | Sentinel and credential model changes    | one category `model.infer`, policy version 2, one credential binder, one hard-coded origin |

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

The second row is the important one. **B2 needs no new wire field at all**, because the B1 contract
already requires every assistant message to carry `model_label` and `simulated` (M-5, §9.4) and
already defines a three-state result resource with an `unavailable` branch reserved for
"artifact-only Task kinds" (X-4). That reservation is what makes B3 fit later without widening a
frozen shape. The old plan's hardest problem — inventing a vocabulary inside the `task_events`
payload allowlist — is now a B3 problem that lands **after** the platform contract is merged, against
a contract owner who has already published the rules.

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

Nothing in this proposal can start before D-1, and each later item is a gate rather than an
assumption.

| ID  | Dependency                                                                                                                          | Owner                         | Blocks                 | If it slips                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| D-1 | Issue #91: `docs/adr/0004-beta-v1-live-platform-contract.md` merged, immutable SHA named                                            | Platform contract owner / CTO | **everything**         | B2 does not start. No partial wire work                                                                        |
| D-2 | PR #92 (B1 contract) merged                                                                                                         | CTO                           | B2 wire alignment      | B2 is designed against a draft; re-review required                                                             |
| D-3 | B1-1 … B1-5 implemented: `0011`–`0012` migrations, `POST`/`GET` messages, turn rows, **responder seam**, turn polling + T-1 sweeper | Platform                      | B2-4                   | B2-2/B2-3 (gateway + ledger) may proceed dark; no turn path                                                    |
| D-4 | B1-6/B1-7 implemented: message→task linkage, `task_results` write path                                                              | Platform                      | B3                     | B3 waits; B2 unaffected                                                                                        |
| D-5 | Migration slot: B1 owns `0011`–`0013`; this proposal takes `0014` (B2) and `0015` (B3)                                              | Platform                      | migrations             | If B1 renumbers, B2 renumbers; the proposal states the **rule**, not just the number                           |
| D-6 | Consumer Identity contract (#91 §5, §11.1): account → tenant/principal mapping                                                      | Platform                      | per-user quota keying  | Interim keying is `AuthContext.principalId` (§7.2), which is real today, not an assumption that tenant == user |
| D-7 | CTO approval items A1–A5, B1–B4 (§14)                                                                                               | CTO                           | any paid call          | `EMBER_MODEL_EXECUTION` stays `disabled`                                                                       |
| D-8 | iOS #90: Live repository plan; no Live calls before B2 merges                                                                       | iOS lead                      | user-visible milestone | Mock transport must not silently fall back to Live, or vice versa                                              |

D-5 and D-6 deserve a sentence each.

**D-5.** A migration number is a coordination artifact, not a preference. If B1's `0013` moves, B2's
file renames; nothing else changes, because no B2 migration references a B1 object by number.

**D-6.** The CTO said do not assume tenant equals user. The proposal does not: it keys the per-user
ceiling on `principalId` from the existing `AuthContext` (`apps/api/src/auth/bearer-authenticator.ts`
already carries `tenantId`, `principalId`, `policyVersion`), stores it as
`(scope_kind, scope_id)` so a future `consumer` scope is a `CHECK` extension rather than a rewrite,
and states plainly that **until #91 lands, "per user" means "per principal within a tenant"** — for
the current dev authenticator those are 1:1, and that 1:1 relation is a property of today's fixture,
not a platform guarantee.

## 4. Phase 1 — B2: Real Assistant Turn

### 4.1 The definition

One authenticated user message produces one durable assistant reply whose text came from a real model,
whose status is authoritative on the server, and which survives force-quit, relaunch and a lost
response. Polling, not streaming.

### 4.2 What B2 adds, and what it refuses to add

| Adds                                                   | Refuses to add                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| A responder implementation behind B1-5's seam          | A conversation route, a message table, a turn table, a sequence rule         |
| `packages/model-gateway` (one package, two operations) | A multi-provider framework, a model registry, caller-chosen models           |
| Migration `0014`: attempts, spend, kill switch         | Any change to `tasks`, `task_events`, or `0002`'s kind and payload allowlist |
| Sentinel category `model.infer` + policy version 2     | Any relaxation of the `network.egress` or `credential.use` denials           |
| One provider adapter, one hard-coded origin            | Retries, redirects, proxies, streaming, tool calls, function calling         |

The refusal list is the architecture. Every item on it is something a model integration normally
grows in its first month, and each one re-opens a decision this proposal closes on purpose.

### 4.3 The seam: one interface, already frozen by B1

B1 §7 states that a turn is completed by "the responder", and B1-5 ships that responder as a
deterministic fake echo. B2 is therefore a **substitution**, not an addition:

```text
                        +-----------------------------+
POST .../messages  ---> | tx: message + turn(running) |   B1, unchanged (S-1, S-2)
                        +--------------+--------------+
                                       |  turn appears as claimable work
                                       v
                    +--------------------------------------+
                    | worker: claim turn (lease, attempt N)|   B2, migration 0014
                    +--------------+-----------------------+
                                   v
              +--------------------------------------------+
              | gate: quota -> sentinel -> credential      |  §6.3/§6.4, before egress
              |       -> spend reservation                 |
              +--------------+-----------------------------+
                             v
                 +-------------------------------+
                 | ModelGateway.generate(..)     |  B2, packages/model-gateway
                 +--------------+----------------+
                                v
        +--------------------------------------------------+
        | tx: ember message + turn(completed|failed) +      |  B1 §7.1 T-2, satisfied
        |     attempt row settled with actual usage         |
        +--------------------------------------------------+
```

The API route, the message row, the sequence rule, the turn states, the polling cadence and the
failure-reason enum are all B1's. B2 owns the middle two boxes and nothing else. That is the whole
argument for why this can be built alongside iOS integration without a wire negotiation.

### 4.4 Flow, in order, with the failure branch of each step

| #   | Step                                                                                                                                             | On failure                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | `POST .../messages` commits message + turn (`running`) — B1                                                                                      | B1 semantics; B2 not involved                                                         |
| 2   | Worker claims the turn: `FOR UPDATE SKIP LOCKED` on `assistant_turns` where `status='running'`, plus an advisory lock per `(tenant_id, turn_id)` | claim lost → no side effect                                                           |
| 3   | Read attempt count for this turn from `model_turn_attempts`                                                                                      | DB error → abandon claim, turn stays `running`                                        |
| 4   | `attempt >= 2`? → finalize `failed` / `internal_error`                                                                                           | —                                                                                     |
| 5   | Kill switch (`EMBER_MODEL_EXECUTION` ≠ `real`) → **write nothing**, release claim                                                                | turn stays `running`; T-1 sweeper closes it at 60 s                                   |
| 6   | Per-user and per-tenant daily quota check                                                                                                        | exceeded → finalize `failed` / `internal_error`; reason stays internal                |
| 7   | Sentinel: `model.infer` + provider id + policy version                                                                                           | deny → finalize `failed` / `internal_error`                                           |
| 8   | Credential binding present and non-placeholder                                                                                                   | missing → finalize `failed`; **loud log**, same wire shape                            |
| 9   | Build bounded context (same conversation, last ≤ 8 messages, ≤ 12 000 chars)                                                                     | parse error → finalize `failed`                                                       |
| 10  | Reserve spend (`model_spend_*`, µUSD, idempotent on `(turn_id, attempt_no)`) **and** insert the attempt row, **before** the request              | unique violation → this attempt already paid; do not call again                       |
| 11  | One model call (single attempt, 20 s deadline, abortable)                                                                                        | §4.6 mapping                                                                          |
| 12  | Commit `ember` message + terminal turn + settled attempt cost in **one** transaction                                                             | commit fails → the attempt row still records that a call happened; retry at attempt 2 |

Step 10 before step 11 is the whole duplicate-call mitigation (§10). Steps 5–9 precede step 11, so
every refusal costs zero provider tokens.

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

The turn's failure vocabulary is B1's closed enum `timeout | internal_error` (§7.2). **B2 adds no
value to it.** Provider detail stays in `model_turn_attempts.outcome_code`, which is internal and
never serialized.

| Provider / gateway outcome    | `assistant_turns.status`                   | `failure_reason` | attempt `outcome_code` | retry?                         |
| ----------------------------- | ------------------------------------------ | ---------------- | ---------------------- | ------------------------------ |
| success                       | `completed` + one `ember` message, same tx | `null`           | `ok`                   | —                              |
| deadline exceeded (20 s)      | `failed`                                   | `timeout`        | `model_timeout`        | one more attempt               |
| connection reset / 5xx        | `failed`                                   | `internal_error` | `model_unavailable`    | one more attempt               |
| 429                           | `failed`                                   | `internal_error` | `model_rate_limited`   | one more attempt               |
| 401 / 403                     | `failed`                                   | `internal_error` | `model_auth_failed`    | **no** — operator fault, alert |
| unparseable or refused output | `failed`                                   | `internal_error` | `model_invalid_output` | **no**                         |
| user cancelled the turn       | `cancelled`                                | `null`           | `client_cancelled`     | no (T-4)                       |

The user-visible text for `failed` is one fixed, user-safe sentence (B1 §7.1). It never contains a
provider name, an HTTP status, a quota number or a spend figure.

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

`evaluateSentinelPolicy` is closed in three separate ways: the frozen category array, the
`strictObject` intent schema, and the branch ladder that ends in `DENY_DEFAULT`. Adding a string to
the array is therefore not enough — a new category falls past step 8 (`isSafeMockActionCategory` is
false) into step 9 and is denied. The change is:

1. Add `'model.infer'` to `SENTINEL_ACTION_CATEGORIES` (still a closed, frozen array).
2. Bump `SENTINEL_POLICY_VERSION` to `2`, so a policy written for version 1 fails
   `DENY_POLICY_VERSION_MISMATCH` instead of silently authorizing a category it never knew about.
3. Insert one branch **after** the step-6 hard denies and **before** step 7 (external mutation):

   ```text
   if (category === 'model.infer') {
     if (!APPROVED_MODEL_PROVIDERS.includes(intent.providerId)) -> deny, DENY_MODEL_PROVIDER_NOT_APPROVED
     if (policy.allowedActions.includes('model.infer'))         -> allow, ALLOWED_MODEL_INFER
     else                                                       -> deny, DENY_MODEL_ACTION_DISALLOWED
   }
   ```

4. Two new reason codes, and `SentinelIntentSchema` gains **one optional** field `providerId`
   (`max(32)`, `^[a-z][a-z0-9._-]*$`), still `strictObject`.

`APPROVED_MODEL_PROVIDERS` is a deep-frozen constant in code, not an environment variable. Adding a
provider becomes a code review, a version bump and a test — not a config change at 3 a.m.

**The `runId` problem (F-2), stated plainly.** `SentinelIntentSchema` requires `runId` as a UUID, and a
conversation turn is not a Task and has no run (B1 §7.4: a turn "carries no execution semantics").
Three ways out, and only one is acceptable:

| Option                                                                                        | Verdict                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Fabricate a run row per turn                                                                  | **Rejected** — invents execution records for a non-execution concept and pollutes every run-count metric |
| Grant the turn `credential.use` / `network.egress`                                            | **Rejected** — that is exactly the bypass this proposal exists to prevent                                |
| Add a turn-scoped intent variant, discriminated by a required `subjectKind` (`run` or `turn`) | **Proposed**                                                                                             |

The third keeps one evaluator and one policy, and the discriminator is _required_ so an intent can
never be ambiguous. It is also the change that most needs the contract owner's review, because it
touches the module everything else trusts. If the CTO prefers, B2 can instead be gated behind a `run`
created solely to host the turn — but that is a worse model of the system and should be an explicit
decision, not an implementation detail.

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

`EMBER_MODEL_EXECUTION` is one of `disabled`, `fake`, `real`, default `disabled`. Boot rules:

| Mode       | Key present | Sentinel allows `model.infer` | Result                                                                    |
| ---------- | ----------- | ----------------------------- | ------------------------------------------------------------------------- |
| `disabled` | any         | any                           | start; gateway is the fake; no egress path is even constructed            |
| `fake`     | any         | any                           | start; fake adapter; exercises the full gate chain with zero cost         |
| `real`     | no          | —                             | **refuse to start** (`POLICY_DENIED` at boot, with a content-free reason) |
| `real`     | yes         | no                            | **refuse to start**                                                       |
| `real`     | yes         | yes                           | start, and only then can a turn reach a provider                          |

There is no row in that table that degrades `real` into `fake`. A process that was configured for real
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

### 7.2 What "per user" means until #91 lands

This is the CTO's point 5, and the honest answer is a limitation, not a design. `AuthContext` today
carries `tenantId`, `principalId` and `policyVersion` and nothing else, and the only authenticator is
the dev bearer one. So:

- the per-user ceiling is keyed on `principalId`, scoped by tenant;
- for the current dev fixture tenant and principal are 1:1, which means the per-user ceiling is
  **untested against a real multi-user tenant** until #91 provisions accounts;
- storage is `(tenant_id, scope_kind, scope_id)` with `scope_kind IN ('tenant','principal')`, so adding
  `'consumer'` is one `CHECK` change later plus one constant — not a data migration;
- if #91 decides the consumer is not the principal, the per-user ceiling follows the consumer and the
  principal-scoped rows remain history that is still auditable.

I will not claim the per-user ceiling is proven. It is implemented against the only identity the
platform currently has, and it is labelled as such in the code and in the runbook.

### 7.3 Migration `0014` (sketch, not written)

Three tables, all B2-owned, none altering a B1 object.

```sql
-- 0014_model_execution.sql  (PROPOSED)
CREATE TABLE model_turn_attempts (
  tenant_id      uuid    NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  turn_id        uuid    NOT NULL,
  attempt_no     integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 2),
  state          text    NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  outcome_code   text    CHECK (outcome_code IN (
                   'ok', 'model_timeout', 'model_unavailable', 'model_rate_limited',
                   'model_auth_failed', 'model_invalid_output', 'client_cancelled')),
  input_tokens   integer CHECK (input_tokens  >= 0),
  output_tokens  integer CHECK (output_tokens >= 0),
  cost_micro_usd bigint  NOT NULL CHECK (cost_micro_usd >= 0),
  rate_version   text    NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  PRIMARY KEY (tenant_id, turn_id, attempt_no),
  CONSTRAINT settled_iff_timestamp CHECK ((state = 'settled') = (settled_at IS NOT NULL))
);

CREATE TABLE model_spend_days (
  tenant_id          uuid   NOT NULL,
  scope_kind         text   NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id           uuid   NOT NULL,
  utc_day            date   NOT NULL,
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd bigint NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  request_count      integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (tenant_id, scope_kind, scope_id, utc_day),
  CONSTRAINT consumption_within_reservation CHECK (consumed_micro_usd <= reserved_micro_usd)
);

CREATE TABLE model_spend_operations (
  tenant_id          uuid   NOT NULL,
  operation_id       uuid   NOT NULL,   -- stable: derived from (turn_id, attempt_no)
  scope_kind         text   NOT NULL CHECK (scope_kind IN ('tenant', 'principal')),
  scope_id           uuid   NOT NULL,
  utc_day            date   NOT NULL,
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd bigint CHECK (consumed_micro_usd >= 0),
  state              text   NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  expires_at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT settle_within_reservation CHECK (
    consumed_micro_usd IS NULL OR consumed_micro_usd <= reserved_micro_usd)
);
```

Locking follows `0006`'s proven order: `pg_advisory_xact_lock('ember.model_spend', tenant_id)` → turn
row → spend rows; a settle touches one operation row and one bucket. Two constraints carry the money —
`consumption_within_reservation` and `settle_within_reservation` — so a bug that over-settles becomes
a constraint violation instead of an overage.

**Coordination item CR-2.** The `model_turn_attempts` → `assistant_turns` foreign key wants
`UNIQUE (tenant_id, id)` on a B1-owned table, which is the house style
(`0003_tasks_current_run_tenant_fk.sql`). If B1 does not expose it, B2 uses a single-column FK plus an
explicit tenant predicate on every query and records the weaker guarantee in the migration comment.
Either answer is acceptable; the decision belongs to the B1 owner.

### 7.4 Ceilings, and which one binds first

| Scope                  | Limit    | Why that number                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| per turn               | $0.005   | ~2.8× the worst-case turn in §8.2                                        |
| per task (B3)          | $0.005   | ~3× the worst-case task in §8.2                                          |
| per user, per day      | 60 turns | well under B1's 200 messages/day (S-5), so volume is capped before money |
| per user, per day      | $0.25    | 60 × worst-case turn = $0.11, so the request cap normally binds first    |
| per tenant, per day    | $1.00    | a four-person shared tenant at full tilt                                 |
| global, per day        | $5.00    | the platform's actual financial stop: $150/month worst case              |
| per user, per day (B3) | 20 tasks | a separate counter, so a note-heavy user cannot starve chat              |

The intent: **volume binds before money** for a normal user, money binds for a pathological one. A user
who hits the request cap sees a normal failure, not a surprise invoice.

### 7.5 Fixing the settlement defect (F-4) rather than inheriting it

`runBudgetedStep` settles the **full reservation** (`apps/worker/src/durable-run-handler.ts:352`),
which is right for simulated work units and wrong for tokens. B2 does not change that function's
behaviour for existing kinds; it adds an optional `consumedFor(value)` hook that the model path uses
and every other kind ignores. The hook is clamped to the reservation so the `CHECK` cannot be
violated, and a `consumedFor` that returns more than the reservation settles the reservation and
records the overflow in telemetry — a bug that must be visible, not silently absorbed.

### 7.6 Stopping spend

Four independent stops, cheapest first: per-request ceilings (§7.4) → per-scope daily counters → the
per-tenant `model.infer` policy grant (removing it denies at L1 on the next turn) →
`EMBER_MODEL_EXECUTION=disabled` (a restart, and the only stop needing no database access). A runtime
flag row that stops spend **without** a deploy is proposed as PR B2-6, not assumed here.

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

The envelope comes from `MODEL_LIMITS` (§6.1), not from optimism. Tokens at 4 chars/token, rounded up.

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

Every ceiling in §7.4 is derived as `k × worst-case unit cost`, and every stored cost is
`(inputTokens × r_in + outputTokens × r_out) / 10^6` computed from a **versioned rate row**
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

### 10.1 How it happens

The window is unavoidable in any design that is not a distributed transaction with the provider: the
provider completes the work and bills it, and the process dies before the reply is committed. A retry
then pays twice for one user message.

### 10.2 What bounds it

| Mechanism                                                                     | Effect                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Attempt row + spend reservation written **before** the request (§4.4 step 10) | a crash still consumes quota; the crash cannot be "free"                                    |
| `PRIMARY KEY (tenant_id, turn_id, attempt_no)` with `attempt_no ≤ 2`          | at most two paid calls per user message, enforced by the database rather than by code paths |
| Terminal commit in one transaction (B1 T-2)                                   | the successful attempt publishes exactly one reply; a duplicate reply is impossible         |
| T-1 sweeper at 60 s                                                           | an orphaned `running` turn becomes `failed` / `timeout`; it never retries forever           |
| Cost reported from **attempts**, not turns                                    | the ledger cannot under-report; a duplicate is visible as `attempt_no = 2`                  |

Worst case is therefore **2× the per-turn ceiling** for one message ($0.010), which is the multiple the
per-user-day money ceiling in §7.4 is set with.

### 10.3 What is deliberately not done

No idempotency key is sent to the provider. Providers do not offer a general "do not bill a duplicate"
guarantee, so the key would create the appearance of exactly-once billing without the substance. A
bounded duplicate that is documented, priced and observable is a better contract with the reader than a
mechanism that does not exist.

### 10.4 The B3 form of the same risk

A retried `infer` step can re-bill a provider call; the step's idempotency key protects the _artifact_,
not the _invoice_. Same mitigation, plus `max_attempts = 2` for this kind (§5.4). The artifact write is
idempotent and immutable, so a duplicate attempt yields the same artifact and one extra paid call —
never two artifacts.

## 11. Test plan (what must be green before any `real` mode)

| #   | Test                                           | Asserts                                                                                          |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T1  | sentinel unit: `model.infer` matrix            | provider allowlist checked before policy; a version-1 policy is denied                           |
| T2  | sentinel unit: no widening                     | `network.egress`, `host.exec`, `credential.use` still hard-denied under a `model.infer` grant    |
| T3  | gateway unit: config validation                | placeholder key, empty key, unknown provider, `real` without key ⇒ constructor throws            |
| T4  | gateway unit: origin constants                 | exactly one origin, no redirects, no proxy env, request body shape frozen                        |
| T5  | gateway unit: error taxonomy                   | each provider response class maps to the intended closed code; no key in any message             |
| T6  | worker integration: happy path (fake)          | turn `running` → `completed`, one `ember` message, `simulated: true`, one attempt row            |
| T7  | worker integration: real-mode refusal          | `real` without a key ⇒ process refuses to start; no turn is ever completed by the fake           |
| T8  | worker integration: attempt cap                | a second failure finalizes `failed`; no third call is attempted                                  |
| T9  | worker chaos: kill between response and commit | turn stays `running`, sweeper closes it, exactly 2 attempts, spend = 2× one call                 |
| T10 | ledger integration: ceilings                   | over-cap denies **before** any gateway call (asserted with a throwing spy gateway)               |
| T11 | ledger integration: settle clamp               | `consumedFor` > reservation settles the reservation and flags the overflow                       |
| T12 | privacy: content-free output                   | no log line, error or event contains message text (scan of captured output)                      |
| T13 | truthfulness                                   | a real adapter's `model_label` never matches `/-(fake\|echo)-/`; `simulated` matches the adapter |
| T14 | B3 migration: fail-closed                      | unknown kind, unknown payload key, unknown error code still rejected by `0002`'s function        |
| T15 | B3 integration: artifact                       | typed JSON matches the schema, is immutable, `task_results` is `unavailable` with a reason code  |

T10 and T11 are the two that would otherwise be discovered by a bill.

## 12. PR sequence

Order is dependency order. Every PR is independently revertable, and **exactly one of them (B2-5) can
spend money** — and only while `EMBER_MODEL_EXECUTION=real`, which no environment sets.

| PR   | Scope                                                                                                                         | Depends on           | Gate                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| B2-0 | this document + the audit (docs only)                                                                                         | —                    | CTO review; no code                                                          |
| B2-1 | Sentinel: `model.infer` category, policy v2, turn-scoped intent variant, reason codes, unit tests. **Dark: no caller exists** | D-1, D-2             | T1, T2                                                                       |
| B2-2 | `packages/model-gateway`: types, config validation, `FakeModelGateway`, error taxonomy. No HTTP client                        | B2-1                 | T3, T5, T13                                                                  |
| B2-3 | Migration `0014` + repositories (attempts, spend days, spend operations)                                                      | B2-1, CR-2 answered  | `migrations.test.ts`, T10, T11                                               |
| B2-4 | `ModelTurnResponder`, claim loop, boot rules, sweeper integration. `real` mode refuses to start                               | B2-2, B2-3, B1-5     | T6, T7, T8, T9, T12                                                          |
| B2-5 | `OpenAiModelGateway` adapter: one origin, one call, 20 s deadline. Merged **dark**                                            | B2-4, approval A1–A5 | T4, T5; `model:smoke:local` refuses without an explicit acknowledgement flag |
| B2-6 | Runtime kill switch + usage/cost report command + runbook page                                                                | B2-5                 | operator dry run                                                             |
| B3-1 | Migration `0015`: kind + payload allowlist + two error codes, fail-closed tests                                               | B2-4, D-4            | T14                                                                          |
| B3-2 | `extractActionItems` + `infer` step + artifact + `task_results` `unavailable` write                                           | B3-1                 | T15                                                                          |
| B3-3 | iOS surfacing of the artifact through existing card rendering                                                                 | B3-2                 | iOS lead owns this PR                                                        |

B2-1 through B2-3 change no observable behaviour on their own: no route changes, no turn completes
differently, and `main`'s test suite is the proof. That is deliberate — the risky part (B2-4/B2-5)
lands on top of infrastructure that is already green.

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

### 14.4 Open questions I cannot answer from the repository

| ID   | Question                                                                                       | Why it blocks                                                      |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| OQ-1 | Does #91 make the consumer the same object as `AuthContext.principalId`?                       | decides whether §7.2's interim keying is permanent or superseded   |
| OQ-2 | Does the B1 owner accept CR-2 (`UNIQUE (tenant_id, id)` on `assistant_turns`)?                 | decides whether B2 gets a composite FK or a weaker guarantee       |
| OQ-3 | Is T-1's 60 s turn budget meant to include provider latency, or is it a ceiling to stay under? | 20 s is comfortable either way, but the sweeper's clock must agree |
| OQ-4 | Should the message quota (S-5, 200/day) and the turn cap (60/day) be reconciled?               | two caps on one action confuse users and support                   |
| OQ-5 | May `notes.action_items` be created without transcript linkage?                                | decides whether B3 can exist before B1-6                           |

### 14.5 What to review first

1. §6.3 (C2) — the turn-scoped intent, because it touches the module everything else trusts.
2. §6.4 — that `model.infer` is a _narrower_ category, not a widening of the three Round-1 denials.
3. §7.1 and §7.2 — that per-tenant and per-user are genuinely independent, and honestly labelled.
4. §8.1 — that the prices are unverified, and that fact is visible rather than buried.
5. §5.1 item 3 — that B3 needs no widening of `task_results`, because B1's X-4 already allows it.

## Appendix A — file inventory per PR (none of these exist yet)

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

No file in this appendix has been created, and `docs/` is the only directory this PR touches.

---

Status: **PROPOSED**. No executable change, no dependency, no secret, no migration file, no provider
contact. Implementing B2 requires D-1 (the #91 ADR) plus approval of §14.1–§14.3. Implementing B3
additionally requires B1-6/B1-7 and §14.3 C4.
