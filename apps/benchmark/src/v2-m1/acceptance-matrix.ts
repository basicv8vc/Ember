import { existsSync } from 'node:fs';
import path from 'node:path';

export type AcceptanceScenarioFamily = 'M0A_F' | 'M0B_FI' | 'D2_COMPAT';

export type AcceptanceVerificationStatus =
  'harness_infra_verified' | 'blocked_awaiting_ab_m1' | 'passed_ab_runtime' | 'failed_ab_runtime';

export interface AcceptanceMatrixEntry {
  readonly id: string;
  readonly family: AcceptanceScenarioFamily;
  readonly d2Category:
    | 'b1_api_compat'
    | 'chat_stream_recovery'
    | 'durable_task_schedule'
    | 'offline_recovery_alarm'
    | 'd1_fault_coverage_race'
    | 'queue_dup_dlq'
    | 'cancel_tenant_transcript'
    | 'budget_concurrency_revision'
    | 'long_reasoning_handoff';
  readonly title: string;
  readonly requiredFaults: readonly string[];
  readonly invariantSummary: string;
  readonly status: AcceptanceVerificationStatus;
}

/**
 * Complete V2-M1 End-to-End Acceptance Matrix covering F-1..F-23 (M0-A §10) and FI-01..FI-16 (M0-B §9).
 * All entries remain `blocked_awaiting_ab_m1` until A/B merges their real V2 runtime and passes E2E execution.
 */
export const V2_M1_ACCEPTANCE_MATRIX: readonly AcceptanceMatrixEntry[] = Object.freeze([
  // --- M0-A F-1 .. F-23 ---
  {
    id: 'F-1',
    family: 'M0A_F',
    d2Category: 'b1_api_compat',
    title: 'Concurrent identical client_submission_id submission',
    requiredFaults: ['concurrent_race', 'stage3_toctou'],
    invariantSummary:
      'First commits 201; loser writes budget_sync(release) and returns 200 replay with 0 duplicate calls.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-2',
    family: 'M0A_F',
    d2Category: 'b1_api_compat',
    title: 'Same client_submission_id with differing payload/attachments/conversation',
    requiredFaults: ['none'],
    invariantSummary: 'Rejects with 409 IDEMPOTENCY_CONFLICT; zero writes, zero quota deductions.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-3',
    family: 'M0A_F',
    d2Category: 'cancel_tenant_transcript',
    title: 'clearTranscript interleaved with prepareTurn Stage 2 await',
    requiredFaults: ['concurrent_race'],
    invariantSummary:
      'Stage 3 detects transcript_epoch increment, writes budget_sync(release), throws 409; zero resurrected messages.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-4',
    family: 'M0A_F',
    d2Category: 'd1_fault_coverage_race',
    title: 'Uncovered turn when D1 Recovery Registry is unavailable',
    requiredFaults: ['d1:unavailable'],
    invariantSummary: 'Fail closed 503 DB_UNAVAILABLE; zero DO turn/message writes.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-5',
    family: 'M0A_F',
    d2Category: 'd1_fault_coverage_race',
    title: 'Covered turn when D1 Recovery Registry is unavailable',
    requiredFaults: ['d1:unavailable'],
    invariantSummary: 'Zero synchronous D1 I/O; completes prepareTurn and execution normally.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-6',
    family: 'M0A_F',
    d2Category: 'budget_concurrency_revision',
    title: 'GlobalBudgetAuthority unavailable, exceeded, or incident-halted',
    requiredFaults: ['global_budget:unavailable', 'global_budget:halt'],
    invariantSummary:
      '429 BUDGET_EXCEEDED on cap/halt, 503 DB_UNAVAILABLE on outage; zero new paid egress.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-7',
    family: 'M0A_F',
    d2Category: 'chat_stream_recovery',
    title: 'Edge Worker crash after prepareTurn and before markAttemptSent',
    requiredFaults: ['crash:after_prepare_before_mark_sent'],
    invariantSummary:
      'DO Alarm settles attempt as released (0 charge) and writes budget_sync(release).',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-8',
    family: 'M0A_F',
    d2Category: 'chat_stream_recovery',
    title: 'Edge Worker silent crash after markAttemptSent before provider response',
    requiredFaults: ['crash:after_mark_sent_before_provider_fetch', 'virtual_clock'],
    invariantSummary:
      'DO Alarm reconciles within <=60s as unknown_billed (retains reservation, never blindly replays).',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-9',
    family: 'M0A_F',
    d2Category: 'cancel_tenant_transcript',
    title: 'markAttemptSent encounters cancel, STALE_LEASE, or already_sent',
    requiredFaults: ['concurrent_race'],
    invariantSummary:
      'Returns authorized=false; zero provider fetch egress; no refund if already_sent.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-10',
    family: 'M0A_F',
    d2Category: 'chat_stream_recovery',
    title: 'Client disconnect mid-stream',
    requiredFaults: ['gateway:abort_on_disconnect'],
    invariantSummary:
      'Stops 15s renewal immediately; aborts or hands off; reconnect via GET messages/turns yields zero duplicate text.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-11',
    family: 'M0A_F',
    d2Category: 'long_reasoning_handoff',
    title: 'B1 non-streaming waitUntil exceeds 22s or dies within 25s',
    requiredFaults: ['gateway:slow_handoff', 'virtual_clock'],
    invariantSummary:
      'Soft handoff at 22s or Alarm takeover at 25s converges within frozen 60s B1 deadline.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-12',
    family: 'M0A_F',
    d2Category: 'long_reasoning_handoff',
    title: 'V2 reasoning exceeds 120s interactive window -> Durable handoff',
    requiredFaults: ['gateway:slow_handoff', 'virtual_clock'],
    invariantSummary:
      'handoffTurnToDurable bumps lease_epoch, preserves 600s deadline_at_ms, polls provider_job_handle; stale executor rejected.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-13',
    family: 'M0A_F',
    d2Category: 'd1_fault_coverage_race',
    title: 'DO registering crash, concurrent same-gen registration, stale/quarantined repair',
    requiredFaults: ['crash:after_do_pending_before_d1', 'concurrent_race'],
    invariantSummary:
      'Strictly increasing generations, fast-forward self-heal, zero false covered state.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-14',
    family: 'M0A_F',
    d2Category: 'offline_recovery_alarm',
    title: 'All 6 DO Alarm retries exhausted offline with pending work + future schedule',
    requiredFaults: ['alarm:exhaust_6_retries'],
    invariantSummary:
      'Sweeper detects <=2m, recovers <=5m via reconcileFromRegistry, re-arms future v2_schedules alarm.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-15',
    family: 'M0A_F',
    d2Category: 'budget_concurrency_revision',
    title: 'Usage missing, late overage revision, GlobalGrant TTL expiry, and cross-tenant Halt',
    requiredFaults: [
      'gateway:usage_missing',
      'gateway:late_charge_revision',
      'global_budget:grant_expired',
    ],
    invariantSummary:
      'Opens usage_missing/day_ceiling incident, preserves expired_consumed without refund, halts cross-tenant attempts.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-16',
    family: 'M0A_F',
    d2Category: 'cancel_tenant_transcript',
    title: 'Cross-tenant access, token reuse revocation, and no-content log audit',
    requiredFaults: ['none'],
    invariantSummary:
      'Tenant A<->B returns 404; refresh token reuse revokes session family; logs contain zero prompt/reply text.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-17',
    family: 'M0A_F',
    d2Category: 'd1_fault_coverage_race',
    title: 'Sweeper retire/postpone raced against concurrent prepareTurn',
    requiredFaults: ['concurrent_race'],
    invariantSummary: 'DO transitions local coverage before Sweeper D1 CAS; new turn never erased.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-18',
    family: 'M0A_F',
    d2Category: 'durable_task_schedule',
    title: 'Task multi-run retry hits V1 attempt (4/6) and cost (20k/30k micro_usd) caps',
    requiredFaults: ['gateway:error_5xx'],
    invariantSummary:
      'Refuses further reservations and converges Task terminally; zero unbounded retry spend.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-19',
    family: 'M0A_F',
    d2Category: 'd1_fault_coverage_race',
    title: 'D1 CAS committed but ACK lost / DO pending crash without app reopen',
    requiredFaults: ['d1:uncertain_timeout_committed', 'crash:after_do_pending_before_d1'],
    invariantSummary:
      'getCoverage recovers lost ACK; Sweeper repairs pending obligations via repair_ensure(MIN).',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-20',
    family: 'M0A_F',
    d2Category: 'offline_recovery_alarm',
    title: 'retry_not_before_ms backoff & postpone never later than earliest D(O)',
    requiredFaults: ['d1:unavailable'],
    invariantSummary:
      'Backoff leaves next_recovery_at_ms immutable; postpone/retire forbidden while budget_sync or tasks exist.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-21',
    family: 'M0A_F',
    d2Category: 'long_reasoning_handoff',
    title:
      'handoffTurnToDurable rejects expired lease, cancel, epoch mismatch, deadline, missing handle',
    requiredFaults: ['gateway:missing_handle_hang', 'virtual_clock'],
    invariantSummary:
      'Returns fenced without extending deadline_at_ms; missing-handle uncertain sends converge as unknown_billed.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-22',
    family: 'M0A_F',
    d2Category: 'queue_dup_dlq',
    title:
      'Forged/stale/future/null-queue Queue envelopes & B1 deadline retry boundary (0/500/1000/1001ms)',
    requiredFaults: ['queue:forged_envelope', 'virtual_clock'],
    invariantSummary:
      'Accepts all 4 canonical entityKinds, rejects malformed/budget_sync/wrong-epoch envelopes; enforces 1s/5s retry cap.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'F-23',
    family: 'M0A_F',
    d2Category: 'budget_concurrency_revision',
    title:
      'budget_sync survives clearTranscript/cancelTurn + cumulative revision delta & conflict rejection',
    requiredFaults: ['gateway:late_charge_revision', 'global_budget:conflict_payload'],
    invariantSummary:
      'budget_sync outbox never cancelled; rev=0 and rev>=1 apply delta without double charge; mismatched payload returns conflict.',
    status: 'blocked_awaiting_ab_m1',
  },

  // --- M0-B FI-01 .. FI-16 ---
  {
    id: 'FI-01',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'DO writes pending (ensure/postpone/retire) then crashes before D1 CAS',
    requiredFaults: ['crash:after_do_pending_before_d1'],
    invariantSummary:
      'Sweeper reconciles via repair_ensure even if observedGen lags; never unconditional noop_stale.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-02',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'D1 CAS succeeds then ACK lost / crash before confirmCoverageSync',
    requiredFaults: ['d1:uncertain_timeout_committed', 'crash:after_d1_before_confirm'],
    invariantSummary:
      'Reads getCoverage authoritative row; confirms if sufficient or upgrades generation.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-03',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'D1 rejects stale upsertCoverage due to concurrent higher generation',
    requiredFaults: ['concurrent_race'],
    invariantSummary:
      'DO checks accepted=false and currentGeneration; never falsely marks covered.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-04',
    family: 'M0B_FI',
    d2Category: 'queue_dup_dlq',
    title: 'Crash after DO commit before Queue.send / after send before outbox state update',
    requiredFaults: [
      'crash:after_do_commit_before_queue_send',
      'crash:after_queue_send_before_outbox_update',
      'queue:duplicate',
    ],
    invariantSummary:
      '2s Alarm re-publishes; duplicate deliveries deduplicated with duplicate_commit_count = 0.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-05',
    family: 'M0B_FI',
    d2Category: 'queue_dup_dlq',
    title: 'Forged/tampered Queue envelope & SQLite queue_name IS NULL constraint',
    requiredFaults: ['queue:forged_envelope'],
    invariantSummary:
      'SQLite rejects normal outbox queue_name IS NULL; DO rejects forged/future/stale envelopes with 0 mutations.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-06',
    family: 'M0B_FI',
    d2Category: 'durable_task_schedule',
    title: 'B1 60s deadline boundary (remaining = 0 / 500 / 1000 / 1001 ms) re-enqueue cap',
    requiredFaults: ['virtual_clock'],
    invariantSummary:
      '<=1000ms schedules deadlineAtMs directly; >1000ms caps within [now+1s, deadline-5s]; preserves budget_sync.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-07',
    family: 'M0B_FI',
    d2Category: 'queue_dup_dlq',
    title: 'Queue 5 retries exhausted -> DLQ consumer onDispatchDeadLetter',
    requiredFaults: ['queue:force_dlq'],
    invariantSummary:
      'applyOutboxDeadLetterSync matches outbox_id + fenceEpoch and re-arms backoff Alarm or converges deadline.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-08',
    family: 'M0B_FI',
    d2Category: 'offline_recovery_alarm',
    title: 'Initial Alarm + all 6 retries fail offline (pending + future schedule)',
    requiredFaults: ['alarm:exhaust_6_retries'],
    invariantSummary:
      'Sweeper detects <=2m, recovers <=5m, preserves next_recovery_at_ms, re-arms future schedule.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-09',
    family: 'M0B_FI',
    d2Category: 'offline_recovery_alarm',
    title: 'Sweeper RPC failures -> backoff/quarantined + stale sweeper CAS rejection',
    requiredFaults: ['d1:unavailable', 'concurrent_race'],
    invariantSummary:
      'Updates retry_not_before_ms only; quarantined remains in index; stale sweep_lease_owner rejected.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-10',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'Concurrent Sweeper retire vs new turn / postpone vs earlier deadline',
    requiredFaults: ['concurrent_race'],
    invariantSummary:
      'DO advances generation locally first; D1 conditional DELETE/postpone matches 0 rows.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-11',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'Postpone UPDATE encounters ambiguous D1 timeout',
    requiredFaults: ['d1:uncertain_timeout_aborted'],
    invariantSummary: 'DO remains registering (never reverts to stale covered) until resynced.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-12',
    family: 'M0B_FI',
    d2Category: 'd1_fault_coverage_race',
    title: 'D1 unavailable across Direct / Covered / Uncovered / Unknown-ACK paths',
    requiredFaults: ['d1:unavailable'],
    invariantSummary:
      'Direct and covered continue; uncovered returns 503 DB_UNAVAILABLE; Unknown-ACK reconciles via B1 N-2.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-13',
    family: 'M0B_FI',
    d2Category: 'long_reasoning_handoff',
    title: 'Fast Path 120s active 15s renewal handoff vs expired/cancel/wrong-owner rejection',
    requiredFaults: ['gateway:slow_handoff', 'virtual_clock'],
    invariantSummary:
      'Active handoff keeps original 600s deadline_at_ms; expired (>45s), cancelled, or wrong-owner handoffs fenced.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-14',
    family: 'M0B_FI',
    d2Category: 'long_reasoning_handoff',
    title: 'Handoff with provider_job_handle vs missing-handle uncertain + silent loss <=60s',
    requiredFaults: ['gateway:slow_handoff', 'gateway:missing_handle_hang', 'virtual_clock'],
    invariantSummary:
      'Handle polled without recompute; missing handle reconciles honestly; silent loss enters reconciliation <=60s.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-15',
    family: 'M0B_FI',
    d2Category: 'budget_concurrency_revision',
    title: 'budget_sync survival + (operation_id, revision) cumulative delta & conflict rejection',
    requiredFaults: ['gateway:late_charge_revision', 'global_budget:conflict_payload'],
    invariantSummary:
      'Never lost across cancel/clear/deadline; rev=0 + rev=1 delta accounting; same-rev conflict rejected.',
    status: 'blocked_awaiting_ab_m1',
  },
  {
    id: 'FI-16',
    family: 'M0B_FI',
    d2Category: 'durable_task_schedule',
    title: 'DST Spring-Forward / Fall-Back scheduling & ADR-0001/0002 invariants',
    requiredFaults: ['virtual_clock:dst_spring_forward', 'virtual_clock:dst_fall_back'],
    invariantSummary:
      'Spring-forward fires at first valid instant; fall-back fires once; cancel beats retry; pre-claim timeout creates no run.',
    status: 'blocked_awaiting_ab_m1',
  },
]);

export interface ResolvedAbRuntimeTarget {
  readonly available: boolean;
  readonly configPath: string | null;
  readonly reason: string;
}

/**
 * Discover whether A/B's M1 V2 runtime Wrangler config is present and explicitly targeted.
 * Never treats M0 probes or the harness smoke worker as A/B's runtime.
 */
export function resolveAbRuntimeTarget(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = process.cwd(),
): ResolvedAbRuntimeTarget {
  const explicitConfig = env.EMBER_V2_RUNTIME_CONFIG?.trim();
  if (explicitConfig !== undefined && explicitConfig.length > 0) {
    const resolved = path.resolve(repoRoot, explicitConfig);
    if (!existsSync(resolved)) {
      return {
        available: false,
        configPath: null,
        reason: `EMBER_V2_RUNTIME_CONFIG="${resolved}" does not exist on disk.`,
      };
    }
    return {
      available: true,
      configPath: resolved,
      reason: `Using explicit A/B runtime Wrangler config at ${resolved}.`,
    };
  }

  return {
    available: false,
    configPath: null,
    reason:
      'A/B M1 runtime has not merged yet (set EMBER_V2_RUNTIME_CONFIG once Agent A & Agent B M1 runtime Wrangler config is available).',
  };
}
