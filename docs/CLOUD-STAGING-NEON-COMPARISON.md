# Ember Cloud Staging — Neon PostgreSQL Assessment

**Observed:** 2026-11-07. **Baseline:** `main` at `db9fab1`.

## Decision

Neon is a credible future managed-PostgreSQL option for Ember under the CTO's Cloud-native,
Cloudflare-first, pay-as-you-grow direction. It preserves PostgreSQL and Ember's existing
`DATABASE_URL` contract at the driver boundary, so no business-contract or schema rewrite is
indicated. It is **not a drop-in change to today's staging deployment**: the current preflight
rejects external database hosts, and the Worker/migration containers have no external network
route. Keep it as a phase-two candidate until a measured need for managed HA/recovery outweighs
the added monthly cost and deployment work. No Neon project, paid plan, or database was created.

## Current Ember fit

| Area | Finding |
| --- | --- |
| PostgreSQL and application contract | Ember accepts a PostgreSQL URL and uses `pg.Pool`; Neon documents PostgreSQL 17 support. The production schema and business contract can remain unchanged, but integration and migration verification against Neon is still required. See [`config.ts`](../packages/postgres/src/config.ts), [`pool.ts`](../packages/postgres/src/pool.ts), [Neon's plan limits](https://neon.com/docs/introduction/plans), and [migration compatibility](https://neon.com/docs/import/migrate-from-postgres). |
| Current staging boundary | Compose runs PostgreSQL 17.6 on an `internal: true` network with no published port. Preflight only permits `postgres`, `db`, and loopback hosts, with `postgres` required in shared staging. Worker and one-shot `migrate` are attached only to that internal network. A Neon endpoint therefore needs explicit preflight and egress-network changes; do not weaken the guard to accept arbitrary hosts. See [`compose.yaml`](../infra/staging/compose.yaml) and [`preflight.mjs`](../infra/staging/scripts/preflight.mjs). |
| Cloudflare path | A Cloudflare Tunnel publishes an origin/API; it does not grant the Compose Worker or migration job an outbound route to Neon. If Ember later runs its API on Cloudflare Workers, Cloudflare documents Neon support through Hyperdrive, and the repository's `pg@8.23.1` exceeds Hyperdrive's documented `pg@8.16.3` minimum. That is a separate runtime integration to validate, not a consequence of adding a Tunnel. [Cloudflare Neon/Hyperdrive guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/). |
| Private networking | Neon lists private networking and IP allow rules on Scale; its private network integration is AWS PrivateLink. That can fit an AWS-hosted Ember runtime, but it is not a Cloudflare Tunnel feature and raises the plan/commercial floor. Launch's public TLS endpoint is the low-cost path, subject to an explicit outbound policy and credential controls. [Neon plans](https://neon.com/docs/introduction/plans), [Neon PrivateLink](https://neon.com/blog/aws-privatelink-for-neon-databases). |

## Cost and scale

Prices below are USD and were checked on 2026-11-07; Neon says its pricing page was updated
2026-11-04. Pricing and limits can change. [Neon plans](https://neon.com/docs/introduction/plans)
and [pricing](https://neon.com/pricing) are the source of record.

| Option | Current allowance / rate | Ember implication |
| --- | --- | --- |
| Free | $0; 100 CU-hours/project/month, up to 2 CU, 1 GB/project (20 GB total account), 5 GB public transfer/project; scales to zero after 5 idle minutes. Free history is up to 6 hours or 1 GB of changes and includes one manual snapshot. | Good for an isolated, intermittent prototype. The staging Worker reaper defaults to a database check every 2 seconds (`EMBER_WORKER_INTERVAL_MS=2000`), so a continuously running Worker will keep waking the database and should not be budgeted as scale-to-zero. Free usage is limited, not an always-on $0 allowance. [`config.ts`](../apps/worker/src/config.ts), [`reaper-loop.ts`](../apps/worker/src/reaper-loop.ts). |
| Launch | No minimum monthly fee; $0.106/CU-hour, $0.35/GB-month, up to 16 CU autoscaling; 500 GB public transfer included/project then $0.10/GB. Five-minute scale-to-zero can be disabled. History is up to 7 days; extra history is $0.20/GB-month and snapshots are $0.09/GB-month. | Lowest reasonable always-on managed trial. No listed uptime SLA or private networking. |
| Scale | $0.222/CU-hour, $0.35/GB-month; autoscale to 16 CU or fixed compute to 56 CU; 500 GB transfer included/project then $0.10/GB. Up to 30 days of history; SLA, IP allow rules, and AWS PrivateLink are listed. | Offers a smoother path to larger fixed compute and stronger operational/network features, at about 2.1× Launch's compute rate. Validate which specific SLA and network requirements apply before selecting it. |

Illustrative Launch floor for a 30-day continuously active database at 0.25 CU and 1 GB:
`0.25 × 730 × $0.106 = $19.35` compute plus `$0.35` storage, or about **$19.70/month**.
That exceeds Free's 100 CU-hours (equivalent to 400 hours at 0.25 CU). This is a scenario,
not a bill forecast: it excludes snapshots, extra history, transfer, other computes, taxes, and
any separately billed Cloudflare/AWS resources. Neon advertises $15/month typical Launch spend
for intermittent load and 1 GB; that workload differs from Ember's active reaper loop.

## Connection, recovery, and migration

- **Pooling:** Neon’s pooled endpoint uses PgBouncer transaction mode. Ordinary transactional
  Ember queries are a plausible fit, but session-level advisory locks are unsupported through
  that endpoint. Ember's migration runner takes a session-level `pg_advisory_lock`; therefore,
  migrations must use Neon's direct/unpooled connection string. Keep runtime and migration
  connection strings distinct if runtime pooling is adopted. Neon recommends direct connections
  for schema migrations and `pg_dump`/`pg_restore`. [Connection pooling](https://neon.com/docs/connect/connection-pooling),
  [migration guide](https://neon.com/docs/import/migrate-from-postgres), and Ember's
  [`migrator.ts`](../packages/postgres/src/migrator.ts).
- **Recovery:** Neon provides managed history/restore and snapshots, which reduce host-level
  backup work. The Free history window is narrow; Launch's 7-day history and paid snapshot/history
  storage must be compared with Ember's required RPO/RTO. Before relying on it, perform and record
  a restore exercise and keep an independent export policy. This does not change Ember's explicit,
  forward-only, checksum-verified migration policy.
- **Cutover cost:** PostgreSQL data can be moved with `pg_dump`/`pg_restore`; the source is
  PostgreSQL 17.6 and Neon lists major version 17 support. The dump/restore must use direct
  endpoints, and the final run must verify row counts, migration checksums, indexes/constraints,
  restart durability, and application integration. Budget operator time, a maintenance window
  (or a separately designed replication cutover), temporary dual storage/compute, and possible
  data-transfer charges. A rollback after writes reach Neon needs a reverse data plan; simply
  restoring the old `DATABASE_URL` would lose those writes.

## Adoption gate

Revisit Neon when Ember has a measured need for managed recovery/HA or has outgrown the single-host
PostgreSQL operations. Before connecting any real Ember data, require an approved monthly spend cap
and plan, a disposable-project compatibility run, explicit outbound/network rules, successful
restore and migration exercises, and an agreed cutover/backout procedure. Creating a paid Neon
resource or enabling paid features requires prior user approval. Until then, preserve the current
PostgreSQL service and the application/business contracts.
