# Ember Alpha PostgreSQL Service Validation — Neon vs Supabase

**Status:** P0–P4 complete; recommendation ready for CTO review. **Evidence date:** 2026-11-08. **Current PR #138 HEAD:** `b090dffd39336a7374a2febb8a8f32077f384ce5`; Neon behavior probes ran at `7385bb18d791c4265ae1c53b618776cd61c07002`. The intervening PR diff contains no changes under `migrations/`, `packages/postgres/`, or `tests/integration/`; both providers were tested against the exact current migration source.

## Final recommendation

**Choose Neon for Ember Alpha**, using a direct/unpooled PostgreSQL origin behind Cloudflare Hyperdrive for runtime traffic and a separate direct connection for migrations. Both providers passed the PostgreSQL 17.11 migration and core compatibility checks, but Neon is the stronger low-cost starting point for this workload: the live Neon branch suspended while Hyperdrive was idle, then resumed on the next request; Free includes 1 GB storage, 100 CU-hours/month, 5 GB public transfer, a 6-hour/1 GB instant-restore window, and one manual snapshot. Supabase Free passed compatibility too, but it has no automatic project backup, a 500 MB database quota, pauses after a week of low activity, and this live test still observed five idle Hyperdrive origin connections after 11 minutes.

The CTO direction remains Cloud-native, Cloudflare-first, pay-as-you-grow. Keep PostgreSQL and Ember's existing `DATABASE_URL` and business contracts; no application rewrite is indicated. The user confirmed a global audience. Both test projects were placed in Singapore only for a matched comparison; this is not a production-region recommendation. The available measurements describe this test path, not global user latency.

Start Alpha on Neon Free while the measured workload stays inside its 100 CU-hour, 1 GB storage, and 5 GB transfer allowances; keep a scheduled encrypted logical export because the Free snapshot/history is not a complete backup strategy. Move to Neon Launch when measured or forecast usage exceeds Free limits, or when production needs its 16-CU ceiling and up to 7-day history. At the modeled 10,000 registered users, storage grows by about 1.2 GB/month and Hyperdrive reaches 100,000 statements/day with no headroom, so plan for a paid Neon/Workers configuration before that point. Reassess Supabase Pro if its integrated platform or fixed-capacity behavior becomes a product requirement and its backup/restore price is acceptable. Do not choose Supabase Free for production user conversations without an independently operated backup path.

Paid transition is usage-based: current Neon Launch rates are $0.106/CU-hour and $0.35/GB-month with no monthly minimum; at the modeled 0.25 CU for 8 hours/day, compute is about $6.36/month before storage, restore history, and transfer. Cloudflare Workers Paid starts at $5/month; no paid resource was created during this validation. Upgrade Cloudflare before approaching roughly 80,000 Hyperdrive statements/day or the observed Free connection ceiling, leaving 20% statement headroom. Consider Supabase Pro at $25/month for daily backups retained 7 days; PITR is a further $100/month for 7 days. These are current published rates, not observed bills.

## Exact-HEAD and local baseline

| Check | Result |
| --- | --- |
| PR #138 source | Current remote HEAD is `b090dffd39336a7374a2febb8a8f32077f384ce5`. Neon database behavior probes used `7385bb18d791c4265ae1c53b618776cd61c07002`; a diff to current HEAD confirms no changes to migrations, `packages/postgres/`, or `tests/integration/`. |
| Migration history | `migrations/0001`–`0016` are byte-for-byte unchanged against `main`. No historical migration semantics were edited. |
| PR #138 migration `0017_apple_nonce_replay.sql` | SHA-256 `bd8f88e89d3178e5472c4af03e3b719a7a2c51c09406fb9bbf822bec2d35d169`; this matches the checksum stored by the local PG run and is unchanged at current PR #138 HEAD. |
| Local PostgreSQL | Homebrew PostgreSQL 17.11. This is a local baseline, not provider evidence. |
| Migration runner, first run | 17 applied, 0 already applied. |
| Migration runner, second run | 0 applied, 17 already applied. |
| Provider checksums | All 17 Neon and all 17 Supabase `(id, name, checksum)` rows match the exact-HEAD migration files byte-for-byte. |
| Normalized schema diff | Neon vs local PostgreSQL 17.11 matched for `public` and `ember_private` (SHA-256 `48956655484740217b1460de413a2ce973a59a469ee1eeaee1f2446245500f11`). Supabase vs local also matched for `public` and `ember_private` (SHA-256 `8db09073a072ea0115feee6ab4a156431ab1bb0457eead493356567d4f39eded`). |
| Unit tests | Exact current PR #138 HEAD: 86 files, 1,500 tests passed with the repository's local Vitest CLI. The `pnpm` wrapper could not run because installed pnpm 11.25.0 is below the repository's `>=12.0.0` engine requirement. |
| Build | `pnpm build` passed. |
| Integration suite | 47 files, 546 tests: 542 passed; 4 failed only because `tests/integration/migrations.test.ts` still hard-codes 16 migrations at lines 125, 257, 327, and 499. With `0017`, the expected count is 17. This stale assertion is also relevant to the provider runs and has been shared with Agent C on PR #138. |

The provider projects are isolated test resources and must contain synthetic data only. No production database has been connected or migrated, and no paid database resource has been created.

## P0 — Real projects and migrations

| Provider | Project/setup | Engine version | Migration state |
| --- | --- | --- | --- |
| Neon | One Neon Free project in Singapore, PostgreSQL only; `ember_test` database and `ember_test_owner` role; direct/unpooled endpoint. Singapore is only for a matched provider comparison. | Server reports PostgreSQL `17.11 (9045acd)`. | Exact PR #138 migrations 0001–0017 applied; first run 17 applied, second run 0 applied/17 already. Migration 0017 stored SHA-256 matches exact-HEAD source. Normalized `public` and `ember_private` schema diff matches local PG17.11; all 17 provider checksums match exact-HEAD files. |
| Supabase | One approved Free project `ember-issue132-supabase-free` in Singapore, Data API disabled. The creation UI had no version selector. | Direct TLS connection and authenticated SQL report PostgreSQL 17.11. | Exact PR #138 migrations 0001–0017 applied; first run 17 applied, second run 0 applied/17 already. All 17 provider checksums match exact-HEAD files. Normalized `public` and `ember_private` schema diff matches local PG17.11. |

Both providers were reached through direct/unpooled PostgreSQL TLS connections. All migrations from current PR #138 were applied on each provider: 17 on the first run and 0 applied/17 already applied on the second. Every stored `(id, name, checksum)` matches the exact-HEAD files. Normalized `public` and `ember_private` schema dumps match local PostgreSQL 17.11. The migrator uses session-level `pg_advisory_lock`; run migrations only over a separate direct connection, never through transaction-pooling Hyperdrive. No paid IPv4 add-on was enabled.

`0017` adds `ember_private.apple_identity_nonce_replays` with a unique SHA-256 nonce digest. It is additive and does not expose raw nonces or identity tokens. Its exact-HEAD checksum is `bd8f88e89d3178e5472c4af03e3b719a7a2c51c09406fb9bbf822bec2d35d169`; both providers applied it and the replay uniqueness check passed.

## P1 — Ember behavior and security

Neon was tested against exact PR #138 HEAD with synthetic data. The passing `b1-message-write-runtime` suite covered Conversation/Message persistence, tenant isolation, idempotent replay, transaction rollback, and concurrent duplicate submissions. The Apple nonce replay race passed on rerun. Results:

- `b1-message-write-runtime` passed: Conversation/Message persistence, tenant isolation, idempotent replay, transaction rollback, and concurrent duplicate submissions. Lease fencing, lease recovery, and the advisory-lock barrier also passed.
- The six-file integration group completed 59/61 tests; four files passed. One failure was a fixed 2-second `pg_stat_activity` lock-wait assertion. A targeted rerun with a 10-second observer still did not see the expected waiter; it returned the expected `23503` foreign-key rejection after about 3 seconds.
- The lease-claim file failed one 16+16 concurrent-claim scenario with sanitized `DB_UNAVAILABLE`. A follow-up with sequential synthetic task creation passed 16/16 simultaneous claims in 6.37 seconds; at 32 claims, 18/32 succeeded and 14 were classified as timeouts. The test connection config applies a 5-second `statement_timeout`; the exact failing SQL diagnostics were not retained.
- A direct SQL pool ran 24 concurrent queries successfully. The exact Apple nonce replay store accepted one of two concurrent uses and returned replay=false for the other; an initial probe had one transient sanitized failure, but the complete rerun passed. Synthetic nonce rows were deleted after each probe.
- A direct session-level advisory-lock probe held migrator key `8675309`; the exact-HEAD migrator waited, then finished with 17 already applied and 0 applied after unlock. Keep migrations on direct/unpooled PostgreSQL.
- Direct `pg_terminate_backend` recovery succeeded: the checked-out client failed as expected, and the pool issued a successful query again about 2.2–2.7 seconds later. This models backend termination, not a full network partition.
- `psql` confirmed TLS to the direct Neon endpoint. The same backend's `pg_stat_ssl` row reported `false`; proxy-side TLS semantics remain unresolved. The PR #138 role script created `ember_worker` but failed at `ALTER ROLE ... NOSUPERUSER`, which Neon denies to a non-superuser admin. Applying its table grants separately succeeded. Catalog checks confirmed a non-superuser role without CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS; no public-schema CREATE; expected B1 table privileges; and no task or migration-table access. The admin could not `SET ROLE ember_worker`, so password-authenticated login was not tested. The test role and grants were dropped after inspection.

The PR #138 full integration suite has four stale assertions expecting 16 migrations although current HEAD contains 17. Do not weaken or change an already-applied migration to work around this test mismatch. The Supabase targeted suites passed as recorded below.

Supabase P1 results, using synthetic data and PostgreSQL 17.11:

- Targeted `b1-message-write-runtime` cases passed: Conversation/Message persistence, tenant isolation, idempotent replay, and one message/turn under a racing duplicate submission (4 passed; 11 unrelated cases skipped).
- Targeted lease tests passed: one winner across two independent workers and successful completion of 24 concurrent lease claims (2 passed; 7 unrelated cases skipped; 24-claim case took 7.5 seconds).
- Six conversation invariants passed after increasing the integration hook timeout to 120 seconds. The default 2-second `pg_stat_activity` lock-observer case timed out once under this cross-region path; direct advisory-lock serialization passed separately. Treat that test's fixed wait window as unresolved test sensitivity, not evidence that PostgreSQL locking is incompatible.
- The Apple nonce unique constraint rejected a duplicate synthetic digest with SQLSTATE `23505`; the test digest was deleted. Transaction rollback succeeded. The direct migration lock serialized two sessions using key `8675309`.
- TLS was verified both by the authenticated direct connection and by the Worker query's `pg_stat_ssl` result. The project reports `max_connections=60`; the test suite's 24-claim concurrency completed successfully.
- The PR #138 `ember-worker-role.sql` script fails on its `ALTER ROLE ... NOSUPERUSER` statement with SQLSTATE `42501` because Supabase reserves that operation to its own superuser. Creating the login role with default non-admin flags, then applying the script's grants and timeouts while omitting that `ALTER ROLE`, succeeded. Login checks showed SELECT permitted, DDL denied, `schema_migrations` denied, and ungranted DELETE denied; `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, and `BYPASSRLS` are all false, with `NOINHERIT`.
- Cleanup: the managed admin also denied `DROP OWNED BY ember_worker`. Revoking the test role's table, sequence, function, schema, and database privileges explicitly allowed its removal. The temporary export schema and role were removed; business-table and nonce counts are zero, while the 17 migration rows remain.
- Direct `pg_terminate_backend` caused the test client to disconnect and a new direct pool query succeeded in 2.567 seconds. Separately, terminating a Hyperdrive backend recovered on the next Worker request in 409 ms. These are server-side backend termination tests, not a full client-to-provider network partition.

## P2 — Cloudflare Hyperdrive

Wrangler authentication is available. One temporary Hyperdrive config per provider used the direct PostgreSQL origin, disabled query caching, and a provider CA with `verify-full`; the Neon config used 20 origin connections and the Supabase probe used 5 to test the cap. A temporary diagnostic Worker was deployed under Workers Free. No project URL, certificate ID, or credential is in source. The PR #138 placeholder config was not modified. The temporary Workers, Hyperdrive configs, and CA resource were removed after testing. Hyperdrive is included in Workers Free, with 100,000 database statements/day; a Free Worker has a 10 ms CPU limit. Explicitly setting `limits.cpu_ms=10` was rejected by Cloudflare Free (error 100328), so the test Worker used the Free default with no explicit CPU limit. No upgrade was made.

For each provider, use the **direct/unpooled** database URL as the Hyperdrive origin. Cloudflare's provider guides recommend direct PostgreSQL URLs for both Neon and Supabase, because Hyperdrive supplies the connection pool. Hyperdrive transaction-pools and does not support session-level advisory locks; keep migrations on a separate direct connection. The Neon migrator lock was verified on direct connections, never through Hyperdrive.

Supabase Worker observations (test runner location is not a production/global latency measurement):

- A temporary Worker with `pg` established and closed a client through Hyperdrive. It returned PostgreSQL 17.11 and `pg_stat_ssl.ssl=true`; one simple Worker query took 103 ms (2 ms connect, 103 ms query) and the client closed successfully. Eight sequential calls all passed and observed five distinct backend PIDs, consistent with Hyperdrive returning clients to its pool.
- Three Worker transactions using `pg_advisory_xact_lock` all committed over transaction pooling. Do not use session-level locks or run migrations through Hyperdrive.
- Twelve simultaneous `pg_sleep(2.2)` requests all returned HTTP 200. Supabase showed at most five `ember_worker` origin sessions (the configured cap); at most three were active in one sample. Maximum client-harness round trip was 13.51 seconds. This includes the test runner-to-Worker network path; it is not a global Worker latency or database-only benchmark.
- After the last Worker query, the owner connected directly to PostgreSQL every 45 seconds without touching Hyperdrive. At 11 minutes 18 seconds, Supabase still showed five idle `ember_worker` backends and zero active ones. The first Worker request then succeeded (4 ms connect, 113 ms query, 1.66 seconds total from this runner). Supabase remained queryable; this does not establish a Supabase sleep/resume cycle. It does show that this Hyperdrive pool retained five origin sessions beyond Cloudflare's documented 10-minute idle timeout.
- Cloudflare's Hyperdrive restart API returned success, but direct `pg_stat_activity` inspection did not observe the five origin sessions drain to zero within 20 seconds. Subsequent Worker health and transaction requests succeeded. A separate `pg_terminate_backend` test recovered on the next Worker request in 409 ms. This validates recovery from a terminated backend, not a full network partition.
- No actual Supabase Free one-week inactivity pause was tested. Its documented pause behavior is included in the plan comparison, not presented as a measured pause.

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

Estimated database growth is about 14.6 MB, 146 MB, 1.46 GB, and 14.6 GB per year for those rows, respectively. Neon Free currently includes 100 CU-hours, 1 GB storage, 5 GB public transfer, a 6-hour/1 GB restore window, and one snapshot. Supabase Free includes a 500 MB database quota, 5 GB uncached plus 5 GB cached egress, and pauses after a week of low activity. At 10,000 registered users, the model reaches the Cloudflare Hyperdrive Free allowance of 100,000 SQL statements/day with no headroom and estimates 50 concurrent requests; plan an upgrade before the model reaches that limit (an 80,000 statement/day operating threshold leaves 20% headroom). Hyperdrive documents about 20 origin DB connections per config on Workers Free and 100 on Paid; Neon reached 20 under 24 concurrent long queries, while the Supabase test config was capped at 5 and reached that cap. Workers Paid starts at $5/month.

| Scale | Free-plan fit under this model | Upgrade trigger / illustrative monthly cost |
| --- | --- | --- |
| 10 users | Both providers fit modeled storage and transfer. Neon suspends compute after 5 idle minutes in the live test; Supabase's 7-day Free pause was not exercised. | $0 in database plan allowance while under Free limits. Keep scheduled encrypted exports because neither Free plan provides an Alpha-grade backup commitment. |
| 100 users | Modeled 12 MB/month and 60 MB/month egress fit both Free quotas. Short compatibility/concurrency tests passed, but neither service was subjected to sustained workload or production SLO load testing. | $0 in plan allowance, subject to actual usage staying within limits. |
| 1,000 users | Modeled 120 MB/month and 0.6 GB/month egress. Supabase's 500 MB quota is reached in about 4 months; Neon Free's 1 GB limit in about 8 months, assuming constant growth and no starting data. | Supabase Pro starts at $25/month and includes a Micro compute credit, 8 GB database disk, 250 GB egress, and daily backups retained 7 days. Neon Free can cover the modeled 60 CU-hours/month at 0.25 CU for 8 h/day until a Free quota is reached. If using Launch, 0.25 CU for 8 h/day costs about $6.36/month plus ~$0.04 for 120 MB storage (~$6.40 total). These are pricing formulas, not measured usage. |
| 10,000 users | Modeled first-month storage growth (~1.2 GB) exceeds either Free database limit. Modeled 6 GB of direct, uncached DB egress exceeds Neon Free's 5 GB and Supabase Free's 5 GB origin-egress allowance (Supabase separately includes 5 GB cached egress). Hyperdrive Free's 100,000 statement/day allowance is reached, and estimated peak concurrency is 50. | Neon Launch example: at 0.25 CU for 8 h/day, about $6.36 compute plus $0.42 storage at 1.2 GB in month one (~$6.78), rising to ~$11.47/month at 14.6 GB after a year. At 24 h/day, about $19.08 compute plus storage (~$19.50 first month; ~$24.19 at year end). Add Workers Paid at $5/month: combined Neon/Cloudflare is about $11.78/month for month one at 8 h/day or $24.50 for month one at 24 h/day; after a year, about $16.47 or $29.19 respectively, before overages. Supabase Pro is $25/month before compute changes; 14.6 GB at year end is ~$0.83/month over the included 8 GB, or about $25.83 database total. Add the same $5 Worker base (~$30.83 total). A larger Supabase compute may be needed if measured load exceeds Micro. Budget for Workers Paid before 100,000 statements/day or sustained concurrency approaches the observed 20-connection Free cap. |

The Neon estimate excludes restore-history/snapshot storage above included allowances, taxes, and transfer above allowance. Supabase PITR starts at an additional $100/month; it is not included in the Pro base estimate. Hyperdrive/Worker pricing is subject to the account's plan and current Cloudflare pricing. Data export, cutover downtime, and restore cost depend on actual database size and remain unmeasured. Neon Launch includes 500 GB public transfer/project, then $0.10/GB; Supabase Free includes 5 GB uncached egress plus 5 GB cached egress. Neon Launch restore history beyond the included window is $0.20/GB-month, and manual snapshot storage is $0.09/GB-month.

## P4 — Backup and recovery

Neon synthetic-data drill completed: custom-format `pg_dump` produced a 296,158-byte archive; `pg_restore --exit-on-error` into local PostgreSQL 17.11 completed in 0.37 seconds. Migration, tenant, principal, agent, conversation, message, nonce, and marker counts matched source to restore (17 migrations and three synthetic conversations/messages). All migration rows matched between source and restore; normalized schema dump matched the exact-HEAD local migrations. This validates a portable logical export/restore path, not Neon PITR. To reproduce with test-only data, use `pg_dump --format=custom --no-owner --no-privileges --file=synthetic.dump "$DATABASE_URL"`, then `pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" synthetic.dump` and compare row counts plus checksums.

Supabase synthetic-data drill completed: a custom-format `pg_dump --no-owner --no-acl` archive was 154,351 bytes (SHA-256 `e3baa7aa28e46ba98c73f062886fbfb3119c1d000f469a873ce7f263215d8ced`). It restored into local PostgreSQL 17.11; all 17 migration rows and the one synthetic message matched. The temporary remote export schema was isolated from the Ember public tables. This validates the logical export/restore path, not provider PITR.

Supabase's live backup UI was inspected on the Free project: the Scheduled backups page says Free does not include project backups and Pro provides daily backups retained up to 7 days. The Point in time page identifies PITR as a Pro add-on starting at $100/month for 7 days; restoring to a new project requires Pro and physical backups. No upgrade was selected. The Free project's overview showed no automatic backup. Use scheduled encrypted external `pg_dump` exports if selecting Supabase Free.

Plan-level baseline (verify against the linked current plan terms before choosing):

| Provider / plan | Automatic backup and recovery baseline |
| --- | --- |
| Neon Free | Plan includes a 6-hour history window capped at 1 GB of changes plus one manual snapshot. Neon compute suspension and wake were observed live; logical export/restore was tested. The snapshot/history features themselves were not used as a restore drill. |
| Neon Launch | Up to 7 days of history; history/snapshot storage and scheduled backup configuration affect cost. A restore exercise is still required. |
| Supabase Free | Live dashboard evidence: no project backups on Free; the overview has no backup and Scheduled backups is unavailable. Free projects pause after one week of low activity, according to the plan terms; this pause was not observed in the test. Use a scheduled external `pg_dump` to encrypted storage if choosing Free. |
| Supabase Pro | Daily backups retained 7 days; PITR is a paid add-on starting at $100/month for 7 days. Provider backup restore time and data-loss window were not measured. |

## Risks and open items

1. Rotate test-owner credentials before reusing either project. No database URL, password, certificate ID, or token is included in this report.
2. Neon lease-claim concurrency is not validated at 32 simultaneous direct claims: 14/32 timed out, while 16/16 passed. The transaction-wait observer did not see the expected `pg_stat_activity` lock state, even with a 10-second window; the foreign-key rejection occurred after about 3 seconds. Keep both as unresolved Neon Free risks.
3. Supabase Free's one-week inactivity pause was not exercised. This test observed five idle Hyperdrive origin backends after 11 minutes, despite Cloudflare's documented 10-minute idle timeout; the Cloudflare restart API also did not make those sessions drain within 20 seconds. This discrepancy needs a longer or provider-assisted investigation before using idle pool behavior as a cost guarantee.
4. Neon TLS client-to-endpoint is confirmed; the `pg_stat_ssl` discrepancy needs provider-aware interpretation. The Supabase worker role was password-authenticated and least-privilege checks passed; Neon role login remains untested because Neon denied `SET ROLE` to its admin.
5. The user specified a global audience. Singapore is only the matched test region; the single SIN edge result does not determine production database placement.
6. The current PR #138 migration integration test asserts 16 migrations in four places although exact HEAD contains 17. Agent C should update the test expectations and add a `0017` assertion on its own Draft PR.
7. The cost model underestimates storage if real message payloads, indexes, attachments, or transcript reads are larger than the assumptions. Compute-hour estimates need measured load.
8. This is a synthetic-data compatibility and bounded-concurrency test, not a sustained-load, formal availability, or global-region performance assessment. The probe's 12-request Supabase maximum round trip was 13.51 seconds; investigate before setting Alpha latency targets.

## Official plan and integration references

- [Neon plans and pricing](https://neon.com/docs/introduction/plans), [backup and restore](https://neon.com/docs/guides/backup-restore), [scale-to-zero](https://neon.com/docs/introduction/scale-to-zero), [Neon Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/).
- [Supabase pricing](https://supabase.com/pricing), [billing and project limits](https://supabase.com/docs/guides/platform/billing-on-supabase), [Free project pause](https://supabase.com/docs/guides/platform/free-project-pausing), [database backups](https://supabase.com/docs/guides/platform/backups), [TLS enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), [PostgreSQL connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/).
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/), [transaction pooling and advisory locks](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
