# ADR-0006 — Experience-first, Device-powered Runtime V2

- Status: Accepted upon owner / CTO approval and merge to main — M0 and local M1 PoC only
- Date: 2026-11-19
- Owner: V2 Chief Architect
- Scope: V2 architectural baseline, bounded PoC and deployment budget; not production cutover authorization
- Related: [ADR-0005](0005-cloudflare-native-runtime-v2.md), [ADR-0004](0004-beta-v1-live-platform-contract.md), [V1 architecture baseline](../architecture/v1-architecture-baseline.md), [V1 execution placement](../architecture/v1-execution-placement.md)

## Architecture North Star — long-term principles

**Experience-first, Event-driven, Cost-efficient.**

**Cloud-managed, Device-powered Personal Agent.**

These are long-term product architecture principles, not descriptions of a particular vendor stack.

- Experience first: minimize time to useful feedback and completion; never make a user wait merely to save infrastructure cost. Security, privacy, authorization, data integrity and durable execution are mandatory constraints, not tradeoffs.
- Event-driven: the agent appears always present, with durable identity, memory, tasks and commitments; computation happens when a user, schedule, external event or recovery obligation needs it.
- Cost-efficient: eliminate wasted idle computation and write amplification; choose cost savings only after experience and correctness requirements are satisfied. Persistent existence does not imply persistent computation.
- Cloud-managed: cloud is the continuously reachable coordination and persistence plane; it accepts and schedules work even when every device is offline. This is a design goal, not a guaranteed 100% SLA.
- Device-powered: iPhone and Mac are first-class execution nodes, with Android and other platforms future candidates. User-owned CPU/GPU/NPU, local data and native tools can expand capability, reduce latency and avoid unnecessary cloud sandbox spend. No cross-user compute pooling. Device availability, battery, thermals, memory, permissions and OS/store rules constrain execution.
- Cloud execution remains essential for offline devices, unattended jobs, unsupported workloads and authorized fallback. Optimize for best execution, not local-first at any cost.

## Decision and precedence

This ADR refines ADR-0005: retain the Cloudflare-native direction and its correctness and migration gates; add a latency-first interactive path, device-powered execution as a first-class architecture boundary, and measurable deployment budgets. Upon owner/CTO approval and merge, this ADR supersedes ADR-0005's no-PoC restriction only for M0 (contract/benchmark freeze) and local, isolated M1 (Agent Head, Fast/Durable Path and independent recovery with fake providers). Before dependent coding, M0's common contracts require architect/CTO review. Cloud resource creation/deployment/smoke (even within the proposed $10/month envelope) requires a separate explicit owner/CTO cloud-PoC approval after the local M1 gates pass, including environment, quotas and credentials. Real external LLM/Daytona calls require a separate owner/CTO provider-canary approval with explicit spend caps and validated per-agent/global reservations. M2 and later milestone implementation/integration require subsequent scope approval; standalone device research is unaffected. It does not change ADR-0004's V1 wire contract, permit real-user migration, authorize new external model spend or paid sandbox use, or certify any V2 component as implemented. V1 product delivery proceeds independently. Existing V1 security, fencing, budget reservation, idempotency, deletion-epoch and atomic message/task linkage invariants remain mandatory.

## Target topology

```text
 iPhone / Mac / future Android / Web
       |                         ^ local execution / progress
       v                         |
 Edge API Worker (auth, route, streaming, sync)
       |
 Agent Head DO <-----------------+ fenced commits / events
 (SQLite, state, policy, alarms, durable recovery)
       |                    |
       | Fast Path          | Durable Path
       v                    v
 Interactive Executor     Queues -> Execution Worker
       |                    |
       +----------+---------+
                  v
       LLM / Tools / Daytona / authorized Device Executors

 D1 (when needed): account, session, device and routing directory
 R2: immutable/versioned artifacts, files, backup objects
 Device local store: cache, offline outbox, private inputs
```

These are logical boundaries; initially reuse the monorepo and keep Worker deployment units minimal. Avoid a general multi-runtime framework or mandatory Agents SDK/Workflows dependency.

### Three access paths

1. **Direct Path**: local cached views and scoped API reads/writes; history, task status and settings do not invoke LLM, Queue or Sandbox. Reconcile optimistic UI with authoritative versions/cursors.
2. **Interactive Fast Path**: API Worker authenticates, calls Agent Head to atomically accept the message, check transcript epoch, reserve budget, prepare context, claim a run/lease and record durable recovery intent. After commit, interactive executor directly streams model output; it need not wait for queue consumption. Target two core DO RPCs (prepare and fenced commit) for a simple turn, not an invariant. Intermediate tools, recovery, renewal and sync may require more calls. Committed response, usage and linked Task/Notes effects remain atomic where existing contracts require them.
3. **Durable Path**: user delegation, schedule, external event, approval, callback or recovery creates/claims durable work; persist dispatch intent, deliver via Queue, execute outside DO, commit under fencing. Long external work uses provider job handles/callbacks or bounded durable continuations; do not await unbounded work in the DO.

Fast Path and Durable Path share the same authoritative state machine, run identity, lease/epoch, cancellation, budget and security rules. Client disconnect does not revoke accepted work. On expired lease, recovery must reconcile any in-flight provider call, fence stale completions and follow explicit uncertain-outcome or idempotent retry rules. Never blindly replay non-idempotent external effects or infer exactly-once provider billing. HTTP waitUntil alone is not a durable recovery mechanism. Streaming output is provisional until final commit; client reconnection retrieves durable state and must not duplicate messages. Resume from durable checkpoints where supported; exact partial-token recovery is not promised.

### Interactive Executor hosting and recovery

Initially the Interactive Executor is an HTTP-triggered handler in the Edge API Worker, not an additional container/service or a DO stream. Use incremental streaming with bounded buffers. Workers Standard has no wall-clock duration charge or hard HTTP duration limit while the client remains connected; CPU, memory and subrequest limits still apply. A disconnect or runtime restart can cancel work; waitUntil extends work by at most 30 seconds after response/disconnect. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). Do not rely on that grace period for liveness.

M0 initial test profile (not a wire contract or SLA): 120 s total interactive execution deadline, 45 s lease renewed every 15 s only during active execution; use a bounded provider timeout and abort signal. On observed disconnect, stop renewal and request provider cancellation/handoff promptly; on silent executor loss, normal recovery should enter reconciliation within 60 s of last successful renewal (45 s expiry + 15 s detection/dispatch allowance). An active run cannot be stolen before a valid fenced handoff or lease expiry. Recovery entry is not a promise to repeat an uncertain provider call or complete the task within 60 s. Alarm failure uses the independent recovery gate below. Longer or unsupported work moves to Durable Path with durable state, not a second execution. M0 freezes exact timeout/renewal rules after verifying compatibility with existing V1 leases/deadlines; M1 exercises connected streaming, disconnect, silent crash, slow provider, duplicate/stale completion and long-task handoff using fake providers. Explicitly simulate reasoning lasting beyond 120 s: checkpoint or persist the provider job/operation handle before the deadline, transition the same logical task/turn to Durable Path with a fenced handoff and user-visible continuing status, and verify a single final committed result after reconnect. If a provider cannot resume a stream or its outcome is uncertain, reconcile/cancel or surface the limitation; never promise seamless continuation of the same provider computation, blindly replay it, or silently truncate the user's task. Report recovery time and actual P50/P95/P99. No idle heartbeat.

### Agent Head and storage boundaries

- Start with one canonical DO per server-resolved agent/tenant ownership domain; preserve tenant/principal/agent distinctions. Never route on untrusted client IDs. No global business-state DO. Partition further only after evidence of a hotspot.
- DO SQLite owns conversations, messages, turns, tasks, runs, schedules, inbox/outbox, approvals, reservations, Notes and metadata when transaction invariants require co-location. Read context and commit related effects locally; no slow I/O inside SQLite transactions or global async locks spanning external calls. DO interleaving still requires transactions and fences.
- D1 is the preferred optional global control store for identity/directory, session, entitlement, device registry and bounded recovery indexes. Introduce only the minimal needed schema. DO SQLite and D1 have the same advertised row-write/read rates but different storage rates and latency/transaction boundaries. Compare D1-centric vs DO-local on identical benchmark workloads; do not split atomic message/task/usage changes across stores. D1 indexes that are projections must be rebuildable and not a second authority.
- Cache routing/identity only with explicitly bounded freshness and revocation semantics. Per-agent reservations do not enforce a platform-wide spend cap; preserve the existing strict global budget gate before paid egress, with a separately validated authority/reservation mechanism and measured latency.
- R2 holds large immutable/versioned artifacts and backups; stage uploads, validate ownership/hash, commit metadata, clean orphans. R2 and SQLite cannot share a transaction. Archive history only when measured need justifies it.
- Device storage separates rebuildable confirmed-history caches from protected pending submissions. Persist message body, original `client_submission_id`, `transcript_epoch` and account scope before the first attempt, across restart/offline/cache eviction. Follow [B1 Platform Contract §10](../product/B1_PLATFORM_CONTRACT.md) (N-1–N-12): on unknown ACK look up the original ID; adopt the confirmed record on 200, retry the same ID on 404 only with valid epoch, and reconcile by ID/sequence, not text. Remove confirmed outbox entries only after a 200/201 carrying a sequence per N-7; apply B1 conflict/deletion exceptions (409 stops retry, preserves unsent draft per §10.3; transcript deletion clears/fences queued/in-flight submissions per N-11/N-12). No cache cleanup, restart or account switch may silently discard or replay another account's unconfirmed records; honor B1-defined clearing and conflict rules; do not introduce new silent discard behavior. Device-private inputs remain authoritative locally; no silent upload.
- Schema evolution: transactional, idempotent per-object versioned migrations, tested dormant schema upgrades, inventory, export/restore, deletion plus R2 cleanup, and forward-repair/rollback rehearsals.

### Event scheduler and reliability

A single Alarm per Agent Head points to earliest due work in indexed persistent scheduling/outbox/lease tables. Re-arm only when earliest deadline changes or processing requires it; batch bounded due work, preserve ordering and timezone/DST rules for recurring schedules, isolate failures. No normal-path global polling or continuous agent loop. Alarm and Queue delivery are at least once; handle duplicates, delays, retry exhaustion, failure before/after publishing, and terminal/outcome reconciliation. Verify atomic storage/alarm behavior against platform APIs and fault-injection tests. Independent bounded recovery is mandatory even if storage/alarm registration is atomic: all six automatic Alarm retries can fail. Maintain a durable, indexed wakeup/recovery registry outside the Agent Head's Alarm failure domain, containing only canonical agent ID, generation and next eligible recovery time (D1 plus one scheduled Worker is the initial candidate; an equivalent independently durable trigger is acceptable). Ensure durable discoverability before accepting an obligation, and fail closed for uncovered work if it cannot be ensured; a crash between registry and DO commits may leave a harmless stale marker, never an undiscoverable accepted obligation. Reconcile conservatively with generation/CAS; do not remove or postpone the only marker while an earlier obligation can still commit. Retain future schedule markers until safely retired. A periodic bounded sweep of only due markers re-arms/dispatches through the same fenced state machine; no fleet-wide DO polling, global business-state DO, or per-agent heartbeat. Backlog, lag and repeated failures must be observable/alerted. No lost committed work; a dirty flag is not a durable guarantee.

**Fast Path registration and degraded operation.** Do not synchronously write or read D1 for every ordinary turn. An existing durable marker can cover additional obligations if its recovery time is no later than their required discovery time, its generation is demonstrably valid, and the admission/retirement protocol prevents concurrent removal or postponement. In particular, an ordinary turn that does not advance the earliest recovery time needs no synchronous registry write when this coverage is established. A DO-local durable coverage record may be used only under a proven generation/fencing protocol: the sweeper must obtain safe retirement/postponement authorization from the authoritative DO, invalidate the old admission coverage before remote retirement, and use generation-conditional updates; no stale cache, absence of work at a prior read, or unconditional delete suffices. The first uncovered obligation (including a previously idle agent) or one with an earlier required recovery time must establish coverage before commit. Do not keep idle agents periodically awake just to avoid a registration write. Evaluate regional placement or an equivalent independent durable trigger if cross-region D1 writes dominate latency; D1 read replicas do not move writes away from the primary ([D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

If the recovery registry is unavailable, continue authorized Direct Path operations that do not create uncovered obligations and covered Fast Path turns only when every other required authority, including global budget and authentication, is available and valid. Do not block all chat merely because D1 recovery registration fails, but do not acknowledge new uncovered work as accepted. Preserve the client's protected outbox, surface a retryable unavailable/unknown-ACK state and reconcile using the original B1 submission ID/epoch; an uncertain commit is not proof of rejection. Continue existing fenced execution where safe, retain its marker and durable recovery, and reconcile after dependency restoration. Never bypass the budget guard or promise autonomous recovery during a registry outage. M0 must freeze admission/retirement, outage behavior and client-compatible error mapping; M1 must test covered vs uncovered turns with registry unavailable, concurrent sweep/retirement vs acceptance, earlier deadlines, crash/restart, stale generations and lost ACK. Measure ACK/Runtime P95 for the first uncovered turn and marker-reuse turns separately across regional RTTs; report actual registry operations/turn and fault behavior. No synchronous registry access on the proven covered path is an explicit acceptance check.

M1 recovery gate (local fault injection, then repeat on separately approved cloud PoC): force initial Alarm invocation and all six retries to fail, with all clients offline and a pending dispatch plus later scheduled event; demonstrate independent detection and correct dispatch/re-arm without user traffic. Initial target: detect within 2 minutes and resume dispatch/re-arm within 5 minutes of retry exhaustion (or restoration of required dependencies if unavailable), under the documented bounded PoC load; report actual max/P95 and failures, not a platform SLA. Test crash before/after registry and DO commits, duplicate sweep/Alarm/Queue delivery, stale marker cleanup, concurrent schedule changes, and later schedule execution. No lost accepted work, no duplicate committed results; provider uncertainty handled by existing reconciliation rules. M0 freezes exact registry protocol, recovery cadence/batch and measurement definitions before implementation; include any pre-registration calls in Fast Path latency and cost benchmarks; failure to meet the gate blocks M1 acceptance and later rollout.

### Device-powered execution contract

Reuse existing V1 domain/contracts, Placement, Run/Lease and Checkpoint concepts rather than inventing a second execution system.

- Device registry: canonical ownership, authenticated device identity, supported tool/runtime versions and capability declarations; readiness is short-lived and must not be assumed from registration alone. Authorization, scope, revocation, app state and local policy checked at execution.
- Execution request/offer: stable task/run/epoch and operation ID, capability, authorized inputs, deadline, resource envelope and scoped credentials; no secrets in generic queue payloads or logs.
- Device status/result: accepted/running/waiting/failed/completed/cancelled, versioned progress, validated referenced outputs, fencing and idempotent commit. Credentials are revocable and scoped to one permitted execution; device is not trusted to grant itself new privileges.
- Placement priority: hard privacy, permissions, capabilities and deadlines; then expected user-visible completion latency, reliability and device health; then cloud cost. Start with simple deterministic rules. Fallback only if authorized and input/data permissions allow it; otherwise wait for device or ask user. Never automatically upload local-only inputs. External effects and checkpoint portability must be verified before cross-run transfer.
- First device demo: native PDF/text extraction or OCR on a foreground iPhone, with a permitted result returned to cloud. Compare identical input/output and end-to-end latency against Daytona; measure device battery, thermals and memory. Mac adapter and dynamic code/WASM/Python remain subsequent work; no unrestricted mobile code execution, background wakeup or OS sandbox escape assumption. Mobile background availability must be demonstrated on supported hardware and OS versions.

### Global latency and DO efficiency

Edge API near client; use an Agent Home location hint at creation where useful (not a placement guarantee or multi-master replication). Measure Asia-Pacific, Europe and Americas separately, including travel, cold start and cross-region model latency. Do not add live cross-region migration yet. Model provider/placement chosen by actual TTFT, generation rate, accuracy, tool ability and cost.

DO runs short coordination handlers; never wait for LLM/Sandbox/tool completion inside it. Use hibernatable sockets if justified; no keepalive timers or per-token persistence. Coalesce progress writes while preserving necessary recovery/audit data. Use bounded context, indexed queries, incremental sync and local cache. Aim for idle-compute near zero where hibernation eligible; persisted storage and scheduled work still cost money.

## Experience and reliability gates

Initial engineering targets, not measured SLA. Compare against optimized V1 using matched regions, models, prompts, data, clients and load; report P50/P95/P99, cold/warm, failures and measurement definitions.

| Metric                                                      | Initial target |
| ----------------------------------------------------------- | -------------- |
| Local send feedback                                         | <= 50 ms       |
| Cached history first render                                 | <= 100 ms      |
| Durable message ACK (near-region P95)                       | <= 250 ms      |
| Runtime overhead excluding model/provider (near-region P95) | <= 200 ms      |
| Simple low-latency model first useful token (P50 / P95)     | <= 1 s / 2.5 s |
| Background task dispatch start (P95, not provider startup)  | <= 3 s         |
| Foreground cancel state feedback                            | <= 500 ms      |
| Foreground P95 degradation with background load             | <= 10%         |

M1 exit gate: time the full synchronous global budget reservation/check (including contention, cold start and cross-region RPC) separately and inside end-to-end Runtime/TTFT measurements under concurrent foreground/background load. Initial allocation: <= 50 ms near-region P95 within the 200 ms Runtime overhead, not an extra allowance. Fake-provider tests must exercise actual reservation semantics, concurrency, exhaustion and fail-closed behavior; validate again under separately approved cloud and provider canaries. Do not call paid providers before an authoritative reservation or replace it with an eventually consistent cached balance. If the latency budget is missed, optimize the authority/transaction or evaluate bounded preallocated grants with proven global-cap invariants and explicit review; do not weaken the cap. The first-token figures remain hypotheses until real model tests.

Do not weaken integrity for these targets. Test offline/outbox restart and cache eviction, account isolation, unknown ACK and B1 conflict/deletion reconciliation, duplicate events, concurrent budgets/global cap, transcript deletion, cross-tenant isolation, disconnect, stale epoch, outbox publish gap, Alarm retry exhaustion, provider unknown outcome, credential revocation, R2 mismatch, device sleep/offline and authorized fallback. Preserve all B1 wire and domain contract behavior; streaming/device wire extensions require explicit versioned approval.

## Deployment budget (USD/month)

Planning date: 2026-11-19. Existing owner account: Workers Paid $5/month, Neon Free, Supabase Free. No new fixed database subscription required. Shared account allowances are not dedicated to Ember; other products consume the same allocations. V1 remains on Neon until cutover; any V1 overage is separate migration-period cost. Supabase is not needed for V2. All figures exclude taxes, existing developer program/domain fees, engineering time and third-party connector fees unless separately budgeted.

### Official metering inputs

| Meter                                           |                    Included/month |           Additional rate |
| ----------------------------------------------- | --------------------------------: | ------------------------: |
| Workers requests                                |                               10M |                   $0.30/M |
| Workers CPU                                     |                            30M ms |                $0.02/M ms |
| DO requests (including Alarm and billed RPC/WS) |                                1M |                   $0.15/M |
| DO duration                                     |                         400k GB-s |             $12.50/M GB-s |
| DO SQLite rows read / written                   |                         25B / 50M |           $0.001/M / $1/M |
| DO SQLite storage                               |                        5 GB-month |            $0.20/GB-month |
| D1 rows read / written                          |                         25B / 50M |           $0.001/M / $1/M |
| D1 storage                                      |                        5 GB-month |            $0.75/GB-month |
| Queues operations                               |                                1M |                   $0.40/M |
| R2 Standard storage                             |                       10 GB-month |           $0.015/GB-month |
| R2 Class A / B                                  |                          1M / 10M |         $4.50/M / $0.36/M |
| Observability from Dec 1 2026                   | 50 GB ingested / 10 GB-month kept | $0.25/GB / $0.10/GB-month |

Workers Paid base $5 once per account. DO memory metering uses 0.128 GB per active object; idle eligible for hibernation is not duration-billed. For the model, round DO compute request and GB-s overages up to whole millions and R2 Standard operations up to whole millions/storage up to whole GB-month; prorate DO SQLite rows/storage and other meters, subject to invoice validation. This is not merely a discretionary safety margin: the official [DO Pricing > Compute billing](https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing) section explicitly rounds excess usage, including duration, to the next billable unit. For 10k MAU, 437,760 GB-s minus 400,000 included = 37,760 GB-s; ceil(37,760 / 1,000,000) * $12.50 = $12.50, rather than $0.472 on a hypothetical proportional basis. The corrected rounded total is $176.07 (the prior $176.27 included $0.20 excess storage rounding). Queue message <64 KB typically requires three operations; retries add operations. D1 and DO SQLite allowances modeled separately. Index writes, deletes, and setAlarm writes count toward metering; measure actual billed rows. D1 first 100k databases and Queues first 10k queues included; V2 does not require a queue/database per user. R2 internet egress free, other services may charge. Workers Logs before Dec 1: 20M events/month included, $0.60/M excess; model forward-looking Observability cost instead. Sources below.

### Workload and reproducible estimate

30-day month; MAU = monthly active agents (one per user for this model). Assume 60% light, 30% medium, 10% heavy. Additional dormant retained accounts, history growth, backups and high-volume connectors must be added when known.

| User type        | Turns/day | Background tasks/day | Total events/mo | DO DB average MB | R2 average MB |
| ---------------- | --------: | -------------------: | --------------: | ---------------: | ------------: |
| Light            |         5 |                    1 |             180 |                5 |            20 |
| Medium           |        20 |                    4 |             720 |               20 |           100 |
| Heavy            |       100 |                   20 |            3600 |              100 |           500 |
| Weighted average |        19 |                  3.8 |             684 |               19 |            92 |

Per event, assumed (not measured): 6 billed Worker requests, 40 ms aggregate Worker CPU, 4 billed DO requests, 0.5 s total billable DO wall time, 200 DO rows read, 20 DO billed row writes inclusive of index/alarm overhead, 10 D1 rows read, 0.2 D1 billed row writes on average, 1.2 Queue operations (0.4 small messages on average including recovery/followups), 0.1 R2 Class A and 0.2 Class B operations. D1 storage 0.25 MB/agent. Assume 2 KB aggregate billable observability ingestion per event after sampling, 7-day retention and steady load. Storage MB/GB uses decimal units. Storage estimates represent average metered retained storage, not monthly increments.

For N agents, E = 684*N (or the per-user workload above). Monthly usage vector:

- Workers: 6E requests, 40E ms aggregate active CPU. Streaming wall time has no separate charge on Workers Standard; measure it separately for latency/concurrency and provider work. For a reproducible breakdown, allocate the illustrative 40 ms/event to 30 ms other processing + 10 ms stream processing averaged over all events (not measured); total CPU = E * (30 + 10) ms. Account separately for extra stream reconnects, active lease renewal requests/writes, bytes/logging and retries if not already in the per-event vector. At 100k MAU, an extra 10 ms CPU/event adds $13.68/month after included CPU is consumed; a 30 s network wait alone adds $0 Worker duration cost. Do not hold a DO active for streaming. M1 and M4 measure both wall time and active CPU before replacing these assumptions.
- DO: 4E requests, 0.128*0.5E GB-s, 200E rows read, 20E rows written, 0.019N GB-month.
- D1: 10E reads, 0.2E writes, 0.00025N GB-month.
- Queues: 1.2E operations. R2: 0.092N GB-month, 0.1E A, 0.2E B.
- Observability: 0.000002E GB ingestion, approximate storage ingestion*7/30.
- For each meter i, input A_i (account included allowance), B_i (forecast other products' usage), U_i (Ember usage). Remaining allowance R_i = max(A_i - B_i, 0). Normalize usage by pricing unit Q_i; estimate cost = $5 + sum of p_i * f_i(max(U_i - R_i, 0)/Q_i), where f_i = ceil for DO compute requests/duration and R2 Standard operations/storage; identity otherwise. $5 is the allocated existing account base, not an incremental subscription. Rounded marginal invoice charges can differ at unit boundaries; reconcile total account bills.
- The table excludes incremental independent-recovery overhead pending M0 protocol measurement. Model it explicitly as an additional usage vector before rollout: e.g. a once/minute scheduled Worker adds 43,200 invocations per 30 days, plus indexed due-row reads, registration/cleanup writes, recovery RPC/CPU, telemetry and retries. Add these to U_i (avoid double-counting existing per-event assumptions); measure and reforecast. Two additional D1 billed writes per event alone can add up to $1.37/month at 1k MAU or $136.80 at 100k MAU if allowances are exhausted. No polling all agents. Recovery is mandatory even if actual cost is higher.

|                    MAU | Full allowance | 50% allowance remaining | Zero allowance remaining |     Proposed planning budget |
| ---------------------: | -------------: | ----------------------: | -----------------------: | ---------------------------: |
| 1-10 (PoC, 10 modeled) |          $5.00 |                   $5.00 |                   $22.73 |                          $10 |
|   100 (Internal Alpha) |          $5.00 |                   $5.08 |                   $24.70 |                          $15 |
|    1,000 (Public Beta) |          $9.33 |                  $10.43 |                   $44.62 | $30 target / $60 conditional |
|        10,000 (Growth) |        $176.07 |                 $208.14 |                  $245.01 |                         $300 |
|        100,000 (Scale) |      $2,204.80 |               $2,261.13 |                $2,326.00 |                       $3,500 |

Allowance scenarios apply the stated remaining fraction to every meter only for sensitivity; actual per-meter B_i must be taken from the shared account baseline. Include $5 in all scenarios and exclude incremental independent-recovery cost as noted above. The $30 Beta target is not viable if the shared allowance is exhausted; propose a $60 conditional envelope (including margin), subject to separate owner/CTO budget approval based on actual usage. PoC/Alpha may also exceed $10/$15 under zero allowance; verify capacity and obtain revised approval BEFORE cloud provisioning or expanding load. Do not claim dedicated free allowances or an account-wide hard cap.

At 1,000 identical light/medium/heavy users, same assumptions yield $5.15/$9.65/$62.54 respectively. At 100k mixed users, about $1,318 is DO row-write overage alone; each extra 10 writes/event adds about $684/month. A 10 s instead of 0.5 s billed DO duration/event raises modeled duration fees from $50 to $1,100/month at 100k MAU. These are workload projections, not proof of throughput or guaranteed bills. Preserve required audit, budget and recovery writes. Use real billing metrics before changing the architecture for cost.

M0 exit: define a repeatable per-event billing trace, measure the available V1 baseline (logical database mutations, bytes retained and task mix, not a proxy for billed SQLite rows), and calibrate a minimal local SQLite/DO probe for normal turn, task, retry, active lease renewal and alarm/recovery operations; record measured or explicitly estimated billed-row counts (including indexes, deletes and alarms), storage bytes and limitations. M1 report real local V2 measurements and M4 exit require separately approved cloud metering/observed billed writes per event for each path/cohort, P50/P95 and weighted mean, and reconcile with provider metrics; replace the assumed 20 rows/event and reforecast before rollout. No cost gate may remove necessary integrity/recovery writes.

Storage is a stock, not a fixed per-user lifetime cap. M0 define starting bytes, net bytes/event and retention/deletion/backup assumptions for active and dormant users. M4 measure DB/index/metadata and R2 growth from a representative long-history workload and forecast 1/6/12-month average GB-month, including retained inactive users and backups. For sensitivity, at 100k MAU increasing average DO storage from 19 to 38 MB/agent adds $380/month at $0.20/GB-month; apply actual retention and quota data. Archival/deletion must respect existing user retention, export and integrity contracts; no forced history pruning purely to meet the model.

### Separate variable execution budget

LLM spend is independent of infrastructure. Example illustrative rate only, not a selected model quote: $0.50/M input and $2/M output tokens, with 5k input and 1k output per event, yields $0.0045/event or $3.078/month per mixed active user ($3,078 for 1,000 MAU). Actual input/output, cached input, number of model/tool steps and retries must be metered; no unconditional per-event token allowance.

Daytona official list CPU rate $0.0504/vCPU-hour and RAM $0.0162/GiB-hour, storage $0.000108/GiB-hour after first 5 free per pricing; confirm account entitlement, storage lifecycle and detailed metering. Example Linux 1 vCPU/1 GiB RAM costs $0.0666 per active hour before additional storage. At 30 eligible 5-minute runs/user/month, 1,000 users consume 2,500 active hours = $166.50 gross compute before any credits/storage. If 50% of those jobs safely execute locally with equal quality and no cloud sandbox fallback, gross compute falls to $83.25; this is a scenario, not an offload forecast. Device compute shifts energy/thermal burden to the owner's device; cloud coordination and LLM charges remain. No promotional credits assumed for recurring operation. Device savings require paired benchmark and real placement mix.

For 1,000 mixed MAU, illustrative budget envelope: $30 Cloud Runtime + $3,078 LLM + $166.50 sandbox = $3,274.50/month before extras; 50% eligible device offload reduces sandbox portion by $83.25. With the conditional $60 Cloud Runtime envelope the same scenario is $3,304.50/month before extras. These are not spending authorizations or product pricing. PoC uses fake model/executor by default; real-provider canary spend requires a separately approved explicit hard cap plus per-user/global reservations. No paid Supabase/Neon upgrade authorized by this ADR.

In the illustrative 1k MAU $3,274.50 envelope, LLM is about 94% and Cloud Runtime about 1%; this is a scenario, not an empirical cost mix. Prioritize inference unit economics before micro-optimizing infrastructure: reuse the existing Model Gateway and budget controls, establish approved per-user/plan and global limits, reserve estimated maximum spend before every paid call, reconcile actual input/output/cached tokens and retries, and handle unknown usage conservatively. M0 defines a small model-routing evaluation matrix (latency, correctness/task success, cost per successful task, tool capability, privacy); start with deterministic routing and bounded context/output/tool-step/call budgets. Evaluate prompt caching or on-device inference only when supported and quality/latency/privacy are maintained; no forced downgrade solely to save tokens. At budget exhaustion show accurate user-facing status and preserve accepted-work recovery; do not silently truncate or auto-spend beyond approved caps. M1 fake-provider tests validate per-user/global caps and metering; paid-model evaluation is separately authorized. M4 rollout requires measured inference cost distributions and revised per-user budgets, not just infrastructure estimates. No model selection or real-provider spend is approved here.

### Budget controls and deployment

- Use existing Workers Paid plan; local Wrangler tests first. Isolated V2 staging Worker, DO namespace, Queue, R2 prefix/bucket and optional D1, with dedicated nonproduction identities and no real-user data; no change to V1 routes. Cloud resource provisioning/deployment/smoke requires the separate approval defined above; no new fixed-fee subscriptions.
- First cloud PoC envelope: $10/month total allocated Cloud Runtime ($5 existing base + up to $5 planning headroom), $0 external LLM/Sandbox by default. Track actual incremental usage against account baseline, since included allowances are shared and attribution is imperfect.
- Alerts at 50%, 80%, 100% of phase planning budget; review spend and traffic/latency daily during PoC, weekly after launch. Alert rather than blanket stop production for ordinary cost deviations; gate unapproved model/sandbox spend and abusive workloads, retain accepted-task recovery. Account-wide Workers/DO spending limits can interrupt other apps; stored-data charges may continue. Do not activate broad hard limits without owner review. Dev isolation, per-invocation CPU limits, provider budget checks, artifact retention and sampled non-sensitive observability.
- Track Workers CPU/request, DO duration/request/rows, D1, Queue retry/DLQ, R2 storage/ops, observability bytes, model tokens/cost and sandbox allocated active/storage time per event and workload cohort. Reconcile with provider invoices; do not log private text, files or credentials.
- Recheck official prices (especially the Dec 1 Observability transition), usage model and shared remaining allowances at the first rollout gate and each later gate; reforecast using measured P95 latency, billed writes/operation, storage growth, stream CPU and cost/user. If costs exceed plan, investigate; product experience and durable recovery take precedence. Budget envelopes are provisional planning decisions, not automatic hard service limits.

## Implementation and cutover

M0: ADR, minimal common execution/stream/recovery contract and matched V1 benchmark. M1: local Agent Head + Fast Path and Alarm/Queue Durable Path in parallel; fake executor first; independent recovery and protected outbox acceptance mandatory. M2: authorized iPhone native tool and routing demo (standalone mobile sandbox research continues). M3: reuse V1 LLM, Notes, Daytona and minimal global control data as needed, with versioned API extensions reviewed separately. M4: cloud benchmark, fault injection, export/import, deletion/restore, region and cost verification. M5: reversible per-agent migration; no real data before separate cutover approval.

### M0/M1 acceptance checklist (summary; detailed gates above remain normative)

| Stage | Check                                                                                              | Evidence                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| M0    | Common execution/stream/recovery contracts; existing B1 compatibility                              | Reviewed contract and ownership invariants                                                                              |
| M0    | Registry coverage, retirement/fencing and D1 outage behavior; lease/deadline and long-turn handoff | Protocol and deterministic fault scenarios                                                                              |
| M0    | V1 baseline, billing trace, storage-growth assumptions and model-routing matrix                    | Reproducible workload/measurement definitions and local probe                                                           |
| M1    | Fast/Durable paths, protected outbox, unknown ACK, tenant isolation                                | Local fake-provider end-to-end and negative tests                                                                       |
| M1    | Covered turn: zero synchronous registry I/O; uncovered turn and registry outage                    | Race/fault tests; separate ACK/Runtime latency traces; no lost accepted work                                            |
| M1    | All six Alarm retries fail; independent recovery and later schedule                                | Offline recovery <= 2 min detection / <= 5 min dispatch or re-arm under specified conditions                            |
| M1    | Streaming/disconnect, silent executor loss and reasoning > 120 s                                   | 60 s normal reconciliation-entry target; fenced handoff, one final result or explicit uncertain outcome                 |
| M1    | Global/per-agent budgets, latency and billing trace                                                | Atomic reservations, <= 50 ms near-region P95 budget-check target within 200 ms Runtime; measured writes and stream CPU |

All M1 checks use local/fake providers at this approval level. Repeat relevant checks with separately approved cloud/provider canaries before rollout. Failure or unmeasurable evidence must be reported, not marked as a pass.

Work packages: A Agent Core/Fast Path; B Event Runtime/Recovery; C Device Runtime; D Performance/Migration and D1 comparison. Common contract frozen before dependent changes; shared schema/ownership coordinated by architect; isolated worktrees, Draft PRs, local tests (no GitHub Actions requested).

Migration must maintain one writable authoritative runtime per agent, fence old executions and quiesce or reconcile in-flight external effects. Snapshot/export, import validate IDs, counts, checksums, ordering, constraints and schema versions; verify API/iOS compatibility, route by server-resolved agent ownership, test rollout and reverse migration of post-cutover changes before production. A routing flip alone is not rollback. Retain Neon temporarily during bounded cutover; retire only after operational acceptance. No indefinite dual-write.

## Open evidence / non-goals

Not yet measured: real Cloudflare account usage, V1 Neon active CU/idle cause, DO cold/warm latency/duration/write amplification, global budget authority latency, actual device availability/offload rate, cost of retained dormant users and exports, provider unknown-outcome handling. The budget and performance targets are provisional. No new resources, production change, credential access, paid execution or runtime tests performed by this document PR.

## References (pricing verified 2026-11-19)

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/observability/pricing/
- https://neon.com/pricing
- https://www.daytona.io/pricing
