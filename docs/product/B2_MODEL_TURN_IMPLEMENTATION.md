# B2 — Real Assistant Turn: implementation, failure matrix and enablement gates

| field                   | value                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| status                  | **implemented, `real` mode disabled in code** — this PR is a Draft                             |
| branch                  | `feature/b2-real-model-turn`                                                                   |
| base                    | `main@c6c9c3d650f977f3783fa73b941f677639a449ff`                                                |
| migration added         | `0014_model_execution.sql`, `0015_model_budget_safety.sql` (inventory at base ended at `0013`) |
| production call status  | **none.** No provider account, key, model approval or price approval exists                    |
| paid spend in this tree | **$0.** Every automated test uses a controlled fake provider                                   |

This document is the reviewer-facing companion to the implementation. It states what now exists, where
each required invariant is enforced (code, database or test), what happens on every failure, what the
money ledger can and cannot promise, and precisely what must be true before `EMBER_MODEL_EXECUTION=real`
may be removed from the dark state.

The design baseline is `docs/product/V1ALPHA-B2-B3-MODEL-EXECUTION-PROPOSAL.md`. That file is a
**proposal**; nothing in it authorises a paid call, and this implementation does not treat it as
authorisation. Approval items are referenced by their proposal IDs (A1–A5, B1–B4, C1–C6).

---

## 1. What changed, and what deliberately did not

### 1.1 Added

| Path                                                                       | Role                                                                                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/0014_model_execution.sql`                                      | Claim/fence columns on `assistant_turns`; `model_global_spend_days`, `model_spend_days`, `model_turn_attempts`                         |
| `migrations/0015_model_budget_safety.sql`                                  | `conservative_billed`, `billing_basis`, `overage_micro_usd`, `model_budget_incidents` — the CTO review fixes (§3.2)                    |
| `packages/model-gateway/`                                                  | The minimal gateway: types, limits, bounded context, token preflight, rates, credential, config, fake adapter, OpenAI adapter, factory |
| `packages/postgres/src/repositories/b1-turn-publication.ts`                | The B1 publication primitives extracted so B1 and B2 share one atomic publish path                                                     |
| `packages/postgres/src/repositories/b2-interfaces.ts`                      | Persistence-facing types for claim, reservation, settlement and publication                                                            |
| `packages/postgres/src/repositories/b2-model-turn-execution-repository.ts` | Claim, fence, attempt accounting, money reservation, fenced publication, deadline sweep                                                |
| `packages/postgres/src/repositories/b2-ledger-limits.ts`                   | The absolute day ceilings the settlement path needs to split consumed from overage (asserted against the CHECKs by a test)             |
| `apps/worker/src/b1/model-turn-responder.ts`                               | The responder behind B1-5's existing seam                                                                                              |
| `tests/unit/model-gateway.test.ts`                                         | 41 cases: limits, token estimate, context, preflight, mode resolution, credential redaction, adapter behaviour, missing-usage handling |
| `tests/unit/b2-model-turn-responder.test.ts`                               | 30 cases: orchestration, retry, settlement state, abort path, reservation ceiling, budget halt                                         |
| `tests/integration/b2-model-turn-runtime.test.ts`                          | 26 cases on PostgreSQL 17: the 12 required scenarios plus database-guard cases                                                         |
| `tests/integration/b2-budget-safety.test.ts`                               | 10 cases on PostgreSQL 17: conservative billing, refusal, overage, halt, concurrent settlement, drift guard                            |

### 1.2 Unchanged on purpose

- **B1 HTTP contract.** No route, DTO, status code or receipt shape changed. `b1-assistant-turn-repository.ts`
  still exposes the same interface; it now delegates to the shared primitives instead of duplicating the SQL.
- **B1 Turn state machine.** `assistant_turns.status` still moves only `running → completed | failed | cancelled`.
  B2 adds lease columns; it does not add a status.
- **Migrations `0001`–`0013`.** Untouched. `0014` is additive and guarded with `IF NOT EXISTS` / `DO $$` blocks
  so a replay is idempotent.
- **The simulated (B1) responder.** Still available, still labelled simulated, still mutually exclusive with
  the model responder at boot.
- **`budget_ledger.ts`.** Not reused. Its unit is a simulated work unit aggregated per tenant-day, which cannot
  express a token-priced cost separable per principal. The money ledger is a separate set of tables.

---

## 2. The seam, and the order of operations

The responder replaces exactly one thing: the implementation behind B1-5's assistant-turn responder port
(`ModelTurnExecutionPort`). Everything a client can observe — one Turn per user message, one reply per Turn,
the 60 second deadline, the frozen failure text — remains B1's.

```text
claim            UPDATE ... lease_epoch += 1, lease_expires_at = now + lease_ms
                 WHERE status='running' AND deadline > now AND lease free
                 loser: 0 rows -> 0 provider calls
deadline sweep   DB clock; an expired Turn never reaches a provider
halt gate        an unresolved budget incident applying to this tenant/principal/global:
                 refuse before the reservation, 0 provider calls
reserve          one transaction: fence re-check, principal lookup, UTC day, attempt_no,
                 global -> tenant -> principal reservation, attempt row
                 any bucket over its ceiling: whole transaction rolls back, 0 provider calls
one-send CAS     send_started_at NULL -> clock_timestamp(), only while the lease is live
                 rowCount 0 -> the request provably never left: full release, 0 provider calls
provider call    no transaction held, no client checked out, bounded by AbortSignal
settle           settled | conservative_billed | unknown_billed | released,
                 in the same lock order as reservation; overage opens an incident
publish          fence re-check under the conversation+turn locks; epoch/owner/status/deadline/lease
                 any mismatch -> the text is discarded
```

Every step is its own short transaction. `tests/integration/b2-model-turn-runtime.test.ts` case 13 samples
`pool.totalCount - pool.idleCount` from inside the provider call and asserts it is `0`.

---

## 3. Invariants → where they are enforced

A reviewer should not have to trust a comment. Each row names the mechanism, not the intent.

| Invariant                                           | Code                                                                                                  | Database                                                                    | Test                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| At most one valid Assistant Reply per user message  | `publishCompletion` requires `status='running'` + expected epoch/owner; second publish is `fenced`    | `assistant_turns UNIQUE (tenant_id, id)` (B1), attempt PK                   | 1, 2, 12             |
| Competing workers never double-publish              | `claimTurn` is one UPDATE; the loser updates zero rows and makes no call                              | Row lock serialises the two claimants                                       | 2                    |
| No transaction spans provider I/O                   | claim / reserve / settle / publish are separate transactions                                          | —                                                                           | 13                   |
| Cancellation and timeout beat late output           | `isFenceValid` re-reads status, deadline and lease liveness under lock                                | `deadline_at`, `lease_expires_at`, DB clock                                 | 6, 7, 8              |
| Worker crash recovers safely                        | Lease expiry alone makes the Turn claimable; the abandoned attempt keeps its pessimistic charge       | `assistant_turns_lease_state_check`, `assistant_turns_lease_idx`            | 7                    |
| Old migrations are immutable                        | —                                                                                                     | `0014`/`0015` only; `migrations.test.ts` asserts the 15-migration inventory | migrations suite     |
| Real output is marked `simulated: false`            | `publishCompletion` is the only writer of that flag; `B1AssistantTurnRepository` still literal `true` | `conversation_messages.simulated`                                           | 1, 14                |
| A real label can never be simulated, or the reverse | zod `.refine` at the persistence boundary against `/-(fake\|echo)-/`                                  | —                                                                           | 15                   |
| `real` cannot be enabled by configuration alone     | `APPROVED_REAL_MODELS` is empty; every rate row is `unverified`                                       | —                                                                           | 10, 10b              |
| Budget overrun is a hard refusal                    | `Refusal` rolls the reservation back; the Turn fails, it never degrades to fake                       | Ceilings re-asserted as CHECK constraints                                   | 9a–9d                |
| An unreported charge is never booked as zero        | `usage: null` is a distinct outcome; the responder settles `conservative_billed`                      | `state_shape_check` requires `applied = reserved` for that state            | budget-safety 1, 2   |
| A request that cannot fit the cap is never sent     | `reserveMicroUsd` throws `reservation_cap_exceeded` before the attempt row exists                     | `reserved_micro_usd BETWEEN 1 AND 5000`                                     | budget-safety 3      |
| Actual cost above the reservation is never clipped  | `splitCharge` returns the excess instead of dropping it                                               | `overage_micro_usd`, `overage = observed - applied`                         | budget-safety 4, 6   |
| A spend overrun stops further paid calls            | `findOutstandingHalt` refuses before the reservation                                                  | `model_budget_incidents` (unresolved), partial index                        | budget-safety 4, 7   |
| Provider credentials never reach a sandbox or a log | `ModelCredential` has no accessor; `use()` passes the key once; `toJSON`/`toString` are `[redacted]`  | No key column exists anywhere                                               | `model-gateway` unit |
| Provider origin is fixed                            | `OPENAI_ORIGIN` constant; `redirect: 'error'`, `credentials: 'omit'`                                  | —                                                                           | `model-gateway` unit |

### 3.1 Two defects the tests found, and the fix

Both were found by the integration suite, not by review. They are recorded because they are the kind of
error that looks correct in a comment.

1. **Settlement double-counted the booked amount.** `settleAttempt` released only `reserved - applied`,
   leaving `applied` both consumed and still reserved. Fixed: a settlement ends the whole hold
   (`release = reserved`) and books `applied` as consumed.
2. **The day's first reservation bypassed its own ceiling.** The cap lived only in the
   `ON CONFLICT ... DO UPDATE WHERE` branch, which does not run when the bucket row does not exist yet.
   Fixed: the cap is enforced on the `INSERT ... SELECT` path as well, and it is applied to
   `consumed + reserved`, so money already spent keeps occupying the day's allowance.

The second fix changes the meaning of the cap from "outstanding hold" to "day spend", which is the only
definition that can stop spend. `tests/integration/b2-model-turn-runtime.test.ts` case 9d covers it.

### 3.2 Three defects found in CTO review, and the fix

All three were in the paid path, and all three shared a shape: a value the code did not know was
silently replaced by a convenient one. Each fix removes the substitution rather than adjusting it.

| #    | Defect                                                                                  | Why it was dangerous                                                                                                        | Fix                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | A 2xx without `usage` was priced at 0 and settled as `settled`                          | A billed call recorded as free understates the day's spend and lets the same budget be spent again                          | `usage` is nullable; `null` means "unknown". The responder settles `conservative_billed`, which books **the full reservation** and sets `billing_basis` |
| P0-2 | `Math.min(estimate, cap)` reserved the cap and then sent a request that could cost more | The per-attempt cap stopped being a ceiling: a $0.02 request reserved $0.005 and the difference arrived on an invoice       | The worst-case cost is computed first and the call is **refused** (`reservation_cap_exceeded`) before an attempt row or a byte exists                   |
| P0-3 | `applied = min(observed, reserved)` clipped the excess out of the day ledger            | Recorded spend could be lower than actual spend, with no record that it happened and nothing stopping the next bad estimate | The full amount is kept: `consumed` (absorbed) plus `overage_micro_usd` (excess). Any overage opens an incident that refuses further paid calls         |

Three consequences a reviewer should check directly:

1. **The token estimate is no longer 4 characters per token.** That ratio is a Latin-script assumption.
   A Han character is roughly a token or more, so pricing Chinese text at a quarter of a token under-reserved
   it by close to an order of magnitude. `estimateTokensConservative` prices ASCII at 4 chars/token and every
   non-ASCII code point at 2 tokens, and the preflight now reads the message text rather than a character
   count. It is a conservative upper bound **for reservation purposes**, not a proof about any tokenizer:
   nothing in the code or this document claims it guarantees a cost ceiling. §5.3.
2. **A reservation that is too small is now an event, not a rounding error.** It is recorded on the attempt
   (`overage_micro_usd`), on the day bucket (outside the ceiling arithmetic) and as an incident, and it halts
   spending. That is the only way an underestimate can be discovered before an invoice arrives.
3. **The halt is reversible, and the reversal is attributed.** `resolveBudgetIncident` records who cleared it
   and why; a second resolution updates zero rows rather than overwriting the first attribution.

`tests/integration/b2-budget-safety.test.ts` carries the evidence: conservative billing books
`applied = reserved` with `observed = NULL` (cases 1–2); an unaffordable request leaves no attempt row, no
bucket and no provider call (case 3); an overage preserves `consumed + overage = observed` exactly (case 4);
the next Turn is refused with `halted` and only resumes after an attributed resolution (case 5); two
concurrent settlements move the money once (case 6); the incident outlives the transcript that caused it
(case 7).

---

## 4. Failure matrix

`fake` mode never reaches a provider; it is listed so a reader can see that it shares the gate chain.

| #   | Trigger                                            | Detected by                         | Attempt ledger                                                          | Turn result                                     | Provider calls | User sees                        |
| --- | -------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- | -------------- | -------------------------------- |
| 1   | Normal reply                                       | provider 200 + parse                | `settled` / `ok`, applied = observed                                    | `completed`                                     | 1              | the reply, `simulated:false`     |
| 2   | Another worker holds the lease                     | claim updates 0 rows                | none created                                                            | unchanged (`running`)                           | 0              | nothing yet                      |
| 3   | Turn past its 60 s deadline                        | DB clock in sweep and claim         | none created                                                            | `failed` / `timeout`                            | 0              | frozen failure text              |
| 4   | Provider timeout (`model_timeout`)                 | adapter abort                       | `unknown_billed` (reservation kept)                                     | retry, else `failed`/`timeout`                  | ≤ 2            | frozen failure text              |
| 5   | Provider 5xx / reset (`model_unavailable`)         | transport error                     | `unknown_billed`                                                        | retry, else `failed`/`internal_error`           | ≤ 2            | frozen failure text              |
| 6   | Provider 429 (`model_rate_limited`)                | HTTP 429                            | `unknown_billed`                                                        | retry, else `failed`/`internal_error`           | ≤ 2            | frozen failure text              |
| 7   | Provider 401/403 (`model_auth_failed`)             | HTTP 401/403                        | `unknown_billed`                                                        | `failed`/`internal_error`, **no retry**         | 1              | frozen failure text              |
| 8   | 2xx with unparseable body (`model_invalid_output`) | adapter parse                       | `unknown_billed`                                                        | `failed`/`internal_error`, no retry             | 1              | frozen failure text              |
| 9   | Cancelled during inference                         | `cancelTurn` then publish fence     | `settled`/`unknown_billed` with the real cost                           | stays `cancelled`; text discarded               | 1              | nothing (cancellation won)       |
| 10  | Worker shutdown during inference                   | shared `AbortSignal`                | `unknown_billed` / `client_cancelled`                                   | stays `running`                                 | 1              | nothing yet; lease expires later |
| 11  | One-send CAS loses                                 | `send_started_at IS NULL` CAS       | `released` / `not_sent`, full refund                                    | `fenced`                                        | 0              | nothing yet                      |
| 12  | Lease taken over, then stale reply arrives         | publish fence: epoch/owner mismatch | the stale worker's attempt stays `settled` (money is real)              | `fenced`; text discarded                        | 1              | the takeover worker's reply      |
| 13  | Lease expired, no takeover yet                     | `listRunningTurns` filter           | —                                                                       | invisible until expiry                          | 0              | nothing yet                      |
| 14  | Global / tenant / principal ceiling reached        | reservation predicates              | none created (rolled back)                                              | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 15  | Principal turn allowance exhausted                 | `turns_started` predicate           | none created                                                            | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 16  | No server-derived principal for the tenant         | `consumers` lookup                  | none created                                                            | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 17  | Context too large / not user-terminated            | `buildBoundedContext` / preflight   | none created                                                            | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 18  | Credential missing on boot                         | `ModelCredential.parse`             | —                                                                       | **process refuses to start**                    | 0              | a dead worker, visibly           |
| 19  | Model not in the code allowlist                    | `resolveModelExecution`             | —                                                                       | **process refuses to start**                    | 0              | a dead worker, visibly           |
| 20  | PostgreSQL unavailable during an iteration         | `asDomainError`                     | whatever was committed stays committed                                  | `running`; the loop backs off                   | 0              | nothing yet                      |
| 21  | 2xx reply with no reported `usage`                 | adapter: `usage` absent/invalid     | `conservative_billed` / `usage_missing`, applied = the full reservation | `completed` (the reply is real)                 | 1              | the reply, `simulated:false`     |
| 22  | Worst-case cost above the per-attempt cap          | `reserveMicroUsd`                   | none created                                                            | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 23  | Chinese/Latin mix over the token cap               | conservative token estimate         | none created                                                            | `failed`/`internal_error`                       | 0              | frozen failure text              |
| 24  | Actual cost above the reservation                  | `splitCharge` overage               | `settled` with `overage_micro_usd` > 0; incident opened                 | `completed`, then spend halted                  | 1              | the reply                        |
| 25  | An unresolved incident applies to the caller       | `findOutstandingHalt`               | none created                                                            | `failed`/`internal_error` (counted as `halted`) | 0              | frozen failure text              |

Deliberate design points visible in the matrix:

- **There is no silent downgrade.** A process configured for `real` that cannot deliver it dies at boot
  (§6). A paid call refused by budget fails the Turn; it is never answered with simulated text.
- **An unknown charge is not a free charge.** Every path where a request may have been sent keeps its
  reservation as `unknown_billed`; a reply whose provider did not report usage books the reservation as
  `conservative_billed`. Only a provably unsent request is released.
- **A wrong estimate stops spending rather than quietly shrinking.** Row 24 is the one case where the
  ledger learns its own reservation was too small; it records the difference and refuses the next call.
- **A stale worker's text is discarded but its cost is booked.** Discarding the cost would make the ledger
  dishonest about an invoice we may receive.

---

## 5. Cost: what the ledger can and cannot promise

### 5.1 Units

All money is integer micro-USD (`1 USD = 1_000_000`). No float arithmetic exists in the ledger path.

| Table                     | Cardinality                          | Meaning                                                           |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `model_global_spend_days` | one row per UTC day                  | the single cross-tenant bucket                                    |
| `model_spend_days`        | one row per (tenant, scope, id, day) | `scope_kind IN ('tenant','principal')`, independent of each other |
| `model_turn_attempts`     | one row per (turn, attempt_no)       | the canonical paid operation; at most 2 per Turn                  |
| `model_budget_incidents`  | one row per detected overrun         | the audit record **and** the stop switch, until resolved          |

`reserved` is the live hold. `consumed` is recognized spend **inside** the day's allowance.
`overage_micro_usd` is the part of an actual cost the allowance could not absorb, kept outside the
`reserved + consumed <= ceiling` arithmetic so the ceiling still binds. Actual spend for the day is
`consumed_micro_usd + overage_micro_usd`, and on an attempt
`applied_cost_micro_usd + overage_micro_usd = observed_cost_micro_usd` holds exactly, by constraint.
The budget predicate is `consumed + reserved + new <= ceiling`, so settling a call does not return its
allowance.

### 5.2 Ceilings, in code and in the database

| Bucket              | Config default (µUSD/day) | USD    | DB absolute CHECK | DB-enforced? |
| ------------------- | ------------------------- | ------ | ----------------- | ------------ |
| Per attempt         | 5 000                     | $0.005 | 1 … 5 000         | yes          |
| Principal           | 250 000                   | $0.25  | ≤ 250 000         | yes          |
| Tenant              | 1 000 000                 | $1.00  | ≤ 1 000 000       | yes          |
| Global              | 5 000 000                 | $5.00  | ≤ 5 000 000       | yes          |
| Principal turns/day | 60                        | —      | ≤ 60              | yes          |

Configuration can only **lower** these; `resolveModelExecution` refuses a budget that is negative,
fractional, above the absolute ceiling, or inverted (`principal ≤ tenant ≤ global`). These are
implementation design values from the CTO task; they are **not** an authorisation to spend.

### 5.3 What one worst-case Turn reserves — and why that is not a guarantee

The reservation is the largest bill the request can plausibly produce: the conservative token estimate of
the bounded context plus the fixed prompt and envelope, priced at the pinned rate, with the full
`maxOutputTokens` allowance.

**The estimator is not 4 characters per token.** ASCII is priced at 4 characters per token; every non-ASCII
code point is priced at **2 tokens**. The previous formula divided a character count by four, which is a
Latin-script assumption: 12 000 characters of Chinese is roughly 12 000–24 000 tokens, not 3 353. That
under-reservation was the mechanism behind P0-2.

| Context     | Characters | Estimated input tokens | Outcome                               |
| ----------- | ---------- | ---------------------- | ------------------------------------- |
| ASCII prose | 12 000     | ≈ 3 353                | priced, reserved, sent                |
| Chinese     | 12 000     | ≈ 24 353               | **refused** (`input_tokens_over_cap`) |
| Chinese     | 3 500      | ≈ 7 353                | priced, reserved, sent                |

Because the preflight fails closed above `maxInputTokens = 8 000`, the largest reservation any Turn can
hold is bounded by 8 000 input tokens plus 512 output tokens:

```text
gpt-5-mini   (unverified row $0.25/1M in, $2.00/1M out)
  ceil((8 000 × 250 000 + 512 × 2 000 000) / 1 000 000) = 3 024 µUSD = $0.003024
gpt-4.1-mini ceil((8 000 × 400 000 + 512 × 1 600 000) / 1 000 000) = 4 020 µUSD = $0.004020
gpt-4o-mini  ceil((8 000 × 150 000 + 512 ×   600 000) / 1 000 000) = 1 508 µUSD = $0.001508
```

Each fits under the $0.005 per-attempt cap, so today's rate rows can be reserved honestly. A rate row that
could not fit would be **refused before egress** rather than clamped to the cap (P0-2).

There is deliberately **no per-Turn cap**: a Turn may reserve up to `maxAttempts × perAttempt` = $0.010,
which is the bound approval item C5 asks the CTO to accept. This is arithmetic on a proposed price sheet,
not a quote: approval item A2 requires an invoice-verified row before any real call.

**No part of this bounds an invoice.** A tokenizer that disagrees with the estimate, a price change applied
mid-day, or cached-token accounting can all make the actual charge larger than the reservation. That is why
the ledger records `overage_micro_usd` and halts spending when it happens, instead of asserting that it
cannot (§3.2, P0-3).

### 5.4 Evidence produced by the automated tests

Every number below is asserted in `tests/integration/b2-model-turn-runtime.test.ts` with a controlled
fake provider whose usage is fixed at 40 input / 20 output tokens and 130 µUSD.

| Test | Scenario                        | Observed ledger state                                                                                                              |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | one successful Turn             | global `reserved 0, consumed 130`; principal `consumed 130, turns_started 1`; attempt `settled`, `applied = 130`, `observed = 130` |
| 4    | provider timeout, both attempts | both attempts `unknown_billed`; global `reserved = Σ reservations`, `consumed 0`                                                   |
| 5    | 5xx then success                | attempt 1 `unknown_billed`, attempt 2 `settled`                                                                                    |
| 6    | cancelled mid-flight            | attempt `settled` with the real cost; zero messages                                                                                |
| 7    | crash then recovery             | attempt 1 `unknown_billed`/`client_cancelled`, attempt 2 `settled`                                                                 |
| 9a   | global ceiling                  | zero attempt rows, zero provider calls, `consumed 0`                                                                               |
| 9b   | tenant ceiling                  | zero attempt rows, zero provider calls                                                                                             |
| 9c   | principal ceiling               | all three buckets byte-identical before and after (the rollback covered them)                                                      |
| 9d   | principal turn allowance = 0    | zero attempt rows, zero provider calls                                                                                             |
| 14   | fake mode                       | no spend row is created at all; zero attempt rows                                                                                  |

The tests also assert the _ordering_ the ledger depends on: `reserveAttempt` precedes
`markAttemptSent`, which precedes the provider call, which precedes `settleAttempt`, which precedes
`publishCompletion`.

---

## 6. Mode resolution and boot gates

`EMBER_MODEL_EXECUTION` is resolved by `resolveModelExecution()`; the worker turns any refusal into a
startup error.

| Mode       | Requires                                                                      | Behaviour                                                         |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `disabled` | nothing                                                                       | default in every environment, including production                |
| `fake`     | nothing; refused when `EMBER_ENV=production` or `NODE_ENV=staging/production` | zero-cost, zero-egress, `simulated:true`, label contains `-fake-` |
| `real`     | **all four gates below**                                                      | paid provider calls                                               |

The four `real` gates, each independent:

1. provider in the code-owned `APPROVED_MODEL_PROVIDERS` (`['openai']`);
2. model id in the code-owned `APPROVED_REAL_MODELS` — **empty in this tree**;
3. an `invoice_verified` rate row for that exact model id — every shipped row is `unverified`;
4. a usable credential (present, not a placeholder, `sk-` + ≥ 20 characters).

> **Superseded in part by L4-B.** Each `APPROVED_REAL_MODELS` entry now carries a `ModelApprovalRecord`
> (`approvalId`, `approvedBy`, `approvedAt`, `expiresAt`) that must be effective on the day the
> process boots, and a rate row may carry a provider `shutdownDate` that refuses `real` once the
> snapshot has been retired. So `real` has five gates, not four, and an approval expires. See
> `docs/product/L4B-FIRST-REAL-LLM-RESPONSE.md` §2 and §4.

Because gates 2 and 3 cannot be satisfied by any environment variable, `.env` file or tenant policy,
`real` is off in **code**, not by configuration. Turning it on is a reviewed diff.

Additional boot guards:

- `EMBER_MODEL_EXECUTION != disabled` together with `EMBER_B1_FAKE_RESPONDER_ENABLED=true` is refused:
  one Turn must have exactly one responder.
- `fake` in a production or staging process is refused: a simulated reply must never be served by a
  process that could be described as running a live model.

### 6.1 Environment variables

| Variable                                       | Default    | Notes                                                              |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `EMBER_MODEL_EXECUTION`                        | `disabled` | `disabled` \| `fake` \| `real`                                     |
| `EMBER_MODEL_PROVIDER`                         | `openai`   | must match a code-owned allowlist entry                            |
| `EMBER_MODEL_ID`                               | unset      | pinned dated id; required for `real`                               |
| `EMBER_MODEL_API_KEY`                          | unset      | credential; never logged, never persisted, never sent to a sandbox |
| `EMBER_MODEL_TURN_LEASE_MS`                    | `30000`    | 1 000 … 60 000                                                     |
| `EMBER_MODEL_ATTEMPT_TIMEOUT_MS`               | `20000`    | 1 000 … 30 000, further clamped by the Turn deadline               |
| `EMBER_MODEL_MAX_ATTEMPTS`                     | `2`        | 1 … 2                                                              |
| `EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD`     | `5000`     | 1 … 5 000                                                          |
| `EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD` | `250000`   | 0 … 250 000                                                        |
| `EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD`    | `1000000`  | 0 … 1 000 000                                                      |
| `EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD`    | `5000000`  | 0 … 5 000 000                                                      |
| `EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS`     | `60`       | 0 … 60                                                             |

---

## 7. What must be true before `real` may be enabled

Nothing below is done. This is the checklist the enablement PR must satisfy, in this order.

### 7.1 Code and configuration changes

| #   | Change                                                                                                        | Where                                 |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Add the dated model id to `APPROVED_REAL_MODELS`                                                              | `packages/model-gateway/src/rates.ts` |
| 2   | Replace the matching rate row with `provenance: 'invoice_verified'` and the invoice source                    | same file                             |
| 3   | Set `EMBER_MODEL_EXECUTION=real`, `EMBER_MODEL_ID`, `EMBER_MODEL_API_KEY` in the deployment secret store only | deployment config, not the repo       |
| 4   | Confirm the four ceiling variables are at or below the approved A3 values                                     | deployment config                     |
| 5   | Confirm `EMBER_B1_FAKE_RESPONDER_ENABLED` is absent or `false`                                                | deployment config                     |

### 7.2 Approvals that must be recorded first

| ID  | Decision still owed                                                                                       | Blocks                    |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------- |
| A1  | Provider and pinned dated model id                                                                        | gates 2 and 3             |
| A2  | Invoice-grade price sheet for that exact id                                                               | gate 3, and every ceiling |
| A3  | Ceilings confirmed as $0.005 / $0.25 / $1 / $5 and 60 turns per principal                                 | this PR's defaults        |
| A4  | Named owner of the global ceiling and the kill-switch runbook                                             | first day of real traffic |
| A5  | Alert destination for `model_auth_failed`, **unresolved `model_budget_incidents`** and daily spend ≥ 80 % | incident response         |
| B1  | Transcript egress of ≤ 8 messages accepted for Alpha and stated in the privacy copy                       | any real user             |
| B2  | Provider retention and training terms, named source and dated                                             | any real user             |
| B3  | Content-free audit trail (turn id, tokens, cost, outcome) judged sufficient                               | any real user             |
| B4  | Provider data-processing addendum executed                                                                | TestFlight at the latest  |
| C5  | Bounded duplicate paid call (≤ 2 attempts, ≤ $0.010) accepted                                             | this PR's retry policy    |
| C6  | "Refuse to boot" confirmed as the correct failure for a misconfigured `real`                              | §6                        |

`C1`–`C4` concern Sentinel intent and the B3 task kind; they block B3, not B2. B2 issues no Sentinel
intent and creates no Task.

### 7.3 Verification that must be run, by a human, once

| Step                                                                                                      | Evidence to attach                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Real provider smoke with a CTO-authorised key and a hard spend limit                                      | one Turn, `simulated:false`, attempt row `settled`, cost matching the invoice line                |
| Account spend limit set at the provider                                                                   | screenshot or billing-config reference                                                            |
| Reconciliation: sum of `model_turn_attempts.observed_micro_usd` for one UTC day vs the provider invoice   | a signed comparison, not a claim                                                                  |
| 80 % alert fires                                                                                          | a test notification in the named channel                                                          |
| Emergency stop rehearsed                                                                                  | `EMBER_MODEL_EXECUTION` flipped to `disabled` and rolled out; one Turn fails with the frozen text |
| Overage rehearsal in staging: force `observed > reserved`, confirm the halt and the attributed resolution | an incident row, a refused Turn, and a resolved incident with a named resolver                    |

**The real provider smoke test is not part of this PR and must not be added to CI.** CI must never hold
a provider credential; every automated test in this branch uses a controlled fake provider.

---

## 8. Test map — the twelve required scenarios

`tests/integration/b2-model-turn-runtime.test.ts`, PostgreSQL 17, one throwaway schema per run.

| #   | Required scenario                         | Test case                                                                    |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Normal model reply                        | `1. publishes one live reply marked simulated:false …`                       |
| 2   | Two workers claim simultaneously          | `2. lets only one of two workers holding the same candidate claim it`        |
| 3   | Concurrent duplicate submission           | `3. collapses two concurrent identical submissions …`                        |
| 4   | Provider timeout                          | `4. keeps the reservation when the provider times out …`                     |
| 5   | Provider 5xx                              | `5. retries a provider 5xx once and keeps both attempt records`              |
| 6   | Cancellation while inference is in flight | `6. discards an in-flight reply when the Turn is cancelled during inference` |
| 7   | Worker crash / restart                    | `7. recovers an abandoned Turn after the crashed worker lease expires`       |
| 8   | Lease expiry / stale output               | `8. refuses a stale worker output after its lease is taken over`             |
| 9   | Budget exceeded                           | `9a` global, `9b` tenant, `9c` principal, `9d` principal turn allowance      |
| 10  | Credential missing                        | `10. refuses to boot real mode without a credential …` and `10b. …`          |
| 11  | PostgreSQL disconnect                     | `11. survives a PostgreSQL disconnect without corrupting the Turn`           |
| 12  | No duplicate assistant message            | `12. never produces a second assistant Message for one Turn`                 |

Supporting cases: `13` (no client checked out during provider I/O), `14` (fake mode is inert),
`15` (mislabelled publication refused). The second describe block asserts the `0014` guards directly
against SQL: attempt number ceiling, attempt state shape, provider allowlist, absolute ceilings,
half-cleared lease, and cascade behaviour on transcript deletion.

`tests/integration/b2-budget-safety.test.ts` carries the CTO-review evidence: conservative billing for a
missing usage report, refusal of an unaffordable request, an overage preserved in full, the halt and its
attributed resolution, concurrent settlement, incident durability across transcript deletion, and a guard
that the settlement path's ceiling constants still agree with the database CHECKs.

Unit coverage (`tests/unit/`): 41 gateway cases and 30 responder cases, including credential redaction,
provider origin pinning, the closed failure taxonomy, bounded-context truncation, the conservative token
estimate (Latin and Chinese), token preflight fail-closed, every `real` refusal reason, the reservation
ceiling, the budget halt, and the responder's settlement state for each outcome.

### 8.1 How to run

```bash
pnpm dev:db                      # PostgreSQL 17 on 127.0.0.1:55432
export TEST_DATABASE_URL='postgres://ember:ember_local_dev_only@127.0.0.1:55432/ember_test'
pnpm typecheck && pnpm lint
pnpm test:unit && pnpm test:integration && pnpm test:chaos && pnpm test:e2e
```

Result on this branch: `typecheck` clean, `lint` clean, unit 1316 passed, integration 532 passed,
chaos 30 passed, e2e 39 passed.

---

## 9. Known limits, stated rather than hidden

| Limit                                                                      | Consequence                                                                                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The rate sheet is not invoice-grade                                        | every ceiling is arithmetic on a secondary source; gate 3 exists precisely for this                                                                              |
| Token counts are estimated locally, never proved                           | the reservation can be wrong in either direction; the estimate is deliberately pessimistic, and an overage is recorded and halts spend rather than being clipped |
| A wrong reservation stops paid traffic until a human resolves it           | `model_budget_incidents` has no automatic expiry on purpose: an unreviewed overage is the failure mode being prevented                                           |
| A crash after the provider received the request keeps the full reservation | one Turn may cost up to 2 × per-attempt cap; bounded by `attempt_no ≤ 2`                                                                                         |
| `model_turn_attempts` cascades with its Turn                               | deleting a transcript removes the attempt detail; the day buckets keep the spend                                                                                 |
| The 60-second Turn deadline can expire mid-call                            | the reply is discarded and the cost is still booked, which is the correct trade for the user                                                                     |
| The `fake` adapter's text is deterministic, not cached                     | it is a gate-chain exerciser, not a product behaviour                                                                                                            |
| No streaming, no tools, no multi-turn agent loop                           | out of B2 scope; the adapter sends `stream:false`, `n:1`, no tools, no temperature                                                                               |
| No reconciliation job                                                      | `model_turn_attempts_open_idx` exists so one can be added without a schema change                                                                                |
| A tenant has exactly one consumer in Alpha                                 | the tenant bucket and the principal bucket therefore move together today; they remain separate so an N:1 tenant cannot silently inherit one user's ceiling       |
