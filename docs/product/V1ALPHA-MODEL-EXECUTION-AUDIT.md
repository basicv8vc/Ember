# V1 Alpha — Model Execution Audit (technical and security findings)

| field                    | value                                                    |
| ------------------------ | -------------------------------------------------------- |
| status                   | **audit — findings current; superseded as a plan**       |
| superseded by            | `docs/product/V1ALPHA-B2-B3-MODEL-EXECUTION-PROPOSAL.md` |
| base commit of audit     | `154860a` (`main` HEAD when audited)                     |
| latest migration on base | `0010_p0c3d_consent.sql`                                 |
| original framing         | Notes → Action Items as the first capability             |

## Document status (read this before the rest)

This file is the **audit of record**. Its findings — the database vocabulary traps, the Sentinel
analysis, the budget/settlement defect, the failure-semantics review — are unchanged and remain the
basis for the phased plan. Three things about it are superseded by the CTO decision of 2026-11-03 and
by the B2-first proposal:

1. **Ordering.** The capability is not first. **B2 (real assistant turn) precedes B3
   (`notes.action_items`)**, which becomes a capability _invoked from Chat_, never the app home.
2. **Migration numbering.** This file says "next slot `0011`". The B1 platform contract (PR #92,
   §11) reserves `0011`–`0013`. Model execution therefore takes `0014`, and B3 takes `0015`.
3. **Sections that are history, not instruction.** §5 (design), §6 (cost model), §8.6, §9 (PR
   sequence) and §11 (approval checklist) describe the earlier single-capability shape. Do **not**
   implement from them. The current plan is the B2/B3 proposal; where the two disagree, the proposal
   wins and this file is stale on that point.

Everything in §1–§4, §7, §8.1–§8.5, §10 and the appendix is the audit itself and is current.

## 0. Decision requested

Approve, modify or reject four things before any code lands:

1. **A new task kind** `notes.action_items` rather than overloading `mock.chat` (§5.1).
2. **A new Sentinel category** `model.infer`, deny-by-default (§4.1).
3. **A candidate provider + price ceiling** (§6) — the provider name below is a
   _recommendation_, not an authorisation.
4. **A 6-PR sequence** where the kill switch ships first and the real provider adapter
   ships dark (§9).

Nothing in this document has been executed. No branch has been pushed, no provider
account contacted, no key provisioned.

---

## 1. Scope

**In scope (V1 Alpha):** one synchronous, single-shot, no-tools transformation. A user
submits notes (plain text, ≤ 8 000 chars) as a durable Task; a worker calls exactly one
server-side model; the worker publishes one bounded JSON artifact; the client reads the
result through the existing authenticated API.

**Out of scope, deliberately:**

| excluded                                     | why                                                            |
| -------------------------------------------- | -------------------------------------------------------------- |
| chat / multi-turn / streaming tokens         | makes every limit unbounded; not the capability                |
| tool calls, browsing, retrieval, connectors  | each is a separate egress + Sentinel review                    |
| owner / due-date / priority inference        | we cannot verify it; unverifiable fields read as authoritative |
| client-chosen model, temperature, max tokens | all server-fixed; the client sends notes and nothing else      |
| image/PDF input, OCR                         | new ingress, new size limits, new content-type surface         |
| persistence of prompt text anywhere          | §5.8                                                           |
| per-item regeneration                        | a second spend path without a second approval                  |

---

## 2. What the audit found (and what we reuse instead of rebuilding)

The durable pipeline is already the exact shape this capability needs. We add **no new
transport, no new store, no new scheduler** — we add one step inside an existing state
machine.

| need                                            | already exists                                                                                                       | file:line                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| durable task, lease fencing, epoch, heartbeat   | `PostgresLeaseQueue` + `RunGrant`                                                                                    | `packages/postgres/src/lease-queue/postgres-lease-queue.ts`                           |
| task event stream + SSE                         | `appendTaskEvent`, poll/replay, 15 s heartbeat                                                                       | `apps/api/src/tasks/event-stream.ts`, `apps/api/src/tasks/routes.ts`                  |
| artifact bytes + SHA-256 + authenticated read   | `BlobStore` stage/install, `MAX_BLOB_BYTES = 33 554 432`                                                             | `packages/postgres/src/storage/artifact-store.ts`, `apps/api/src/artifacts/routes.ts` |
| atomic "publish result once"                    | `PostgresRunResultCommitter.commitStep` (artifact + workspace CAS + checkpoint + event + receipt in one transaction) | `packages/postgres/src/storage/result-committer.ts`                                   |
| crash-safe replay                               | step checkpoints keyed by `stepId` + `inputDigest` + executor version                                                | `apps/worker/src/durable-run-handler.ts`                                              |
| bounded retry                                   | `planRetry` + `task.max_attempts` (default 3)                                                                        | `packages/postgres/src/lease-queue/retry-policy.ts:40`, `migrations/0002:83`          |
| per-tenant daily quota, deny-before-side-effect | `BudgetLedger.reserve/settle/release`                                                                                | `packages/postgres/src/storage/budget-ledger.ts`                                      |
| cooperative cancellation                        | `AbortSignal` + `assertStepLive` re-read                                                                             | `apps/worker/src/durable-run-handler.ts`                                              |
| worker log hygiene                              | `WorkerLogger` w/ allowlisted fields                                                                                 | `apps/worker/src/logger.ts`                                                           |

Current simulated boundary, which this kind simply does not use:
`packages/execution/src/deterministic-executor.ts` (`SimulatedExecutor`, `simulated: true`,
`durable: false`). It is **not modified** — the four `mock.*` kinds keep executing through it
byte-for-byte as today.

---

## 3. Non-negotiable invariants for this capability

1. **No egress before approval.** Default build has no network code path reachable: the
   worker is constructed with a fake gateway unless `EMBER_MODEL_EXECUTION=real`.
2. **Deny before spend.** Every refusal (kill switch, quota, ceiling, oversized input,
   Sentinel) happens _before_ the provider call.
3. **Publish at most once.** Duplicate publication is impossible by transaction, not by
   discipline. Duplicate _provider_ calls are possible and are bounded + priced (§7.3).
4. **Bounded everything.** Input chars, output tokens, item count, item length, wall-clock
   timeout, attempts, cost — each has a hard ceiling enforced server-side, not by prompt.
5. **No prompt or note text leaves the worker process except to the approved provider** —
   not into logs, not into events, not into error DTOs, not into the artifact.
6. **The mock path stays mock.** `mock.*` kinds never reach the gateway; the gateway is
   reachable from exactly one kind, enforced by construction and by test.

---

## 4. Five hard constraints the audit exposed

These are the reasons this cannot be a one-file change. Each is load-bearing; each is
listed with the exact mechanism so the reviewer can verify it.

### 4.1 The Sentinel action matrix cannot admit a real model call

`packages/execution/src/sentinel-lite.ts:115-141` defines a **closed** category set and
reason-code set. `network.egress`, `host.exec` and `credential.use` are hard-denied
(`DENY_HIGH_RISK_EGRESS` / `_EXEC` / `_CREDENTIAL`), and anything unrecognised gets
`DENY_UNKNOWN_ACTION`. A real provider call is simultaneously `network.egress` **and**
`credential.use`.

Consequences:

- Real inference is currently **impossible by construction** — good, that is the correct
  starting state.
- It therefore cannot be enabled by relabelling `mock.chat` → `mock.compute`. Doing so
  would launder egress through a mock label, which is precisely the "new task kind to slip
  past the closed action matrix" failure mode the P0-C3 contract freeze warns about.
- We must add exactly one category, `model.infer`, with its own reason codes
  (`ALLOWED_MODEL_INFER`, `DENY_MODEL_INFER_DISABLED`, `DENY_MODEL_INFER_BUDGET`,
  `DENY_MODEL_INFER_NOT_APPROVED`), and it must be **absent from the default allowlist** so
  that flipping the env flag alone is not sufficient: the policy object must also list it.

### 4.2 The database — not the application — owns the kind and event vocabularies

Two checks make the contract change a migration, and both fail closed:

- `migrations/0002_durable_task_inbox.sql:63-64` —
  `kind IN ('mock.chat','mock.compute','mock.file','mock.approval')`.
- `migrations/0002_durable_task_inbox.sql:141` `ember_task_event_payload_is_valid(payload jsonb)` —
  a per-key `CASE` that **whitelists payload keys** (`ELSE RETURN false`), re-lists the four
  kinds, and re-lists all 15 `errorCode` values.

So adding a kind, an error code, or a single new event field is rejected by the database
until `0011` replaces that function. This is a feature: no service can emit an unreviewed
payload. It also means every field proposed in §5.7 must be justified individually,
because each one is a permanent DB-level contract.

### 4.3 The budget ledger is per-tenant only — there is no global ceiling

`packages/postgres/src/storage/budget-ledger.ts` aggregates per `(tenantId, UTC day)`. It
has no cross-tenant counter and its units are explicitly _simulated work units_, not
currency (`docs/P0B-08A-BUDGET-GUARD.md`). A "global spend ceiling" is therefore **not
implementable by configuration** — it needs one new, narrow table (§5.5).

### 4.4 `runBudgetedStep` settles the full reservation, not actual usage

`apps/worker/src/durable-run-handler.ts:345-402` settles `consumed: cost` — the reserved
amount — on every non-replay outcome. For a model call whose cost is token-dependent, this
either over-charges (reserve worst case) or under-charges (reserve typical). The
reservation must stay worst-case (§3.4) and the settle must become actual, clamped to the
reservation. The DB already enforces the clamp:
`CONSTRAINT budget_operations_settlement_within_reservation`
(`migrations/0006_p0b08b_persistent_budget.sql:76`), so a bad settlement is rejected rather
than silently over-spending.

### 4.5 The event payload allowlist has no place for usage or cost

`packages/domain/src/types.ts` `TaskEventPayload` is a strict, closed schema of
enum/UUID/int/bool fields, and `simulated` is already present. There is no field for
`inputTokens`, `outputTokens` or `costMicroUsd`. Because of §4.2, adding them requires a
contract change **and** a migration. Recommendation: add the three integers and add **no**
strings — provider and model identity stay in the worker log and the result artifact,
never in the client event stream.

---

## 5. Proposed design

### 5.1 Task contract — a new kind, not a relabelled mock

```ts
// packages/domain/src/types.ts
TASK_KINDS = [...existing, 'notes.action_items'] as const;

// packages/contracts/src/task-schemas.ts  (strict object, no extra keys)
NotesActionItemsInput = {
  notes: string;            // 1..8_000 chars, NFC, not whitespace-only
}
```

Why a new kind instead of reusing `mock.chat`:

| reason            | detail                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| honesty in the UI | iOS already persists a **mock disclosure** for `mock.chat` (`a359498`, `7a7a679`). A real result must never inherit it, and a mock result must never be presented as real. Distinct kinds keep the disclosure truthful with zero client heuristics. |
| input shape       | `mock.chat` accepts an open prompt (a general chat surface). `notes.action_items` accepts notes only, under its own limit.                                                                                                                          |
| blast radius      | the gateway is reachable from one kind only (§3.6); a `mock.*` label must not become a route to the network.                                                                                                                                        |
| budget            | a distinct kind gets a distinct reservation plan and a distinct `max_attempts`.                                                                                                                                                                     |

Deliberately **not** in the input: `maxOutputTokens` (server-fixed), `model`, `temperature`,
an expected item count, or any `tenantId`/`principalId` (already rejected by the strict
schema).

`CreateTaskRequestSchema` stays a discriminated union over `kind`; `max_attempts` for this
kind defaults to **2** (one retry) at creation, not the platform default of 3.

### 5.2 Result artifact — bounded, verifiable, boring

`application/json`, published at `results/<taskId>.json` (passes
`normalizeWorkspacePath`), one object, at most one level of array nesting:

```ts
interface NotesActionItemsResult {
  schemaVersion: 1; // literal
  taskId: string; // must equal the task it is published for
  generatedAt: string; // ISO-8601 UTC
  simulated: boolean; // true ⇒ produced by FakeModelGateway
  truncated: boolean; // provider hit max_output_tokens or the item cap
  notesChars: number; // ≤ 8000; echoes input *size* only, never input
  usage: { inputTokens: number; outputTokens: number }; // non-negative ints
  model: { provider: 'openai'; modelId: string }; // from server config
  actionItems: { text: string }[]; // ≤ 20 items, text 1..280
}
```

Rules:

- The worker **parses the provider output against this exact schema** and rejects on any
  mismatch → `MODEL_REJECTED` (terminal). No partial acceptance, no coercion, no salvage.
- `actionItems` may be empty. "No action items found" is a valid answer; we do not invent
  items to look productive.
- Each `text` is plain text; the client renders it, never executes it. Control characters
  and markup are stripped with the existing artifact sanitisation.
- Serialised size is bounded by construction (20 × 280 + envelope ≈ 6 KB), far below
  `MAX_BLOB_BYTES`.

**No `owner`, no `due`, no `priority`, no confidence score.** They are unverifiable, they
read as authoritative once rendered, and adding them later is a schema-version bump rather
than a breaking change.

### 5.3 Model gateway boundary

New package `packages/model-gateway`. It is a **capability gateway, not a provider
abstraction**: one port, one operation, one provider at a time. No `chat()`, no `tools`, no
`stream`, no caller-supplied `model`, no fallback chain, no multi-provider router. A second
capability requires a new review, not a new parameter.

```ts
export interface ModelGateway {
  readonly mode: 'disabled' | 'real';
  generateActionItems(
    request: ActionItemsRequest, // { notes, taskId, runId, attempt, inputDigest }
    signal: AbortSignal, // worker cancellation + timeout
  ): Promise<ActionItemsGeneration>; // { result, usage, latencyMs }
}
```

Fixed at construction from server-side config only, never from the request:

| knob                                | value for alpha                 | enforcement                                                        |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| input chars                         | 8 000                           | re-checked on the exact string handed to the provider              |
| `max_output_tokens`                 | 512                             | request field, not a prompt instruction                            |
| wall clock                          | 20 000 ms                       | `AbortSignal.timeout` plus provider timeout, whichever fires first |
| response format                     | JSON schema (structured output) | validated again on receipt (§5.2)                                  |
| tools / function calling / browsing | **omitted entirely**            | absent from the request type                                       |
| provider-side retention (`store`)   | `false` where supported         | explicit request field                                             |
| retries inside the gateway          | **none**                        | retrying is the worker's job (§5.4)                                |

Two implementations, selected once at worker startup:

- `FakeModelGateway` — deterministic, no network, derives items from a digest of the notes.
  Used by **100 % of tests** and by every build where `EMBER_MODEL_EXECUTION=disabled`.
- `OpenAiModelGateway` — real HTTP. Constructed only when the switch is `real` **and** a key
  is present; if either is missing the process refuses to start rather than silently
  degrading to fake (`POLICY_DENIED` at boot beats a silent downgrade).

Credential access is a single injected `ModelApiKeyResolver` reading one worker env var. It
is deliberately **not** the P0-C2 `CredentialBroker` (that broker is synthetic and
network-less); the broker is left untouched and this narrow path gets its own review.

### 5.4 Worker integration boundary

One new step id, `infer`, inserted where `produce` runs today for `mock.*` kinds
(`apps/worker/src/durable-run-handler.ts`). The kind routes to exactly one branch: a
`switch` over `DURABLE_TASK_KINDS` gains one case, and the existing branch stays
byte-identical for the other four kinds.

Ordering inside the step — every refusal precedes every side effect:

```text
1  contextReader.read(run, now)              → STALE_LEASE / NOT_FOUND / cancellation / deadline
2  assertStepLive()                          → CANCELLED
3  sentinel.evaluate(model.infer)            → POLICY_DENIED (category must be allowlisted)
4  gateway.mode === 'real' ? proceed : deny  → POLICY_DENIED (kill switch, §5.6)
5  validate input (chars, NFC)               → INVALID_ARGUMENT
6  modelSpend.reserve(tenant day, global day)→ BUDGET_EXCEEDED   ┐ reserved worst case
7  budget.reserve(infer units)               → BUDGET_EXCEEDED   ┘
8  checkpoint lookup by inputDigest          → hit ⇒ skip 9-10, reuse artifact (no spend)
9  gateway.generateActionItems(notes, signal)→ MODEL_UNAVAILABLE / MODEL_REJECTED / EXECUTION_TIMEOUT
10 parse + validate result schema            → MODEL_REJECTED
11 modelSpend.settle(actual µUSD) ; budget.settle(actual units, clamped)
12 blobStore.stage → commitStep(publish artifact + workspace CAS + event)
```

A denial at step 6 writes nothing at all; a denial at step 7 releases the reservation taken at
step 6, because no call started. Nothing is ever refunded once step 9 has begun — that is the
existing `runBudgetedStep` rule, kept intact.

Two changes to shared code, both small and both forced by §4.4:

- `runBudgetedStep` gains an optional `consumedFor(value) => amount`, used only by `infer`,
  so settlement is actual cost rather than the reservation. Absent ⇒ today's behaviour.
- `budget-plan.ts` gains an `infer` entry: worst-case units derived from the token caps,
  `elapsedMs: 20_000`, one concurrency slot.

Checkpoint / replay semantics (this is where the money is protected):

- The step writes a checkpoint carrying `inputDigest` and executor version
  `notes-action-items@1`. On resume, a matching committed checkpoint means the artifact is
  reused and **the provider is not called again**. Crash-after-publish therefore costs
  nothing.
- A crash _after_ the provider responded but _before_ publication cannot be de-duplicated at
  the provider (a new attempt carries a new `leaseEpoch`, so a provider-side idempotency key
  would differ). §7.3 states this plainly instead of papering over it: we guarantee
  at-most-once **publication**, plus bounded duplicate spend of ≤ `max_attempts` × worst-case
  per-call cost, all of which is counted against the ceilings.

Retry classification — one new terminal code, one new retryable code (§4.2 requires the
migration to carry both):

| provider outcome               | domain code                         | worker action                        |
| ------------------------------ | ----------------------------------- | ------------------------------------ |
| 429, 5xx, connect/DNS failure  | `MODEL_UNAVAILABLE` (bounded_retry) | retry while attempts remain          |
| client timeout / abort at 20 s | `EXECUTION_TIMEOUT` (existing)      | retry while attempts remain          |
| 4xx other than 429             | `MODEL_REJECTED` (not_retryable)    | terminal                             |
| refusal / safety block         | `MODEL_REJECTED` (not_retryable)    | terminal                             |
| schema mismatch                | `MODEL_REJECTED` (not_retryable)    | terminal                             |
| cancellation mid-call          | `CANCELLED` (existing)              | terminal; settled, nothing published |

`MODEL_UNAVAILABLE` and `MODEL_REJECTED` are added to `DOMAIN_ERROR_CODES`,
`PUBLIC_MESSAGES` (fixed safe text), `DEFAULT_DIAGNOSTICS`, `RETRYABILITY`, the contracts
error schema and the `0011` payload function — six touch points, all enumerated by the
compiler.

### 5.5 Spend accounting and ceilings — new, narrow, currency-denominated

The existing ledger answers "did this tenant consume its simulated work units?" It cannot
answer "how many dollars has the platform spent today?" (§4.3). Add one table pair and one
ledger that mirrors the existing reserve/settle shape, so the reviewer is reading a familiar
algorithm:

```sql
CREATE TABLE model_spend_days (
  scope_kind          text    NOT NULL CHECK (scope_kind IN ('tenant','global')),
  scope_id            text    NOT NULL,            -- tenant uuid, or 'global'
  utc_day             date    NOT NULL,
  reserved_micro_usd  bigint  NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd  bigint  NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  request_count       integer NOT NULL DEFAULT 0 CHECK (request_count      >= 0),
  PRIMARY KEY (scope_kind, scope_id, utc_day),
  CONSTRAINT model_spend_consumed_within_reserved
    CHECK (consumed_micro_usd <= reserved_micro_usd)
);

CREATE TABLE model_spend_operations (
  operation_id       text PRIMARY KEY,             -- '<runId>:infer:<leaseEpoch>'
  scope_kind         text NOT NULL, scope_id text NOT NULL, utc_day date NOT NULL,
  reserved_micro_usd bigint NOT NULL,
  consumed_micro_usd bigint NULL,
  state              text NOT NULL CHECK (state IN ('reserved','settled','released')),
  created_at         timestamptz NOT NULL,
  settled_at         timestamptz NULL
);
```

Reservation is one transaction, tenant row then global row, serialised per day with
`pg_advisory_xact_lock('ember:model-spend:<utcDay>')` — the same advisory-lock idiom the
lease queue already uses, exercised by `tests/integration/support/advisory-locks.ts`.
A denial writes nothing and throws `BUDGET_EXCEEDED` (existing code), so the client-facing
quota error stays stable.

Four ceilings, all checked **before** the call:

| ceiling                   | env var                                | initial value     | rationale                                                |
| ------------------------- | -------------------------------------- | ----------------- | -------------------------------------------------------- |
| per task                  | `EMBER_MODEL_PER_TASK_MAX_MICRO_USD`   | 5 000 ($0.005)    | ≈ 8× worst-case cost; catches a runaway prompt           |
| per user (tenant) per day | `EMBER_MODEL_TENANT_DAY_MAX_MICRO_USD` | 200 000 ($0.20)   | ~130 tasks/day; a user cannot burn the budget by looping |
| global per day            | `EMBER_MODEL_GLOBAL_DAY_MAX_MICRO_USD` | 2 000 000 ($2.00) | hard blast radius; ≈ $60/month absolute worst case       |
| requests per user per day | `EMBER_MODEL_TENANT_DAY_MAX_REQUESTS`  | 20                | rate limit independent of price                          |

`request_count` increments on reservation, so a burst of cheap-but-numerous calls is capped
even when the dollar total is small.

### 5.6 Kill switch

Two tiers, shipped separately, because "a switch that needs a deploy" and "a switch that
works in five seconds" are different promises:

| tier                | mechanism                                                                                                                   | latency            | ships in        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------- |
| **1 (alpha)**       | `EMBER_MODEL_EXECUTION` ∈ {`disabled`,`real`}, default `disabled`, read once at worker boot; gateway is constructed from it | one worker restart | PR-2            |
| **2 (before beta)** | `model_runtime_flags.enabled` row, read per call with a 2 s in-process TTL, failures treated as **disabled**                | ≤ ~2 s             | PR-7 (optional) |

Fail-closed rules that are not negotiable:

- `disabled` ⇒ `FakeModelGateway` is injected; the real adapter is never constructed and no
  socket is opened. This is the default in `.env.example`, in CI, and in every test.
- `real` with no key, or `real` without the Sentinel category allowlisted ⇒ worker refuses
  to start (`POLICY_DENIED` at boot). It never silently downgrades to fake, because a silent
  downgrade is how a "mock" result gets shipped as a real one.
- Flipping to `disabled` **during** an in-flight call does not cancel that call; it prevents
  the next one. In-flight aborts are the cancellation path (`CANCELLED`), not the switch.
- The switch never grants capability on its own: Sentinel must also allow `model.infer`
  (§4.1), so two independent server-side conditions must both hold.

### 5.7 Client-visible result: one typed read, no new store

Four routes, all authenticated and tenant-scoped by the existing `/v1` middleware (three
already exist; only the last is new):

| route                             | state                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/tasks/:taskId`           | exists — gains a typed `result` object: `{ available, artifactId, schemaVersion }` |
| `GET /v1/tasks/:taskId/artifacts` | exists — unchanged                                                                 |
| `GET /v1/artifacts/:artifactId`   | exists — unchanged (SHA-256 verified, `nosniff`, `no-store`)                       |
| `GET /v1/tasks/:taskId/result`    | **new** — 200 JSON result, 404 before completion, 409 on `failed`/`cancelled`      |

`/result` is deliberately a _reader_, not a store: it fetches the single `results/<taskId>.json`
artifact through the existing artifact service, re-validates it against the frozen schema,
and returns it. There is one source of truth and it is the artifact the committer published.
If the artifact is missing while the task is `completed`, the route returns `NOT_FOUND` — a
loud, honest broken state rather than an empty list.

Task event stream: the client learns the outcome from the existing terminal event; we add
only `inputTokens`, `outputTokens` and `costMicroUsd` (integers, §4.5) on the publish event.
No provider name, no model id, no prompt, no note text on the wire. iOS needs no new
transport, and `IOS_M3_CONVERSATION_API_PROPOSAL.md` §9's `available | missing | failed`
tri-state maps directly onto the three status codes above.

### 5.8 Observability and redaction

Worker log lines for this step carry exactly:

```text
taskId, runId, attempt, leaseEpoch, step='infer', provider, modelId,
inputChars, inputTokens, outputTokens, costMicroUsd, latencyMs,
providerStatus, errorClass, simulated, truncated, itemCount
```

Forbidden in logs, events, artifacts, error DTOs and the DB: the notes text, the model
output text before publication, the API key, the raw provider response body, and full
request headers. Provider errors are mapped to the closed enum in §5.4 at the adapter
boundary, so no provider string can reach a log by accident.

Metrics (reusing the P0B-09A conventions): `model_infer_calls_total{outcome}`,
`model_infer_tokens_total{kind}`, `model_infer_micro_usd_total{scope}`,
`model_infer_latency_ms` histogram, `model_infer_denied_total{reason}` where reason ∈
{`kill_switch`,`sentinel`,`tenant_ceiling`,`global_ceiling`,`item_cap`}.

---

## 6. Cost model

Worst case per task = 8 000 chars input (≈ 2 000 tokens) + 512 output tokens. A realistic
note (≈ 600 chars ≈ 150 tokens, ≈ 250 output tokens) is far below that. Prices are list
prices **as observed at the time of writing and must be re-verified at approval time** — the
formula, not the number, is the durable part:

```text
per_task_micro_usd = round( (in_tokens  * in_price_per_mtok  * 1000)
                          + (out_tokens * out_price_per_mtok * 1000) )
```

| candidate                                  | worst case / task | realistic / task | 1 000 realistic tasks | note                                         |
| ------------------------------------------ | ----------------- | ---------------- | --------------------- | -------------------------------------------- |
| small "mini" tier (e.g. gpt-4o-mini class) | ≈ $0.0005         | ≈ $0.0002        | ≈ $0.20               | cheapest that reliably follows a JSON schema |
| mid "mini" tier (e.g. gpt-4.1-mini class)  | ≈ $0.0016         | ≈ $0.0007        | ≈ $0.70               | better instruction-following on messy notes  |
| small Haiku tier                           | ≈ $0.0032         | ≈ $0.0012        | ≈ $1.20               | comparable quality band                      |

**Recommendation:** the _smallest_ tier that passes the eval in §8.6, with
`EMBER_MODEL_PER_TASK_MAX_MICRO_USD=5000` as an 8×-headroom backstop. At α scale (≤ 100
tasks/user/month, ≤ 20 users) the realistic monthly envelope is **< $2**, and the $2/day
global ceiling caps the pathological case at **$60/month**. The ceiling, not the price, is
what makes this safe to turn on.

Retries multiply: `max_attempts = 2` bounds duplicate spend at 2 × worst case per task, and
a failed call usually still bills its input tokens. Both are already inside the per-task
ceiling.

---

## 7. Failure semantics

### 7.1 Client-visible

| state                        | HTTP                                                 | body                            |
| ---------------------------- | ---------------------------------------------------- | ------------------------------- |
| accepted / replayed          | 202 / 200                                            | task receipt (unchanged)        |
| quota or ceiling hit         | 202 then task `failed` with `BUDGET_EXCEEDED`        | terminal event carries the code |
| kill switch / Sentinel       | 202 then `failed` with `POLICY_DENIED`               | idem                            |
| provider down, attempts left | task `retryable_failed`, no event consumed by client | iOS keeps polling               |
| provider down, attempts gone | `failed` with `MODEL_UNAVAILABLE`                    | idem                            |
| model output unusable        | `failed` with `MODEL_REJECTED`                       | idem                            |
| cancelled by user            | `cancelled`                                          | unchanged                       |

No new HTTP status codes, no new client-side branching beyond parsing two new error codes.

### 7.2 Never happens

- a `simulated: true` result delivered for `notes.action_items` when the switch is `real`;
- a `notes.action_items` result with no artifact;
- a published artifact whose `taskId` differs from the task;
- a provider call after a quota denial;
- a provider call for any `mock.*` kind;
- note text in a log line, event payload, or error message.

### 7.3 Known, accepted limitation

A crash between the provider response and publication can cause **one bounded duplicate
call** per retry. We accept it, price it into the per-task ceiling, and count it — rather
than adding a provider-side dedupe layer whose correctness we cannot test against a real
provider in CI.

---

## 8. Test plan

Everything below is deterministic and runs in the existing harnesses
(`vitest.unit.config.ts`, `vitest.integration.config.ts`). **No test ever contacts a real
provider**; the real adapter is exercised only by the gated smoke harness in §8.7.

### 8.1 Unit (no DB, no network)

| test                        | asserts                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `notes-action-items-schema` | 0 chars, 8 001 chars, whitespace-only, non-NFC rejected; extra keys rejected                                                           |
| `result-schema`             | 21 items rejected, 281-char text rejected, wrong `schemaVersion`, `taskId` mismatch, negative tokens                                   |
| `sentinel-model-infer`      | `model.infer` denied by default; `DENY_MODEL_INFER_DISABLED` when the switch is off; `mock.compute` still maps to `ALLOWED_LOCAL_MOCK` |
| `model-gateway-fake`        | deterministic output for a fixed digest, `simulated: true`, honours the abort signal                                                   |
| `model-gateway-limits`      | the §5.4 mapping table: 4xx vs 429 vs 5xx vs timeout vs abort                                                                          |
| `budget-plan-infer`         | worst-case units match the token caps; `consumedFor` clamps to the reservation                                                         |
| `redaction`                 | a capture sink never receives notes text or key material on any error path                                                             |

### 8.2 Integration — happy path (`tests/integration/notes-action-items.test.ts`)

POST `/v1/tasks` (HTTP, real auth, real idempotency header) → claim with
`PostgresLeaseQueue` → `createDurableRunHandler` with `FakeModelGateway` → assert: task
`completed`; `results/<taskId>.json` exists and matches the schema exactly; `GET
/v1/tasks/:id/result` returns it; the workspace version advanced exactly once; one terminal
event carrying only allowlisted keys; `model_spend_days` has one settled row with
`consumed ≤ reserved`; gateway call count is exactly 1.

### 8.3 Integration — idempotency and replay

- Second POST with the same `Idempotency-Key` ⇒ 200, same task, gateway calls still 1.
- Re-run the handler on an already-published run ⇒ gateway calls still 1, no second
  artifact, no second charge (checkpoint reuse, §5.4).
- Stale `leaseEpoch` ⇒ `STALE_LEASE`, gateway never called, nothing published.

### 8.4 Integration — refusals (each asserts **zero** gateway calls)

| scenario                                                   | expected                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `EMBER_MODEL_EXECUTION=disabled`                           | `failed` + `POLICY_DENIED`; gateway factory not invoked           |
| `model.infer` absent from the policy allowlist             | `failed` + `POLICY_DENIED`                                        |
| tenant day ceiling at 1 µUSD                               | `failed` + `BUDGET_EXCEEDED`, no `model_spend_operations` row     |
| global day ceiling at 1 µUSD while the tenant has headroom | `failed` + `BUDGET_EXCEEDED` (proves the global row is consulted) |
| request-count limit reached                                | `failed` + `BUDGET_EXCEEDED`                                      |
| 8 001-char notes                                           | `INVALID_ARGUMENT` at the API, before any task exists             |

### 8.5 Integration — fault paths

- Hanging fake gateway under a shortened timeout profile ⇒ `EXECUTION_TIMEOUT` →
  `retryable_failed` → one retry → `failed` at `max_attempts`; the reservation settles on
  each attempt and is never released after a call has started.
- Cancel while the gateway is in flight ⇒ `cancelled`, reservation settled, nothing
  published, no orphan artifact.
- Provider returns schema-violating JSON ⇒ `MODEL_REJECTED`, nothing published.
- Provider 429 then 200 ⇒ exactly one retry, one publication, two
  `model_spend_operations` rows.

### 8.6 Contract eval (offline)

`docs/prompts/` gains ~15 fixture notes with **assertions, not golden strings**: each item
must be a phrase derivable from the notes, count ≤ 20, no invented owners or dates, no
duplicated items. Runs against the fake gateway in CI, and against a real provider only in
the gated harness. That keeps "did quality regress?" answerable without making CI
non-deterministic.

### 8.7 Real-provider smoke (manual, never in CI)

`apps/cli/src/model-smoke/cli.ts` + `pnpm model:smoke:local`, mirroring the existing
`apps/cli/src/sandbox-smoke` precedent. Requires `EMBER_MODEL_EXECUTION=real`,
`EMBER_MODEL_API_KEY` and an explicit `EMBER_MODEL_SMOKE_ACK=yes`. Caps at 3 calls, prints
only `{providerStatus, inputTokens, outputTokens, costMicroUsd, latencyMs, itemCount,
artifactId}` — never the notes and never the output. Non-zero exit on schema violation.
Refuses to run without the ACK variable, so it cannot fire by accident from a CI runner or
a stale shell history.

---

## 9. PR sequence

Each PR is independently reviewable, independently revertible, and leaves `main` green. The
first two change nothing at runtime.

| #        | title                                                                                 | contents                                                                                                                                                                            | runtime effect                                                                     | tests                            |
| -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| **PR-1** | `feat(contracts): notes.action_items kind, result schema, model error codes`          | `TASK_KINDS`, input/result zod schemas, `MODEL_UNAVAILABLE`/`MODEL_REJECTED`, `model.infer` category + reason codes, migration `0011` replacing `ember_task_event_payload_is_valid` | none — nothing emits the kind yet                                                  | 8.1 schema + sentinel            |
| **PR-2** | `feat(model-gateway): capability gateway, fake and real adapters, kill-switch config` | new package, `FakeModelGateway`, `OpenAiModelGateway`, limits, timeout, redaction, boot-time refusal                                                                                | none — nothing imports it                                                          | 8.1 gateway + limits + redaction |
| **PR-3** | `feat(worker): infer step for notes.action_items behind the kill switch`              | `infer` branch, `budget-plan` entry, `consumedFor` settle, checkpoint version, claim list, `max_attempts=2`                                                                         | reachable **only** with switch `real` **and** Sentinel allow; default path refuses | 8.2, 8.3, 8.5                    |
| **PR-4** | `feat(budget): model_spend_days ledger and per-user/global ceilings`                  | migration `0012`, ledger, wiring, env config, `.env.example`                                                                                                                        | enforcement active: spendable but capped                                           | 8.4                              |
| **PR-5** | `feat(api): GET /v1/tasks/:id/result and typed result on task detail`                 | read route, task-detail field, event integer fields end to end                                                                                                                      | read surface only                                                                  | API unit + 8.2                   |
| **PR-6** | `docs(ops): model capability runbook, metrics, smoke harness`                         | runbook, final `.env.example`, `model:smoke:local`, `docs/prompts/` fixtures                                                                                                        | none                                                                               | 8.6 + manual 8.7                 |
| **PR-7** | _optional_ `feat(ops): runtime kill switch without redeploy`                          | `model_runtime_flags` + 2 s TTL                                                                                                                                                     | ≤ 2 s kill latency                                                                 | flag unit + integration          |

Ordering rationale:

- **PR-1 is pure contract** — the database decides the vocabulary before any service can emit
  it. Reverting it removes the possibility of the kind existing at all.
- **PR-2 ships dark** — the network adapter is reviewed and unit-tested with zero callers, so
  the riskiest code is merged before anything can reach it.
- **PR-3 wires it behind two independent gates** (switch + Sentinel category), so a single
  mistaken env value cannot open the path.
- **PR-4 adds money** only after the call path exists and is bounded.
- **PR-5** gives the client something to read last, so no UI can show a half-built capability.

Rough size: PR-1 ≈ 600 lines with tests, PR-2 ≈ 900, PR-3 ≈ 500, PR-4 ≈ 700, PR-5 ≈ 400,
PR-6 ≈ 300. No PR exceeds a single sitting.

Every PR carries a `docs/` note in the existing `P0B-*`/`P0C3-*` style and an ACCEPTANCE file
listing the commands run and their output, matching the precedent already in `docs/`.

---

## 10. Explicitly out of scope for V1 Alpha

| item                                         | trigger to revisit                                             |
| -------------------------------------------- | -------------------------------------------------------------- |
| streaming tokens to the client               | a UX decision that needs sub-second first paint                |
| a second capability on the same gateway      | a new review, not a new parameter                              |
| provider fallback / multi-provider routing   | a documented outage that our retry cannot absorb               |
| prompt versioning + A/B quality evaluation   | the first quality regression we cannot explain                 |
| per-item regeneration / user edit round-trip | a second spend path with its own ceiling                       |
| provider-side prompt caching                 | cost data showing caching would materially change the envelope |
| storing prompt or output text in Postgres    | a legal/retention decision; today it is a deliberate absence   |
| iOS streaming or background refresh          | separate M-slice; the read route is already sufficient         |

---

## 11. Approval checklist

Real provider traffic stays at **zero** until every line below is ticked by the CTO. Each
line names what changes if it is answered differently, so a "no" is actionable rather than
blocking.

### 11.1 Provider and spend (blocking)

| #   | question                                                                                             | default in this proposal                                                               |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A1  | Which provider, and which model id? Any vendor data-processing terms we must accept?                 | one provider, one model id, smallest tier passing §8.6; **not authorised** until named |
| A2  | Is the price table in §6 re-verified at today's list price?                                          | treat as stale until re-checked                                                        |
| A3  | Accept the four ceilings in §5.5 (per task $0.005 / user $0.20 / day / global $2.00 / day / 20 req)? | yes, values are proposals                                                              |
| A4  | Is "no provider-side retention" (`store: false`) available and sufficient?                           | yes, requested explicitly                                                              |
| A5  | Who receives the daily spend alert, and at what threshold?                                           | 70 % of the global daily ceiling                                                       |

### 11.2 Compliance and privacy (blocking)

| #   | question                                                                                                           | default                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| B1  | Is sending user notes to a third-party model acceptable for alpha users, and is a consent line required in the UI? | assumed **yes with disclosure**; iOS copy is not in this scope |
| B2  | Confirm no note text in logs, events, artifacts or DB (§5.8) is the intended bar                                   | yes, test-enforced                                             |
| B3  | Is the result artifact retention acceptable at the existing artifact lifetime?                                     | yes, unchanged from today                                      |
| B4  | Is `simulated: false` sufficient evidence that a result came from a real model (audit trail)?                      | yes, plus the worker log line                                  |

### 11.3 Architecture (blocking)

| #   | question                                                                                        | default |
| --- | ----------------------------------------------------------------------------------------------- | ------- |
| C1  | Approve the new kind `notes.action_items` and the DB migration that admits it (§5.1, §4.2)      | yes     |
| C2  | Approve adding the Sentinel category `model.infer`, deny-by-default (§4.1)                      | yes     |
| C3  | Approve two new domain error codes (§5.4)                                                       | yes     |
| C4  | Approve `infer` as a distinct step rather than reusing `produce` (§5.4)                         | yes     |
| C5  | Accept the documented duplicate-call limitation (§7.3) instead of building provider-side dedupe | yes     |
| C6  | Accept the real adapter being merged **dark** in PR-2                                           | yes     |

### 11.4 Open questions I could not settle from the repository

1. **Tenant vs user.** The budget ledger is tenant-scoped; whether one tenant is one user in
   alpha (and therefore whether "per-user quota" is literally per-tenant) is a product
   decision, not a code fact. The proposal assumes tenant == user.
2. **`max_attempts`.** `tasks.max_attempts` defaults to 3 platform-wide. Proposing 2 for this
   kind is a per-kind default that does not exist yet; if per-kind defaults are unwanted, the
   value must be set by the creating caller instead.
3. **Global ceiling ownership.** A platform-wide money counter only makes sense with a named
   owner of that number. If no one owns it for alpha, the proposal falls back to per-user
   ceilings plus the kill switch — still bounded, less absolute.
4. **`GET /result` vs artifact-only.** If iOS would rather read `/artifacts/:id` directly,
   PR-5 shrinks or disappears; the artifact schema in §5.2 is unchanged either way.

### 11.5 What is already true today, with no approval needed

- Real model egress is impossible: Sentinel denies `network.egress` and `credential.use`, the
  gateway does not exist, and no task kind can reach one.
- `mock.*` behaviour is unchanged by everything above; the simulator is not modified.
- No secret exists in `.env.example` for a model provider, and this proposal does not add one
  until A1 is answered.

---

## Appendix — files this proposal touches, by PR

| PR   | created                                                                                          | modified                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | `migrations/0011_*.sql`, `packages/contracts/src/notes-action-items.ts` (input + result schemas) | `packages/domain/src/{types,errors}.ts`, `packages/contracts/src/{task-schemas,error-schemas,event-schemas,index}.ts`, `packages/execution/src/sentinel-lite.ts` |
| PR-2 | `packages/model-gateway/**`                                                                      | `pnpm-workspace.yaml` if needed, root `package.json`                                                                                                             |
| PR-3 | —                                                                                                | `apps/worker/src/{index,durable-run-handler,config}.ts`, `apps/worker/src/budget-plan.ts`, `packages/postgres/src/lease-queue/validation.ts`                     |
| PR-4 | `migrations/0012_model_spend.sql`, `packages/postgres/src/storage/model-spend-ledger.ts`         | `apps/worker/src/{config,durable-run-handler,index}.ts`, `.env.example`                                                                                          |
| PR-5 | `apps/api/src/tasks/result-route.ts`                                                             | `apps/api/src/tasks/{routes,dto}.ts`, `packages/contracts/src/task-schemas.ts`                                                                                   |
| PR-6 | `apps/cli/src/model-smoke/cli.ts`, `docs/prompts/*.json`                                         | `package.json`, `docs/V1ALPHA-NOTES-ACTION-ITEMS.md` (final state)                                                                                               |

## Addendum — 2026-11-03: finding F-2, from the B2 re-scope

Found while re-scoping to the Conversation-first milestone, and **not** in the original audit. It is a
blocker for a turn-scoped model call, which the original notes-first framing never hit because every
`infer` step had a Run.

| Field               | Value                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding             | `SentinelIntentSchema` (`packages/execution/src/sentinel-lite.ts:182`) is a `z.strictObject` that **requires** `runId: z.string().regex(UUID_PATTERN)` (`:186`)                                                  |
| Why it matters      | A conversation turn is not a Task and has no Run (B1 §7.4: a turn "carries no execution semantics"). A B2 model call therefore has no legal Sentinel intent, and Sentinel is the only admission gate in the repo |
| Not a workaround    | Adding `model.infer` to the category array does **not** help: an unknown-but-valid category falls past the safe-mock branch into step 9 and is denied (`DENY_DEFAULT`, `:369-405`)                               |
| Proposed resolution | A turn-scoped intent variant discriminated by a **required** `subjectKind` (`'run'` or `'turn'`), so no intent is ever ambiguous. Detail and the rejected alternatives: proposal §6.3                            |
| Severity            | High for B2, none for existing kinds                                                                                                                                                                             |
| Owner               | Sentinel owner, with the #91 contract owner as reviewer                                                                                                                                                          |

This addendum changes no earlier finding and no conclusion of §1–§4: the four Round-1 denials, the
closed category set and the fail-closed event payload allowlist all still hold. It adds one constraint
that any real model call inside Chat must satisfy.

## Addendum 2 — 2026-11-03: pricing provenance

§6's cost model was written from unverified rate figures and the CTO has asked for dated sources. On
2026-11-03 the primary pricing pages were unreachable from this environment (OpenAI 403, Anthropic
region-restricted, Gemini timeout). The B2/B3 proposal therefore carries the rate rows as
**UNVERIFIED, dated, secondary**, with the arithmetic expressed as a formula so a corrected rate
rescales every ceiling without redesign (proposal §8.1, §8.3). The numbers in §6 below should be read
as illustrations of the method, not as a quote.
