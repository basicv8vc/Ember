# Ember PostgreSQL Provider Decision: Why Neon over Supabase

English | [简体中文](neon-postgres-provider-decision.zh-CN.md)

- Date: 2026-11-19
- Status: Historical decision record and current architecture description; does not authorize new migrations, resources, or paid operations.
- Scope: Managed PostgreSQL selection for Ember Cloud / Private Alpha and its relationship to Cloud Runtime V2.
- Original evidence: [Issue #132](https://github.com/basicv8vc/Ember/issues/132), [PR #135](https://github.com/basicv8vc/Ember/pull/135) (measurement report, Draft), [PR #139](https://github.com/basicv8vc/Ember/pull/139) (follow-up compatibility and concurrency diagnostics, Draft).

## TL;DR

Ember selected Neon neither because Supabase lacked the required PostgreSQL capabilities nor because Neon was faster in every test. Both services passed targeted compatibility checks for the core business contracts.

The main reasons for selecting Neon as the Alpha database were:

1. Neon was observed entering Idle despite idle Cloudflare Hyperdrive connections, and automatically resumed on the next request. This better matches an on-demand Personal Agent than Supabase Free's project-level pause, which may require manual restoration.
2. Ember already has authentication, business APIs, task execution, and file storage. It primarily needs managed PostgreSQL rather than a complete BaaS.
3. Neon's historical Free database capacity and usage-based upgrade path were better suited to starting with low traffic. However, compute savings depend on the actual workload allowing the database to suspend.

**V1 retains Neon PostgreSQL; Supabase is a validated alternative, not a current runtime dependency. ADR-0005 independently governs the Cloudflare-native Runtime V2 direction.**

## 1. Decision background and timeline

| Date                   | Event                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-07             | Issue #132 initiated the Neon/Supabase comparison; one Free test project per provider was authorized, using synthetic data only. Existing PostgreSQL business and transaction contracts had to be preserved, without migrating to D1. |
| 2026-11-08             | PR #135 summarized P0–P4 measurements and recommended Neon for Alpha. PR #139 recorded Neon as the CTO-approved provider and retained follow-up diagnostic work.                                                                      |
| 2026-11 (subsequently) | Neon became part of the shared Ember Cloud environment, serving the API and Async Runtime through Hyperdrive. See [Ember Cloud](../cloud-staging.md) for the deployment path.                                                         |
| 2026-11-18             | [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md) recorded the Neon compute warning and the Cloudflare-native V2 direction, requiring measurement and mitigation of unnecessary V1 database wakeups first.                      |
| 2026-11-19             | The user provided an email warning of an upcoming inactivity pause for the Supabase Free experiment. This was not an Ember Cloud database outage notice.                                                                              |

The original comparison report remains Draft; its outstanding issues must not be treated as resolved. The actual selection and current deployment are corroborated by the deployment documentation on main and ADR-0005.

## 2. Why Ember does not need the complete Supabase BaaS

The established approach was Cloudflare-first and pay-as-you-grow. Managed PostgreSQL had to preserve Ember's existing persistence, tenant isolation, transactions, idempotency, and worker lease semantics.

| Supabase capability | Ember's current approach                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| Auth                | Apple Sign-in + Ember-owned authentication and tenant identity               |
| Data API            | Hono API + PostgreSQL repositories                                           |
| Edge Functions      | Cloudflare Workers                                                           |
| Asynchronous tasks  | Cloudflare Queues + Async Runtime                                            |
| Storage             | Cloudflare R2 (objects) + PostgreSQL (business state and metadata)           |
| Realtime            | Ember-owned API/client state synchronization; no current Supabase dependency |
| PostgreSQL          | Neon + Hyperdrive                                                            |

Database selection therefore prioritizes PostgreSQL compatibility, connection semantics, availability, cost, and recovery. There is no need to pay a fixed platform fee for BaaS features that are not required or introduce a direct dependency between the iOS app and the database API.

## 3. Summary of the 2026-11-08 comparison

Both experimental databases were located in Singapore for a matched regional comparison, not as a production region decision or a global latency benchmark. The following is historical evidence from PR #135, not a new execution of the tests.

| Item                                                      | Neon Free                                                                                                 | Supabase Free                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| PostgreSQL version                                        | 17.11                                                                                                     | 17.11                                                                                 |
| Migrations 0001–0017 (PR #138 baseline)                   | All applied; second run found all already applied; checksums and normalized schema matched local baseline | Same                                                                                  |
| Core persistence, tenant isolation, idempotency, rollback | Targeted checks passed                                                                                    | Targeted checks passed                                                                |
| Advisory locks                                            | Direct migration lock and Hyperdrive transaction lock passed                                              | Direct migration lock and Hyperdrive transaction lock passed                          |
| Hyperdrive Worker                                         | Live calls passed                                                                                         | Live calls passed                                                                     |
| Connection failure recovery                               | Recovered after backend termination in approximately 2.2–2.7 s                                            | Direct connection approximately 2.567 s; next Hyperdrive request approximately 409 ms |
| Idle/resume                                               | Entered Idle in two controlled observations and automatically resumed on the next request                 | Five idle origin sessions remained after 11m18s; project pause/resume not verified    |
| Synthetic logical export/restore                          | Passed                                                                                                    | Passed                                                                                |
| Hosted load testing                                       | Some concurrency scenarios remained unresolved                                                            | Targeted scenarios passed; no production-grade load test                              |

### Key differentiating evidence: Scale-to-zero

In controlled Neon tests:

- Idle was observed after approximately 7.5 minutes without requests; the next Worker query took 640 ms inside the Worker and 1.96 s total HTTP time.
- An independent repeat observed Idle after 6m19s; the next query took 611 ms inside the Worker and 1.34 s total HTTP time.

Both observations preceded the 10-minute Hyperdrive idle-connection timeout documented at the time. This shows that idle Hyperdrive connections did not prevent Neon suspension in the experimental configuration. These are limited samples, not a production SLO, and do not establish that suspension will occur when background SQL calls continue.

Supabase's seven-day low-activity project pause is not equivalent to Neon's short compute suspension. The former may require manual restoration; the latter was automatically resumed by the next request in the experiment.

### Outstanding issues and evidence limitations

- Neon passed 16 concurrent claims; in the 32-claim test, 18 succeeded and 14 timed out. Exact SQL diagnostics were not retained, so connection pooling, database latency, and provider limits cannot be identified as the root cause. The PR #139 diagnostic tool passed static validation, but the original report does not record a subsequent hosted diagnostic run.
- Both providers exhibited sensitivity to the fixed timing window in the lock-observer test; independent core advisory-lock probes passed.
- Neon's role script rejected `ALTER ROLE ... NOSUPERUSER` (SQLSTATE 42501). Separate grants and role-attribute checks passed, but password-authenticated runtime login was not verified in that experiment. Supabase completed least-privilege login testing using a compatible role-creation method.
- Neon direct TLS was verified by the client; the relationship between `pg_stat_ssl` and proxy-side TLS remained unexplained.
- Four failures in the local full integration suite came from stale assertions expecting 16 migrations instead of 17 after migration 0017 was added. The results are not presented as an entirely passing suite.
- The Hyperdrive origin connection caps differed (Neon 20, Supabase 5), so latency and concurrency observations cannot be treated as a provider performance ranking. Sustained load, 10,000-user capacity, complete network partitions, and production-grade disaster recovery were not validated.

See [PR #135](https://github.com/basicv8vc/Ember/pull/135) and [PR #139](https://github.com/basicv8vc/Ember/pull/139) for details. New tests require separate authorization and evidence records.

## 4. Economics: historical plan assessment, not current pricing

The following allowances and prices come from the original report dated 2026-11-08. They have not been rechecked for this document and are not commitments about future plans.

| Item                   | Neon                                                              | Supabase                                         |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| Free database capacity | 1 GB                                                              | 500 MB                                           |
| Free compute           | 100 CU-hours/month                                                | Instance model; low activity may trigger a pause |
| Free transfer          | 5 GB public transfer                                              | 5 GB uncached + 5 GB cached egress               |
| Free recovery          | 6-hour/1 GB history; one manual snapshot                          | No automatic project backups                     |
| Paid entry             | Usage-based Launch: $0.106/CU-hour and $0.35/GB-month at the time | Pro: starting at $25/month at the time           |

Historical Neon Launch example: 0.25 CU for 8 hours per day gives approximately 60 CU-hours per month and $6.36 in compute costs, excluding storage, restore history, and excess transfer. Running continuously for 24 hours per day gives approximately 180 CU-hours and $19.08 in compute costs alone. These are modeled estimates, not observed bills.

The original 10,000-user scenario assumed DAU equal to 10% of registered users, 10 messages per DAU per day, and 10 SQL statements per message. It estimated 100,000 statements/day, 1.2 GB/month of database growth, and 6 GB/month of database egress. Under these assumptions, neither Free plan is suitable for the entire workload; capacity must be planned in advance. Actual costs must be calculated from measured SQL usage, CU-hours, storage, network traffic, recovery objectives, and then-current pricing.

Free tiers are a way to experiment and start at low traffic, not an architectural constraint. Neither Free plan provides sufficient production-grade recovery commitments. Encrypted logical backups and recoverability should be verified before introducing real user data.

## 5. Current Ember Cloud architecture

According to [cloud-staging.md](../cloud-staging.md), the [Cloudflare README](../../infra/cloudflare/README.md), and [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md), the current shared environment is:

```text
iOS App
   |
API Worker ---- Cloudflare Queues ---- Async Runtime Worker ---- LLM / Daytona
   |                                         |
   +------------ Cloudflare Hyperdrive -----+
                         |
                  Neon PostgreSQL
                         |
              Business state / metadata

R2: file payloads and artifacts
Migration runner -> separate direct PostgreSQL connection
```

Neon PostgreSQL is the source of truth for business state. API and execution Workers share the database through Hyperdrive. Migrations must use a separate direct connection because session-level advisory locks cannot pass through Hyperdrive transaction pooling.

The Supabase project `ember-issue132-supabase-free` is the synthetic-data comparison environment authorized by Issue #132. Ember Cloud does not use its Auth, Storage, or Data API, and it was not selected as the current primary database.

These findings are verified against repository configuration and deployment documentation. The live Cloudflare Hyperdrive origin, database contents, and platform usage were not queried again.

## 6. Practical impact of recent provider notices

### Neon compute warning

The Neon compute quota warning demonstrates real pressure on the early Free budget. Frequent SQL calls from API state reads, Worker recovery/relay, lease checks, or scheduled cleanup may prevent scale-to-zero.

This is a runtime issue requiring measurement, not a finding that PostgreSQL is unsuitable. Actual wakeup sources, SQL counts, CU-hours, task recovery latency, and first-request latency must be measured. The email alone cannot establish the root cause or quantify potential savings.

### Supabase Free pause warning (2026-11-19)

The user's forwarded email says that `ember-issue132-supabase-free` is scheduled for pausing after more than seven days of insufficient activity. It was not paused when the email was sent. It can be restored within 90 days of pausing; afterward, data can be downloaded but the project cannot be restored in place. The specific deadline should follow the project notice and dashboard. Account status was not reverified for this document.

As this is an isolated experiment, the pause is not expected to affect current Ember Cloud. Do not upgrade to Pro solely to keep the experimental instance. If retesting is needed, first inspect and preserve necessary synthetic data, original reports, and logical exports, then restore or recreate the test project as needed. Do not delete, migrate, or modify the existing shared database, or use artificial continuous requests to circumvent Free-tier policies.

## 7. Next steps and conditions for reconsideration

### V1: Retain Neon

- Preserve validated PostgreSQL contracts and the current deployment; do not migrate databases merely because of short-term Free-tier quota pressure.
- Prioritize reducing unnecessary database wakeups while retaining reliable outbox, lease fencing, idempotency, budget, cancellation, and bounded reconciliation semantics. Cost savings must not cause lost tasks.
- Monitor CU-hours, cold-start/tail latency, task recovery, SQL/connection usage, and actual bills. Submit a paid-plan assessment when quotas or production availability/backup objectives require it.
- Define backup, recovery, and export requirements for real user data, and periodically verify logical restoration.

### V2: Event-driven Cloudflare-native Runtime

Follow [ADR-0005](../adr/0005-cloudflare-native-runtime-v2.md): explore Workers + SQLite-backed Durable Objects + Alarms + Queues + R2, with D1 only as an optional global control plane when a concrete need exists.

A thin DO coordinates agent-local state and scheduling; slow model or sandbox I/O remains with independent Workers. Potential benefits include on-demand wakeups, less idle polling, and improved per-agent scheduling, not a guarantee of zero idle cost.

ADR-0005 targets retiring Neon when conditions are met, but does not itself approve migration, implement V2, or promise a fixed timeline. Migration requires separate approval and validation of tenant isolation, transaction/idempotency/budget semantics, failure recovery, schema lifecycle, export and rollback, end-to-end latency, and actual cost.

### When to reconsider Supabase

If integrated BaaS capabilities or predictable always-on compute become necessary, or if optimized Neon shows sustained cost or performance disadvantages under real workloads, reassess Neon Launch against Supabase Pro using existing PostgreSQL compatibility evidence. A new decision must consider actual plan pricing, region, capacity, recovery capabilities, and migration risk—not just a single Free-tier warning.

## References

- [Issue #132 — Managed PostgreSQL: Supabase vs Neon + Hyperdrive](https://github.com/basicv8vc/Ember/issues/132)
- [PR #135 — Neon/Supabase validation](https://github.com/basicv8vc/Ember/pull/135) (original measurements, cost model, and backup/restore evidence)
- [PR #139 — Follow-up compatibility and claim diagnostics](https://github.com/basicv8vc/Ember/pull/139)
- [L4 Cloudflare Workers P0](../product/L4_CF_WORKERS_P0.md)
- [Ember Cloud](../cloud-staging.md)
- [Cloudflare deployment](../../infra/cloudflare/README.md)
- [ADR-0005 — Cloudflare-native Cloud Runtime V2](../adr/0005-cloudflare-native-runtime-v2.md)
- [Neon pricing](https://neon.com/pricing) / [Supabase pricing](https://supabase.com/pricing) (recheck when reassessing)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)

This document records decisions and evidence only. It introduces no runtime dependencies and changes no database, code, deployment, credentials, or paid plans.
