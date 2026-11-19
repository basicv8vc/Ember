# ADR-0006 — Experience-first, Device-powered Runtime V2

- Status: Proposed — owner / CTO review required; effective upon merge
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

This ADR refines ADR-0005: retain the Cloudflare-native direction and its correctness and migration gates; add a latency-first interactive path, device-powered execution as a first-class architecture boundary, and measurable deployment budgets. On merge, it authorizes only bounded V2 PoC implementation in isolated environments, subject to the budget and release gates below. It does not change ADR-0004's V1 wire contract, permit real-user migration, authorize new external model spend or paid sandbox use, or certify any V2 component as implemented. V1 product delivery proceeds independently. Existing V1 security, fencing, budget reservation, idempotency, deletion-epoch and atomic message/task linkage invariants remain mandatory.

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

### Agent Head and storage boundaries

- Start with one canonical DO per server-resolved agent/tenant ownership domain; preserve tenant/principal/agent distinctions. Never route on untrusted client IDs. No global business-state DO. Partition further only after evidence of a hotspot.
- DO SQLite owns conversations, messages, turns, tasks, runs, schedules, inbox/outbox, approvals, reservations, Notes and metadata when transaction invariants require co-location. Read context and commit related effects locally; no slow I/O inside SQLite transactions or global async locks spanning external calls. DO interleaving still requires transactions and fences.
- D1 is the preferred optional global control store for identity/directory, session, entitlement, device registry and bounded recovery indexes. Introduce only the minimal needed schema. DO SQLite and D1 have the same advertised row-write/read rates but different storage rates and latency/transaction boundaries. Compare D1-centric vs DO-local on identical benchmark workloads; do not split atomic message/task/usage changes across stores. D1 indexes that are projections must be rebuildable and not a second authority.
- Cache routing/identity only with explicitly bounded freshness and revocation semantics. Per-agent reservations do not enforce a platform-wide spend cap; preserve the existing strict global budget gate before paid egress, with a separately validated authority/reservation mechanism and measured latency.
- R2 holds large immutable/versioned artifacts and backups; stage uploads, validate ownership/hash, commit metadata, clean orphans. R2 and SQLite cannot share a transaction. Archive history only when measured need justifies it.
- Device storage is disposable cache/outbox for synced data and authoritative only for explicitly device-private inputs. No silent file upload.
- Schema evolution: transactional, idempotent per-object versioned migrations, tested dormant schema upgrades, inventory, export/restore, deletion plus R2 cleanup, and forward-repair/rollback rehearsals.

### Event scheduler and reliability

A single Alarm per Agent Head points to earliest due work in indexed persistent scheduling/outbox/lease tables. Re-arm only when earliest deadline changes or processing requires it; batch bounded due work, preserve ordering and timezone/DST rules for recurring schedules, isolate failures. No normal-path global polling or continuous agent loop. Alarm and Queue delivery are at least once; handle duplicates, delays, retry exhaustion, failure before/after publishing, and terminal/outcome reconciliation. Verify atomic storage/alarm behavior against platform APIs and fault-injection tests; if an unrecoverable registration gap exists, retain a durable bounded recovery index and reconciliation path before launch. No lost committed work; a dirty flag is not a durable guarantee.

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

| Metric | Initial target |
| --- | --- |
| Local send feedback | <= 50 ms |
| Cached history first render | <= 100 ms |
| Durable message ACK (near-region P95) | <= 250 ms |
| Runtime overhead excluding model/provider (near-region P95) | <= 200 ms |
| Simple low-latency model first useful token (P50 / P95) | <= 1 s / 2.5 s |
| Background task dispatch start (P95, not provider startup) | <= 3 s |
| Foreground cancel state feedback | <= 500 ms |
| Foreground P95 degradation with background load | <= 10% |

Do not weaken integrity for these targets. Test unknown ACK, duplicate events, concurrent budgets/global cap, transcript deletion, cross-tenant isolation, disconnect, stale epoch, outbox publish gap, Alarm retry exhaustion, provider unknown outcome, credential revocation, R2 mismatch, device sleep/offline and authorized fallback. Preserve all B1 wire and domain contract behavior; streaming/device wire extensions require explicit versioned approval.

## Deployment budget (USD/month)

Planning date: 2026-11-19. Existing owner account: Workers Paid $5/month, Neon Free, Supabase Free. No new fixed database subscription required. Shared account allowances are not dedicated to Ember; other products consume the same allocations. V1 remains on Neon until cutover; any V1 overage is separate migration-period cost. Supabase is not needed for V2. All figures exclude taxes, existing developer program/domain fees, engineering time and third-party connector fees unless separately budgeted.

### Official metering inputs

| Meter | Included/month | Additional rate |
| --- | ---: | ---: |
| Workers requests | 10M | $0.30/M |
| Workers CPU | 30M ms | $0.02/M ms |
| DO requests (including Alarm and billed RPC/WS) | 1M | $0.15/M |
| DO duration | 400k GB-s | $12.50/M GB-s |
| DO SQLite rows read / written | 25B / 50M | $0.001/M / $1/M |
| DO SQLite storage | 5 GB-month | $0.20/GB-month |
| D1 rows read / written | 25B / 50M | $0.001/M / $1/M |
| D1 storage | 5 GB-month | $0.75/GB-month |
| Queues operations | 1M | $0.40/M |
| R2 Standard storage | 10 GB-month | $0.015/GB-month |
| R2 Class A / B | 1M / 10M | $4.50/M / $0.36/M |
| Observability from Dec 1 2026 | 50 GB ingested / 10 GB-month kept | $0.25/GB / $0.10/GB-month |

Workers Paid base $5 once per account. DO memory metering uses 0.128 GB per active object; idle eligible for hibernation is not duration-billed. DO and R2 overage rounded to billing units in this model. Queue message <64 KB typically requires three operations; retries add operations. D1 and DO SQLite allowances modeled separately. Index writes, deletes, and setAlarm writes count toward metering; measure actual billed rows. D1 first 100k databases and Queues first 10k queues included; V2 does not require a queue/database per user. R2 internet egress free, other services may charge. Workers Logs before Dec 1: 20M events/month included, $0.60/M excess; model forward-looking Observability cost instead. Sources below.

### Workload and reproducible estimate

30-day month; MAU = monthly active agents (one per user for this model). Assume 60% light, 30% medium, 10% heavy. Additional dormant retained accounts, history growth, backups and high-volume connectors must be added when known.

| User type | Turns/day | Background tasks/day | Total events/mo | DO DB average MB | R2 average MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Light | 5 | 1 | 180 | 5 | 20 |
| Medium | 20 | 4 | 720 | 20 | 100 |
| Heavy | 100 | 20 | 3600 | 100 | 500 |
| Weighted average | 19 | 3.8 | 684 | 19 | 92 |

Per event, assumed (not measured): 6 billed Worker requests, 40 ms aggregate Worker CPU, 4 billed DO requests, 0.5 s total billable DO wall time, 200 DO rows read, 20 DO billed row writes inclusive of index/alarm overhead, 10 D1 rows read, 0.2 D1 billed row writes on average, 1.2 Queue operations (0.4 small messages on average including recovery/followups), 0.1 R2 Class A and 0.2 Class B operations. D1 storage 0.25 MB/agent. Assume 2 KB aggregate billable observability ingestion per event after sampling, 7-day retention and steady load. Storage MB/GB uses decimal units. Storage estimates represent average metered retained storage, not monthly increments.

For N agents, E = 684*N (or the per-user workload above). Monthly usage vector:
- Workers: 6E requests, 40E ms.
- DO: 4E requests, 0.128*0.5E GB-s, 200E rows read, 20E rows written, 0.019N GB-month.
- D1: 10E reads, 0.2E writes, 0.00025N GB-month.
- Queues: 1.2E operations. R2: 0.092N GB-month, 0.1E A, 0.2E B.
- Observability: 0.000002E GB ingestion, approximate storage ingestion*7/30.
- Cost = $5 + sum over meters of max(usage - allowance, 0) * per-unit rate (normalize to M/GB/etc; round DO and R2 excess up to billable units).

| MAU | Modeled Cloud Runtime total/month | Proposed monthly planning budget |
| ---: | ---: | ---: |
| 1-10 (PoC) | $5.00 | $10 |
| 100 (Internal Alpha) | $5.00 | $15 |
| 1,000 (Public Beta) | $9.33 | $30 |
| 10,000 (Growth) | $176.27 | $300 |
| 100,000 (Scale) | ~$2,205 | $3,500 |

At 1,000 identical light/medium/heavy users, same assumptions yield $5.15/$9.65/$62.54 respectively. At 100k mixed users, about $1,318 is DO row-write overage alone; each extra 10 writes/event adds about $684/month. A 10 s instead of 0.5 s billed DO duration/event raises modeled duration fees from $50 to $1,100/month at 100k MAU. These are workload projections, not proof of throughput or guaranteed bills. Preserve required audit, budget and recovery writes. Use real billing metrics before changing the architecture for cost.

### Separate variable execution budget

LLM spend is independent of infrastructure. Example illustrative rate only, not a selected model quote: $0.50/M input and $2/M output tokens, with 5k input and 1k output per event, yields $0.0045/event or $3.078/month per mixed active user ($3,078 for 1,000 MAU). Actual input/output, cached input, number of model/tool steps and retries must be metered; no unconditional per-event token allowance.

Daytona official list CPU rate $0.0504/vCPU-hour and RAM $0.0162/GiB-hour, storage $0.000108/GiB-hour after first 5 free per pricing; confirm account entitlement, storage lifecycle and detailed metering. Example Linux 1 vCPU/1 GiB RAM costs $0.0666 per active hour before additional storage. At 30 eligible 5-minute runs/user/month, 1,000 users consume 2,500 active hours = $166.50 gross compute before any credits/storage. If 50% of those jobs safely execute locally with equal quality and no cloud sandbox fallback, gross compute falls to $83.25; this is a scenario, not an offload forecast. Device compute shifts energy/thermal burden to the owner's device; cloud coordination and LLM charges remain. No promotional credits assumed for recurring operation. Device savings require paired benchmark and real placement mix.

For 1,000 mixed MAU, illustrative budget envelope: $30 Cloud Runtime + $3,078 LLM + $166.50 sandbox = $3,274.50/month before extras; 50% eligible device offload reduces sandbox portion by $83.25. These are not spending authorizations or product pricing. PoC uses fake model/executor by default; real-provider canary spend requires a separately approved explicit hard cap plus per-user/global reservations. No paid Supabase/Neon upgrade authorized by this ADR.

### Budget controls and deployment

- Use existing Workers Paid plan; local Wrangler tests first. Isolated V2 staging Worker, DO namespace, Queue, R2 prefix/bucket and optional D1, with dedicated nonproduction identities and no real-user data; no change to V1 routes. Cloud resource provisioning/smoke is subject to agreed scope and credentials; no new fixed-fee subscriptions.
- First cloud PoC envelope: $10/month total allocated Cloud Runtime ($5 existing base + up to $5 planning headroom), $0 external LLM/Sandbox by default. Track actual incremental usage against account baseline, since included allowances are shared and attribution is imperfect.
- Alerts at 50%, 80%, 100% of phase planning budget; review spend and traffic/latency daily during PoC, weekly after launch. Alert rather than blanket stop production for ordinary cost deviations; gate unapproved model/sandbox spend and abusive workloads, retain accepted-task recovery. Account-wide Workers/DO spending limits can interrupt other apps; stored-data charges may continue. Do not activate broad hard limits without owner review. Dev isolation, per-invocation CPU limits, provider budget checks, artifact retention and sampled non-sensitive observability.
- Track Workers CPU/request, DO duration/request/rows, D1, Queue retry/DLQ, R2 storage/ops, observability bytes, model tokens/cost and sandbox allocated active/storage time per event and workload cohort. Reconcile with provider invoices; do not log private text, files or credentials.
- Reforecast at every rollout gate; use measured P95 latency, billed writes/operation and cost/user. If costs exceed plan, investigate; product experience and durable recovery take precedence. Budget envelopes are provisional planning decisions, not automatic hard service limits.

## Implementation and cutover

M0: ADR, minimal common execution/stream/recovery contract and matched V1 benchmark. M1: Agent Head + Fast Path and Alarm/Queue Durable Path in parallel; fake executor first. M2: authorized iPhone native tool and routing demo (standalone mobile sandbox research continues). M3: reuse V1 LLM, Notes, Daytona and minimal global control data as needed, with versioned API extensions reviewed separately. M4: cloud benchmark, fault injection, export/import, deletion/restore, region and cost verification. M5: reversible per-agent migration; no real data before separate cutover approval.

Work packages: A Agent Core/Fast Path; B Event Runtime/Recovery; C Device Runtime; D Performance/Migration and D1 comparison. Common contract frozen before dependent changes; shared schema/ownership coordinated by architect; isolated worktrees, Draft PRs, local tests (no GitHub Actions requested).

Migration must maintain one writable authoritative runtime per agent, fence old executions and quiesce or reconcile in-flight external effects. Snapshot/export, import validate IDs, counts, checksums, ordering, constraints and schema versions; verify API/iOS compatibility, route by server-resolved agent ownership, test rollout and reverse migration of post-cutover changes before production. A routing flip alone is not rollback. Retain Neon temporarily during bounded cutover; retire only after operational acceptance. No indefinite dual-write.

## Open evidence / non-goals

Not yet measured: real Cloudflare account usage, V1 Neon active CU/idle cause, DO cold/warm latency/duration/write amplification, global budget authority latency, actual device availability/offload rate, cost of retained dormant users and exports, provider unknown-outcome handling. The budget and performance targets are provisional. No new resources, production change, credential access, paid execution or runtime tests performed by this document PR.

## References (pricing verified 2026-11-19)

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
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
