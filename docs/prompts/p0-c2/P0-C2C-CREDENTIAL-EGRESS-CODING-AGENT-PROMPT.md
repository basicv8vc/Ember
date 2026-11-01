# Coding Agent Task Prompt — Lane P0-C2C: Credential/Egress Control-Plane Wiring (v3)

> **Revision:** v3.0 (CTO Round 2 trust-boundary hardening)  
> **Status:** `READY FOR CTO KICKOFF REVIEW; NO CODING UNTIL APPROVED`  
> **Role:** Credential Management & Network Egress Security Engineer (Agent C2C)  
> **Repository:** `https://github.com/basicv8vc/Ember`  
> **Pre-Prompt Reference SHA:** `7057bcfcce84e46d70f5cfc6b6b3bd641de5f642` (main before the docs-only PR; **not** the implementation checkout SHA)  
> **Coding Baseline Rule:** After the docs PR merges, fetch `origin/main`, create the worktree from its then-current HEAD, and record the actual full SHA.  
> **Target Branch:** `feature/p0c-2c-credential-egress-context-wiring`  
> **PR Target:** `main` (Draft PR only; no auto-merge, no deployment)  
> **Priority:** P0 Foundation Integration  
> **Execution Rule:** **Do NOT create branches or edit files in main checkout. Create a dedicated Git worktree.**

---

## 1. Objective & Boundaries

### 1.1 Objective

Connect the **simulated Credential Broker and Egress Policy engine** (`packages/credentials/`) through the **existing** `RunExecutionContextReader` interface to the PostgreSQL-backed implementation supplied by a **trusted composition root**. Establish fail-closed operational worker-identity consistency and tenant/operation/scope checks without introducing a live Vault, proxy or external network call. **Do not claim that string worker-ID comparison is cryptographic authentication.**

### 1.2 In-Scope

1. **Reuse Existing Context Reader (DO NOT Re-implement):**
   - Reuse `PostgresRunExecutionContextReader` from `@ember/postgres` (`packages/postgres/src/repositories/run-execution-context-reader.ts`) **in integration tests and, later, the trusted Worker composition root**. Do **not** import `@ember/postgres` from production `packages/credentials/src/**`; this package remains interface-driven.
   - Preserve `CredentialBroker.executeWithCredential(lease, credentialRef, egressRequest, contextReader, now)` and the existing `RunExecutionContextReader` interface from `@ember/contracts` (whose `read()` **returns** `RunExecutionContext` or **throws**; it does not return `null`). No duplicate reader and no new cycle between credentials and postgres.
2. **Caller Identity Authentication vs Lease Claim:**
   - Recognize that `LeasedRun` does **NOT** contain `workerId` (`LeasedRun` contains `taskId`, `runId`, `tenantId`, `attempt`, `leaseEpoch`, `leaseExpiresAt`).
   - The database stores `worker_id` on the `runs` table, which `PostgresRunExecutionContextReader` returns in `RunExecutionContext.workerId`.
   - **Never accept `callerWorkerId` as a per-request argument or a value from Task/HTTP/Sandbox input.** A caller could simply assert the expected value. Instead, bind a trusted operational `workerId` when constructing the Broker's **execution capability** in the server-side Worker composition root, sourced exclusively from validated Worker configuration. The Broker must fail closed for execution when this trusted binding is absent, malformed or missing in the authoritative context.
   - The Broker then verifies:
     - Lease is valid, active, and not expired (`context.leaseEpoch === lease.leaseEpoch`).
     - The server-configured operational Worker identity matches the `worker_id` recorded in PostgreSQL (`context.workerId === trustedWorkerId`). A lease claim or caller-chosen string alone is **NOT** authentication. This is a local trusted-process consistency guard; remote Worker authentication (e.g. mTLS/signed capability) remains **NOT IMPLEMENTED** in P0-C2.
3. **Tenant-Scoped Policy Binding & Scope Enforcement:**
   - **Keep `EgressPolicy` authoritative in `CredentialBrokerOptions` / Broker instance. Never accept a policy document in `executeWithCredential()` options or other caller-supplied execution payload.** If the trusted policy is tenant-bound (`policy.tenantId` set), enforce equality to `context.tenantId`. Preserve explicit global-policy semantics if current contract permits an unbound policy.
   - Match server-side required scopes against credential scopes stored in registry.
4. **Integration Testing with Real PostgreSQL:**
   - Implement `tests/integration/credential-broker-postgres.test.ts` targeting real PostgreSQL schemas.
   - Assert: stale/expired/cancelled/fenced lease rejection, missing trusted Worker identity rejection, incorrect trusted Worker identity rejection, cross-tenant isolation, denied operation/scope, rotation revocation, and duplicate `ruleId` rejection. Existing reader's `STALE_LEASE`/`CANCELLED`/`NOT_FOUND` semantics must remain observable or safely mapped without leaking data.
5. **Zero Outbound Network Traffic:**
   - Zero HTTP/TCP sockets to real internet endpoints (`tests/unit/p0c-credential-zero-network.test.ts` must pass).

### 1.3 Out-of-Scope (Strict Non-Goals)

- **NO Duplicate Postgres Reader:** Do NOT create a new context reader in `packages/postgres/src/run-context.ts` or anywhere else.
- **NO Direct Edits to Worker Run Loop:** Do NOT modify `apps/worker/**` (Lane B will wire the reader/broker into the worker).
- **NO Changes to Sandbox Interfaces:** Do NOT touch `packages/contracts/src/interfaces.ts`.
- **NO Production Vault / Real Network:** Sockets and HTTP connections to real internet remain strictly prohibited.
- **NO Caller-Selected Policy or Identity:** Do not accept `policy` or `callerWorkerId` per operation. Never mistake matching a string for caller authentication.

---

## 2. File Ownership & Change Windows

### 2.1 Allowed Write Paths

- `packages/credentials/src/**`
- `tests/unit/p0c-credential-*.test.ts`
- `tests/integration/credential-broker-postgres.test.ts` (new)
- `docs/P0-C2C-CREDENTIAL-CONTEXT-WIRING.md` (new)

### 2.2 Forbidden Paths (STRICT)

- `packages/postgres/src/**` (existing reader is frozen and reused as-is)
- `apps/worker/**` (violators will be rejected)
- `packages/contracts/**`
- `migrations/**`
- `pnpm-lock.yaml` / `package.json`
- `packages/credentials/package.json` (no new production dependency needed: the concrete Reader is composed by Worker/tests)

---

## 3. Trust Boundary & Security Invariants

1. **Trusted Process Identity Binding (NOT Remote Authentication):**
   - A valid lease claim is **NOT** proof of caller identity.
   - A trusted server composition root configures the Broker's `trustedWorkerId`; external callers cannot replace it per call. Broker asserts `trustedWorkerId === context.workerId` and rejects mismatches. A malicious client supplying a matching arbitrary string is **not** authentication; that value must never be used as authority.
   - Remote/hostile Worker identity authentication, signed leases and mTLS are explicitly **out of scope** and must remain `NOT IMPLEMENTED` in all P0-C2 claims.
2. **Authoritative Context Verification:**
   - Broker rechecks the lease via injected `RunExecutionContextReader`, backed by existing PostgreSQL Reader. Stale epoch, expired lease or cancelled tasks must fail closed using existing domain codes or a **fixed sanitized mapping**; do not collapse everything to fabricated `POLICY_DENIED` if the contract specifies `STALE_LEASE`/`CANCELLED`.
3. **Synthetic Metadata Only:**
   - `InMemoryCredentialRegistry` stores only synthetic references (`credentialRef`, `provider`, `scopes`). Zero real tokens.
4. **Tenant-Scoped Policy Binding:**
   - Cross-tenant requests return uniform `NOT_FOUND` / `POLICY_DENIED` to eliminate enumeration attacks.
5. **Redacted Audit Trail:**
   - Unverified providers and operations are masked (`[UNVERIFIED_PROVIDER]`, `[UNVERIFIED_OPERATION]`) on denial.
6. **Policy Authority:** `EgressPolicy` is constructor-injected trusted server configuration; a request body must never replace it or loosen `requiredScopes`, `allowedOperations`, tenant bindings or redirect controls.
7. **TOCTOU Boundary:** This phase has zero real external side effects; a successful point-in-time lease read is not a durable grant to perform future network calls. Document the required later fencing/revalidation at the actual side-effect boundary.

---

## 4. Implementation Steps (Ground in Merged Code)

1. **Create Dedicated Worktree:**
   ```bash
   git fetch origin main
   git rev-parse origin/main # record actual post-docs-merge SHA
   git worktree add -b feature/p0c-2c-credential-egress-context-wiring ~/Downloads/worktrees/ember-p0c-2c-credentials origin/main
   cd ~/Downloads/worktrees/ember-p0c-2c-credentials
   pnpm install --frozen-lockfile
   pnpm test:unit
   ```
2. **Compose Existing Postgres Reader in Tests, Not in Credential Source:**
   ```typescript
   import { PostgresRunExecutionContextReader } from '@ember/postgres';
   import type { RunExecutionContextReader } from '@ember/contracts';
   ```
   Use those imports in `tests/integration/credential-broker-postgres.test.ts` and give the reader through the existing interface. **No `@ember/postgres` dependency in `@ember/credentials`.**
3. **Bind Trusted Operational Identity at Broker Construction:**
   Evolve only the **trusted server-side** Broker options (or a dedicated trusted execution facade created by the Worker composition root):
   ```typescript
   export interface CredentialBrokerOptions {
     readonly registry: InMemoryCredentialRegistry;
     readonly policy: EgressPolicy; // trusted, not caller supplied
     readonly auditSink?: AuditSink;
     readonly trustedWorkerId?: string; // trusted Worker config binding
   }
   ```
   Execution must fail closed when `trustedWorkerId` is absent/invalid, while pure management APIs remain available if appropriate. Verify `context.workerId === this.trustedWorkerId` immediately after the authoritative reader returns, **before** any credential lookup/audit of user-supplied operation details. Keep `executeWithCredential()`'s existing argument and type contract; if a breaking change is truly necessary, document compatibility and update all call sites/tests. Never expose a public per-call override.
4. **Enforce Rotation Invalidation & Audit Sanitization:**
   Ensure credential rotation marks old references as `revoked`.
5. **Add Comprehensive Real PostgreSQL Integration Tests:**
   Create `tests/integration/credential-broker-postgres.test.ts` testing:
   - Successful **SIMULATED** response with trusted configured `workerId` matching current DB owner and active lease.
   - Rejection when trusted identity missing or different from persisted `context.workerId`; demonstrate that forging a `callerWorkerId` in an untrusted payload does not affect authority.
   - Rejection when lease is expired or cancelled.
   - Cross-tenant isolation rejection.
   - Verification that 0 outbound network calls were attempted.

---

## 5. Acceptance Criteria & Definition of Done (DoD)

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` pass with exit code 0.
- [ ] Unit tests pass: `pnpm test:unit`.
- [ ] Integration regression passes: `pnpm test:integration`.
- [ ] Chaos and HTTP E2E regression pass: `pnpm test:chaos`, `pnpm test:e2e` in an approved local/CI disposable test DB (record environment blockers honestly).
- [ ] Zero network test passes: `tests/unit/p0c-credential-zero-network.test.ts`.
- [ ] Real PostgreSQL integration test passes: `tests/integration/credential-broker-postgres.test.ts`.
- [ ] Asserted invariant: Server-bound trusted Worker identity mismatch (or absence) fails closed; no per-call `workerId` or policy override is possible.
- [ ] Asserted invariant: Existing `executeWithCredential` signature and server-owned EgressPolicy cannot be replaced with a caller-selected document; no imports of `@ember/postgres` from `packages/credentials/src/**`.
- [ ] Asserted invariant: Reuses existing `PostgresRunExecutionContextReader` without duplication.

---

## 6. PR Delivery Instructions

1. Open Draft PR titled: `feat(credentials): P0-C2C authoritative context reader and egress wiring`.
2. Target branch: `main`. Starting reference SHA: `7057bcfcce84e46d70f5cfc6b6b3bd641de5f642`. Record actual `origin/main` and head SHAs; do not create a second Reader or a hidden direct dependency on postgres.
3. Include exact local/CI suite outcomes, changed-file list, API compatibility notes, trust-boundary limitations, and rollback plan.
4. Do NOT merge or trigger production workflows.
