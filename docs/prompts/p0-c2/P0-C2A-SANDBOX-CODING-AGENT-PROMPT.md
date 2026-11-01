# Coding Agent Task Prompt — Lane P0-C2A: Sandbox Runtime Integration (v3)

> **Revision:** v3.0 (CTO Round 2 architecture hardening)  
> **Status:** `READY FOR CTO KICKOFF REVIEW; NO CODING UNTIL APPROVED`  
> **Role:** Systems Infrastructure & Sandbox Runtime Engineer (Agent C2A)  
> **Repository:** `https://github.com/basicv8vc/Ember`  
> **Pre-Prompt Reference SHA:** `7057bcfcce84e46d70f5cfc6b6b3bd641de5f642` (main before the docs-only PR; **not** the implementation checkout SHA)  
> **Coding Baseline Rule:** After the docs PR merges, fetch `origin/main`, create the worktree from its then-current HEAD, and record the actual full SHA.  
> **Target Branch:** `feature/p0c-2a-sandbox-runtime-integration`  
> **PR Target:** `main` (Draft PR only; no auto-merge, no deployment)  
> **Priority:** P0 Foundation Integration  
> **Execution Rule:** **Do NOT create branches or edit files in main checkout. Create a dedicated Git worktree.**

---

## 1. Objective & Boundaries

### 1.1 Objective

Design and implement a **provider-neutral sandbox runtime adapter and factory abstraction** that decouples Ember's execution engine (`DeterministicExecutor`) from concrete provider implementations, while strictly preserving the **fail-closed 8-phase lifecycle, independent resource verification, and tri-state leak detection** established in P0-C1A.

### 1.2 In-Scope

1. **Contracts (`packages/contracts/src/interfaces.ts`):**
   - Define `SandboxProviderFactory` and `SandboxAdapterOptions` interfaces extending the existing `SandboxProvider` contract (`#L262-L275`).
2. **Adapter Layer (`packages/execution/src/sandbox-adapter.ts`):**
   - Implement provider-neutral adapter wrapping lifecycle execution (`create` ➔ `waitReady` ➔ `exec` ➔ `readOutput` ➔ `usage` ➔ `stop` ➔ `destroy`).
   - Implement bounded timeouts, **abort signal propagation through factory construction, provider lifecycle and cleanup**, and sanitized domain error mapping.
   - Preserve the P0-C1A trust boundary: an arbitrary Provider exception (including a forged internal error class/code) is untrusted; never reflect its raw message or allow it to spoof a harness timeout.
3. **Pluggable Executor Injection (`packages/execution/src/deterministic-executor.ts`):**
   - Refactor `DeterministicExecutor` to accept an optional `SandboxProviderFactory` (defaulting to in-memory `FakeSandboxProvider`).
   - Preserve 100% deterministic output for `mock.compute` tasks.
   - Preserve cancellation, existing test hooks (`clock`, `sleep`, `onSandboxProvider`) and the current lifecycle behavior; do not allocate a Sandbox on Fast Path / `mock.chat`.
4. **Smoke Harness & Fail-Closed Leak Detection (`apps/cli/src/sandbox-smoke/**`):**
   - Update smoke harness to validate adapter contracts.
   - Strictly adhere to the **tri-state leak assessment model**:
     - `VERIFIED_CLEAN` (`resourcesLeaked: false`): ONLY when independent resource verification confirms 0 active resources (`resourceVerification: 'VERIFIED_ZERO'`).
     - `CONFIRMED_LEAK` (`resourcesLeaked: true`): When lingering resources are detected.
     - `UNKNOWN` (`resourcesLeaked: true` fail-closed): When cleanup cannot be independently proven (e.g. timeout during `create()` before a sandbox ID is returned, missing provider ID, or verification failure). Must set **SmokeReport** overall status to `FAIL` (not an invented Task/Run state).
   - Distinguish a Provider's successful `destroy()` acknowledgment from independent resource verification. A missing/throwing `liveSandboxCount`-style check can never create a false PASS.

### 1.3 Out-of-Scope (Strict Non-Goals)

- **NO Cloud Vendor SDKs or Calls:** Zero calls to Cloudflare, E2B, Daytona, or Boat. Passing `--provider <vendor>` must continue to fail closed with exit code 1.
- **NO Edits to Worker Run Loops:** Do NOT modify `apps/worker/**` (owned exclusively by Agent C2B).
- **NO Edits to Credentials/Egress:** Do NOT touch `packages/credentials/**` (owned exclusively by Agent C2C).
- **NO Root Manifest / Lockfile Changes:** `package.json` and `pnpm-lock.yaml` remain frozen.

---

## 2. File Ownership & Change Windows

### 2.1 Allowed Write Paths

- `packages/contracts/src/interfaces.ts` (sandbox interface extensions only)
- `packages/contracts/src/index.ts`
- `packages/execution/src/sandbox-adapter.ts` (new)
- `packages/execution/src/fake-sandbox.ts`
- `packages/execution/src/deterministic-executor.ts` (factory injection only)
- `packages/execution/src/index.ts` (**Sole owner during Step 1 window**)
- `apps/cli/src/sandbox-smoke/**`
- `tests/unit/p0c-sandbox-*.test.ts`
- `tests/integration/sandbox-adapter.test.ts` (new)
- `docs/P0-C2A-SANDBOX-ADAPTER.md` (new)

### 2.2 Forbidden Paths (STRICT)

- `apps/worker/**` (violators will be rejected)
- `packages/credentials/**`
- `packages/postgres/**`
- `migrations/**`
- `pnpm-lock.yaml` / `package.json`

---

## 3. Trust Boundary & Security Invariants

1. **Independent Resource Verification Invariant:**
   - Calling `stop()` and `destroy()` does **NOT** inherently guarantee `resourcesLeaked: false`.
   - If `create()` fails or times out before returning a sandbox ID, the runner cannot track what was allocated. The state is strictly `UNKNOWN`, `resourcesLeaked` is `true` (fail-closed), and overall status is `FAIL`.
   - A report may only declare `PASS` when `cleanup.leakStatus === 'VERIFIED_CLEAN'`, `cleanup.resourceVerification === 'VERIFIED_ZERO'`, and `cleanup.resourcesLeaked === false`.
   - If provider construction fails/hangs before allocation identity is known, assume cleanup **unverifiable** unless positively proven no allocation was attempted; never assert zero leak from a `finally` block alone.
2. **No Process Isolation:** The Fake provider executes in the **same process** and provides no OS process, container, VM or kernel isolation. Its deterministic lifecycle exercises contracts, not a security boundary.
3. **Sensitive Data Redaction:** Provider error messages, stack traces, and internal identifiers must be sanitized through `formatSanitizedError()` to safe domain error templates.
4. **Candidate Providers Remain `NOT_MEASURED`:** Rejection with exit code 1 and 0 network requests.

---

## 4. Implementation Steps (Ground in Merged Code)

1. **Create Dedicated Worktree:**
   ```bash
   git fetch origin main
   git rev-parse origin/main # record actual post-docs-merge SHA
   git worktree add -b feature/p0c-2a-sandbox-runtime-integration ~/Downloads/worktrees/ember-p0c-2a-sandbox origin/main
   cd ~/Downloads/worktrees/ember-p0c-2a-sandbox
   pnpm install --frozen-lockfile
   pnpm test:unit
   ```
2. **Define SandboxProviderFactory (`packages/contracts/src/interfaces.ts`):**
   ```typescript
   export interface SandboxProviderFactory {
     createProvider(context: {
       tenantId: Id;
       runId: Id;
       signal: AbortSignal; // trusted Run cancellation/lease-loss signal
     }): Promise<SandboxProvider>;
   }
   ```
   Preserve the existing `SandboxProvider` API; do not duplicate lifecycle methods or introduce an implicit real-vendor selector. Factory implementations must not retain the signal or raw user payload in exported reports.
3. **Implement SandboxAdapter (`packages/execution/src/sandbox-adapter.ts`):**
   - Wrap `SandboxProvider` with timeout guards (`parseBoundedTimeoutMs`), abort signal handling (`throwIfAborted`), and normalized error mapping.
   - Enforce lifecycle transitions: `create` ➔ `waitReady` ➔ `exec` ➔ `readOutput` ➔ `usage` ➔ `stop` ➔ `destroy`.
4. **Refactor DeterministicExecutor (`packages/execution/src/deterministic-executor.ts`):**
   - Accept `options.sandboxFactory?: SandboxProviderFactory`.
   - Default to `defaultFakeSandboxFactory` to maintain existing P0-B execution behavior.
5. **Update Export Manifest (`packages/execution/src/index.ts`):**
   - Export new adapter types and factory interfaces.
6. **Add Unit & Integration Regression Tests:**
   - Test normal execution, abort during factory/create/waitReady/exec, bounded stop/destroy cleanup, timeout with no returned sandbox ID, failed independent verification, and non-support of resource counting.
   - Inject Provider errors with spoofed `SmokeHarnessError` codes, raw tokens, and malicious output; assert exported JSON and logs contain no raw values and cannot misclassify a Provider failure as an internal timeout.
   - Verify failed creation or uncertain cleanup reports `leakStatus: UNKNOWN`, `resourcesLeaked: true`, overall SmokeReport `FAIL`; preserve 0 live Sandbox and no extra allocations on Fast Path.

---

## 5. Acceptance Criteria & Definition of Done (DoD)

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` pass with exit code 0.
- [ ] Unit tests pass: `pnpm test:unit` (≥ 52 files, ≥ 877 tests).
- [ ] Integration tests pass: `pnpm test:integration`.
- [ ] Chaos and HTTP E2E regression pass: `pnpm test:chaos`, `pnpm test:e2e` (where a configured disposable PostgreSQL test DB is available; record any environment block honestly).
- [ ] Product demos pass: `pnpm demo` (all 4 scenarios).
- [ ] Sandbox smoke CLI passes: `pnpm sandbox:smoke:local` and `pnpm sandbox:smoke:local --json`.
- [ ] Passing `--provider cloudflare` exits with code 1 and executes 0 network calls.
- [ ] Verification test: Simulated timeout during `create()` produces `leakStatus: UNKNOWN`, `resourcesLeaked: true`, and SmokeReport overall status `FAIL`.
- [ ] Timeout/abort propagation from `DeterministicExecutor` to factory/provider is exercised; no hung cleanup can be reported `VERIFIED_CLEAN` without independent proof.
- [ ] Clean run asserts `resourceVerification: VERIFIED_ZERO`, `leakStatus: VERIFIED_CLEAN`, and `resourcesLeaked: false`.

---

## 6. PR Delivery Instructions

1. Open Draft PR titled: `feat(sandbox): P0-C2A provider-neutral sandbox runtime adapter`.
2. Target branch: `main`. Starting reference SHA: `7057bcfcce84e46d70f5cfc6b6b3bd641de5f642`. Record actual `origin/main` base and head SHAs at PR creation; do not silently claim the historic baseline is still current.
3. Include exact local and CI test exit codes/counts, changed-file list, constraints, rollback plan, zero-cost/zero-real-network attestation, and the latest head SHA.
4. Do NOT merge or trigger production workflows.
