# L4-B — First Real LLM Response

> **Status update (2026-11-11):** This document records the earlier direct-OpenAI candidate review. The CTO has since selected the exact OpenRouter route `nvidia/nemotron-3.5-lightning` through DeepInfra, with a date-only inclusive expiry on 2026-11-12; see [OpenRouter Adapter and P1 Security Gates](OPENROUTER-AND-P1-SECURITY.md). The exact DeepInfra endpoint is currently listed in OpenRouter's ZDR catalog. The rest of preflight is incomplete; no real call has been made, and Staging remains disabled.

| field                   | value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| status                  | **Draft PR. `real` is implemented as a reviewed gate and is NOT enabled** |
| branch                  | `feature/l4b-first-real-llm-response`                                     |
| base                    | `main@8c84e4b` (latest main at integration)                               |
| migrations added        | none                                                                      |
| paid spend in this tree | **$0.** No provider account, key, model approval or price approval exists |
| real Turn evidence      | **not produced.** Blocked on approvals A1/A2 (see §7), by design          |

This document is the reviewer-facing companion for L4-B. It states what already existed, what this
branch changes, which candidate model is nominated and on what evidence, what a paid Turn would cost,
how the staging guard was given a formal authorization path without deleting a check, and precisely
what remains blocked.

The design baseline is `docs/product/B2_MODEL_TURN_IMPLEMENTATION.md` (B2, merged) and
`docs/product/V1ALPHA-B2-B3-MODEL-EXECUTION-PROPOSAL.md` (the proposal, which authorises nothing).
Approval ids are the proposal's: A1–A5, B1–B4, C5, C6.

---

## 1. What this branch does, in one page

| #   | Change                                                                                             | Why it was necessary                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ModelApprovalRecord` on `APPROVED_REAL_MODELS`, with `approvedBy` / `approvedAt` / `expiresAt`    | "Approved" had no owner and no expiry, so one merged diff would have been a permanent permission. Expiry is now a boot gate.             |
| 2   | `PENDING_MODEL_CANDIDATES`: the nominated id, in code, **not** approved                            | The review needs a code-side anchor that a reviewer can diff and a test can prove unusable.                                              |
| 3   | `shutdownDate` on `ModelRateRow` + `model_shutdown` refusal                                        | The tree's whole price sheet turned out to be deprecated (§3). A retired snapshot must be refused before egress, not after a 404.        |
| 4   | `reasoningEffort: 'none'` pinned on the rate row and sent by the adapter                           | GPT-5.6 Luna supports this effort and the existing 512-token cap; the caller cannot change it.                                           |
| 5   | `infra/staging/model-authorization.json` + guard rule 3b rewritten                                 | PR #123's guard refused `real` and provider credentials unconditionally. Any future real deployment would have had to delete a check.    |
| 6   | `EMBER_MODEL_API_KEY` blanked in `api`, `migrate` and `edge`                                       | The staging `env_file` is shared; only the worker has a model gateway and needs the key.                                                 |
| 7   | Per-process concurrency gate in the responder, reported as `busy`                                  | Concurrency was implicitly one because the loop is sequential. Now it is structural, so a future parallel loop cannot quietly double it. |
| 8   | `pnpm model:smoke` — the only executable that may spend, exactly one Turn and one provider attempt | §6. It scopes processing to the new Turn and writes content-free evidence.                                                               |

Deliberately **not** changed: the B1 HTTP contract, the B1 Turn state machine, migrations, the
Sentinel policy surface, the Agent tool surface, Daytona, and the `disabled` default.

---

## 2. Audit of what already existed

Reviewed at `main@db9fab1`: `packages/model-gateway/*`, `apps/worker/src/b1/model-turn-responder.ts`,
`apps/worker/src/config.ts`, `infra/staging/scripts/preflight.mjs`, `migrations/0014`, `0015`.

### 2.1 What is already correct, and stays

| Control                      | Mechanism                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single egress origin         | `OPENAI_ORIGIN` is a module constant; `redirect: 'error'`, `credentials: 'omit'`. No base-URL parameter, no environment override.                  |
| No capability smuggling      | `ConversationTurnInput` has no model, temperature, tools, stop sequence, provider or system prompt.                                                |
| Credential containment       | `ModelCredential` has no accessor; `use()` hands the secret to exactly one consumer; `toJSON`/`toString` are `[redacted]`; placeholders refused.   |
| Token bounds before building | char ceiling (12 000), message cap (8), conservative token preflight (8 000), output cap (512). Refusal happens before a request is constructed.   |
| Money before bytes           | `reserveAttempt` → `markAttemptSent` CAS → provider call → `settleAttempt` → fenced publish. Any bucket over budget: rollback, zero calls.         |
| Unknown charge is not free   | `usage: null` settles `conservative_billed` at the full reservation.                                                                               |
| Overage halts spend          | `overage_micro_usd` opens a `model_budget_incidents` row; further paid calls refuse until resolved.                                                |
| No silent fallback           | `real` refuses to boot rather than degrade to `fake`; `createModelGateway` throws in `disabled`.                                                   |
| Ceilings in code _and_ DB    | $0.005 per attempt / $0.25 principal / $1 tenant / $5 global per day, 60 paid Turns per principal per day, asserted against the CHECK constraints. |

### 2.2 Findings

**F-1 — the nominated GPT-5 mini snapshot has a shutdown date.** OpenAI lists
`gpt-5-mini-2025-08-07` for shutdown on 2026-12-11; the gpt-4.1 and gpt-4o mini snapshots in the
historical price rows shut down on 2027-01-14. The new candidate is `gpt-5.6-luna`.

**F-2 — "approved" had no owner and no expiry.** `APPROVED_REAL_MODELS` was a list of
`{providerId, modelId}`. Adding a string was the entire enablement procedure, and nothing recorded who
decided, when, or for how long. An approval that never expires is not an approval, it is a merge.
_Fixed_: `ModelApprovalRecord` + `approval_not_effective`.

**F-3 — reasoning effort must match the output cap.** `maxOutputTokens = 512` is passed as
`max_completion_tokens`, which includes reasoning tokens. GPT-5.6 Luna supports
`reasoning_effort: "none"`; the rate row pins and sends it. The adapter test asserts both parameters
and the Chat Completions request shape.

**F-4 — no retirement awareness.** `ModelRateRow` recorded a price and a provenance but not whether
the provider still serves the snapshot. _Fixed_: `shutdownDate` + `model_shutdown`.

**F-5 — the staging guard had no authorized path.** `infra/staging/scripts/preflight.mjs` refused
`EMBER_MODEL_EXECUTION=real` in every mode and refused any variable whose name contained
`MODEL_API_KEY` or `MODEL_PROVIDER`. That is the correct default, but it left exactly one way to
deploy real inference: delete the rule. _Fixed_ in §4 by adding a reviewed artifact the guard reads —
no rule removed, one narrow door with a lock.

**F-6 — the credential reached containers that cannot use it.** `compose.yaml` gives `api`, `worker`,
`migrate` and `edge` the same `env_file`. _Fixed_: Compose explicitly blanks `EMBER_MODEL_API_KEY` in
`api`, `migrate` and `edge`; only the worker receives the project-scoped key.

**F-7 — concurrency was incidental, not enforced.** `processOnce` is a sequential `for` loop, so one
responder instance makes one paid call at a time — but only because nobody has parallelised it yet,
and nothing failed if someone did. _Fixed_: an explicit gate taken _before_ the candidate list is
read, surfaced as `busy` in the summary so a concurrent entry cannot masquerade as an empty poll.

### 2.3 Audit conclusions that did **not** become code

- **Cross-replica concurrency is bounded by money and leasing, not by a counter.** N workers can make
  N concurrent paid calls, each on a different Turn. A distributed semaphore needs its own row and
  transaction and is out of scope for L4-B (§9, R-2).
- **The token estimate is a reservation heuristic, not a provider tokenizer.** Unchanged from B2 and
  still true: only `overage_micro_usd` + the halt path actually stop an under-reserved invoice.
- **`budget_ledger` (simulated work units) is still not reused.** The money ledger is separate and
  should stay separate.

---

## 3. Model selection

### 3.1 Constraint

The adapter stays on OpenAI Chat Completions (`APPROVED_MODEL_PROVIDERS = ['openai']`). A second
provider means a second credential, a second retention review and a second failure taxonomy — no
Alpha value, and out of scope. The requested model must support `POST /v1/chat/completions`,
`max_completion_tokens` and the pinned `reasoning_effort`, and its current price must fit the existing
$0.005-per-attempt ceiling.

### 3.2 Official evidence obtained (2026-11-10)

| Official OpenAI source                                                                                                                  | Verified fact                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)                                                   | Model ID `gpt-5.6-luna`; $0.20 input / $1.20 output per 1M tokens; `reasoning.effort` supports `none`; Chat Completions endpoint is supported. |
| [Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) | `max_completion_tokens` includes visible and reasoning tokens; `reasoning_effort` includes `none`.                                             |
| [Deprecations](https://developers.openai.com/api/docs/deprecations)                                                                     | `gpt-5-mini-2025-08-07` shutdown 2026-12-11; listed gpt-4o-mini and gpt-4.1-mini snapshots shutdown 2027-01-14.                                |

This is official published-price evidence. CTO explicitly reviews and signs A2 against the model page
before the first call. An actual provider invoice is not a prerequisite; persisted usage is reconciled
against billing after the smoke. The account's access and project-specific settings still need review.

### 3.3 Why `gpt-5.6-luna`

| Candidate                 | Price in/out per 1M | Shutdown    | Reasoning | Verdict                                      |
| ------------------------- | ------------------- | ----------- | --------- | -------------------------------------------- |
| `gpt-4o-mini-2024-07-18`  | $0.15 / $0.60       | 2027-01-14  | no        | **rejected** — deprecated                    |
| `gpt-4.1-mini-2025-04-14` | $0.40 / $1.60       | 2027-01-14  | no        | **rejected** — deprecated                    |
| `gpt-5-mini-2025-08-07`   | $0.25 / $2.00       | 2026-12-11  | yes       | **rejected** — near-term shutdown            |
| `gpt-5.6-luna`            | $0.20 / $1.20       | none listed | yes       | **nominated**, with `reasoning_effort: none` |

The older rate rows stay in the table as history and are not candidates for new calls. GPT-5.6 Luna's
official model page lists the model ID without a dated snapshot. Its `none` effort is pinned beside the
published price in the code-owned rate row and sent by the adapter; the caller cannot override it.

### 3.4 Credential required

| Item            | Value                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Variable        | `EMBER_MODEL_API_KEY` (worker process only)                                                                                                                        |
| Format enforced | `sk-` prefix, ≥ 20 chars, no placeholder marker (`REPLACE`, `CHANGEME`, `YOUR_`, `XXXX`, `EXAMPLE`)                                                                |
| Issuing account | An OpenAI **project** key with a hard monthly spend limit set at the provider, not a personal key                                                                  |
| Storage         | SSM Parameter Store `SecureString` under `/ember/staging/secrets/`, rendered to a 0600 file by `render-env.sh`, never in git, never in `compose.yaml`, never in CI |
| Rotation        | New SSM value + `render-env.sh` + `docker compose up -d worker`; the old key is revoked at the provider                                                            |

CI never holds this value. No automated test in this branch reads it; `tests/integration/b2-mock-provider.test.ts`
uses a literal `sk-mock-…` string that the provider would reject.

---

## 4. PR #123 compatibility: the formal authorization path

### 4.1 The problem, stated precisely

`infra/staging/scripts/preflight.mjs` runs on the host before Docker and in CI. At `main@db9fab1` it
enforces two rules that make real inference undeployable:

- rule 3: any variable whose **name** contains `MODEL_API_KEY`, `MODEL_PROVIDER`, `OPENAI`, … is a
  violation `E_PROVIDER_SECRET` — so `EMBER_MODEL_API_KEY` and `EMBER_MODEL_PROVIDER` are refused;
- rule 3b: `EMBER_MODEL_EXECUTION=real` is a violation `E_MODEL_REAL` in every mode.

Both are correct defaults. The gap is that there was **no legitimate state** in which staging could
run a real model, so the only way to enable one would have been to delete the rules — which is how a
security control becomes a comment.

### 4.2 The path added

A reviewed artifact, `infra/staging/model-authorization.json`, ships **empty**:

```json
{ "schemaVersion": 1, "authorizations": [] }
```

The guard now computes, before the credential scan:

```text
authorization = (EMBER_MODEL_EXECUTION == "real" && mode != "e2e")
  ? findModelAuthorization(manifest, { providerId, modelId, today })
  : not_requested
```

and then:

| Situation                                                              | Result                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| default (empty manifest)                                               | `E_MODEL_REAL` — identical outcome and identical code to `main`                                          |
| `real` with no matching entry                                          | `E_MODEL_REAL`, message "no entry … covers this provider and model id"                                   |
| `real` with an **expired** entry                                       | `E_MODEL_REAL`, message "has expired"                                                                    |
| `real` with a not-yet-valid, malformed, placeholder or duplicate entry | `E_MODEL_REAL` with the specific reason                                                                  |
| `real` with a valid entry                                              | `EMBER_MODEL_PROVIDER` + `EMBER_MODEL_API_KEY` are **exempt from rule 3**; everything else still applies |
| `real` with a valid entry, credential missing                          | `E_MODEL_CREDENTIAL`                                                                                     |
| `real` with a valid entry, a ceiling above the authorized one          | `E_MODEL_BUDGET`                                                                                         |
| `real` in `e2e` mode                                                   | `E_MODEL_REAL` **even with a valid entry**, and the credential is still refused                          |

What did **not** change: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `DAYTONA_API_KEY`, any
other provider surface is still `E_PROVIDER_SECRET` in every mode, authorized or not. The exemption is
two exact names, together, and only while the entry matches.

### 4.3 Why an artifact and not an environment variable

- The path is resolved from the module's own location (`new URL('../model-authorization.json', import.meta.url)`).
  No `--env-file`, no host variable and no SSM parameter can point the guard at a different document.
- Changing it requires a commit, a review and a merge — the same bar as changing the code allowlist.
- An entry is **necessary but not sufficient**: `packages/model-gateway/src/rates.ts` must
  independently approve the same id (and itself requires an unexpired `ModelApprovalRecord` and an
  `official_price_verified` or `invoice_verified` rate row). The manifest includes an official
  `priceSource` URL reviewed in A2. A unit test asserts the artifact and the code agree, so the two cannot
  drift into "the guard says yes, the worker refuses to boot".
- The guard stays dependency-free (`node:fs` + `JSON.parse`), so it still runs on a host with Docker
  but no TypeScript toolchain.
- A missing or malformed file is `manifest_unreadable` → refuse. The guard never crashes the
  deployment and never defaults to "allowed".

### 4.4 What a real deployment would look like

```text
EMBER_MODEL_EXECUTION=real
EMBER_MODEL_PROVIDER=openai
EMBER_MODEL_ID=gpt-5.6-luna
EMBER_MODEL_API_KEY=<SSM SecureString → 0600 env file>
EMBER_MODEL_BUDGET_PER_ATTEMPT_MICRO_USD=5000
EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD=250000
EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD=1000000
EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD=5000000
EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS=60
```

plus one entry in `model-authorization.json` and one entry in `APPROVED_REAL_MODELS`. Neither ships in
this branch.

---

## 5. Cost

### 5.1 The ceilings, unchanged

| Bucket              | µUSD/day  | USD    | Enforced by                     |
| ------------------- | --------- | ------ | ------------------------------- |
| Per attempt         | 5 000     | $0.005 | code cap + DB CHECK (1 … 5 000) |
| Principal per day   | 250 000   | $0.25  | DB CHECK                        |
| Tenant per day      | 1 000 000 | $1.00  | DB CHECK                        |
| Global per day      | 5 000 000 | $5.00  | DB CHECK                        |
| Principal Turns/day | 60        | —      | DB CHECK                        |

Configuration may only lower them; `resolveModelExecution` refuses a negative, fractional, inverted or
above-absolute budget in every mode, not only when a paid call is about to happen.

### 5.2 What one Turn can cost at $0.20 / $1.20 per 1M

The reservation is the worst case, priced before the request is built:

| Case                                 | input tokens | output tokens | reservation                  |
| ------------------------------------ | ------------ | ------------- | ---------------------------- |
| Maximum reservation per attempt      | 8 000        | 512           | 2 215 µUSD = **$0.002215**   |
| Typical Alpha turn (short follow-up) | ~770         | ~220          | ~418 µUSD = **$0.000418**    |
| Two attempts on the same Turn        | 16 000       | 1 024         | ≤ 4 430 µUSD = **$0.004430** |

Each attempt's worst-case reservation is under the $0.005 per-attempt cap, so it can be reserved
honestly rather than clamped (the P0-2 defect class). The estimated total for both attempts is
$0.004430; the hard bound remains `maxAttempts × perAttempt` = $0.010, which is approval item C5.

### 5.3 Monthly envelope

| Assumption                                 | Monthly cost                                      |
| ------------------------------------------ | ------------------------------------------------- |
| 25 users × 20 Turns/day × 30 days, typical | 15 000 Turns × $0.000418 ≈ **$6.27**              |
| Same volume at estimated worst case        | 15 000 Turns × $0.004430 ≈ **$66.45**             |
| Hard stop: the $5/day global ceiling       | **$150/month**, and no configuration can raise it |

The binding financial control is the global ceiling, not the per-Turn arithmetic.

### 5.4 Smoke test budget

| Item                 | Bound                                  |
| -------------------- | -------------------------------------- |
| Turns per run        | exactly 1 (`--max-turns=1`)            |
| Provider attempts    | exactly 1 for the first paid smoke     |
| Worst-case estimate  | $0.002215                              |
| Authorized aggregate | `maxPaidSmokeTurns: 1` in the manifest |
| Expected real spend  | ≈ **$0.000418** for one short turn     |

---

## 6. The paid smoke test

`pnpm model:smoke` (`apps/cli/src/model-smoke/cli.ts`) is the only executable in the repository that
can produce a real provider charge, and it refuses unless **all five** hold:

1. `EMBER_MODEL_EXECUTION=real` **resolves** — which requires the code allowlist entry, an unexpired
   `ModelApprovalRecord`, an `official_price_verified` or `invoice_verified` rate row and a usable
   credential;
2. `EMBER_MODEL_SMOKE_APPROVAL` names that same approval id (an operator restates the decision;
   "the config was real" is not "I was asked to spend now");
3. `--max-turns` is exactly 1;
4. no other Turn is `running` at the initial database check, and the responder's candidate query is
   scoped to the new Turn's tenant/conversation/id so a concurrent or historical Turn cannot be billed;
5. `--confirm` is passed. Without it the command prints the plan and exits 2.

It provisions a disposable tenant, submits one user message, runs **one** `processOnce()` through the
production responder and adapter with **one provider attempt**, reads the exact Turn, reply and usage
rows back, and writes a content-free evidence document (ids, model identity, booked cost, timings;
never prompt, reply or key) to `--evidence=<path>` with mode 0600.

Because approvals A1 and A2 are not signed, this branch contains **no** `docs/evidence/l4b-*.json`.
That file is the expected output of the command in §7.3, not something that can be produced today.

---

## 7. Approval items still owed

### 7.1 Blocking A1/A2

| ID     | Decision                                                                                                            | Owner     | Blocks                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------- |
| **A1** | Approve provider `openai` and model id `gpt-5.6-luna`                                                               | CTO / Jia | the code allowlist entry                |
| **A2** | Review $0.20 input / $1.20 output per 1M against OpenAI's official model page; record its URL                       | CTO / Jia | `provenance: 'official_price_verified'` |
| **A3** | Confirm the ceilings $0.005 / $0.25 / $1 / $5 and 60 Turns per principal                                            | CTO / Jia | unchanged defaults                      |
| **A5** | Name the alert destination for `model_auth_failed`, unresolved `model_budget_incidents` and ≥80 % of the global day | CTO / Jia | incident response                       |
| **C5** | Accept ≤ 2 attempts per Turn, ≤ $0.010 per Turn                                                                     | CTO / Jia | the retry policy                        |
| **C6** | Confirm "refuse to boot" is the right failure for a misconfigured `real`                                            | CTO / Jia | §2.1                                    |
| **B1** | Accept that ≤ 8 messages of one conversation leave the platform, and state it in the privacy copy                   | Product   | any real user                           |
| **B2** | Provider retention and training terms, named source, dated                                                          | CTO / Jia | any real user                           |

Sign-off sheet: `docs/product/L4B-MODEL-APPROVAL-REQUEST.md`.

### 7.2 The exact diff that enablement needs, after A1 + A2

```ts
// packages/model-gateway/src/rates.ts
export const APPROVED_REAL_MODELS = [
  {
    providerId: 'openai',
    modelId: 'gpt-5.6-luna',
    approval: { approvalId: 'L4B-A1', approvedBy: '…', approvedAt: '…', expiresAt: '…' },
  },
];

// the existing rate row: `provenance: 'unverified'` → 'official_price_verified'
// Keep the official model-page URL in source; reconcile invoice usage after the first call.
```

plus one entry in `infra/staging/model-authorization.json`, including `priceSource` with the official
OpenAI model-page URL. The entry must use the same model/rate/approval and `maxPaidSmokeTurns: 1`.

### 7.3 Commands that must be run by a human, once, after A1/A2

```bash
# 1. one paid Turn, evidence to a file
EMBER_MODEL_SMOKE_APPROVAL=L4B-A1 \
  pnpm model:smoke --max-turns=1 --confirm --evidence=docs/evidence/l4b-paid-smoke-01.json

# 2. reconciliation: attempts vs the provider invoice for the same UTC day
psql "$DATABASE_URL" -c \
  "SELECT model_label, rate_version, count(*), sum(observed_micro_usd)
     FROM model_turn_attempts
    WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
    GROUP BY 1,2"

# 3. emergency stop rehearsal
#    flip EMBER_MODEL_EXECUTION to disabled, re-render the env file, restart the worker,
#    submit one Turn, confirm the frozen failure text and zero attempt rows.
```

---

## 8. Test evidence

Full run recorded in §8.3. Every paid-code path in this branch is exercised by a **mock provider** at
the transport boundary: the production adapter builds the request and parses the reply, only `fetch`
is replaced, and the database is real PostgreSQL 17.

### 8.1 `tests/integration/b2-mock-provider.test.ts` (new, 9 cases)

| #   | Scenario               | What is asserted                                                                                                                                                                       |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | success + persistence  | ordered transcript `user → ember`; reply `simulated:false` with the pinned label; `response_message_id` matches; attempt `settled` at 50 µUSD; global bucket `reserved 0, consumed 50` |
| 2   | timeout                | both attempts `unknown_billed` / `model_timeout`; every request signal aborted; reservations still held; no reply published                                                            |
| 3   | cost cap               | worst case > per-attempt ceiling → **zero** provider calls, **zero** attempt rows, **no** spend bucket created at all                                                                  |
| 4   | cancellation           | reply discarded after `cancelTurn`; Turn `cancelled`; charge stands because the request was sent                                                                                       |
| 5   | failure recovery       | 503 then 200 → attempts `unknown_billed → settled`, one reply, Turn `completed`                                                                                                        |
| 6   | auth failure           | 401 is not retried: exactly one attempt, one call, frozen failure reply                                                                                                                |
| 7   | concurrency            | a second concurrent pass returns `busy`, examined 0; one call in total                                                                                                                 |
| 8   | invalid output         | a 200 with no usable body → `model_invalid_output`, no reply published                                                                                                                 |
| 9   | credential containment | no persisted row contains `sk-`; failure messages carry a closed code, never provider text                                                                                             |

### 8.2 Unit coverage added

| File                                            | Cases | Subject                                                                                                                                                                           |
| ----------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/deploy/model-authorization.test.ts` | 22    | guard rule 3/3b: empty/expired/future/malformed/duplicate authorization, ceiling bounds, e2e refusal, unreadable manifest, UTC day, artifact↔code parity, compose secret exposure |
| `tests/unit/model-gateway.test.ts`              | +7    | approval validity states, `approval_not_effective`, `model_shutdown`, pinned `reasoning_effort`, request shape unchanged otherwise                                                |
| `tests/unit/b2-model-turn-responder.test.ts`    | +2    | the concurrency gate: second pass is `busy` and claims/reserves nothing; the gate is released                                                                                     |
| `tests/unit/model-smoke-gate.test.ts`           | 19    | the five smoke preconditions, argument parsing, and every way the evidence verdict can fail                                                                                       |

### 8.3 The run

Measured in this container on the tip of this branch, with PostgreSQL 17 reachable at
`127.0.0.1:55432`. The exact commit is recorded in the PR description rather than here, so this
table cannot go stale when a later commit touches only prose.

| Command                         | Result                                                                | Verdict                            |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `pnpm typecheck`                | clean                                                                 | —                                  |
| ESLint                          | clean on `apps`, `tests`, `infra`, root files and each package        | see the note below                 |
| `pnpm test:unit`                | `86 files`: 84 passed, 2 failed; **1 539 passed / 2 failed of 1 541** | the 2 are pre-existing, see below  |
| `pnpm test:integration`         | `48 files`: 45 passed, 3 failed; **552 passed / 3 failed of 555**     | the 3 are environmental, see below |
| `b2-mock-provider.test.ts`      | **9 / 9**                                                             | this branch's paid-path suite      |
| `b2-model-turn-runtime.test.ts` | **26 / 26**                                                           | B2 runtime, unchanged contract     |

**About `pnpm lint`.** A single `eslint .` cannot finish in this container: it aborts with
`Error: write EPIPE` inside the host's `broker-ipc-client`, which is the same class of sandbox
failure as the two integration tests below, not a lint finding. Splitting the invocation covers the
whole tree instead, and every part is clean — `apps`, `tests`, `infra`, the root config files, and
each of the nine packages run one at a time. Two findings the split did surface were real and were
fixed before this commit: `String()` on an `unknown` column in the smoke CLI (which would have
printed `[object Object]` into an evidence file), and `@ember/model-gateway` missing from
`apps/cli/tsconfig.json` and `apps/cli/package.json`.

Five failures in total, zero of them caused by this branch. Four reproduce on a clean `main@db9fab1`
checkout in the same container, with the same commands and the same database; the fifth is a
30-second timeout that passes when the file is run alone.

| Test                                                              | Failure                                                                                     | Cause                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tests/unit/test-registration-guard.test.ts`                      | a 5 000 ms per-test timeout while scanning the suite                                        | slow scan, wall-clock                                             |
| `tests/unit/local-blob-store.test.ts`                             | "idempotent for concurrent installations" — `Brokered link refused …`                       | the same `fs` shim, same `link()` call                            |
| `tests/integration/http-task-sse.test.ts` → SIGTERM               | `API process did not log "message":"api listening"; API stdout: ; API stderr:`              | the spawned API child writes nothing under this sandbox           |
| `tests/integration/result-commit.test.ts` → 24 concurrent commits | `Brokered link refused because the resolved path could not be revalidated before execution` | the host's `fs` shim refuses `link()` in `LocalBlobStore.install` |
| `tests/integration/benchmark-smoke.test.ts` → CLI entry point     | `Test timed out in 30000ms` under 48 parallel workers                                       | spawn-heavy test; passes alone in 15 s                            |

The last one is worth naming precisely because it is the most alarming to read: it is not Ember's
committer failing, it is the sandbox's brokered filesystem refusing a hardlink that
`packages/postgres/src/storage/local-blob-store.ts:119` issues on purpose, in order to get
no-clobber install semantics. It fails identically on `main`.

Nothing in this branch is covered only by a failing or skipped test: the 9 mock-provider cases, the
22 guard cases, the 19 smoke-gate cases and the +9 gateway/responder cases all pass.

Two of the four failures are the same sandbox bug wearing different clothes: the brokered `fs` shim
refuses `link()`, and both `LocalBlobStore.install`'s no-clobber path and the 24-way concurrent
commit go through it. Neither is Ember misbehaving.

---

## 9. Known limits, stated rather than hidden

**R-1 — the token reservation is an estimate.** GPT-5.6 Luna is pinned to `reasoning_effort: 'none'`,
but the offline tokenizer estimate is not a provider guarantee. The overage incident path remains the
protection if the actual charge exceeds the reservation.

**R-2 — concurrency is not capped across replicas.** N worker containers can make N paid calls at
once, each on a different Turn. The bound is the money ledger plus claim leasing, not a counter. A
distributed semaphore would need its own row; it is not in L4-B.

**R-3 — the approval artifact and the code allowlist are two records of one decision.** A test keeps
them in step, but they are still two edits. Collapsing them would require the guard to import
TypeScript, which it cannot do on a host without a toolchain.

**R-4 — the first-call price source is the official published model page.** Project access, regional
availability and provider-side spend settings must be confirmed before the smoke; reported usage is
reconciled against billing afterward.

**R-5 — the smoke test asserts a Turn the database reports, not a charge the provider confirms.**
Reconciliation against billing is a manual step in §7.3 and stays manual.

---

## 10. Scope discipline

| Not done                    | Why                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| No B1 contract change       | `assistant_turns`, its statuses, the 60 s deadline and the transcript are B1's and frozen |
| No migration                | `0014`/`0015` already carry every column this branch needs                                |
| No Agent tool execution     | The gateway still has no tools, no streaming and no second operation                      |
| No Daytona                  | Unrelated capability; `DAYTONA_*` remains refused by the guard in every mode              |
| No second provider          | Doubles credential, egress and retention review for zero Alpha value                      |
| No `fake` → `real` fallback | A process that cannot deliver what it was configured for must be dead and visible         |
| `real` **not enabled**      | A1/A2 are unsigned. The gate ships; the permission does not                               |
