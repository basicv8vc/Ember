# B1 Cloud process E2E

`tests/e2e/b1-cloud-process-lifecycle.test.ts` checks the B1 conversation workflow through the executable API and Worker entry points. The test process creates a randomly named disposable database, applies the repository migrations, starts independent Node child processes, and sends application requests over loopback HTTP. It uses an explicitly enabled `dev` identity only with a `127.0.0.1` listener and `EMBER_ENV=test`. Direct SQL is limited to checking committed rows and setting deterministic expiry/outage conditions.

The suite covers Session provisioning/reuse, message persistence and reads, fake reply completion, process restart and pending-Turn recovery, idempotency/Unknown ACK, two-tenant 404 equivalence, cancellation, timeout, Session rejection, stale transcript epoch, database outage/recovery, and sensitive-log checks. It never imports route factories or calls application repositories for the behavior under test.

## Prerequisites and execution

- Node.js 24 and pnpm 12.
- A local PostgreSQL 17 endpoint reachable through `TEST_DATABASE_URL`. The role must create and drop databases and terminate sessions in databases it owns. The suite rejects non-loopback hosts and refuses to target `DATABASE_URL` implicitly.
- The PostgreSQL role and database supplied in `TEST_DATABASE_URL` are used only to create/drop the unique `ember_b1_e2e_<random>` database. Existing schemas and rows in the supplied database are not modified.

Install and run the focused suite with:

```sh
pnpm install --frozen-lockfile
TEST_DATABASE_URL='postgres://ember:<local-password>@127.0.0.1:55432/ember_test' \
  pnpm exec vitest run --config vitest.e2e.config.ts \
  tests/e2e/b1-cloud-process-lifecycle.test.ts
```

The existing CI workflow runs this file through `pnpm test:e2e` with its PostgreSQL 17 service. The suite reports the Node and PostgreSQL versions through the cluster fixture when diagnosing a run; it enforces PostgreSQL 17 before starting the application processes.

## Real process commands

The E2E harness starts these separate processes from the repository root, each with the disposable database URL and loopback-only test auth configuration:

```sh
node --import tsx apps/api/src/index.ts
node --import tsx apps/worker/src/index.ts
```

The API is health-checked over HTTP before test requests begin. The Worker must report its startup event and is observed through its durable effects in PostgreSQL and the API. Restart and cancellation cases signal the actual child process; the pending-Turn recovery case kills a paused Worker after the message/Turn transaction commits, then starts a fresh Worker against the same database.

## Runtime integration prerequisite

This suite is intentionally separate from B1 runtime composition code. At the starting revision `afa05e27681a5adeb67ba5cfcb6f90b8458a9b6e`, the API executable mounted the Session routes but not the Conversation message/Turn routes, and the Worker executable did not start the Fake Turn Responder. The process E2E checks must be run after those integrations are merged and this Draft PR is rebased onto that commit. The Draft must stay unmerged until the complete suite runs against the integrated runtime.
