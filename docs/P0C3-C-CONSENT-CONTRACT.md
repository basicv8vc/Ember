# Ember P0-C3C — Consent Contract & Security Conformance

## 1. Executive Summary

- **Agent**: Coding Agent C (`@ember/connectors` Trust Boundary Engineer)
- **Component**: `@ember/connectors` (`packages/connectors/`)
- **Git reference baseline**:
  - Base commit: `a7842f2b2d6fde09ceb27d8dae41d7c2d8ac67bb` (`main`)
  - Branch: `feature/p0c-3c-consent-security`
  - Worktree: `/Users/a1-6/Downloads/Ember-p0c3c`
  - Mode: standalone worktree, Draft PR only
- **Deliverables in this change set**:
  1. Frozen consent lifecycle semantics (`grant` / re-affirmation / `revoke` / derived expiry).
  2. Versioned **authorization fence** (`tenantId`, `sourceProfileId`, `grantId`, `grantVersion`,
     `issuedAt`, `digest`) with an authority-backed validator.
  3. `GuardedSourceReader` fence enforcement on **both** sides of the read (pre-read gate + post-read
     re-verification), fail-closed on any unverifiable input, plus **generation binding** (§4.5):
     the grant whose `allowedOperations` / `scopes` policy evaluates must **be** the fenced
     generation — checked before dispatch and again after the read.
  4. Rewritten `FakeConsentRegistry` implementing the frozen contract as an explicitly test-only
     double.
  5. A framework-free, I/O-free **conformance kit** (`consent-conformance.ts`) with 13 cases
     (`C-01` … `C-13`) that any implementation — including Agent A's durable PostgreSQL
     repository — can run from its own package.
  6. Security/contract unit tests: `tests/unit/p0c3c-consent-contract.test.ts` (5 tests) and
     `tests/unit/p0c3c-consent-security.test.ts` (25 tests).

- **Acceptance summary**:

  | Requirement                                                                     | Status                                  |
  | ------------------------------------------------------------------------------- | --------------------------------------- |
  | Consent lifecycle frozen (states, transitions, idempotency)                     | PASS                                    |
  | Generation identity + strictly monotonic versions                               | PASS                                    |
  | Derived (non-mutating) expiry                                                   | PASS                                    |
  | Tenant isolation / uniform agnosticism                                          | PASS                                    |
  | Versioned authorization fence minted, validated, and audited                    | PASS                                    |
  | Fence enforced pre-read (reader never invoked on deny)                          | PASS                                    |
  | Fence re-enforced post-read (mid-read revoke **and** re-grant discard snapshot) | PASS                                    |
  | Policy-evaluated grant **is** the fenced generation (pre- and post-read)        | PASS                                    |
  | Fail-closed on malformed / tampered / unverifiable fences                       | PASS                                    |
  | `FakeConsentRegistry` conforms to all 13 conformance cases                      | PASS                                    |
  | Conformance kit has a negative control (mutant implementations fail)            | PASS                                    |
  | Durable PostgreSQL implementation certified by this kit                         | Handed to Agent A (port + kit provided) |
  | Real public-source / live HTTP connectors                                       | NOT IMPLEMENTED / NOT AUTHORIZED        |

---

## 2. Scope, Non-Goals, and Trust Model

### 2.1 Scope

This task freezes **authorization semantics for consent-gated source reads**. It does not add
providers, credentials, or network egress. Its single question is:

> Given a read request carrying a consent reference, may `@ember/connectors` read the source — and
> can that answer be re-proven _after_ the read completes?

### 2.2 Non-goals

- No OAuth flows, no token vault, no provider SDKs, no outbound HTTP/DNS/sockets (still enforced at
  zero, see `tests/unit/p0c3-source-zero-network.test.ts`).
- No durable persistence in this package. `FakeConsentRegistry` remains an ephemeral, process-local
  test double. Durable, cross-process consent storage is Agent A's PostgreSQL repository.
- No changes to the worker scheduler contract beyond the _optional_ `authorizationFence` field on
  `TrustedSourceAccessContext`.

### 2.3 Trust model (three distinct parties)

| Input                                                                                     | Trust level                                                                                         | How it is handled                                                                                                           |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TrustedSourceAccessContext` (tenant, commitment, task, run, lease epoch, `authorizedAt`) | Assembled by the authoritative worker scheduler; **not** attacker-controlled but still re-validated | Shape/format validation only; never used as proof of authorization                                                          |
| `authorizationFence`                                                                      | **Untrusted** worker payload                                                                        | Structurally validated, digest-checked, bound to caller tenant/profile, then compared against authoritative persisted state |
| Inner `SourceReader` + the `SourceSnapshot` it returns                                    | **Untrusted**                                                                                       | Bounds/schema/digest inspection, sanitization, exception sanitization, deep freeze                                          |
| Persisted consent state (`ConsentAuthority`)                                              | **Authoritative**                                                                                   | The only source of authorization truth                                                                                      |

### 2.4 What the fence is _not_

The fence digest is a **self-consistency checksum over a canonical JSON encoding of the fence body**
(domain-separated with `ember.consent.fence.v1`). It is **not** a MAC, **not** a signature, and
**not** proof of authorization: any caller can recompute it. It exists to make accidental or
naive tampering detectable and to give the audit trail a stable generation reference.

Authorization is established **exclusively** by looking up the current authoritative generation for
`(tenantId, sourceProfileId)` and comparing `grantId` **and** `grantVersion`.

---

## 3. Consent Lifecycle (Frozen)

### 3.1 Lineage and generations

- A **lineage** is the pair `(tenantId, sourceProfileId)`. Consent is defined per lineage, never
  globally.
- Every unit of authorization is a **generation**: the immutable pair `(grantId, version)` inside a
  lineage. A generation is **single-use for authorization**: once revoked or superseded it can never
  authorize again — even if identical terms are later granted, because the new grant carries a new
  `grantId` and a strictly greater `version`.
- Records are **immutable once issued**. `status` is a _stored_ field, but the **effective** status
  is always derived at evaluation time (see §5).

### 3.2 States

```mermaid
stateDiagram-v2
    [*] --> active: grant() [first grant, version = 1]
    active --> active: grant() [identical terms → idempotent re-affirmation, same generation]
    active --> active: grant() [changed terms → new grantId, version + 1]
    active --> revoked: revoke() [version + 1, revokedAt set, terminal]
    active --> expired: clock >= expiresAt [derived, record NOT rewritten]
    expired --> active: grant() [new grantId, version + 1]
    expired --> revoked: revoke() [version + 1, terminal]
    revoked --> active: grant() [new grantId, version + 1, new generation]
    revoked --> revoked: revoke() [idempotent, version unchanged, revokedAt preserved]
```

### 3.3 Transition rules (normative)

| Operation                                                                                | Precondition                       | Effect                                                                                            | Idempotent?                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `grant(params)` — first ever                                                             | no record                          | new `grantId`, `version = 1`, `status = active`, `revokedAt = null`                               | n/a                                                          |
| `grant(params)` — **identical** authorization terms while current generation is `active` | record present, effective `active` | **nothing changes**; the same `(grantId, version)` is returned                                    | **Yes** — repeated scheduler calls must not inflate versions |
| `grant(params)` — **different** terms, or current record `revoked` / `expired`           | record present                     | new `grantId`, `version = previous + 1`, `status = active`, `revokedAt = null`, fresh `grantedAt` | No                                                           |
| `revoke(...)` — active or expired                                                        | record present                     | `status = revoked`, `revokedAt = now`, `version = previous + 1`                                   | **Exactly once**                                             |
| `revoke(...)` — already revoked                                                          | effective `revoked`                | unchanged record returned (same `revokedAt`, same `version`)                                      | **Yes**                                                      |
| `revoke(...)` — no record                                                                | —                                  | `NOT_FOUND` (`POLICY_DENIED` at the reader perimeter, see §4.2)                                   | n/a                                                          |

**"Authorization terms"** = `allowedOperations` (order-insensitive, de-duplicated), `scopes`
(order-insensitive, de-duplicated), and `expiresAt`. Changing any of them is an explicit re-grant and
therefore mints a new generation. `grantedAt`/`grantId`/`version` are not terms.

### 3.4 Version monotonicity

- `version` is a **per-lineage, strictly increasing integer** starting at `1`.
- It increases by exactly `1` per re-grant **or** per effective revocation — never by `0` on a real
  state change, never by more than `1`, and never on an idempotent call.
- The sequence `grant → revoke → grant → revoke → …` from C-08 must be strictly increasing with each
  newly minted generation.
- A durable implementation must allocate the version **atomically** (e.g.
  `UPDATE … SET version = version + 1 … RETURNING version` or a `SELECT … FOR UPDATE` in the same
  transaction) so two concurrent re-grants cannot both observe `version = n`.

---

## 4. Authorization Fence (Frozen)

### 4.1 Shape

```ts
interface ConsentAuthorizationFence {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly issuedAt: string; // RFC 3339
  readonly digest: string; // 64 lowercase hex chars
}
```

- Minted **only** from a grant whose effective status is `active`:
  `createConsentAuthorizationFence(grant, issuedAt)` throws `INVALID_ARGUMENT` for `revoked` or
  `expired` generations — a dead generation can never be fenced.
- `digest = SHA-256(canonicalJson({ domain: 'ember.consent.fence.v1', tenantId, sourceProfileId,
grantId, grantVersion, issuedAt }))` — a **self-consistency checksum only** (§2.4).
- Fences are deeply frozen values; the minting helper is the only supported producer.

### 4.2 Authoritative generation view

```ts
interface AuthorizedConsentGeneration {
  readonly tenantId: string;
  readonly sourceProfileId: SourceProfileId;
  readonly grantId: string;
  readonly version: number;
  readonly status: ConsentStatus; // EFFECTIVE status at `now`
  readonly expiresAt: string | null;
}
```

Resolved through the `ConsentAuthority` port:

```ts
interface ConsentAuthority {
  resolveGeneration(
    tenantId: string,
    sourceProfileId: string,
    now: Date,
  ): AuthorizedConsentGeneration | null | Promise<AuthorizedConsentGeneration | null>;
}
```

`FakeConsentRegistry` implements this port and is the default authority when none is passed.
Production **must** pass the durable repository.

### 4.3 Validation order (normative)

`validateConsentAuthorizationFence({ fence, tenantId, sourceProfileId, authoritative, now })`
evaluates in this exact order and stops at the first failure:

| #   | Check                                                                                                      | Result on failure                     | Audited denial code     |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------- |
| 1   | Structural validity (all fields, `grantVersion` a positive integer, `issuedAt` parseable, digest = 64 hex) | `CONSENT_FENCE_MALFORMED`             | `CONSENT_FENCE_INVALID` |
| 2   | Digest recomputation over the canonical body                                                               | `CONSENT_FENCE_TAMPERED`              | `CONSENT_FENCE_INVALID` |
| 3   | `issuedAt` not in the future by more than `CONSENT_FENCE_MAX_CLOCK_SKEW_MS` (60 s)                         | `CONSENT_FENCE_MALFORMED`             | `CONSENT_FENCE_INVALID` |
| 4   | `tenantId` and `sourceProfileId` match the caller context                                                  | `CONSENT_FENCE_BINDING_MISMATCH`      | `TENANT_MISMATCH`       |
| 5   | An authoritative generation exists for the lineage                                                         | `CONSENT_NOT_FOUND`                   | `CONSENT_NOT_FOUND`     |
| 6   | Authoritative `tenantId` / `sourceProfileId` still match the fence binding                                 | `CONSENT_FENCE_BINDING_MISMATCH`      | `TENANT_MISMATCH`       |
| 7   | **If** the fence already names the current generation: effective status must be `active`                   | `CONSENT_REVOKED` / `CONSENT_EXPIRED` | same                    |
| 8   | `grantId` **and** `grantVersion` equal the current authoritative generation                                | `CONSENT_FENCE_STALE`                 | `CONSENT_FENCE_STALE`   |
| 9   | Otherwise                                                                                                  | `VALID`                               | — (read proceeds)       |

Why step 7 precedes step 8: a fence that still references the lineage's _current_ generation should
name the specific reason (`revoked` / `expired`) rather than the generic "stale". Superseded
generations (revoked **and** re-granted) correctly report `CONSENT_FENCE_STALE`.

### 4.4 Optionality and fail-closed default

`GuardedSourceReaderOptions.requireAuthorizationFence` (default **`false`**) controls only the
_absence_ of a fence:

- `false` (default, backward compatible): a read with no fence is evaluated exactly as before this
  change; a read **with** a fence is always fully validated.
- `true` (production recommendation): a read with no fence is denied with `CONSENT_FENCE_MISSING`.
- **Unverifiable fence always fails closed**: if a fence is present but no `authority` is wired, the
  result is `CONSENT_FENCE_MISSING` — the perimeter never trusts caller-supplied authorization.
- A throwing authority is treated as "no authoritative state" (`null` → `CONSENT_NOT_FOUND`); the
  thrown value is never inspected or surfaced.

### 4.5 Generation binding (normative) — CTO round 2, P1 closure

**Invariant GB:** the grant the perimeter evaluates policy against **must be** the generation named
by the caller's authorization fence — same `grantId` **and** same `version`.

Verifying a fence is not sufficient on its own. `GuardedSourceReader` performs two independent reads:
`ConsentRegistry.get()` supplies the record whose `allowedOperations`, `scopes`, tenant, and status the
policy gate evaluates, while `ConsentAuthority.resolveGeneration()` supplies the generation the fence
is compared against. If those two sources disagree, a fence for **G2** would rubber-stamp a read whose
permissions were taken from **G1** — the fence would attest terms it never described. Without a
binding check this is exploitable wherever the registry read is stale or served from a lagging
replica, and it also silently survives a cross-wired tenant read.

`validateConsentGenerationBinding({ grant, fence, tenantId, sourceProfileId })` is the pure validator
(exported from `@ember/connectors`) and fails closed at the first failing step:

| #   | Check                                                       | Result on failure             | Audited denial code           |
| --- | ----------------------------------------------------------- | ----------------------------- | ----------------------------- |
| 1   | A fence was supplied at all                                 | `VALID` (nothing to bind)     | — (legacy fence-less path)    |
| 2   | Fence is structurally readable (`readFence`)                | `CONSENT_FENCE_INVALID`       | `CONSENT_FENCE_INVALID`       |
| 3   | Fence names the caller's `tenantId` / `sourceProfileId`     | `TENANT_MISMATCH`             | `TENANT_MISMATCH`             |
| 4   | A grant exists and carries a readable `grantId` / `version` | `CONSENT_NOT_FOUND`           | `CONSENT_NOT_FOUND`           |
| 5   | Grant belongs to the caller's lineage                       | `TENANT_MISMATCH`             | `TENANT_MISMATCH`             |
| 6   | `grant.grantId === fence.grantId` **and** `version` equal   | `CONSENT_GENERATION_MISMATCH` | `CONSENT_GENERATION_MISMATCH` |
| 7   | Otherwise                                                   | `VALID`                       | — (read proceeds)             |

Enforcement points (both are mandatory and independent):

1. **Pre-read (§6.1 step 3.6)**, immediately after the fence validates and before the inner
   `SourceReader` is invoked, using the exact `grant` object the policy gate consumed. A denied read
   records one `DENIED` audit entry with `CONSENT_GENERATION_MISMATCH` and the reader invocation count
   stays **0**.
2. **Post-read (§6.1 step 7)**, using the freshly re-read grant. Divergence that appears while the
   read is in flight discards the snapshot with `REVOKED_DURING_EXECUTION`.

Binding is enforced **whenever a fence is present**, including when
`requireAuthorizationFence === false`: a supplied-but-unbindable fence is never silently ignored. A
read with **no** fence keeps the pre-fence behaviour, which is what preserves backward compatibility.

A hostile grant object (throwing getter / Proxy) cannot escape the validator as an exception; the
unreadable case is reported as `CONSENT_GENERATION_MISMATCH`, and the thrown value is never inspected.

> **Deployment consequence for Agent A/B:** `get()` and `resolveGeneration()` must be answered from the
> same authoritative state (same transaction snapshot, primary reads — no asynchronous read replica).
> Replica lag between the two reads is exactly the split brain this invariant rejects, and it fails
> **closed**: reads deny with `CONSENT_GENERATION_MISMATCH` until the replica catches up.

---

## 5. Expiry, Clocks, and Tenant Isolation

### 5.1 Derived expiry

- `expiresAt: string | null` is the only expiry input. Status is **derived** at evaluation time:
  `revoked` if `revokedAt != null`; else `expired` if `expiresAt != null && now >= expiresAt`; else
  `active`.
- Expiry **never rewrites the stored record**: no version bump, no `status` mutation. `C-03` proves
  a grant is `active` immediately before `expiresAt` and `expired` exactly at `expiresAt`, with an
  unchanged `(grantId, version, expiresAt)`.
- Boundary rule: `now >= expiresAt` is expired (`expiresAt` is exclusive).
- A durable implementation may keep `status` as a stored column, but its **read path must derive**
  the effective status with the same predicate (or constrain the query with `expires_at > now`) so
  an elapsed grant cannot authorize anything.

### 5.2 Clock authority

- The perimeter uses a single injected `nowProvider`; the registry accepts an explicit `now` on
  every method. No consent decision reads the wall clock directly.
- `issuedAt` in a fence may lead `now` by at most `CONSENT_FENCE_MAX_CLOCK_SKEW_MS` (60 s) to absorb
  benign scheduler/replica skew; larger lead times are treated as malformed.
- Invalid clocks (`NaN`, non-`Date`) make `get` / `list` return `null` / `[]` (fail closed) and make
  mutating calls throw `INVALID_ARGUMENT`.

### 5.3 Tenant isolation (uniform agnosticism)

- Every registry lookup, revocation, and listing is **tenant-scoped**; the storage key is
  `tenantId::sourceProfileId`.
- Cross-tenant operations are indistinguishable from "does not exist": `get` → `null`,
  `list` → no entry, `revoke` → `NOT_FOUND`. No oracle reveals whether a foreign lineage exists.
- At the perimeter, a profile whose `tenantId` differs from the authenticated context is reported as
  `SOURCE_PROFILE_NOT_FOUND` (`NOT_FOUND`), never `TENANT_MISMATCH`. The explicit `TENANT_MISMATCH`
  code is reserved for fence binding violations where the fence itself names another tenant.
- `C-04` proves tenant B cannot read, list, or revoke tenant A's generation, and that both tenants
  can hold independent generations for the same `sourceProfileId`.

---

## 6. Perimeter Integration (`GuardedSourceReader`)

### 6.1 Order of checks

```mermaid
sequenceDiagram
    participant S as "Worker Scheduler"
    participant G as "GuardedSourceReader"
    participant P as "evaluateSourceAccess"
    participant A as "ConsentAuthority (authoritative)"
    participant R as "Inner SourceReader"

    S->>G: readSnapshot(profileId, ctx{fence}, signal)
    G->>G: 1. validate context + profileId format
    G->>G: 2. resolve profile + tenant isolation (NOT_FOUND on mismatch)
    G->>P: 3. pre-read policy + consent + scope + operation
    P-->>G: deny → audit DENIED, throw POLICY_DENIED (0 reader calls)
    G->>A: 3.5 resolveGeneration(tenant, profile, now)
    A-->>G: authoritative generation
    G->>G: validateConsentAuthorizationFence(...)
    Note over G: invalid/missing/stale → audit DENIED + throw before dispatch
    G->>G: 3.6 generation binding: policy grant == fenced generation?
    Note over G: mismatch → audit CONSENT_GENERATION_MISMATCH + throw (0 reader calls)
    G->>G: 4. cancellation check
    G->>R: 5. readSnapshot(...)
    R-->>G: untrusted snapshot (or throws)
    G->>G: 6. schema/bounds/digest inspection + sanitization
    G->>A: 7. re-resolve generation + re-read grant (post-read)
    G->>G: deriveConsentStatus(postGrant, now) AND postFence.valid AND postBinding
    Note over G: any failing → audit REVOKED_DURING_EXECUTION, snapshot discarded
    G-->>S: 8. frozen snapshot + audit ALLOWED
```

### 6.2 The double-check invariant

A snapshot may only leave the perimeter if, **after** the read completes:

1. the current grant's effective status is still `active` (`deriveConsentStatus`), **and**
2. the fenced generation is **still the authoritative generation** (`postFence.valid`), **and**
3. the grant just re-read from the registry is **still the fenced generation**
   (`postBinding.consistent`, §4.5).

Condition 2 is what makes `revoke()` immediately followed by `grant()` inside the read window safe:
status alone would be `active` again (the "resurrect under the running read" hole), but the fenced
generation is stale, so the snapshot is discarded with `REVOKED_DURING_EXECUTION`.

Condition 3 is what makes a registry that diverges from the authority safe: status may still read
`active` and the fence may still be valid for the authoritative generation, yet the snapshot was
authorized by terms the fence never described — so it is discarded too.

All three conditions are re-evaluated against freshly read state; nothing from the pre-read gate is
reused.

### 6.3 Audit trail

Every decision writes one `SourceAuditRecord` (tenant hashed with SHA-256/16 hex,
`networkCallsMade: 0`, static `denialReason` selected from `SAFE_DENIAL_DESCRIPTIONS`):

| Situation                                             | `decision` | `denialCode`                                                                |
| ----------------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| Profile missing or foreign tenant                     | `DENIED`   | `SOURCE_PROFILE_NOT_FOUND`                                                  |
| Policy/consent/scope/operation denial                 | `DENIED`   | from `SourceAccessDecision`                                                 |
| Fence missing / invalid / stale / revoked / expired   | `DENIED`   | fence denial code (§4.3)                                                    |
| Policy grant is not the fenced generation             | `DENIED`   | `CONSENT_GENERATION_MISMATCH` (or `TENANT_MISMATCH`, §4.5)                  |
| Aborted before or after dispatch, or reader cancelled | `DENIED`   | `READ_ABORTED`                                                              |
| Reader threw (untrusted)                              | `DENIED`   | `POLICY_DENIED` (fixed text, no reflection)                                 |
| Snapshot failed inspection                            | `DENIED`   | inspection code (`UNTRUSTED_CONTENT_DETECTED`, `PAYLOAD_LIMIT_EXCEEDED`, …) |
| Consent lost / generation superseded mid-read         | `DENIED`   | `REVOKED_DURING_EXECUTION`                                                  |
| Success                                               | `ALLOWED`  | —                                                                           |

New static reasons added by this task:

```
CONSENT_FENCE_MISSING: 'Authorization fence missing or unverifiable'
CONSENT_FENCE_INVALID: 'Authorization fence is malformed or tampered'
CONSENT_FENCE_STALE: 'Authorization fence refers to a superseded consent generation'
CONSENT_GENERATION_MISMATCH: 'Consent generation used for authorization is not the fenced generation'
```

---

## 7. Conformance Kit (`consent-conformance.ts`)

### 7.1 Design

- **No test framework, no I/O, no postgres import.** Pure TypeScript exported from
  `@ember/connectors`, so a durable repository in another package can certify itself from its own
  test suite without depending on this package's test setup.
- **Adapter port** (`ConsentConformanceAdapter`) tolerates sync or async implementations, so the same
  suite drives the in-memory fake and a real repository.
- **Deterministic**: one fixed clock (`CONSENT_CONFORMANCE_CLOCK` =
  `2026-11-01T12:00:00.000Z`), one fixed profile (`sp_ember_releases`), one fixed policy.

```ts
import { assertConsentConformance, type ConsentConformanceAdapter } from '@ember/connectors';

const adapter: ConsentConformanceAdapter = {
  name: 'PostgresConsentRepository',
  reset: () => repo.truncateForTest(),
  grant: (params, now) => repo.grant(params, now),
  get: (tenantId, profileId, now) => repo.get(tenantId, profileId, now),
  revoke: (tenantId, profileId, now) => repo.revoke(tenantId, profileId, now),
  list: (tenantId, now) => repo.list(tenantId, now),
  resolveGeneration: (tenantId, profileId, now) => repo.resolveGeneration(tenantId, profileId, now),
};

await assertConsentConformance(adapter); // throws ConsentConformanceViolation on any failure
```

`runConsentConformanceSuite(adapter)` never throws for a contract violation; it returns
`ConsentConformanceCaseResult[]` (`id`, `requirement`, `title`, `passed`, `error`) so a failing
implementation can be reported case by case.

### 7.2 Requirement matrix

| Case | Requirement id                              | Frozen requirement                                                                                                                | Certified by                                                                                    |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C-01 | `R1-missing-grant-denies`                   | A lineage with no grant is denied (fail closed)                                                                                   | `get` → `null`, `resolveGeneration` → `null`, decision `CONSENT_NOT_FOUND`                      |
| C-02 | `R2-revocation-is-terminal`                 | Revocation denies reads, is terminal, bumps version exactly once, repeat revoke is a no-op                                        | `revoke`, `get`, `resolveGeneration`                                                            |
| C-03 | `R3-expiry-is-derived`                      | Expiry derived at read time from `expiresAt`, record never re-written                                                             | `get` at `expiresAt − 1ms`, at `expiresAt`, and record equality                                 |
| C-04 | `R4-tenant-isolation`                       | Grants are tenant-scoped: no cross-tenant read, list, or revoke                                                                   | `get`, `list`, `revoke` under tenant B                                                          |
| C-05 | `R5-scope-and-operation-binding`            | A grant for other operations or scopes does not authorize a read                                                                  | `evaluateSourceAccess` with `requiredScopes: ['source.readonly']`, `operation: 'read_snapshot'` |
| C-06 | `R6-regrant-mints-new-generation`           | Re-grant after revocation mints a new `grantId` and strictly greater `version`                                                    | `grant` after `revoke`                                                                          |
| C-07 | `R7-generation-fence-binding`               | A fence authorizes only for the current authoritative generation (valid / revoked / stale / tampered / cross-tenant)              | `createConsentAuthorizationFence` + `validateConsentAuthorizationFence`                         |
| C-08 | `R8-version-monotonicity`                   | Versions increase strictly across repeated grant/revoke cycles                                                                    | 3 cycles asserting `1 < 2 < 3`                                                                  |
| C-09 | `R9-reaffirmation-is-idempotent`            | Identical terms on an active generation return the **same** generation (no version inflation)                                     | `grant` twice, compare `grantId`, `version`, `grantedAt`                                        |
| C-10 | `R10-fail-closed-on-invalid-input`          | Invalid input is rejected on writes (`INVALID_ARGUMENT`) and denied — never granted — on reads (`null` / `[]`)                    | `grant`/`revoke` with URL profile ids, empty terms, non-`Date` clocks                           |
| C-11 | `R11-records-are-immutable`                 | Returned and stored records cannot be mutated by callers                                                                          | `Object.isFrozen`, mutation attempts leave stored state unchanged                               |
| C-12 | `R12-list-scope-and-determinism`            | Listing is tenant-scoped, duplicate-free, and deterministically ordered                                                           | `list` under two tenants + repeated-call ordering equality                                      |
| C-13 | `R13-policy-grant-is-the-fenced-generation` | The grant policy evaluates **is** the fenced generation (`grantId` + `version`); foreign / stale / cross-tenant fences never bind | `validateConsentGenerationBinding` against the adapter's own `get` output                       |

### 7.3 Negative controls

The suite is itself tested for _sensitivity_ against two deliberately broken implementations
(`tests/unit/p0c3c-consent-contract.test.ts`):

- **`NonRevokingRegistry`** (revocation is ignored) must fail `C-02`.
- **`VersionInflatingRegistry`** (every `grant` re-mints a generation) must fail `C-09`.

If either mutant passed, the kit would be proven vacuous; both are rejected with
`ConsentConformanceViolation` and the failing case ids are asserted.

---

## 8. Handoff to Agent A — Durable PostgreSQL Implementation

`FakeConsentRegistry` is a **test-only double**. Production persistence is Agent A's responsibility;
this package contributes the contract, the validator, and the certification kit.

### 8.1 Required repository surface

```ts
interface ConsentRepository extends ConsentAuthority {
  grant(params: GrantConsentParams, now: Date): Promise<ConsentGrant>;
  get(tenantId: string, sourceProfileId: string, now: Date): Promise<ConsentGrant | null>;
  revoke(tenantId: string, sourceProfileId: string, now: Date): Promise<ConsentGrant>;
  list(tenantId: string, now: Date): Promise<readonly ConsentGrant[]>;
  truncateForTest(): Promise<void>; // test-only; never exposed over HTTP
}
```

### 8.2 Suggested schema constraints

```sql
CREATE TABLE source_consent_grants (
  grant_id           uuid        PRIMARY KEY,
  tenant_id          text        NOT NULL,
  source_profile_id  text        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('active', 'revoked')),
  allowed_operations text[]      NOT NULL,
  scopes             text[]      NOT NULL,
  granted_at         timestamptz NOT NULL,
  expires_at         timestamptz NULL,
  revoked_at         timestamptz NULL,
  version            integer     NOT NULL CHECK (version >= 1),
  CONSTRAINT source_consent_grants_lineage UNIQUE (tenant_id, source_profile_id),
  CONSTRAINT source_consent_grants_revoked_consistency
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
```

- `UNIQUE (tenant_id, source_profile_id)` enforces **one current generation per lineage**; history, if
  needed, belongs in an append-only `source_consent_grant_events` table.
- `version` monotonicity must be allocated inside the writing transaction:
  `UPDATE … SET version = version + 1 … RETURNING version`, or `SELECT … FOR UPDATE` before the
  write. Never `SELECT max(version) + 1` outside a transaction — two concurrent re-grants would
  collide and the loser would silently re-use a generation.
- Serialize per `(tenant_id, source_profile_id)` if grant and revoke may race.
- **Never** store a derived `expired` status: persist `expires_at` and derive on read
  (`status = 'active' AND (expires_at IS NULL OR expires_at > $now)`).
- **Generation binding (§4.5) requires a single authoritative read path.** `get()` and
  `resolveGeneration()` must be served by the same primary and, ideally, from the same transaction /
  repeatable-read snapshot. Do not route either call through an asynchronous replica or a cache: lag
  between the two reads is indistinguishable from a stale-replica attack and fails **closed**.
  `resolveGeneration()` should be a projection of the row `get()` returns
  (`toAuthorizedConsentGeneration`), never a second independent query with its own WHERE clause.

### 8.3 Certification

```ts
// agent-a/tests/integration/consent-conformance.test.ts
await assertConsentConformance(postgresAdapter);
```

Expected: all 13 cases pass. Any failure names the case id and the violated invariant; never weaken
the case to make a repository pass.

### 8.4 Scheduler obligations (Agent B)

- Call `grant()` idempotently — re-requesting identical terms on an active generation must return the
  same generation (C-09), otherwise schedulers inflate versions and invalidate every in-flight fence.
- Mint the fence at **dispatch time** from the grant just persisted; never cache or reuse a fence
  across task attempts or retries.
- Mint the fence from the **same generation the perimeter will read**: if the scheduler mints from a
  write-path copy while the reader reads a lagging replica, the read fails closed with
  `CONSENT_GENERATION_MISMATCH` (§4.5). Treat that code as "re-resolve consent and retry once", never
  as a reason to disable the fence check.
- Pass `requireAuthorizationFence: true` in production wiring so an unfenced worker payload cannot
  reach a reader.

---

## 9. Backward Compatibility

| Surface                                                | Change                                                                                                                         | Compatibility                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `ConsentRegistry` (`grant`/`get`/`revoke`/`list`)      | `now` already optional; semantics tightened (derived expiry, idempotent re-affirmation, single version bump on revoke)         | Source compatible. Behavioural change: repeated identical `grant` no longer bumps `version` |
| `TrustedSourceAccessContext.authorizationFence`        | New optional field                                                                                                             | Additive; existing contexts parse unchanged                                                 |
| `GuardedSourceReaderOptions.authority`                 | New optional; defaults to the configured `registry`                                                                            | Additive                                                                                    |
| `GuardedSourceReaderOptions.requireAuthorizationFence` | New optional; defaults `false`                                                                                                 | Additive; default preserves all pre-existing behaviour                                      |
| `SourceDenialCode`                                     | Four new members (`CONSENT_FENCE_MISSING/INVALID/STALE`, `CONSENT_GENERATION_MISMATCH`)                                        | Additive; exhaustive `switch` statements over the union must add branches                   |
| `@ember/connectors` exports                            | `consent.js`, `consent-conformance.js` added; `validateConsentGenerationBinding` + `CONSENT_GENERATION_BINDING_CODES` exported | Additive                                                                                    |

Behavioural change to call out for integrators: a read that **supplies** a fence whose generation does
not match the grant the registry returns is now denied (`CONSENT_GENERATION_MISMATCH`). Fence-less
reads are untouched. Any pre-existing caller that attached a fence minted from a different generation
than the one it authorized with was previously authorized by the wrong generation's terms, so this is
a security fix rather than a compatibility regression.

Pre-existing tests continue to pass unmodified, which is the intended evidence that the fence is
additive: `p0c3-source-consent-registry` (7), `p0c3-source-policy-evaluation` (11),
`p0c3-source-revocation-lifecycle`, `p0c3-source-guarded-reader*`, `p0c3-source-zero-network`, and
`p0c3-source-audit-redaction`.

---

## 10. Verification Evidence

All gates run from `/Users/a1-6/Downloads/Ember-p0c3c` on 2026-11-02.

| Gate            | Command                                                                                                                             | Result                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Typecheck       | `pnpm run typecheck` (`tsc -p tsconfig.json`)                                                                                       | PASS — no diagnostics                        |
| Targeted unit   | `npx vitest run --config vitest.unit.config.ts tests/unit/p0c3c-consent-security.test.ts tests/unit/p0c3c-consent-contract.test.ts` | PASS — 2 files, **30 tests**                 |
| Full unit suite | `pnpm run test:unit`                                                                                                                | PASS — **63 files / 1038 tests**, 0 failures |
| Lint            | `pnpm run lint` (`eslint .`)                                                                                                        | PASS — 0 problems                            |
| Format          | `pnpm run format:check` (`prettier --check .`)                                                                                      | PASS                                         |
| Build           | `pnpm run build`                                                                                                                    | PASS                                         |
| CI              | GitHub Actions `Verify (Node 24 LTS + PostgreSQL 17)` on PR #83                                                                     | PASS (see §10.4)                             |

### 10.1 `tests/unit/p0c3c-consent-contract.test.ts` (5 tests)

1. The frozen requirement matrix is immutable, has exactly 13 cases in `C-01`…`C-13` order, and
   assigns each requirement id exactly once.
2. `FakeConsentRegistry` is certified against all 13 cases through the adapter port.
3. Negative control: a non-revoking registry fails `C-02` (and the violation names it).
4. Negative control: a version-inflating registry fails `C-09`.
5. Every result reports `id`, `requirement`, `title`, `passed`, with `error === null` on success.

### 10.2 `tests/unit/p0c3c-consent-security.test.ts` (25 tests)

| #   | Attack / invariant                                                                                       | Expected outcome                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Valid fence for the current generation                                                                   | Read succeeds, audit `ALLOWED`                                                                    |
| 2   | `requireAuthorizationFence: true` with no fence                                                          | `POLICY_DENIED` / `CONSENT_FENCE_MISSING`; reader never called                                    |
| 3   | Default wiring (fence not required) with no fence                                                        | Legacy behaviour preserved                                                                        |
| 4   | Fence whose `grantVersion` was edited                                                                    | `CONSENT_FENCE_INVALID` (tampered); reader never called                                           |
| 5   | Fence for a revoked-then-re-granted generation                                                           | `CONSENT_FENCE_STALE`                                                                             |
| 6   | Fence naming another tenant                                                                              | `TENANT_MISMATCH`, uniform denial                                                                 |
| 7   | Authority returns `null`                                                                                 | `CONSENT_NOT_FOUND` (indistinguishable from missing consent)                                      |
| 8   | Authority throws an error containing a token                                                             | `CONSENT_NOT_FOUND`; token never appears in error or audit                                        |
| 9   | Consent revoked before the read                                                                          | Denied pre-dispatch; reader not invoked                                                           |
| 10  | Consent revoked **during** the read                                                                      | `REVOKED_DURING_EXECUTION`; snapshot discarded                                                    |
| 11  | Consent expires **during** the read                                                                      | `REVOKED_DURING_EXECUTION`; snapshot discarded                                                    |
| 12  | Revoked **then re-granted** during the read                                                              | `REVOKED_DURING_EXECUTION` — status alone would read `active`, generation staleness catches it    |
| 13  | Grant lacks the required scope / operation                                                               | `SCOPE_NOT_GRANTED` / `OPERATION_NOT_ALLOWED`                                                     |
| 14  | Reader throws a sensitive-message error                                                                  | Sanitized `POLICY_DENIED`, no reflection                                                          |
| 15  | Signal aborted before / after dispatch                                                                   | `READ_ABORTED`; reader not called when pre-aborted                                                |
| 16  | Prompt-injection payload inside a fixture snapshot                                                       | Inert: carried as data, never interpreted                                                         |
| 17  | Registry serves **G1** while fence + authority name **G2**                                               | `CONSENT_GENERATION_MISMATCH`; reader never called (CTO round 2 adversarial case, §4.5)           |
| 18  | Stale read replica still serving the superseded generation                                               | `CONSENT_GENERATION_MISMATCH`; reader never called                                                |
| 19  | Mismatched generation while `requireAuthorizationFence` is `false`                                       | Denied — the binding check never fails open                                                       |
| 20  | Registry serves a foreign-tenant generation for the caller context                                       | `TENANT_MISMATCH`; reader never called                                                            |
| 21  | Registry diverges from the fence **during** the read                                                     | `REVOKED_DURING_EXECUTION`; status active + fence valid, so binding alone catches it              |
| 22  | Validator: re-versioned / re-keyed / foreign-tenant grant, cross-tenant fence, malformed fence, no grant | `CONSENT_GENERATION_MISMATCH` / `TENANT_MISMATCH` / `CONSENT_FENCE_INVALID` / `CONSENT_NOT_FOUND` |
| 23  | Validator: fence-less read                                                                               | Unbound (`VALID`) — backward compatibility                                                        |
| 24  | Validator: hostile `Proxy` grant                                                                         | `CONSENT_GENERATION_MISMATCH`, never throws, throw value never inspected                          |
| 25  | Every scenario above                                                                                     | `networkCallsMade: 0` — no sockets, DNS, or `fetch`                                               |

### 10.3 Mutation sensitivity of the binding tests

The new tests were proven **sensitive**, not merely green. Each gate was disabled in isolation and the
suite re-run:

| Mutation (temporary, reverted)                         | Resulting failures                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| Pre-read binding gate replaced with `if (false)`       | 3 failures — the split-brain, stale-replica, and optional-fence tests |
| Post-read `postBinding.consistent` removed from step 7 | 1 failure — the mid-read divergence test                              |

A "zero reader invocations" assertion plus an exact denial code means no other code path can satisfy
the test, so the invariant cannot silently regress.

---

## 11. Limitations and Security Notes

1. **The fence is not a capability.** It is a generation reference plus a checksum. Possessing a
   well-formed fence is never authorization; only the authority lookup authorizes. If cryptographic
   proof is later required, add a MAC/HMAC keyed by the worker/enclave — that is a schema change and
   must bump the digest domain string.
2. **`FakeConsentRegistry` is a test double.** Process-local, non-transactional, no durability,
   replication, or cross-process visibility. Wiring it in production means a restart wipes consent
   state (fail closed — reads deny, never allow — but still an outage).
3. **TOCTOU is narrowed, not eliminated.** Post-read re-verification shrinks the window to the
   authority's own read latency and covers revoke, re-grant, expiry, and registry/authority
   divergence. A revoke that lands _after_ the post-read check but _before_ the caller consumes the
   snapshot is outside this package's control; consumers must treat a snapshot as authorized at
   `authorizedAt`, not at consumption time.
4. **Split brain is detected, not repaired.** Generation binding (§4.5) rejects any read whose
   policy-evaluated grant is not the fenced generation, but it cannot tell a stale replica from an
   attack. Both fail closed. The fix is operational: one authoritative read path for `get()` and
   `resolveGeneration()` (§8.2), fences minted from the generation the perimeter will read (§8.4).
5. **Clock trust.** Expiry and fence skew both depend on the injected clock. A skewed worker clock can
   authorize an elapsed grant until the boundary — keep schedulers NTP-synced and use one clock per
   decision.
6. **Generation binding is structural, not cryptographic.** It compares two self-reported generations;
   it does not sign them. An attacker who can write both the registry and the authority row has
   already compromised consent storage, which is outside this perimeter.
7. **Denial uniformity is intentional.** `CONSENT_NOT_FOUND` is returned for missing, malformed, and
   foreign-tenant lineages so the perimeter is not an existence oracle. Do not "improve" the message.
8. **Real connectors remain out of scope.** No provider adapters, credentials, or egress are added by
   this task; the zero-network guarantee is enforced and tested.
