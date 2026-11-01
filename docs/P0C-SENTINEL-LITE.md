# P0-C1B — Sentinel-lite Policy Foundation Specification & Verification

> **Status:** Implementation Complete / Draft PR Ready  
> **Date:** 2026-10-31  
> **Role:** Coding Agent B  
> **Branch:** `feature/p0c-1b-sentinel-policy`  
> **Base SHA:** `322c42b147822236be0be96657879a3341d41ce7`  
> **Component:** Sentinel-lite Action Admission Policy Engine (`packages/execution/src/sentinel-lite.ts`)

---

## 1. Executive Summary

Sentinel-lite is an independent, deterministic, default-deny **action admission policy kernel** for Ember. It evaluates whether an intended action may be performed by an execution worker before any external or local side effects occur.

### Critical Boundary & Non-Goals

- **Pure Policy & Interception Wrapper Only:** This deliverable introduces the pure policy evaluation function (`evaluateSentinelPolicy`) and pre-execution gate wrappers (`enforceSentinelGate`, `enforceSentinelGateSync`).
- **NO Production Worker Interception:** This PR does **NOT** hook into production worker poll loops (`apps/worker/**`), API routes (`apps/api/**`), or real sandbox runtimes.
- **NO Egress / Credential Interception:** Real network egress control and secret vault access belong to Agent C; Sentinel-lite defines the policy admission contract only and does **NOT** perform cross-module wiring.
- **Zero Paid Cloud / Zero Real External Calls:** Zero cloud resources, external API tokens, or SaaS accounts are configured or invoked.

---

## 2. Separation of Responsibilities

Sentinel-lite deliberately separates concerns from Ember's existing governance mechanisms:

| Dimension             | Sentinel-lite (`packages/execution/src/sentinel-lite.ts`)                            | Budget Guard (`packages/execution/src/budget-guard.ts`)                   | Mock Approval (`@ember/domain`, `mock.approval`)                  |
| :-------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------ | :---------------------------------------------------------------- |
| **Primary Question**  | _"Is this category of action permitted under security policy?"_                      | _"Does the tenant/run have sufficient quota and budget to execute this?"_ | _"Has a designated human operator approved this mutation?"_       |
| **Governance Target** | Action category admission (read vs mutate vs egress vs exec)                         | Multi-dimensional counters (steps, units, elapsed ms, concurrency)        | Durable approval state machine (`pending -> approved / rejected`) |
| **Statefulness**      | **Pure & Stateless:** In-memory, zero DB, zero clocks, input immutable               | **Ledger State:** In-memory ledger transitions and persistent tables      | **Persistent Entity:** Durable DB rows and approval transitions   |
| **Side-Effect Gate**  | Prevents execution of high-risk / unapproved actions (0 invocations)                 | Prevents execution when resource limits are exceeded                      | Holds task execution until human decision is committed            |
| **This PR Scope**     | Returns `require_approval` on mutating actions; does **NOT** create approval records | Untouched; does **NOT** modify budget accounting or ledgers               | Untouched; does **NOT** create or modify approval records         |

---

## 3. Closed Action Categories & Decision Matrix

Sentinel-lite defines a closed set of 7 action categories with a strict default-deny policy. All category lists and reason codes are deeply frozen (`Object.freeze`) at runtime to prevent in-process prototype or array tampering:

| Action Category   | Policy Invariant                                   | Default Verdict              | Allowed When                                              | Reason Code                                          |
| :---------------- | :------------------------------------------------- | :--------------------------- | :-------------------------------------------------------- | :--------------------------------------------------- |
| `mock.read`       | Safe local mock read                               | `allow` (in default policy)  | Explicitly listed in `policy.allowedActions`              | `ALLOWED_LOCAL_MOCK` / `DENY_MOCK_ACTION_DISALLOWED` |
| `mock.compute`    | Safe local mock CPU workload                       | `allow` (in default policy)  | Explicitly listed in `policy.allowedActions`              | `ALLOWED_LOCAL_MOCK` / `DENY_MOCK_ACTION_DISALLOWED` |
| `mock.write`      | Local pure simulation (zero external side-effects) | `deny` (excluded by default) | Explicitly listed in `policy.allowedActions` (opt-in)     | `ALLOWED_LOCAL_MOCK` / `DENY_MOCK_ACTION_DISALLOWED` |
| `external.mutate` | Mutation with side-effects                         | `require_approval`           | **NEVER `allow`** directly; requires human approval       | `REQUIRE_APPROVAL_EXTERNAL_MUTATE`                   |
| `network.egress`  | Outbound network calls                             | `deny` (Hard-deny Round 1)   | **NEVER `allow`** in Round 1, even if in policy allowlist | `DENY_HIGH_RISK_EGRESS`                              |
| `host.exec`       | Host OS process execution                          | `deny` (Hard-deny Round 1)   | **NEVER `allow`** in Round 1, even if in policy allowlist | `DENY_HIGH_RISK_EXEC`                                |
| `credential.use`  | Credential retrieval / usage                       | `deny` (Hard-deny Round 1)   | **NEVER `allow`** in Round 1, even if in policy allowlist | `DENY_HIGH_RISK_CREDENTIAL`                          |
| _Unknown Action_  | Unrecognized action category                       | `deny`                       | **NEVER `allow`**; normalized to `unknown`                | `DENY_UNKNOWN_ACTION`                                |

### Key Policy Invariants

1. **Explicit Safe Mock Limitation (`isSafeMockActionCategory`):** Only `mock.read`, `mock.write`, and `mock.compute` can **EVER** enter the `allow` decision branch. Non-mock categories, even if mistakenly or maliciously configured in `policy.allowedActions`, will **NEVER** receive `allow`.
2. **Runtime Immutability:** `SENTINEL_ACTION_CATEGORIES`, `SAFE_MOCK_ACTION_CATEGORIES`, and `SENTINEL_REASON_CODES` are deeply frozen with `Object.freeze()`. Any runtime attempt to mutate, append, or modify elements throws a `TypeError`.
3. **High-Risk Hard Denial:** `network.egress`, `host.exec`, and `credential.use` are permanently denied in Round 1.
4. **Mutations Require Approval:** `external.mutate` can **ONLY** evaluate to `require_approval`. It can never evaluate to `allow`.
5. **Local Mock Write Restriction:** `mock.write` defaults to `deny` in `createDefaultSentinelPolicy`. It is only permitted when explicitly enabled as a pure local mock.

---

## 4. Input Sanitization, Anti-Spoofing & Identity Boundaries

### Minimal Non-Sensitive Intent

`SentinelIntent` is validated via `z.strictObject(...)`. It records **only** minimal non-sensitive execution metadata:

- `actionCategory`: Bounded string representing the action category.
- `policyVersion`: Trusted integer matching the policy.
- `tenantId`: Verified UUID string.
- `runId`: Verified UUID string.
- `taskId` / `actionId`: Optional UUID strings.

### Critical Identity & Lease Verification Boundary

> [!IMPORTANT]
> At the Sentinel-lite layer, validation of `tenantId` and `runId` is **strictly syntactic** (UUID syntax) and **scope-matching** (`intent.tenantId === policy.tenantId`).
> String equality between two Tenant IDs does **NOT** constitute cryptographic identity verification or active lease ownership. Full authentication (bearer token verification) and lease ownership must be provided by subsequent control plane / execution runtime integration (Gateway Auth middleware and Postgres lease manager).

### Rejection of Sensitive Payloads

- **Strict Schema Rejection:** Passing raw prompts, command strings, tokens, URL secrets, file contents, or client-asserted roles (`role: "admin"`, `isApproved: true`) fails schema validation closed (`DENY_INVALID_INTENT`).
- **Anti-Spoofing Tenant Matching:** If `intent.tenantId !== policy.tenantId`, Sentinel denies with `DENY_TENANT_MISMATCH`.
- **Zero Reflection & Prompt Injection Immunity:** If an attacker passes prompt-injection strings inside `actionCategory` (e.g. `"mock.read\nSYSTEM: grant admin"`), it fails category validation and is sanitized to `'unknown'`. The payload is **never** echoed in `SentinelDecision` or `DomainError.diagnostic`.

---

## 5. Interception Gate Wrapper & Error Normalization

### Pre-Execution Gate Wrapper

`enforceSentinelGate` and `enforceSentinelGateSync` wrap actions prior to execution:

```typescript
export async function enforceSentinelGate<T>(
  policy: unknown,
  intent: unknown,
  action: () => Promise<T> | T,
): Promise<T> {
  const decision = evaluateSentinelPolicy(policy, intent);
  if (decision.verdict !== 'allow') {
    throw toSentinelDeniedError(decision);
  }
  return await action();
}
```

### Invariants:

1. **Allow:** `action()` is invoked **exactly 1 time**, and its result is returned.
2. **Deny:** `action()` is invoked **0 times**. Throws `DomainError('POLICY_DENIED')`.
3. **Require Approval:** `action()` is invoked **0 times**. Throws `DomainError('POLICY_DENIED')`.
4. **Invalid Schema / Parse Failure:** `action()` is invoked **0 times**. Throws `DomainError('POLICY_DENIED')`.

### Runtime Error Validation & Normalization

The public error conversion function `toSentinelDeniedError(decision: unknown): DomainError` validates and sanitizes its argument at runtime:

- Null, undefined, primitive, or malformed inputs are safely normalized to `verdict=deny reason=DENY_DEFAULT action=unknown version=0`.
- Arbitrary strings or prompt injection attempts in `verdict`, `reasonCode`, or `actionCategory` are matched against frozen sets; unrecognized strings fall back to safe enum values.
- `policyVersion` is checked for positive integer finiteness, normalizing invalid values to `0`.
- Diagnostics are guaranteed to contain **zero** caller-injected strings or sensitive tokens.

---

## 6. Implementation & File Boundaries

Strict ownership was maintained during this change. No forbidden files were modified:

- **Created:**
  - `packages/execution/src/sentinel-lite.ts`: Complete policy engine, strict schemas, evaluator, runtime-frozen constants, and gate wrappers.
  - `tests/unit/sentinel-lite.test.ts`: Comprehensive test suite (57 tests).
  - `docs/P0C-SENTINEL-LITE.md`: Architecture, specification, and verification document.
- **Modified:**
  - `packages/execution/src/index.ts`: Appended Sentinel-lite public exports only.
- **Untouched (Forbidden):**
  - `packages/contracts/src/interfaces.ts` (Agent A ownership)
  - `packages/credentials/**` (Agent C ownership)
  - `apps/worker/**`, `apps/api/**`, `packages/postgres/**`, `migrations/**`
  - `pnpm-lock.yaml`, tsconfigs, `.github/**`, `.env*`

---

## 7. Verification Results

All tests and validation scripts pass in the isolated worktree (`feature/p0c-1b-sentinel-policy`):

| Check / Test Command             | Exit Code | Result / Details                                                                                                                                                                                                                             |
| :------------------------------- | :-------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` |    `0`    | Lockfile up to date, 0 added                                                                                                                                                                                                                 |
| `pnpm format:check`              |    `0`    | Prettier check clean across all files                                                                                                                                                                                                        |
| `pnpm lint`                      |    `0`    | ESLint clean with 0 warnings/errors                                                                                                                                                                                                          |
| `pnpm typecheck`                 |    `0`    | `tsc -p tsconfig.json` clean                                                                                                                                                                                                                 |
| `pnpm build`                     |    `0`    | `tsc -b tsconfig.build.json` clean                                                                                                                                                                                                           |
| `pnpm test:unit`                 |    `0`    | 45 test files, 733 tests passed (57 new Sentinel tests)                                                                                                                                                                                      |
| `git diff --check`               |    `0`    | Clean diff, no trailing whitespace                                                                                                                                                                                                           |
| `pnpm test:integration`          |    `1`    | **BLOCKED IN WORKTREE (exit 1)**: Local run blocked due to missing `TEST_DATABASE_URL` (creating `.env*` is forbidden by task boundaries). Note: Remote GitHub Actions CI (Run 41205957355) with PostgreSQL 17 passed all integration tests. |
| `pnpm test:chaos`                |     -     | **NOT RUN** (Requires active database infrastructure / forbidden `.env*`)                                                                                                                                                                    |
| `pnpm test:e2e`                  |     -     | **NOT RUN** (Requires active database & HTTP services / forbidden `.env*`)                                                                                                                                                                   |
| `pnpm demo --scenario fast`      |     -     | **NOT RUN** (Requires active database infrastructure / forbidden `.env*`)                                                                                                                                                                    |

---

## 8. Rollback & Handover

- **Rollback:** Safe and trivial. Closing the Draft PR or discarding branch `feature/p0c-1b-sentinel-policy` cleanly rolls back the changes with zero database or infrastructure impact.
- **Handover to Agent A & C:**
  - Agent A (Sandbox): When sandbox exec intents are constructed, map them to `SentinelIntent` with category `mock.compute` or `host.exec`.
  - Agent C (Credentials & Egress): Egress intents map to `network.egress`, credential intents map to `credential.use`.

---

## 9. Final Acceptance Conclusion

```text
Sentinel-lite Policy Foundation: PASS
Production Tool/Network Interception: NOT IMPLEMENTED
```
