# Ember Alpha PostgreSQL Service Validation — Neon vs Supabase

**Status:** In progress; not yet a provider selection. **Evidence date:** 2026-11-08. **Application baseline:** PR #138 exact HEAD `7385bb18d791c4265ae1c53b618776cd61c07002`.

## Provisional decision

Do not finalize the Alpha database choice until Supabase, least-privilege, backup/restore, and scale-to-zero checks complete. The CTO direction remains Cloud-native, Cloudflare-first, pay-as-you-grow. Keep PostgreSQL and Ember's existing `DATABASE_URL` and business contracts; no application rewrite is indicated.

The user confirmed a global audience. The Neon project is in Singapore; the Supabase form is set to Singapore solely to match this test. Neither choice recommends a production region. The test Worker request was served by Cloudflare's SIN edge, so these latency results describe one test path only, not global user latency. Select production placement from real traffic and multi-region measurements.

Neon P0 migrations, normalized schema comparison, exact-HEAD migration checksums, Workers → Hyperdrive → Neon compatibility, a controlled scale-to-zero/wake cycle, and synthetic export/restore have passed. Neon Free includes PostgreSQL 17, 5-minute scale-to-zero, a 6-hour/1 GB restore history window, and one manual snapshot. Supabase remains untested because its test password and project creation require the user to complete the console form. No final service selection is made yet.

## Exact-HEAD and local baseline

| Check | Result |
| --- | --- |
| PR #138 source | Tested at exact HEAD `7385bb18d791c4265ae1c53b618776cd61c07002`; worktree clean. |
| Migration history | `migrations/0001`–`0016` are byte-for-byte unchanged against `main`. No historical migration semantics were edited. |
| PR #138 migration `0017_apple_nonce_replay.sql` | SHA-256 `bd8f88e89d3178e5472c4af03e3b719a7a2c51c09406fb9bbf822bec2d35d169`; this matches the checksum stored by the exact-HEAD local PG run. |
| Local PostgreSQL | Homebrew PostgreSQL 17.11. This is a local baseline, not provider evidence. |
| Migration runner, first run | 17 applied, 0 already applied. |
| Migration runner, second run | 0 applied, 17 already applied. |
| Provider checksums | All 17 Neon `(id, name, checksum)` rows match the exact-HEAD migration files byte-for-byte. |
| Normalized schema diff | Neon vs local PostgreSQL 17.11 matched for `public` and `ember_private` (SHA-256 `48956655484740217b1460de413a2ce973a59a469ee1eeaee1f2446245500f11`). |
| Unit tests | 86 files, 1,498 tests passed. |
| Build | `pnpm build` passed. |
| Integration suite | 47 files, 546 tests: 542 passed; 4 failed only because `tests/integration/migrations.test.ts` still hard-codes 16 migrations at lines 125, 257, 327, and 499. With `0017`, the expected count is 17. This stale assertion is also relevant to the provider runs and has been shared with Agent C on PR #138. |

The provider projects are isolated test resources and must contain synthetic data only. No production database has been connected or migrated, and no paid database resource has been created.

## P0 — Real projects and migrations

| Provider | Project/setup | Engine version | Migration state |
| --- | --- | --- | --- |
| Neon | One Neon Free project in Singapore, PostgreSQL only; `ember_test` database and `ember_test_owner` role; direct/unpooled endpoint. Singapore is only for a matched provider comparison. | Server reports PostgreSQL `17.11 (9045acd)`. | Exact PR #138 migrations 0001–0017 applied; first run 17 applied, second run 0 applied/17 already. Migration 0017 stored SHA-256 matches exact-HEAD source. Normalized `public` and `ember_private` schema diff matches local PG17.11; all 17 provider checksums match exact-HEAD files. |
| Supabase | Free organization had no projects and no quota warning. The form is prepared for `ember-issue132-supabase-free`, Singapore, Data API off, and Postgres DEFAULT. The user must set/retain the masked database password and submit Create. | Creation UI has no version selector; `Postgres DEFAULT` selected. Actual version must be queried after creation. | Project not created; migrations and provider checks pending. |

Run all migrations from PR #138 against each provider's **direct** endpoint. Neon has completed both runs; Supabase is pending project creation. The migrator uses session-level `pg_advisory_lock`; do not run it through transaction-pooling Hyperdrive. Require 17 rows on the first run and no changes on the second. Compare normalized `public` and `ember_private` schema dumps and verify every migration checksum at the same source HEAD.

`0017` adds `ember_private.apple_identity_nonce_replays` with a unique SHA-256 nonce digest. It is additive and does not expose raw nonces or identity tokens. Its source checksum is recorded above; Neon application and a concurrent replay test passed, while Supabase remains pending.

## P1 — Ember behavior and security

Neon was tested against exact PR #138 HEAD with synthetic data. The passing `b1-message-write-runtime` suite covered Conversation/Message persistence, tenant isolation, idempotent replay, transaction rollback, and concurrent duplicate submissions. The Apple nonce replay race passed on rerun. Results:

- `b1-message-write-runtime` passed: Conversation/Message persistence, tenant isolation, idempotent replay, transaction rollback, and concurrent duplicate submissions. Lease fencing, lease recovery, and the advisory-lock barrier also passed.
- The six-file integration group completed 59/61 tests; four files passed. One failure was a fixed 2-second `pg_stat_activity` lock-wait assertion. A targeted rerun with a 10-second observer still did not see the expected waiter; it returned the expected `23503` foreign-key rejection after about 3 seconds.
- The lease-claim file failed one 16+16 concurrent-claim scenario with sanitized `DB_UNAVAILABLE`. A follow-up with sequential synthetic task creation passed 16/16 simultaneous claims in 6.37 seconds; at 32 claims, 18/32 succeeded and 14 were classified as timeouts. The test connection config applies a 5-second `statement_timeout`; the exact failing SQL diagnostics were not retained.
- A direct SQL pool ran 24 concurrent queries successfully. The exact Apple nonce replay store accepted one of two concurrent uses and returned replay=false for the other; an initial probe had one transient sanitized failure, but the complete rerun passed. Synthetic nonce rows were deleted after each probe.
- A direct session-level advisory-lock probe held migrator key `8675309`; the exact-HEAD migrator waited, then finished with 17 already applied and 0 applied after unlock. Keep migrations on direct/unpooled PostgreSQL.
- Direct `pg_terminate_backend` recovery succeeded: the checked-out client failed as expected, and the pool issued a successful query again about 2.2–2.7 seconds later. This models backend termination, not a full network partition.
- `psql` confirmed TLS to the direct Neon endpoint. The same backend's `pg_stat_ssl` row reported `false`; proxy-side TLS semantics remain unresolved. The PR #138 role script created `ember_worker` but failed at `ALTER ROLE ... NOSUPERUSER`, which Neon denies to a non-superuser admin. Applying its table grants separately succeeded. Catalog checks confirmed a non-superuser role without CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS; no public-schema CREATE; expected B1 table privileges; and no task or migration-table access. The admin could not `SET ROLE ember_worker`, so password-authenticated login was not tested. The test role and grants were dropped after inspection.

The PR #138 full integration suite has four stale assertions expecting 16 migrations although exact HEAD contains 17. Do not weaken or change an already-applied migration to work around this test mismatch. Supabase tests remain pending.

## P2 — Cloudflare Hyperdrive

Wrangler authentication is available. A temporary Neon Hyperdrive config was created with caching disabled and the Free default origin limit of 20; a temporary diagnostic Worker was deployed under Workers Free. Neither project credentials nor the connection URL are in source. The repo's PR #138 placeholder config was not modified. The temporary Worker and Hyperdrive config were deleted after testing. Hyperdrive is included in Workers Free; the Free plan limit is 100,000 database statements/day.

For each provider, use the **direct/unpooled** database URL as the Hyperdrive origin. Cloudflare's provider guides recommend direct PostgreSQL URLs for both Neon and Supabase, because Hyperdrive supplies the connection pool. Hyperdrive transaction-pools and does not support session-level advisory locks; keep migrations on a separate direct connection. The Neon migrator lock was verified on direct connections, never through Hyperdrive.

Neon Worker observations (Cloudflare ray edge `SIN`; no global-latency claim):

- The temporary Worker created and closed a `pg.Client` per request. Repeated calls reused backend PIDs, showing Hyperdrive returned origin connections to its pool after `client.end()`.
- The first Worker query took about 4.96 seconds, but its preceding idle duration was not controlled, so this is not a scale-to-zero wake measurement. Subsequent simple queries were 9–60 ms inside the Worker. The HTTP round trip from this environment was about 0.5–0.6 seconds on those warm samples.
- Twenty-four concurrent transaction/advisory-lock requests all returned successfully; 17 acquired the same transaction lock and 7 correctly observed it held by another request.
- Twenty-four concurrent 1-second `pg_sleep` requests all returned successfully in 2.70 seconds and used 20 distinct backend PIDs, matching the Free origin limit. The extra elapsed time is consistent with requests waiting for pooled connections.
- After about 13 minutes with no Worker or direct DB requests, the Neon Branches page showed compute `Idle` and “Compute last active” at about 13 minutes. The first Worker query afterward succeeded with 1.09 seconds measured inside the Worker and 1.66 seconds total HTTP time.
- Controlled pooled-idle check: after a Worker query, no Worker or direct DB request was sent for about 7.5 minutes. The Neon console showed `Idle` before Hyperdrive's 10-minute idle-connection timeout. The first Worker request afterward succeeded in 640 ms inside the Worker and 1.96 seconds total HTTP time. This is live evidence that an idle Hyperdrive origin connection did not prevent Neon Free from suspending during the observed interval; the wake sample came from this test network and is not a global latency result. A second independent sample produced the same result: the console showed `Idle` after 6 minutes 19 seconds, before the 10-minute pool timeout; the next Worker query resumed in 611 ms inside the Worker and 1.34 seconds total HTTP time.

## P3 — Capacity and cost model

These are workload estimates, **not measured provider bills**. Registered users are not used as a direct cost multiplier.

Assumptions:

- DAU = 20% of MAU; MAU = 50% of registered users (10% registered users become DAU).
- 10 user messages per DAU per day.
- Budget 10 PostgreSQL statements per user message (conservative allowance for the B1 path).
- Store 4 KiB per interaction, including two message rows and estimated row/index overhead. This is unmeasured.
- Transfer 20 KiB per user message across database responses. This is unmeasured and excludes larger transcript reads.
- Peak concurrent requests = 5% of DAU, rounded up.

| Registered users | DAU | Messages/day | SQL statements/day | Storage growth/month | DB egress/month | Estimated peak concurrent requests |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1 | 10 | 100 | ~1.2 MB | ~6 MB | 1 |
| 100 | 10 | 100 | 1,000 | ~12 MB | ~60 MB | 1 |
| 1,000 | 100 | 1,000 | 10,000 | ~120 MB | ~0.6 GB | 5 |
| 10,000 | 1,000 | 10,000 | 100,000 | ~1.2 GB | ~6 GB | 50 |

Estimated database growth is about 14.6 MB, 146 MB, 1.46 GB, and 14.6 GB per year for those rows, respectively. At 10,000 registered users, the model reaches the Cloudflare Hyperdrive Free allowance of 100,000 SQL statements/day with no headroom and estimates 50 concurrent requests; plan an upgrade before the model reaches that limit (an 80,000 statement/day operating threshold leaves 20% headroom). Hyperdrive currently documents about 20 origin DB connections per config on Workers Free and 100 on Paid; the Neon Free test observed 20 under 24 concurrent long queries. Workers Paid starts at $5/month; confirm exact current account pricing before upgrading.

| Scale | Free-plan fit under this model | Upgrade trigger / illustrative monthly cost |
| --- | --- | --- |
| 10 users | Both providers fit the modeled storage and transfer. Neon can suspend after 5 idle minutes; Supabase Free pauses after a week of inactivity. Plan compute capacity and pause behavior are not yet load-tested. | Database plan cost $0 while within Free limits. Keep synthetic-data exports because neither Free plan gives an Alpha-grade recovery commitment. |
| 100 users | Modeled 12 MB/month and 60 MB/month egress fit both storage and transfer allowances. Free capacity stability is not yet proven; provider compute, connections, and peak load still need measurement. | $0 in plan allowance, subject to the workload staying within limits. |
| 1,000 users | Modeled 120 MB/month and 0.6 GB/month egress. Supabase's 500 MB database limit is reached in about 4 months; Neon Free's 1 GB limit in about 8 months, assuming constant growth and no other data. | Supabase Pro starts at $25/month and includes one Micro compute, 8 GB database disk, 250 GB egress, and daily backups retained 7 days. Neon Launch has no minimum monthly charge; at 0.25 CU active 8 h/day, compute is about $6.36/month plus ~$0.04 for 120 MB storage (~$6.40 total). Supabase Pro starts at $25/month, including compute credits for one Micro instance. These are pricing formulas, not measured usage. |
| 10,000 users | Modeled first-month storage growth (~1.2 GB) exceeds either Free database limit. Modeled 6 GB of direct, uncached DB egress exceeds Neon Free's 5 GB and Supabase Free's 5 GB origin-egress allowance (Supabase separately includes 5 GB cached egress). Hyperdrive Free's 100,000 statement/day allowance is reached, and estimated peak concurrency is 50. | Neon Launch example: at 0.25 CU for 8 h/day, about $6.36 compute plus $0.42 storage at 1.2 GB in month one (~$6.78), rising to ~$11.47/month at 14.6 GB after a year. At 24 h/day, about $19.08 compute plus storage (~$19.50 first month; ~$24.19 at year end). Add Workers Paid at $5/month: combined Neon/Cloudflare is about $11.78/month for month one at 8 h/day or $24.50 for month one at 24 h/day; after a year, about $16.47 or $29.19 respectively, before overages. Supabase Pro is $25/month before compute changes; 14.6 GB at year end is ~$0.83/month over the included 8 GB, or about $25.83 database total. Add the same $5 Worker base (~$30.83 total). A larger Supabase compute may be needed if measured load exceeds Micro. Budget for Workers Paid before 100,000 statements/day or sustained concurrency approaches the observed 20-connection Free cap. |

The Neon estimate excludes restore-history/snapshot storage above included allowances, taxes, and transfer above allowance. Supabase PITR starts at an additional $100/month; it is not included in the Pro base estimate. Hyperdrive/Worker pricing is subject to the account's plan and current Cloudflare pricing. Data export, cutover downtime, and restore cost depend on actual database size and remain unmeasured. Neon Launch includes 500 GB public transfer/project, then $0.10/GB; Supabase Free includes 5 GB uncached egress plus 5 GB cached egress. Neon Launch restore history beyond the included window is $0.20/GB-month, and manual snapshot storage is $0.09/GB-month.

## P4 — Backup and recovery

Neon synthetic-data drill completed: custom-format `pg_dump` produced a 296,158-byte archive; `pg_restore --exit-on-error` into local PostgreSQL 17.11 completed in 0.37 seconds. Migration, tenant, principal, agent, conversation, message, nonce, and marker counts matched source to restore (17 migrations and three synthetic conversations/messages). All migration rows matched between source and restore; normalized schema dump matched the exact-HEAD local migrations. This validates a portable logical export/restore path, not Neon PITR. To reproduce with test-only data, use `pg_dump --format=custom --no-owner --no-privileges --file=synthetic.dump "$DATABASE_URL"`, then `pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" synthetic.dump` and compare row counts plus checksums. Supabase export/restore remains pending project creation.

Plan-level baseline (verify against the linked current plan terms before choosing):

| Provider / plan | Automatic backup and recovery baseline |
| --- | --- |
| Neon Free | Instant restore with a 6-hour history window capped at 1 GB of changes, plus one manual snapshot; scheduled backup schedules are paid-plan only. This is not a tested restore result. |
| Neon Launch | Up to 7 days of history; history/snapshot storage and scheduled backup configuration affect cost. A restore exercise is still required. |
| Supabase Free | No automatic database backup; Free project inactivity pause may interrupt an Alpha service. Use a scheduled external `pg_dump` to encrypted storage if choosing Free. |
| Supabase Pro | Daily backups retained 7 days; PITR is a paid add-on starting at $100/month. Restore time and data-loss window have not been measured. |

## Risks and open items

1. The Neon role password was pasted into the chat by the user and must be rotated after testing. Do not repeat or publish the value. All URLs, IDs, and credentials must stay out of Git, CI logs, PR comments, and screenshots.
2. Neon lease-claim concurrency is not validated at 32 simultaneous direct claims: 14/32 timed out, while 16/16 passed. The transaction-wait observer did not see the expected `pg_stat_activity` lock state, even with a 10-second window; the foreign-key rejection occurred after about 3 seconds. Keep both as unresolved Neon Free risks.
3. Supabase project creation, PG version, migrations, business tests, Hyperdrive, TLS, role, backup, and restore remain pending the user's password entry and Create action.
4. Neon TLS client-to-endpoint is confirmed; the `pg_stat_ssl` discrepancy needs provider-aware interpretation. The role's table-level privileges are verified by catalog queries, but login as that role remains untested.
5. The user specified a global audience. Singapore is only the matched test region; the single SIN edge result does not determine production database placement.
6. The current PR #138 migration integration test asserts 16 migrations in four places although exact HEAD contains 17. Agent C should update the test expectations and add a `0017` assertion on its own Draft PR.
7. The cost model underestimates storage if real message payloads, indexes, attachments, or transcript reads are larger than the assumptions. Compute-hour estimates need measured load.
8. The automatic-exposure control in the Supabase form may be disabled while Data API is off; verify the created project's grants and roles before use.

## Official plan and integration references

- [Neon plans and pricing](https://neon.com/docs/introduction/plans), [backup and restore](https://neon.com/docs/guides/backup-restore), [scale-to-zero](https://neon.com/docs/introduction/scale-to-zero), [Neon Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/).
- [Supabase pricing](https://supabase.com/pricing), [billing and project limits](https://supabase.com/docs/guides/platform/billing-on-supabase), [Free project pause](https://supabase.com/docs/guides/platform/free-project-pausing), [database backups](https://supabase.com/docs/guides/platform/backups), [PostgreSQL connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/).
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/), [transaction pooling and advisory locks](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
