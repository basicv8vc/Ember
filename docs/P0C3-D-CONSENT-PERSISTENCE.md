# P0-C3D Durable Consent Authority — Delivery Report

Status: **implementation complete, PR #84 open for CTO review.**
Contract: [`docs/P0C3-C-CONSENT-CONTRACT.md`](./P0C3-C-CONSENT-CONTRACT.md) (frozen, merged in PR #83).
Migration: `migrations/0010_p0c3d_consent.sql`.

---

## 1. Executive summary

PR #84 turns Source Consent from a process-local policy object into a **durable, authoritative
PostgreSQL record** that can both authorize a source read and refuse Outcome publication after a
revocation.

| CTO Round-2 requirement                                          | Where it landed                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Official `ConsentAuthority.resolveGeneration`                 | `PostgresConsentRepository implements ConsentRepository, ConsentEvaluator, ConsentAuthority` |
| B. Generation identity `(grantId, version)`, not `version` alone | `UPDATE_CONSENT_SQL` mints a new `id` on every changed re-grant (version + 1)                |
| C. Persist the complete generation binding                       | `commitment_occurrences.consent_grant_id` + `consent_version` with a coherence CHECK         |
| 3. Transaction-level publication security                        | `PostgresConsentPublicationGuard`, invoked inside the publication transaction                |
| 4. Conformance + adversarial races                               | `assertConsentConformance(postgresAdapter)` C-01…C-13 plus two-connection race tests         |
| 5. Migration coordination                                        | `0010` here; PR #62 renumbers its `0009` to `0011` when it lands second                      |

The single security property this delivery buys, stated plainly:

> An Outcome can only be published by the generation of consent that authorized the read which
> produced it, and only while that exact generation is still effective — evaluated inside the same
> transaction and against the same row lock that a revocation must take.

---

## 2. Architecture

### 2.1 One contract, three faces

The frozen contract lives **once**, in `@ember/contracts/src/consent.ts`. `@ember/connectors` and
`@ember/execution` are re-export boundaries only, so the Worker, the HTTP surface and the PostgreSQL
store can never disagree about status precedence, fence comparison or the digest domain.

`PostgresConsentRepository` (`packages/postgres/src/repositories/consent-repository.ts`) implements
all three faces of that one contract:

| Face                | Method(s)                                                                | Consumer                                      |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| `ConsentAuthority`  | `resolveGeneration(tenantId, sourceProfileId, now?)`                     | Worker gates, dispatch gate, publication gate |
| `ConsentEvaluator`  | `evaluateConsent(tenantId, sourceProfileId, operation, fence?)`          | pre-read diagnostics (read-only, no lock)     |
| `ConsentRepository` | `grant` / `revoke` / `get` / `list` (tenant from verified `AuthContext`) | HTTP admin surface                            |

`get()` and `resolveGeneration()` are **not** independent queries. `resolveGeneration()` delegates to
the same private read (`getForTenant`) that `get()` uses, against the same pool, with the same column
projection and the same `clock_timestamp()` expiry derivation. There is no read replica, no cache and
no second authority that could let the two answers diverge.

### 2.2 Generation identity

`consent_grants` is keyed by the lineage `(tenant_id, source_profile_id)` and carries a mutable `id`
plus a monotonic `version`. The `id` **is** the C3C `grantId`.

| Transition                            | Effect on `id`     | Effect on `version` |
| ------------------------------------- | ------------------ | ------------------- |
| First grant                           | new `id`           | `1`                 |
| Identical re-grant while effective    | unchanged (replay) | unchanged           |
| Changed terms (ops / scopes / expiry) | **new `id`**       | `+1`                |
| Re-grant after revoke or expiry       | **new `id`**       | `+1`                |
| Revocation                            | unchanged          | `+1`                |
| Repeated revocation                   | unchanged          | unchanged           |

Replaying a _dead_ generation would be the dangerous shortcut, so it is not taken: a fence that
compares `grantId` first can never be satisfied by a resurrected row. `version` alone cannot
distinguish "still current" from "revoked and re-granted", which is why the fence is a pair.

### 2.3 Files

| File                                                              | Role                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/contracts/src/consent.ts`                               | the frozen contract (single source of truth)                                       |
| `packages/contracts/src/consent-schemas.ts`                       | `ConsentAuthority`, `ConsentEvaluator`, `ConsentRepository`, DTO schemas           |
| `packages/postgres/src/repositories/consent-repository.ts`        | durable authority: grant / revoke / get / list / `resolveGeneration`               |
| `packages/postgres/src/repositories/consent-fence.ts`             | shared SQL projection, expiry derivation, `evaluateConsentRow`, denial diagnostics |
| `packages/postgres/src/repositories/consent-publication-guard.ts` | transaction-scoped dispatch + publication gates (locks on the caller's client)     |
| `packages/postgres/src/repositories/commitment-repository.ts`     | lock order, dispatch fence write, publication transaction, fence-less recovery     |
| `apps/worker/src/commitment-consent.ts`                           | worker gate helpers (`evaluateSchedulerConsentGate`, guard factory)                |
| `apps/worker/src/index.ts`                                        | composition root: one authority arms every gate                                    |
| `apps/worker/src/commitment-source-reader.ts`                     | pre-read / post-read fence re-verification around the guarded read                 |
| `migrations/0010_p0c3d_consent.sql`                               | `consent_grants` + occurrence fence columns                                        |

---

## 3. Schema

### 3.1 `consent_grants`

```
id                      uuid PRIMARY KEY,                -- the C3C grantId
tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
source_profile_id       text NOT NULL,
status                  text NOT NULL DEFAULT 'active',  -- 'active' | 'revoked'
allowed_operations      text[] NOT NULL,
scopes                  text[] NOT NULL DEFAULT '{source.readonly}',
granted_by_principal_id uuid,
granted_at              timestamptz NOT NULL,
expires_at              timestamptz,
revoked_at              timestamptz,
revoked_by_principal_id uuid,
version                 integer NOT NULL DEFAULT 1,
created_at, updated_at  timestamptz NOT NULL,
UNIQUE (tenant_id, source_profile_id),
UNIQUE (tenant_id, id)
```

Invariants enforced by the database, not by convention:

- **Authority facts only.** There is no column for a token, cookie, key or password, and none may be
  added: a consent row is a permission, not a secret store.
- **Tenant isolation is structural.** `tenant_id` on every row, composite `(tenant_id, …)` foreign
  keys to `tenants` and `principals`, and every repository statement re-scoped by `tenant_id`.
  Another tenant's grant is reported exactly like a missing one.
- **`expired` is never stored.** Only `active` and `revoked` exist as values; `expired` is derived at
  read time from `expires_at <= clock_timestamp()`. An expiry therefore cannot go stale in a column,
  and no background job is needed to "apply" it.
- **Coherence checks.** `expires_at > granted_at`, `version >= 1`, a bounded operation vocabulary
  (≤ 4 labels from `read_snapshot | publish_outcome | read_metadata`), bounded scopes, and
  `status` / `revoked_at` / `revoked_by` coherence.
- **Operation labels stay open within bounds.** A grant for a _different_ capability must be storable
  (C-05 requires such a grant to exist and to deny a `read_snapshot`), so the check bounds the label
  rather than special-casing `read_snapshot` alone.

### 3.2 Occurrence fence

`migrations/0010_p0c3d_consent.sql` adds, to `commitment_occurrences`:

```
consent_grant_id text,
consent_version  integer,
CHECK ((consent_grant_id IS NULL) = (consent_version IS NULL)),
CHECK (consent_version IS NULL OR consent_version >= 1)
```

Both columns are written in the **same** statement that flips the occurrence to `dispatched`, so a
dispatched occurrence either carries a complete generation or the write never happens. The
null-equals-null coherence check makes a half-written fence impossible even for a hand-written

---

## 4. Transaction semantics

### 4.1 The one lock order

Every writer in `PostgresCommitmentRepository` takes row locks in the same order:

```
commitments -> commitment_occurrences -> tasks -> runs -> consent_grants
```

Dispatch (`dispatchOccurrence`) and publication (`appendOutcomeIfAbsent`) both follow it, and so do
`cancel()`, `pause()`, `reserveOccurrence()` and terminalization. A single global order is what makes
a wait cycle impossible, and it is why `commitments` is locked first: a cancellation that wins that
lock is always _observed_ by a publisher, never raced past.

### 4.2 Publication, step by step

`appendOutcomeIfAbsent()` runs entirely inside **one** `withTransaction(this.pool, …)` callback, on
**one** pooled client — no second connection, no nested transaction, no post-commit re-check:

1. `SELECT … FROM commitments … FOR UPDATE` — lock the commitment, read its `source_profile_id`
   (never from the caller) and its `status`.
2. `SELECT … FROM commitment_occurrences … FOR UPDATE` — lock the occurrence, require
   `task_id = grant.taskId`, read the recorded fence.
3. `SELECT … FROM tasks … FOR UPDATE` — require `status = 'running'`.
4. Lock the `runs` row and let PostgreSQL decide the whole fencing verdict: worker ownership, lease
   epoch and `lease_expires_at > clock_timestamp()` are compared in SQL.
5. `SELECT … FROM consent_grants … FOR UPDATE` (`PostgresConsentPublicationGuard.assertFenceCurrent`,
   same client) — evaluate status/expiry with `clock_timestamp()`, then compare the recorded
   `(grantId, version)` pair against the locked row.
6. `INSERT INTO commitment_outcomes … ON CONFLICT (occurrence_id) DO NOTHING`.
7. `UPDATE commitment_occurrences SET status = <terminal>` and, for a `once` schedule, terminalize
   the commitment — in the same transaction.

Steps 1–5 all happen before step 6, so a denial is a rollback of the whole thing: **zero** Outcome
rows and no partial Occurrence transition. Failure modes are `POLICY_DENIED` (consent, commitment
status), `INVALID_STATE_TRANSITION` (task/occurrence already terminal), `NOT_FOUND`, and
`INVALID_ARGUMENT` (occurrence/task mismatch).

### 4.3 The two consent races

The guard reads with `FOR UPDATE` inside the publisher's transaction. That single fact makes both
orderings decidable:

- **Revocation wins the lock.** The publisher's `FOR UPDATE` waits for the revoking transaction, then
  observes `status = 'revoked'` (or a bumped `version`, or a new `grantId`). Publication fails closed.
- **Publication wins the lock.** The revocation waits; the Outcome commits against the generation
  that was current when the read was authorized. A revocation that lands afterwards is real and
  permanent, but it cannot retract an already-authorized write.

A plain `SELECT` under `READ COMMITTED` would have allowed the publisher to read a snapshot taken
before the revoke committed, so the lock is load-bearing, not decorative.

### 4.4 Denials

`evaluateConsentRow` is the single, side-effect-free verdict used by the API, the dispatch gate and
the publication gate. Specific reasons win over the generic fence verdict so an operator can tell
them apart:

| `denialCode`                  | Meaning                                                        | Gates       |
| ----------------------------- | -------------------------------------------------------------- | ----------- |
| `CONSENT_NOT_FOUND`           | no grant for this lineage (or it belongs to another tenant)    | all         |
| `CONSENT_REVOKED`             | grant revoked                                                  | all         |
| `CONSENT_EXPIRED`             | derived expiry elapsed                                         | all         |
| `OPERATION_NOT_ALLOWED`       | grant does not carry `read_snapshot`                           | read gates  |
| `SCOPE_NOT_GRANTED`           | grant does not carry `source.readonly`                         | read gates  |
| `CONSENT_FENCE_MISSING`       | occurrence records no generation                               | publication |
| `CONSENT_GENERATION_MISMATCH` | a different `grantId` is authoritative now (revoke + re-grant) | publication |
| `CONSENT_FENCE_STALE`         | same `grantId`, higher `version` (revocation or changed terms) | publication |

Every denial surfaces as `DomainError('POLICY_DENIED')` with a fixed public message; the reason stays
in the diagnostic, and no consent content, token or scope list reaches the client.

### 4.5 Fence-less occurrences are terminal, never re-dispatched

An occurrence that was dispatched _before_ the fence existed records no generation. Nothing can prove
which consent authorized a read that may already have happened, so:

- `dispatchOccurrence()` refuses to re-bind it (`POLICY_DENIED`), instead of "refreshing" the fence
  from the current grant;
- `failUnverifiableOccurrences(limit)` terminalizes such rows as `failed`, so they leave the retry
  path permanently.

"The grant happens to be active right now" is never accepted as proof that _this_ read was
authorized by it — that shortcut is precisely how a read would be laundered across generations.

`UPDATE`.

---

## 5. Worker wiring: one authority, every gate

`apps/worker/src/index.ts` builds **one** durable authority and hands it to every consumer:

```ts
const consentAuthority = fromResolvedGenerationConsent(new PostgresConsentRepository(pool));
const consentPublicationGuard = new PostgresConsentPublicationGuard();
const consentGate = evaluateSchedulerConsentGate(consentAuthority);
```

| Gate                          | Where                                                   | Behaviour without consent                                |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Scheduler startup             | `evaluateSchedulerConsentGate` (commitment-consent.ts)  | scheduler refuses to start (fail closed)                 |
| Pre-read fence capture        | `CommitmentOrchestrator` (`consent.authorizeFence`)     | no read is attempted                                     |
| Pre/post-read re-verification | `CommitmentSourceReader` (`assertFenceCurrent`)         | `POLICY_DENIED`; the Task fails and nothing is published |
| Dispatch + publication        | `PostgresConsentPublicationGuard` inside the repository | occurrence not bound, Outcome not written                |

There is no deny-all placeholder and no "active-only" fallback in the production path: if the
`consent_grants` row is missing, nothing is read and nothing is published. `consentReady` and
`consentReadiness` are logged at startup so an operator can see the state instead of guessing.

The default guard (`MISSING_CONSENT_PUBLICATION_GUARD`) still exists for exactly one purpose: a
repository constructed _without_ a consent authority must fail closed rather than half-bind work.
`tests/integration/p0c3b-consent-dependency.test.ts` locks that in against real PostgreSQL:
`appendOutcomeIfAbsent` and `findAuthoritativeOutcome` reject with `POLICY_DENIED` and write no row,
and `markDispatched` rejects while the occurrence stays `pending` with `task_id = null`.

---

## 6. C-01 … C-13 conformance evidence (real PostgreSQL)

Command:

```
node --env-file-if-exists=.env.local ./node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts tests/integration/p0c3d-consent-postgres.test.ts --reporter=verbose
```

The test builds the official `ConsentConformanceAdapter` over `PostgresConsentRepository` and calls
`assertConsentConformance(adapter)`. The adapter translates only _tenant identity_ (the suite uses
synthetic lineage ids, the table stores real `uuid` rows with a foreign key); every semantic
assertion runs against the database.

| Case | Requirement                                 | What the durable store did                                                             |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| C-01 | `R1-missing-grant-denies`                   | `get`/`resolveGeneration` return `null`; decision is `CONSENT_NOT_FOUND`               |
| C-02 | `R2-revocation-is-terminal`                 | revoke denies, `version` +1 once, second revoke replays with the same `revokedAt`      |
| C-03 | `R3-expiry-is-derived`                      | `expired` derived from `expires_at`; the row is never rewritten                        |
| C-04 | `R4-tenant-isolation`                       | tenant B sees tenant A's grant as absent; writes stay inside the tenant                |
| C-05 | `R5-scope-and-operation-binding`            | missing scope → `SCOPE_NOT_GRANTED`; other operation → `OPERATION_NOT_ALLOWED`         |
| C-06 | `R6-regrant-mints-new-generation`           | changed terms → new `grantId`, `version` +1                                            |
| C-07 | `R7-generation-fence-binding`               | stale `grantId` / `version` denied; current pair allowed                               |
| C-08 | `R8-version-monotonicity`                   | version strictly increases across the lineage, never reused                            |
| C-09 | `R9-reaffirmation-is-idempotent`            | identical re-grant replays the same `grantId` and `version`                            |
| C-10 | `R10-fail-closed-on-invalid-input`          | malformed tenant/profile/clock fail closed without leaking which part was invalid      |
| C-11 | `R11-records-are-immutable`                 | mutating a returned record does not change stored status/ops/version; reads are stable |
| C-12 | `R12-list-scope-and-determinism`            | `list` is tenant-scoped and ordered by `source_profile_id`                             |
| C-13 | `R13-policy-grant-is-the-fenced-generation` | the generation the policy evaluated is the one the fence carries                       |

Result: `13/13 passed` (`P0-C3D: PostgreSQL consent conformance (C-01..C-13)` — 63 ms). The test also
asserts the case ids come back in order `C-01 … C-13`, so a silently skipped case cannot pass.

---

## 7. Revocation-race evidence (two independent connections)

`tests/integration/p0c3d-consent-postgres.test.ts` → `P0-C3D: consent races against real row locks`.
`createTestDatabase()` provides a pool of 12 connections; each race test takes a **separate**
`db.pool.connect()` client for the competing transaction while the repository uses its own, so the
contention is between two real backends, not two promises on one connection.

| Test                                                                                      | Shape                                                                                                                    | Asserted outcome                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `denies publication when the revocation commits first`                                    | competing tx revokes and parks the consent row; publication starts and blocks; competing tx commits                      | publisher waits (>250 ms), then `POLICY_DENIED`; 0 outcomes               |
| `publishes when the authorization wins the row lock, and a later revoke does not undo it` | competing tx holds the row with `FOR UPDATE` without changing it; publication starts and blocks; competing tx rolls back | publication succeeds, exactly 1 outcome; a later revoke cannot retract it |
| `denies publication after a committed revocation (ordered case)`                          | revoke commits fully, then publication is attempted                                                                      | `POLICY_DENIED`; no outcome                                               |

Additional adversarial coverage in the same file:

| Test                                                                        | Asserted outcome                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `refuses and terminalizes an occurrence with no recorded generation`        | `POLICY_DENIED`, 0 outcomes, occurrence ends `failed` — never re-dispatched        |
| `refuses publication under a superseded generation after revoke + re-grant` | consent is _active again_ but the generation differs → `POLICY_DENIED`, 0 outcomes |
| `refuses to dispatch an occurrence when the grant lacks the read scope`     | occurrence stays `pending`, `task_id` stays `null`                                 |
| `records the generation on the occurrence at dispatch`                      | `consent_grant_id` / `consent_version` equal the authoritative generation          |
| `mints a new grantId and a greater version on an explicit re-grant`         | new `grantId`, `version` +1                                                        |
| `replays an identical reaffirmation without minting a generation`           | same `grantId`, same `version`                                                     |

---

## 8. Migration coordination

| PR            | Migration                                              | Note                                                                   |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| #84 (this PR) | `0010_p0c3d_consent.sql`                               | lands first; creates `consent_grants` and the occurrence fence columns |
| #62 (Agent B) | `0009_p0c3b_runtime_closure.sql`, renumbered to `0011` | lands second; index-only, so the renumber is safe                      |

`0010` does not assume `0009` is already applied: it touches only its own objects, and the runner
requires unique, strictly increasing ids while tolerating an out-of-order backfill. Both orders are
exercised by `tests/integration/migrations.test.ts`, which asserts 10 applied migrations, the
`schema_migrations` version count, and the replay behaviour.

---

## 9. Verification (local, real PostgreSQL 17.11)

| Gate                                | Command                                             | Result                                |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------- |
| Formatting                          | `pnpm format:check`                                 | **0** — all files formatted           |
| Lint                                | `pnpm lint`                                         | **0** — no errors, no warnings        |
| Typecheck (strict)                  | `pnpm typecheck`                                    | **0**                                 |
| Build                               | `pnpm build`                                        | **0**                                 |
| Unit                                | `pnpm test:unit`                                    | **0** — 70 files, 1179 tests          |
| Integration (real PostgreSQL)       | `pnpm test:integration`                             | **0** — 35 files, 354 tests           |
| Chaos (real PostgreSQL)             | `pnpm test:chaos`                                   | **0** — 6 files, 30 tests             |
| End-to-end (real HTTP + PostgreSQL) | `pnpm test:e2e`                                     | **0** — 9 files, 18 tests             |
| Demo CLI smoke                      | `pnpm demo --scenario fast`                         | **0** — Fast Path PASS                |
| Migration from a clean database     | `DATABASE_URL=<fresh> pnpm db:migrate`              | **0** — 10 applied, 0 already applied |
| Migration idempotency (re-run)      | `DATABASE_URL=<fresh> pnpm db:migrate`              | **0** — 0 applied, 10 already applied |
| Consent suites in isolation         | `… p0c3d-consent-postgres p0c3b-consent-dependency` | **0** — 16 tests                      |

CI evidence (workflow `Verify (Node 24 LTS + PostgreSQL 17)`, 10 steps: Lint, Check formatting,
Typecheck, Unit, Build, Migrate ×2, Integration, Chaos, E2E, Demo CLI smoke):

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Code commit | `514cd151dfa5d31f6f40f95bcbcffbea1332718a` (implementation + this report + migration comments) |
| Base SHA    | `14a3f30fd2e48501dfe941747b9ab5b916878932` (`main`, PR #83)                                    |
| Run         | [`41442921738`](https://github.com/basicv8vc/Ember/actions/runs/41442921738) — **PASS**        |

Every local gate above ran on that same commit. Commits after it change documentation only; live
status is `gh pr checks 84`.

---

## 10. Limitations and follow-ups

1. **Fence-less occurrences are terminal.** Any occurrence dispatched before `0010` cannot be
   repaired, only failed. This is deliberate, and it means a deployment that already has dispatched
   occurrences must expect those Tasks to end `failed` rather than published.
2. **Duplicate guard parameter shapes.** `ConsentGuardParams` is declared in both
   `apps/worker/src/commitment-consent.ts` and `tests/integration/support/consent-test-double.ts`.
   They are structurally identical and the test double lives outside the shipped surface, but a
   future change should re-export the worker type instead of re-declaring it.
3. **The in-memory test double stays.** `InMemoryTestConsentAuthority` is used only by integration
   scenarios that are not about consent; the revocation claims in this document are backed by
   `PostgresConsentPublicationGuard` against real row locks, never by the double.
4. **`evaluateConsent` is advisory.** It is a lock-free read used for pre-read decisions and
   diagnostics. The authoritative decision is always the one taken inside the publication
   transaction; nothing may treat a successful `evaluateConsent` as permission to publish.
5. **No Consent UI/HTTP surface changes.** The API contract for grant/revoke was not extended in this
   PR; only the persistence semantics behind it changed.
