# Ember V2 — M0 Post-Merge Verification Report (D0 Gate)

- **Status:** **PASSED (M0 Gate Verified)**
- **Date:** 2026-11-19
- **Role:** Performance, Integration & Reliability Engineer (V2-M1-D)
- **Verified `main` SHA:** `6da1b483b6a854199a0f2eef27e53abc770be6cc` (`origin/main` — PR #170 merged on top of PR #171 `9e9bf54` and PR #172 `d53b9aa`)
- **Pre-M0 Historical Baseline SHA:** `ee660f52f02cad196cf724f0f818df3789fe3e8c`
- **Verification Worktree:** `worktrees.local/v2-m1-d-runtime-acceptance` (branch `feat/v2-m1-d-runtime-acceptance`)

---

## 1. Gate Execution Summary

All D0 post-merge checks were executed in a clean isolated worktree checked out at `6da1b483b6a854199a0f2eef27e53abc770be6cc` with `pnpm install --frozen-lockfile`:

| Check                              | Command                                                                                                                                                                                 | Result                         | Observed Counts / Notes                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build                              | `pnpm build` (`tsc -b tsconfig.build.json`)                                                                                                                                             | **PASS**                       | Exited `0`                                                                                                                                                                                                              |
| Typecheck                          | `pnpm typecheck` (`tsc -p tsconfig.json`)                                                                                                                                               | **PASS**                       | Exited `0`                                                                                                                                                                                                              |
| Lint                               | `pnpm lint` (`eslint .`)                                                                                                                                                                | **PASS**                       | Exited `0` (0 errors, 0 warnings)                                                                                                                                                                                       |
| Unit Tests                         | `pnpm test:unit`                                                                                                                                                                        | **PASS**                       | **103** test files passed, **1,707** tests passed (0 failed, 0 skipped; duration `17.27 s`)                                                                                                                             |
| PR #172 PG / `workerd` Integration | `TEST_DATABASE_URL="postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test" pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m0-probes.test.ts` | **PASS**                       | **1** test file passed, **4** tests passed (`workerd` DO SQLite + `GlobalBudgetDO` + D1 probe, 2-RPC/3-RPC timing & fail-closed budget contention, regional RTT simulation, local PG17 V1 baseline; duration `26.97 s`) |
| Shared DDL & Interface Consistency | Cross-document & probe static check (`v2-m0-runtime-contract.md` vs `v2-m0-event-recovery-contract.md` vs `v2-m0-event-recovery-probe.test.ts`)                                         | **PASS**                       | All shared tables and seam port signatures match verbatim (see §3)                                                                                                                                                      |
| Prettier Format Check (Advisory)   | `pnpm format:check`                                                                                                                                                                     | **PRE-EXISTING WARN (Exit 1)** | 2 pre-existing V1 docs (`docs/architecture/neon-postgres-provider-decision.md`, `docs/architecture/neon-postgres-provider-decision.zh-CN.md`); **0** M0/M1 files affected                                               |

---

## 2. Historical Baseline Comparison (`ee660f5` vs `6da1b48`)

Comparing pre-M0 `main` (`ee660f52f02cad196cf724f0f818df3789fe3e8c`) against post-M0 `main` (`6da1b483b6a854199a0f2eef27e53abc770be6cc`):

- **Code & Artifact Diff:** `32 files changed, 17,424 insertions(+), 29 deletions(-)` across PR #170 (M0-A contract), PR #171 (M0-B contract + probe), and PR #172 (M0-D benchmark suite + raw artifacts + report).
- **Unit Test Delta:**
  - Pre-M0 `main` (`ee660f5`): **98** test files / **1,687** tests (inferred by subtracting the 5 M0 unit test files from the verified post-M0 total).
  - Post-M0 `main` (`6da1b48`): **103** test files (**+5**) / **1,707** tests (**+20**):
    - `tests/unit/v2-m0-event-recovery-probe.test.ts`: **9** tests
    - `tests/unit/v2-m0-guards.test.ts`: **5** tests
    - `tests/unit/v2-m0-cost-model.test.ts`: **4** tests
    - `tests/unit/v2-m0-model-routing.test.ts`: **1** test
    - `tests/unit/v2-m0-report-reconciliation.test.ts`: **1** test
- **Integration Test Delta:**
  - Added `tests/integration/v2-m0-probes.test.ts` (**4** tests covering real local `workerd` DO SQLite/`GlobalBudgetDO`/D1 and local PostgreSQL 17.11).
- **Failures & Regressions:** **0** failures in build, typecheck, lint, unit tests, or PR #172 integration probes. The only pre-existing repo-wide check failure is `pnpm format:check` on two unrelated `neon-postgres-provider-decision*.md` files predating M0.

---

## 3. Shared DDL & Interface Reference Consistency Audit

Verified cross-references across [v2-m0-runtime-contract.md](./v2-m0-runtime-contract.md) (PR #170), [v2-m0-event-recovery-contract.md](./v2-m0-event-recovery-contract.md) (PR #171), and [v2-m0-event-recovery-probe.test.ts](../../tests/unit/v2-m0-event-recovery-probe.test.ts):

1. **Canonical DDL Ownership:**
   - **Agent A (`v2-m0-runtime-contract.md`):** Owns `schema_migrations`, `agent_head_meta`, `conversations`, `conversation_messages`, `message_attachments`, `assistant_turns`, `tasks`, `runs`, `task_events`, `task_results`, `approvals`, `model_attempts`, `agent_spend_days`, `agent_budget_incidents`. Explicitly avoids duplicating B's DDL and confirms no secondary writable `v2_execution_leases` table exists.
   - **Agent B (`v2-m0-event-recovery-contract.md`):** Owns `v2_schedules`, `v2_dispatch_outbox` (with `operation_id`, 0-based `revision >= 0`, `CHECK` forcing `queue_name IS NOT NULL` for `'turn' | 'task' | 'schedule_occurrence' | 'handoff'` and `queue_name IS NULL AND operation_id IS NOT NULL` for `'budget_sync'`, plus partial unique index `idx_v2_outbox_budget_sync_op_rev`), `v2_recovery_coverage`, and D1 `v2_recovery_registry` (preserving immutable `next_recovery_at_ms` + separate `retry_not_before_ms`).
   - All 4 B tables and all 8 primary A tables are consistently referenced across both contract documents; `v2-m0-event-recovery-probe.test.ts` implements the exact `v2_recovery_registry`, `v2_recovery_coverage`, `v2_dispatch_outbox`, and `v2_schedules` DDL.
2. **Joint A ↔ B Seam Interfaces:**
   - `AuthoritativeBusinessPort` (`earliestRequiredDiscoveryAtMsSync`, `listDueBusinessActionsSync`, `convergeDueBusinessItemSync`, `inspectOutboxTargetSync`, `materializeScheduleOccurrenceSync`) matches **character-for-character** in method names, parameters, and return shapes between M0-A and M0-B.
   - `RecoveryRegistryPort` (`upsertCoverage`, `postponeCoverage`, `retireCoverage`, `getCoverage` with nullable `currentGeneration` and `actualRecoveryAtMs`), `RecoveryAdmissionPort` (`inspectCoverageSync`, `confirmCoverageSync`), `EventRuntimeCoordinatorPort` (`enqueueDurableOutboxSync`, `cancelEntityOutboxSync`, `ackOutboxSync`, `applyOutboxDeadLetterSync`, `recomputeAlarmSync`), `AgentHeadRecoveryPort` (`reconcileFromRegistry`, `confirmRegistryPlan`, `claimDurableWork`, `commitDurableResult`), `V2DispatchEnvelope`, `BudgetSyncOutboxPayload`, and `TurnExecutionMode` are consistently referenced across M0-A and M0-B.

---

## 4. D0 Verdict & M1 Readiness Note

- **D0 Gate Verdict:** **GO for M1 Harness & Dependent M1 Coding.** All M0 contracts, probes, guards, and builds are green on `6da1b483b6a854199a0f2eef27e53abc770be6cc`.
- **Implementation Status on `main @ 6da1b48`:** Only M0 contracts/probes exist on `main`; Agent A and Agent B M1 runtime implementations have **not** merged yet. Accordingly, D1 harness infrastructure and test matrices are ready immediately, while D2/D3 full-runtime E2E verification remains explicitly gated on A/B M1 merges.
