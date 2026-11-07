# Cloudflare-first PostgreSQL API PoC

Status (2026-11-07): P0 implementation and local regressions are complete. Cloudflare CLI
authentication was verified read-only; no Worker, Hyperdrive config, database, or other remote
resource has been created. Remote deployment is blocked because Agent D's PR #139 reports no live
Neon/Supabase test database or connection yet. No CPU, latency, or billing data has been measured.

## CTO architecture decision

Ember starts with a cloud-native, pay-as-you-grow deployment. Cloudflare Workers is the first API
runtime candidate; PostgreSQL remains the source of truth and the existing B1 contracts,
repositories, and transactions stay intact. Supabase is the Issue #134 database baseline. Neon is
now included as a provider comparison, and AWS remains an allowed deployment and PostgreSQL option.

The architecture does not require a $0 ceiling. Free plans keep the first experiment inexpensive;
when real usage, reliability, or latency justifies paid capacity, the same API and PostgreSQL
contract can scale onto paid plans. Any new paid resource or plan requires prior approval. No billing
or deployment action is automated by this PoC.

Preliminary provider recommendation: run the first provider A/B on Supabase and Neon before
selecting production. Neon is a strong database-only candidate because Ember owns Apple identity and
does not use Supabase Auth or Storage in this Worker; its published launch plan is usage-priced.
Supabase remains the task baseline and can still be the better fit if its managed platform features,
regional placement, or observed performance outweigh the fixed plan floor. There is not yet a
measurement-based winner.

## Runtime boundary

`apps/api/src/cloudflare-worker.ts` builds the existing Hono API with the B1 session, conversation,
message, and turn routes backed by the existing PostgreSQL repositories. It uses `pg` through a
Cloudflare Hyperdrive binding. It does not import the Node HTTP listener, the main Postgres barrel,
the queue worker, migrations, local blob storage, or any model provider.

| Existing capability                                                                          | Worker decision                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/index.ts`: Node HTTP server, socket binding, process signals, filesystem paths | Excluded; Cloudflare supplies the `fetch` handler and lifecycle.                                                                         |
| `apps/worker/src/index.ts`: long-running poll/reaper loops, leases, task execution           | Excluded from the API Worker. It does not acquire or extend worker leases.                                                               |
| `@ember/postgres` main barrel: migrations, local blob storage, CLI, all repositories         | Excluded from the Worker bundle. The narrow `@ember/postgres/b1-worker` entry exports only the existing B1 repositories and pool.        |
| B1 `node:crypto`, `Buffer`, JOSE, `pg`                                                       | Included behind `nodejs_compat`; PostgreSQL sockets go through Hyperdrive. `pg@8.23.1` exceeds Cloudflare's documented minimum `8.16.3`. |
| Existing B1 SQL transactions, advisory locks, DTOs, error mapping                            | Reused unchanged. The B1 runtime uses transaction-level advisory locks, supported by Hyperdrive's transaction pooling.                   |

The Worker opens a one-connection `pg.Pool` per request and closes it through `waitUntil`;
Hyperdrive owns the cross-request pool. The `ember_worker` role supplies the 5 s statement timeout,
so the client does not send an undocumented per-session `options` startup value. Query caching must
be disabled for session checks, permission checks, and read-after-write paths. Hyperdrive supports both Neon and Supabase, and also
lists AWS RDS/Aurora as supported PostgreSQL providers. A future AWS-hosted API can keep the existing
Node listener and PostgreSQL repositories; no AWS adapter or service rewrite is needed for this PoC.

## Neon and Supabase comparison

Published plan limits checked 2026-11-07. Provider limits and pricing can change; recheck before
choosing a production plan.

| Dimension               | Supabase                                                                                                              | Neon                                                                                                                                             | Ember impact                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free database           | 500 MB database; 5 GB uncached plus 5 GB cached egress; free projects may pause after a week of low activity.         | 1 GB/project; 100 CU-hours/project/month; 5 GB public transfer; compute scales to zero after 5 minutes.                                          | Neon has more free storage; both free tiers can interrupt service at a limit or after inactivity.                                                                       |
| Paid path               | Pro starts at $25/month with 8 GB disk and $10 compute credits; higher egress and optional capacity are usage-priced. | Launch is usage-based with no monthly minimum; $0.106/CU-hour and $0.35/GB-month storage; 500 GB/project public transfer included.               | Neon may fit intermittent database-only traffic better; Supabase's base fee buys a broader managed platform. Cost winner depends on actual uptime, compute, and egress. |
| Cloudflare connectivity | Hyperdrive supported; use the direct PostgreSQL connection string and let Hyperdrive pool.                            | Hyperdrive supported; use an unpooled/direct PostgreSQL connection string and `pg`/Postgres.js, not Neon's serverless driver through Hyperdrive. | Same Worker binding, repository code, and B1 SQL; only the Hyperdrive origin connection and database bootstrap differ.                                                  |
| Database features       | Existing issue baseline; Supabase Auth/Storage are not used in this Worker.                                           | Database-first Postgres with branching; no provider-specific auth/storage is required by B1.                                                     | Prefer the provider based on observed latency, recovery, capacity, and total cost rather than replacing contracts.                                                      |

### Neon compatibility validation

| Check                                                                                                       | Result                      | Evidence / remaining work                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare supports Neon through Hyperdrive and recommends a direct connection with `pg`                    | Pass (documentation review) | Hyperdrive provider guide and Neon integration guide.                                                                                                                                                          |
| B1 transactions and locks fit Hyperdrive transaction pooling                                                | Pass (source review)        | B1 repositories use `BEGIN` plus `pg_advisory_xact_lock`; no session advisory lock, `LISTEN`, or `NOTIFY` is imported into the Worker entry. The migration runner's session lock is outside the Worker bundle. |
| Current migrations use PostgreSQL rather than Supabase Data API or service-role features                    | Pass (source review)        | Runtime accesses PostgreSQL directly; private nonce schema and grants are provider-neutral. The runtime role must be created using the provider's role UI/API where SQL role creation is restricted.           |
| Apply migrations and run B1 integration suites against Neon PG17 through Cloudflare Hyperdrive              | Blocked                     | Agent D's PR #139 reports that it did not create a live provider resource; the required PG17 test database is not available yet.                                                                               |
| Compare Supabase and Neon cold/warm p50/p95, retry/isolation behavior, statements, CPU, storage, and egress | Not run                     | Run the same B1 suite and request mix on both providers before choosing production.                                                                                                                            |

This is a positive compatibility review, not a live Neon validation. A passing source review does
not prove transaction-pool behavior, provider permissions, recovery, or production performance.

## Cost and expansion path

| Layer               | Low-cost starting point                                                                                                | Expansion without changing B1 contracts                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API compute         | Cloudflare Workers Free: 100,000 requests/day and 10 ms CPU per invocation; this config pins the CPU ceiling to 10 ms. | Workers Standard currently starts at $5/month with 10 million requests and 30 million CPU milliseconds included. Raise measured CPU limits when approved. Hyperdrive is included in both plans; its free database statement limit is 100,000/day and paid limit is unlimited. |
| PostgreSQL          | Compare Supabase Free and Neon Free on a disposable environment.                                                       | Upgrade the selected database on its existing provider; Neon Launch supports usage billing, while Supabase Pro removes inactivity pausing and raises included capacity.                                                                                                       |
| Alternative hosting | Keep Cloudflare first for this PoC.                                                                                    | AWS Lambda with the existing Node/Hono runtime and RDS/Aurora are valid future candidates if measured cost, compliance, region, or operational needs favor AWS.                                                                                                               |

Before approving a paid step, collect request volume, database statements per request, Worker CPU,
database compute/storage/egress, cold-start latency, and recovery requirements. Do not migrate
providers solely to avoid a quota that has not been reached.

## Security and product scope

- The public iOS app keeps using Ember's opaque `ems_` bearer token. Database credentials stay in
  Hyperdrive and server-side secrets; no Supabase service-role key is used by this Worker.
- Use the least-privilege `ember_worker` role in `infra/postgres/ember-worker-role.sql`. Create the
  role through the database provider's console/API first when role creation is restricted, then
  apply the grants as a database administrator. Set its credential out of band.
- `POST /v1/auth/session` keeps the existing Apple JWKS URL and verifier: RS256 signature, exact
  issuer and bundle audience, required `exp`/`iat`/`sub`/`nonce`, maximum assertion age, and
  nonce-hash binding. A Worker-only fence stores a SHA-256 nonce digest in
  `ember_private.apple_identity_nonce_replays` and rejects a second exchange. The raw nonce and
  Apple JWT are not stored.
- `provider: dev` is always hidden in the Cloudflare app. Legacy Task/Agent/Artifact routes use an
  empty authenticator and fail closed. There is no Fake Model responder. Message submission creates
  the existing running Turn; this PoC does not produce an assistant response. Model execution stays
  outside this branch at the PR #130 boundary and remains disabled until required approval exists.
- No D1 binding, schema copy, or data movement is introduced.

## Setup and validation

1. Apply migrations `0001`–`0017` to a disposable PostgreSQL 17 database. Keep any production
   database untouched. Create `ember_worker` via the provider control plane if needed, then apply
   `infra/postgres/ember-worker-role.sql` and set the role credential privately.
2. Create a Hyperdrive configuration from the database's direct/unpooled connection string. Use the
   `ember_worker` role and disable query caching. Keep the connection string out of source and
   Wrangler vars.
3. Replace the all-zero local placeholder in `apps/api/wrangler.jsonc` with an authorized
   Hyperdrive id. Do not add a Supabase service-role key, Apple private key, or model key to `vars`.
4. For local Wrangler testing, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in
   the shell to a disposable PostgreSQL database. This direct local connection does not exercise
   Hyperdrive pooling or caching. Never use a production database for local write tests.
5. With user-authorized disposable accounts, run the remote smoke on both Supabase and Neon and
   collect Cloudflare CPU/requests/statements, provider storage/egress, cold/warm latency, and error
   records. Paid plans or resources require prior approval.

| Requirement                                                                       | Local/source evidence                              | Remote evidence                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| Missing/forged Ember token returns 401; invalid Apple signature/claims return 401 | Existing B1 HTTP and Apple verifier tests          | Not run                          |
| Same verified Apple nonce creates at most one session                             | Worker nonce replay test                           | Not run                          |
| Tenant isolation; idempotent append; Unknown ACK; sanitized DB errors             | Existing B1 repository/API tests                   | Not run                          |
| `pg` bundle, transactions, and transaction-level advisory locks                   | Wrangler dry-run and source review                 | Hyperdrive run not yet performed |
| Neon/Supabase provider parity                                                     | PostgreSQL and Hyperdrive source review            | Neon and Supabase suites not run |
| 10 ms CPU and Free quotas                                                         | Config pins the 10 ms CPU limit; no measured value | Not run                          |

## Agent C deployment attempt (2026-11-07)

### Local validation

| Check                                                      | Result                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm test:unit`                                           | Pass — 86 files, 1,500 tests.                                               |
| `pnpm typecheck`                                           | Pass.                                                                       |
| ESLint on changed TypeScript files                         | Pass.                                                                       |
| Prettier on changed TypeScript/JSONC/Markdown files        | Pass.                                                                       |
| `pnpm --filter @ember/api build:worker` (Wrangler dry-run) | Pass — 1,323.88 KiB upload / 236.75 KiB gzip; no cloud deployment occurred. |

| Evidence                                                                                                                                                  | Result                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare CLI account auth                                                                                                                               | Verified read-only. Account identity is omitted from this evidence.                                                                                                                                                                                                       |
| Workers Free test deployment / `workers.dev` URL                                                                                                          | **NOT CREATED**; blocked on Agent D's disposable PostgreSQL 17 database and secure connection handoff.                                                                                                                                                                    |
| Hyperdrive test config ID                                                                                                                                 | **NOT CREATED**; no database connection details are available.                                                                                                                                                                                                            |
| PostgreSQL provider/version                                                                                                                               | **NOT VERIFIED**; Agent D's PR #139 reports local PostgreSQL 17.11 validation only, with no live Neon/Supabase resource.                                                                                                                                                  |
| Health/readiness, Apple API, session, conversation, message, Unknown ACK, tenant isolation, DB outage/recovery, remote concurrency and HTTP compatibility | **NOT VERIFIED remotely**. Local tests do not substitute for the requested cloud acceptance.                                                                                                                                                                              |
| Workers CPU and request P50/P95; Hyperdrive query latency; cold start/recovery; idle/low concurrency                                                      | **NOT VERIFIED**. The configured 10 ms CPU limit is a ceiling, not an observed CPU measurement; request wall time is distinct.                                                                                                                                            |
| Credentials, production data, DNS, paid plans/resources                                                                                                   | No credentials were added to GitHub; no production data or DNS was touched; no paid resource was created.                                                                                                                                                                 |
| Next action                                                                                                                                               | Agent D must provide the authorized PG17 Free test database through a secure credential path. Then apply migrations over a separate direct connection (never Hyperdrive), create one uncached Hyperdrive config, deploy one Worker, and run the remote acceptance matrix. |

## Current go/no-go

No live iPhone traffic until the authorized test database is provisioned and the Worker passes the
remote transaction, retry, recovery, tenant-isolation, latency, and CPU checks. This branch has not
yet met the real-cloud completion definition. The P0 does not force a $0 ceiling; any new paid
resource or plan remains gated on prior approval.

## References

- [Cloudflare Hyperdrive supported databases and PostgreSQL features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
- [Cloudflare Hyperdrive Neon connection guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)
- [Cloudflare Hyperdrive Supabase connection guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
- [Cloudflare Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Neon plans and limits](https://neon.com/docs/introduction/plans)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
