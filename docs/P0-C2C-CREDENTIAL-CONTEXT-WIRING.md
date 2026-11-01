# Ember P0-C2C — Credential/Egress Control-Plane Context Wiring (v3.0)

## 1. Executive Summary & Git Baseline

- **Lane:** P0-C2C (Credential Management & Network Egress Security)
- **Role:** Credential Management & Network Egress Security Engineer (Agent C2C)
- **Repository:** `https://github.com/basicv8vc/Ember`
- **Pre-Prompt Reference SHA:** `7057bcfcce84e46d70f5cfc6b6b3bd641de5f642`
- **Worktree Baseline SHA (`origin/main` after PR #36):** `f02075b7d8139149efdb6bc28ac05d7f5d764ae5`
- **Target Branch:** `feature/p0c-2c-credential-egress-context-wiring`
- **PR Target:** `main` (Draft PR only; no auto-merge, no deployment)
- **Status:**
  - `Broker + PostgreSQL Reader Integration: PASS`
  - `Trusted Worker Identity Binding & Fail-Closed Enforcement: PASS`
  - `Domain Error Semantics Preservation (STALE_LEASE / CANCELLED / NOT_FOUND): PASS`
  - `Zero Network Socket / HTTP Egress Guarantees: PASS`
  - `Production Worker Runtime Wiring: NOT IMPLEMENTED IN THIS PR (Lane P0-C2B scope; apps/worker/** strictly forbidden in P0-C2C)`
  - `Remote Worker Cryptographic Authentication: NOT IMPLEMENTED (Out of scope for P0-C2)`
  - `Live External Vault / Real Proxy Socket Connections: NOT IMPLEMENTED (Out of scope for P0-C2)`

---

## 2. Architecture & Trust Boundary Model

```mermaid
flowchart TD
    subgraph CompositionRoot["Trusted Composition Root (Worker / Server Boot)"]
        WorkerConfig["Worker Configuration (workerId: 'worker-local')"]
        PolicyConfig["Authoritative EgressPolicy (defaultAction: 'deny')"]
        DbPool["PostgreSQL Connection Pool"]
        DbReader["PostgresRunExecutionContextReader (@ember/postgres)"]
        BrokerInit["CredentialBroker Construction"]

        WorkerConfig -->|trustedWorkerId| BrokerInit
        PolicyConfig -->|trusted policy| BrokerInit
        DbPool --> DbReader
    end

    subgraph ControlPlane["Control Plane (@ember/credentials)"]
        Broker["CredentialBroker"]
        Registry["InMemoryCredentialRegistry (Synthetic References Only)"]
        EgressEngine["evaluateEgressRequest (Origin / Method / Scope / Op Guard)"]
        AuditSink["Redacted Audit Sink (networkCallsMade: 0)"]

        BrokerInit --> Broker
        Registry <--> Broker
        Broker --> EgressEngine
        Broker --> AuditSink
    end

    subgraph ExecutionPlane["Execution Plane (Untrusted Caller / Sandbox)"]
        CallerLease["Claimed LeasedRun (tenantId, taskId, runId, epoch, expiry)"]
        UntrustedPayload["EgressRequest (url, method, provider, op)"]
        ForgedInput["Attacker input (callerWorkerId, injected policy) - ZERO AUTHORITY"]
    end

    subgraph Database["PostgreSQL Storage (Authoritative State)"]
        DBTasks["tasks table (cancel_requested_at, lease_epoch, status)"]
        DBRuns["runs table (worker_id, lease_epoch, status, leased_until)"]
        DBAgents["agents table (policy_version)"]
    end

    CallerLease -->|executeWithCredential| Broker
    UntrustedPayload -->|executeWithCredential| Broker
    ForgedInput -.->|Ignored / Stripped| Broker

    Broker -->|1. Injected Reader read(lease)| DbReader
    DbReader -->|Single SELECT snapshot| DBTasks
    DbReader -->|Single SELECT snapshot| DBRuns
    DbReader -->|Single SELECT snapshot| DBAgents
    DbReader -->|Authoritative RunExecutionContext| Broker

    Broker -->|2. Verify context.workerId === trustedWorkerId| Broker
    Broker -->|3. Verify context invariants & tenant policy binding| Broker
    Broker -->|4. Resolve synthetic cred & evaluate egress rules| Broker
    Broker -->|5. Return SIMULATED proxy result| ExecutionPlane
```

### 2.1 Core Invariants & Boundaries

1. **Reuse Existing Context Reader (No Duplication, Interface-Driven):**
   - `@ember/credentials` imports strictly the abstract `RunExecutionContextReader` and `RunExecutionContext` interfaces from `@ember/contracts`.
   - `PostgresRunExecutionContextReader` from `@ember/postgres` is never imported in production source code (`packages/credentials/src/**`), maintaining zero package-dependency cycles.
   - The concrete reader is supplied at the composition root (Worker initialization and integration tests) via dependency injection.
   - **Production Worker Runtime Wiring Boundary:** `apps/worker/**` is intentionally untouched in this PR as production worker runtime wiring belongs to Lane P0-C2B. The interface integration between Credential Broker and `PostgresRunExecutionContextReader` is verified in integration tests (`tests/integration/credential-broker-postgres.test.ts`), while actual production worker wiring is deferred to Lane B.
   - The existing `RunExecutionContextReader.read()` contract is preserved without signature deviation: it returns a frozen `RunExecutionContext` or throws a structured `DomainError`; it never returns `null`.

2. **Operational Worker Identity Consistency vs. Lease Claim:**
   - A `LeasedRun` does **not** contain `workerId` (`LeasedRun` contains `taskId`, `runId`, `tenantId`, `attempt`, `leaseEpoch`, `leaseExpiresAt`).
   - The authoritative PostgreSQL database records `worker_id` on the `runs` table, which `PostgresRunExecutionContextReader` maps to `RunExecutionContext.workerId`.
   - **Never accept `callerWorkerId` as a request argument or caller-supplied payload:** Untrusted clients or malicious sandboxes could simply assert the expected worker identity.
   - The Broker binds a trusted operational `workerId` when constructed:
     ```typescript
     export interface CredentialBrokerOptions {
       readonly registry: InMemoryCredentialRegistry;
       readonly policy: EgressPolicy; // trusted, not caller supplied
       readonly auditSink?: AuditSink;
       readonly trustedWorkerId?: string; // trusted Worker config binding
     }
     ```
   - If `trustedWorkerId` is absent or empty, execution APIs fail closed immediately with `UNAUTHENTICATED`, while pure management APIs remain accessible.
   - Immediately upon receiving `context` from the reader, the Broker verifies:
     `context.workerId === this.trustedWorkerId`
     **before** any credential lookup or audit recording of caller-supplied operation details.
   - **Explicit Trust-Boundary Limitation:** Local string comparison of `workerId` is a trusted-process consistency guard within the node execution host. It is **NOT cryptographic remote authentication**. Remote worker mTLS, signed capabilities, and mutual cryptographic attestation remain explicitly **NOT IMPLEMENTED** in P0-C2.

3. **Authoritative Context & Domain Error Preservation:**
   - Authoritative context verification via `contextReader.read(lease, now)` evaluates lease epoch, run attempt, lease expiration, and cancellation intent against database statement time (`now()`).
   - Rejection semantics from the database reader (`STALE_LEASE`, `CANCELLED`, `NOT_FOUND`, `DEADLINE_EXCEEDED`) pass through transparently to the caller without being flattened or converted into fabricated `POLICY_DENIED` errors.

4. **Authoritative Server Egress Policy Binding:**
   - `EgressPolicy` is server-owned and injected into `CredentialBrokerOptions`. `executeWithCredential` does not accept a per-request policy document.
   - When `policy.tenantId` is specified, it strictly enforces `policy.tenantId === context.tenantId`; cross-tenant requests fail closed with `POLICY_DENIED`. Global unbound policies remain supported when `policy.tenantId` is undefined.
   - All egress rules require unique `ruleId`s; duplicate IDs throw `INVALID_ARGUMENT` during constructor validation.
   - Server-side rule `requiredScopes` are strictly matched against `credential.scopes` stored in the registry.

5. **TOCTOU Boundary:**
   - In P0-C2, zero external side effects occur. Point-in-time lease verification is not a durable license to execute unbounded side effects in the future. Subsequent phases that introduce external network egress must re-validate fencing tokens or implement transaction rollback barriers at the side-effect boundary.

---

## 3. Threat Model & Countermeasure Matrix

| Threat Scenario                     | Vector / Description                                                  | P0-C2C Mitigation                                                                                                                                |
| :---------------------------------- | :-------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker Identity Spoofing**        | Untrusted caller provides a fake `callerWorkerId` in body/options     | Caller payload is ignored; broker verifies persisted `context.workerId === this.trustedWorkerId`. Mismatches throw `UNAUTHENTICATED`.            |
| **Missing Worker Binding**          | Broker constructed without operational identity executes egress       | Execution fails closed with `UNAUTHENTICATED` before reading context or resolving credentials.                                                   |
| **Policy Override Injection**       | Adversarial payload supplies `{ policy: { defaultAction: 'allow' } }` | Broker only references `this.policy` injected at construction. Caller-supplied objects have zero authority.                                      |
| **Audit Injection / Log Pollution** | Hostile worker sends bogus provider/operation before auth check       | Worker identity check runs before any credential lookup or audit sink recording. On denial, provider/operation are masked with `[UNVERIFIED_*]`. |
| **Stale Lease Epoch Replay**        | Worker whose lease was reaped or fenced attempts execution            | PostgreSQL reader asserts `run_lease_epoch === lease.leaseEpoch`. Rejection raises `STALE_LEASE`.                                                |
| **Committed Cancellation Bypass**   | Task was cancelled in DB while run was claimed                        | PostgreSQL reader detects `cancel_requested_at !== null` and raises `CANCELLED` domain error.                                                    |
| **Cross-Tenant Credential Probing** | Tenant B presents lease from Tenant B with credential from Tenant A   | Registry lookup is tenant-partitioned and returns `undefined`, triggering uniform agnosticism `NOT_FOUND`.                                       |
| **Rotation Bypass**                 | Worker attempts to use previously rotated credential reference        | Rotation invalidates old reference (`status: 'revoked'`). Subsequent calls throw `POLICY_DENIED`.                                                |
| **Outbound Data Exfiltration**      | Broker or proxy attempts real HTTP socket to remote target            | Architecture has no socket opening logic; verified with spies on Node `http`, `https`, `net`, `dns`, and `fetch`.                                |

---

## 4. Changed File Manifest

| Path                                                   | Change Type | Description                                                                                                                                                                                          |
| :----------------------------------------------------- | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/credentials/src/broker.ts`                   | Modified    | Added `trustedWorkerId?: string` to `CredentialBrokerOptions`, constructor validation, and fail-closed operational identity checks immediately post-context read in `executeWithCredential`.         |
| `tests/unit/p0c-credential-broker.test.ts`             | Modified    | Updated test setup to supply trusted worker identity; added test cases for missing worker identity, mismatched worker identity, empty identity constructor rejection, and payload spoofing immunity. |
| `tests/unit/p0c-credential-zero-network.test.ts`       | Modified    | Configured `trustedWorkerId` in zero-network verification tests.                                                                                                                                     |
| `tests/integration/credential-broker-postgres.test.ts` | **New**     | Real PostgreSQL integration test suite (12 tests) verifying context reader composition, live lease fencing, cancellation, worker identity consistency, rotation revocation, and zero network calls.  |
| `docs/P0-C2C-CREDENTIAL-CONTEXT-WIRING.md`             | **New**     | Comprehensive architectural documentation, security boundary definitions, and verification evidence.                                                                                                 |

---

## 5. Verification & Test Evidence

All test suites were executed against the isolated local environment and PostgreSQL instance:

```bash
# 1. Typecheck
pnpm typecheck
# Exit code: 0

# 2. Lint
pnpm lint
# Exit code: 0

# 3. Unit Tests
pnpm test:unit
# 52 test files passed, 882 tests passed

# 4. PostgreSQL Integration Tests
pnpm test:integration
# 26 test files passed, 272 tests passed
# Includes: tests/integration/credential-broker-postgres.test.ts (12 tests passed in 233ms)

# 5. Chaos Resilience Tests
pnpm test:chaos
# 4 test files passed, 24 tests passed

# 6. End-to-End Tests
pnpm test:e2e
# 8 test files passed, 13 tests passed

# 7. Package Build
pnpm build
# Exit code: 0
```

### Detailed Summary of `credential-broker-postgres.test.ts` (12 Tests)

1. `executes a valid simulated request against a live PostgreSQL lease and owner`: PASSED (simulated result matches tenant/task/run).
2. `fails closed when trusted operational workerId is missing on broker`: PASSED (`UNAUTHENTICATED` error).
3. `fails closed when trusted operational workerId mismatches PostgreSQL persisted worker_id`: PASSED (`UNAUTHENTICATED` error).
4. `proves that untrusted caller-supplied callerWorkerId has zero authority and cannot match/override Postgres worker_id`: PASSED (`UNAUTHENTICATED` error).
5. `rejects execution when the PostgreSQL lease is expired with observable STALE_LEASE semantics`: PASSED (`STALE_LEASE` preserved).
6. `rejects execution when task has a committed cancellation intent with observable CANCELLED semantics`: PASSED (`CANCELLED` preserved).
7. `rejects execution when the lease epoch is stale/fenced by a subsequent attempt`: PASSED (`STALE_LEASE` preserved).
8. `enforces uniform agnosticism and cross-tenant isolation (NOT_FOUND)`: PASSED (`NOT_FOUND` on cross-tenant cred or lease).
9. `enforces server-side requiredScopes and operation whitelist, rejecting unpermitted actions`: PASSED (`POLICY_DENIED`).
10. `invalidates old credential references upon rotation and enforces revocation`: PASSED (`POLICY_DENIED` on old, success on new).
11. `rejects duplicate ruleId in EgressPolicy constructor to prevent shadowing`: PASSED (`INVALID_ARGUMENT`).
12. `strictly guarantees 0 outbound network/socket/DNS calls across all operations`: PASSED (spies confirm 0 calls).

---

## 6. Backward Compatibility & Rollback Plan

- **API Compatibility:**
  - `CredentialBroker.executeWithCredential(lease, credentialRef, egressRequest, contextReader, now)` keeps its signature and type contract exactly as before.
  - `CredentialBrokerOptions` adds an optional `trustedWorkerId?: string`. Omission of this field does not break constructor calls; management APIs remain fully functional. Execution APIs will fail closed until the trusted operational worker identity is configured by the Worker composition root.
  - **Production Worker Runtime Wiring:** `apps/worker/**` is strictly untouched in this PR; production worker wiring is deferred to Lane P0-C2B.
  - No database migration or schema alteration is required.
  - No new production package dependencies are added to `@ember/credentials`.
- **Rollback Procedure:**
  - Revert commit on `feature/p0c-2c-credential-egress-context-wiring` or restore `packages/credentials/src/broker.ts` to `8ebf524812b2ca04ea91994acf1a473ef7c2b879`.
