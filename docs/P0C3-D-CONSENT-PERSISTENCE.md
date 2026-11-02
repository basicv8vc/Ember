# P0-C3D Durable Consent Authority — Delivery Report

Status: **implementation complete, PR #84 open for CTO review (Draft).**
Contract: [`docs/P0C3-C-CONSENT-CONTRACT.md`](./P0C3-C-CONSENT-CONTRACT.md) (frozen, merged in PR #83).
Migrations: `migrations/0009_p0c3b_runtime_closure.sql` (P0-C3B, inherited with the Worker runtime) then
`migrations/0010_p0c3d_consent.sql` (this PR). No renumbering.

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
| 5. Migration coordination                                        | `0009` (C3B) + `0010` (C3D) in this PR; no renumbering; #62 superseded and closed unmerged   |
| 6. Integrated Worker runtime (PR #62)                            | #62's head is an ancestor of this branch; the durable store is wired into its gates          |

Round-3 follow-ups requested by the CTO after the Round-2 review, both landed here:

| Finding                                                                  | Resolution                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Concurrent identical `grant()` calls could both answer `replayed: false` | the replay verdict is now computed from the row the single write transaction locked  |
| `isReadAuthorized()` promised operation+scope but only checked status    | it now delegates to `evaluateConsent()`, and its application-clock parameter is gone |

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

| File                                                              | Role                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/contracts/src/consent.ts`                               | the frozen contract (single source of truth)                                              |
| `packages/contracts/src/consent-schemas.ts`                       | `ConsentAuthority`, `ConsentEvaluator`, `ConsentRepository`, DTO schemas                  |
| `packages/postgres/src/repositories/consent-repository.ts`        | durable authority: grant / revoke / get / list / `resolveGeneration`                      |
| `packages/postgres/src/repositories/consent-fence.ts`             | shared SQL projection, expiry derivation, `evaluateConsentRow`, denial diagnostics        |
| `packages/postgres/src/repositories/consent-publication-guard.ts` | transaction-scoped dispatch + publication gates (locks on the caller's client)            |
| `packages/postgres/src/repositories/commitment-repository.ts`     | lock order, dispatch fence write, publication transaction, fence-less recovery            |
| `apps/worker/src/commitment-consent.ts`                           | worker gate helpers (`evaluateSchedulerConsentGate`, `requireCommitmentConsentAuthority`) |
| `apps/worker/src/index.ts`                                        | composition root: one authority arms every gate                                           |
| `apps/worker/src/commitment-source-reader.ts`                     | pre-read / post-read fence re-verification around the guarded read                        |
| `migrations/0010_p0c3d_consent.sql`                               | `consent_grants` + occurrence fence columns                                               |

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

### 4.6 Replay is decided inside the write transaction

`grant()` used to read the row before the write transaction and compare it with the result afterwards.
That read is not the decision: two simultaneous identical grants both observed "no prior grant", and
because a missing row cannot be locked with `FOR UPDATE`, both attempted the insert. PostgreSQL
serialised them — but the loser surfaced a unique violation as `DB_UNAVAILABLE` while the survivor
reported a fresh generation, so `replayed` was a property of the caller's timing rather than of the
write.

The write path is now one transaction (`applyGrant`) that locks, decides and mutates:

1. `SELECT … FOR UPDATE` on the lineage.
2. If the row is absent, `INSERT … ON CONFLICT (tenant_id, source_profile_id) DO NOTHING`. A `rowCount`
   of `0` means another transaction created it; the loser re-reads that row and continues.
3. Identical terms on a still-effective generation → `replayed: true`, same `(grantId, version)`,
   nothing written.
4. Anything else (changed terms, revoked, expired, or a lost insert race that produced different
   terms) → `UPDATE` mints a new `grantId` and `version + 1`.

`tests/integration/p0c3d-consent-postgres.test.ts` → `P0-C3D: concurrent grant replay (two connections)`
holds a first insert open on one connection and proves the other request blocks and then answers
`replayed: true` with the winner's generation; a second case launches two identical `grant()` calls at
once and requires exactly one non-replay, one row, `version = 1`. Against the previous implementation
both cases fail with `DB_UNAVAILABLE` (unique violation) — the local evidence is recorded in §9.

### 4.7 The read gate is the authoritative read

`isReadAuthorized(tenantId, sourceProfileId)` is a convenience predicate over `evaluateConsent()`, so
"authorized" means there what it means on the guarded read path: the `read_snapshot` operation is
granted, the `source.readonly` scope is present, and expiry is derived from `is_expired` — computed in
SQL against `clock_timestamp()`. The method takes **no** clock argument: an application clock may not
extend or shrink an authorization boundary. Its previous version checked status only (answering `true`
for an `active` grant that lacked the read scope) and compared `expires_at` against `new Date()`.

---

## 5. Worker wiring: one authority, every gate

`apps/worker/src/index.ts` builds **one** durable authority and hands it to every consumer:

```ts
const consentStore = new PostgresConsentRepository(pool);
// The connector boundary evaluates `allowedOperations`/`scopes` against the SAME persistence the
// generation was resolved from, so no Worker-side copy of the terms can authorize a read.
const consentGrants = {
  get: (tenantId: string, sourceProfileId: SourceProfileId, now?: Date) =>
    consentStore.getForTenant(tenantId, sourceProfileId, now),
};
const consentAuthority = fromResolvedGenerationConsent(consentStore, { grants: consentGrants });
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

PR #62's own `createCommitmentConsentPublicationGuard` was **deleted** in this integration. It called
`assertActive()` before the append transaction and could not see the `client` the repository hands to
a guard, so it could not prove the generation was still current at write time; it existed only because
#62 had no durable guard. Keeping it would have left a seam whose name suggests atomicity it did not
have. Publication denial is covered by the durable guard's integration tests instead.

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

### 7.1 Concurrent grant replay (write-side race)

Same file, `P0-C3D: concurrent grant replay (two connections)`. These are the CTO's Round-3 case: two
requests that arrive together must not both believe they created the generation.

| Test                                                                        | Shape                                                                                                        | Asserted outcome                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `resolves a lost first-insert race as a replay …`                           | connection A inserts the lineage row and does not commit; `grant()` on connection B blocks on the unique key | B is unresolved while A holds the row; after A commits B answers `replayed: true` with A's `grantId`, `version` 1; exactly one row |
| `answers exactly one replay when two identical grants arrive at once`       | two `grant()` calls on independent pool clients, started together                                            | exactly one `replayed: false`, identical `grantId`/`version` in both, one row, `version = 1`                                       |
| `still mints a new generation when the terms change, even under contention` | grant, then a widened grant, then the same terms in a different order                                        | widened → new `grantId`, `version + 1`, `replayed: false`; reordered identical terms → `replayed: true`                            |

Local before/after, both gates observed on this branch:

| Implementation                                    | `lost first-insert race`                                    | `two identical grants at once` |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| pre-fix (`HEAD~`, pre-merge `consent-repository`) | **FAIL** — `DomainError: DB_UNAVAILABLE` (unique violation) | **FAIL** — same error          |
| this branch                                       | **PASS**                                                    | **PASS**                       |

### 7.2 Read-gate discrimination

`answers isReadAuthorized with the whole decision, not just the status` fails against the previous
implementation (`expected true to be false`: an `active` grant that carries `source.readwrite` but not
`source.readonly` was reported as authorizing a read) and passes now. The companion case asserts the
gate flips to `false` when the row's `expires_at` is elapsed in the database, and there is no clock
parameter through which a caller could argue otherwise.

---

## 8. Migration coordination

| PR            | Migrations it ships                                               | Status                                            |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| #84 (this PR) | `0009_p0c3b_runtime_closure.sql` **and** `0010_p0c3d_consent.sql` | lands first                                       |
| #62 (Agent B) | none of its own — its `0009` is already here                      | superseded by #84; close it instead of merging it |

The agreed merge order was "#84 first, then #62 with the `0009` → `0011` renumber". That renumber is
now **dropped**, and it has to be: `0009_p0c3b_runtime_closure.sql` in this PR and the `0011` file on
#62's branch are byte-identical (two partial indexes on `commitment_occurrences`). Applying both would
repeat the same index-only DDL under a new id. Since this branch contains #62's work — verified with
`git merge-base --is-ancestor <62-head> HEAD` — there is nothing left for #62 to land.

1. #84 lands with `0009` + `0010`; main then contains the P0-C3B indexes and the Consent schema.
2. #62 is **closed as superseded**, not merged: merging it afterwards would either be empty or drag
   the `0011` duplicate back in.

`0010` is order-independent regardless: it never assumes `0009` is applied, and the runner requires
unique, strictly increasing ids while tolerating an out-of-order backfill.
`tests/integration/migrations.test.ts` covers 10 applied migrations, the `schema_migrations` version
count, the idempotent replay, the **normal** `0009` → `0010` order, and the **out-of-order** case where
`0010` was already applied and `0009` is backfilled behind it.

---

## 9. Verification (local, real PostgreSQL 17.11)

| Gate                                | Command                                             | Result                                |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------- |
| Formatting                          | `pnpm format:check`                                 | **0** — all files formatted           |
| Lint                                | `pnpm lint`                                         | **0** — no errors, no warnings        |
| Typecheck (strict)                  | `pnpm typecheck`                                    | **0**                                 |
| Build                               | `pnpm build`                                        | **0**                                 |
| Unit                                | `pnpm test:unit`                                    | **0** — 70 files, 1184 tests          |
| Integration (real PostgreSQL)       | `pnpm test:integration`                             | **0** — 35 files, 364 tests           |
| Chaos (real PostgreSQL)             | `pnpm test:chaos`                                   | **0** — 6 files, 30 tests             |
| End-to-end (real HTTP + PostgreSQL) | `pnpm test:e2e`                                     | **0** — 9 files, 18 tests             |
| Demo CLI smoke                      | `pnpm demo --scenario fast`                         | **0** — Fast Path PASS                |
| Migration from a clean database     | `DATABASE_URL=<fresh> pnpm db:migrate`              | **0** — 10 applied, 0 already applied |
| Migration idempotency (re-run)      | `DATABASE_URL=<fresh> pnpm db:migrate`              | **0** — 0 applied, 10 already applied |
| Consent suites in isolation         | `… p0c3d-consent-postgres p0c3b-consent-dependency` | **0** — 21 tests                      |

Round-3 evidence: the two new grant cases and the two read-gate cases were run against the _previous_
`consent-repository.ts` (`git show HEAD~:…`) and fail there (§7.1/§7.2); they pass on this branch.
`pnpm` is not installed in this environment, so the equivalent commands were invoked directly
(`npx prettier --check .`, `npx eslint . --max-warnings=0`, `npx tsc -p tsconfig.json --noEmit`,
`npx tsc -b tsconfig.build.json`, `vitest run --config vitest.<suite>.config.ts`).

CI evidence (workflow `Verify (Node 24 LTS + PostgreSQL 17)`, 10 steps: Lint, Check formatting,
Typecheck, Unit, Build, Migrate ×2, Integration, Chaos, E2E, Demo CLI smoke):

| Field           | Value                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Code commit     | `514cd151dfa5d31f6f40f95bcbcffbea1332718a` (implementation + this report + migration comments)                                                |
| Base SHA        | `14a3f30fd2e48501dfe941747b9ab5b916878932` (`main`, PR #83)                                                                                   |
| Run 1 (code)    | [`41442921738`](https://github.com/basicv8vc/Ember/actions/runs/41442921738) — **PASS**                                                       |
| Run 2 (docs)    | [`41443602008`](https://github.com/basicv8vc/Ember/actions/runs/41443602008) — **PASS**                                                       |
| Run 3 (docs)    | [`41444213883`](https://github.com/basicv8vc/Ember/actions/runs/41444213883) — **PASS**                                                       |
| Run 4 (docs)    | [`41444960256`](https://github.com/basicv8vc/Ember/actions/runs/41444960256) — **PASS**                                                       |
| Run 5 (round 3) | [`41452775221`](https://github.com/basicv8vc/Ember/actions/runs/41452775221) — **PASS** on `2d46c93` (replay fix, read gate, #62 integration) |

Every local gate above ran on the code commit. Runs 2–4 cover commits that change documentation and SQL
comments only (`0cb03d6`, `8dd0459`, `7f0d6be`); run 5 covers the Round-3 code and integration changes.
Live status is `gh pr checks 84`.

---

## 10. Limitations and follow-ups

1. **Fence-less occurrences are terminal.** Any occurrence dispatched before `0010` cannot be
   repaired, only failed. This is deliberate, and it means a deployment that already has dispatched
   occurrences must expect those Tasks to end `failed` rather than published.
2. **Duplicate guard parameter shapes — resolved.** `ConsentGuardParams` was declared both in
   `apps/worker/src/commitment-consent.ts` and in `tests/integration/support/consent-test-double.ts`.
   The worker declaration is gone with the deleted guard factory, so the repository's
   `ConsentPublicationGuard` is the only shape.
3. **The in-memory test double stays.** `InMemoryTestConsentAuthority` is used only by integration
   scenarios that are not about consent; the revocation claims in this document are backed by
   `PostgresConsentPublicationGuard` against real row locks, never by the double. Its publication guard
   now implements the same `authorizeFence` / `assertFenceCurrent` contract as the durable one (`null`
   fence denied, generation compared), so the commitment suites cannot pass under a weaker gate than
   production.
4. **`evaluateConsent` is advisory.** It is a lock-free read used for pre-read decisions and
   diagnostics. The authoritative decision is always the one taken inside the publication
   transaction; nothing may treat a successful `evaluateConsent` as permission to publish.
5. **No Consent UI/HTTP surface changes.** The API contract for grant/revoke was not extended in this
   PR; only the persistence semantics behind it changed.
