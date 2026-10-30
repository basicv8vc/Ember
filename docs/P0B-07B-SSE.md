# P0B-07b — Durable Task Event SSE

## Design

`GET /v1/tasks/:taskId/stream` reuses the authenticated, tenant-scoped `TaskStore`. PostgreSQL `task_events` remains the sole event authority: every read is ordered by persisted `sequence` and uses the existing exclusive `sequence > after` page query. There is no process-local event counter, broker, or second event log.

Before returning `text/event-stream`, the handler validates the task ID and resume cursor, verifies task visibility for the authenticated tenant, and reads and validates the first page. Missing and cross-tenant tasks both return 404. Missing or invalid credentials are rejected by `/v1` auth middleware before the route reads a task or starts a stream. An initial EventStore or DTO-contract failure remains an ordinary sanitized HTTP error.

Each task event is sent as an SSE `event: task` frame. Its `id` is the persisted sequence, and its `data` is the existing `TaskEventDto` JSON produced by `toTaskEventDto`; the shared strict schema and payload allowlist apply unchanged. A `: keep-alive` comment is emitted on the heartbeat schedule. Comments have no `id` and do not advance the event cursor.

The initial page and every later page use the fixed `MAX_EVENTS_PER_PAGE` bound. A full page is immediately followed by another exclusive-cursor read, so replay drains all available history before waiting for the next poll. A partial page ends the current catch-up pass. Events committed while replay is in progress remain eligible for a later page or poll. Pages are checked for the requested task, safe sequence values, and strict increase before any event is sent.

## Resume cursor rules

- With neither cursor, streaming starts after sequence `0`.
- `?after=N` alone resumes exclusively after `N`.
- `Last-Event-ID: N` alone resumes exclusively after `N`.
- If both are present, they must be the same value; a mismatch returns `400 INVALID_ARGUMENT` before a task lookup.
- Cursor values are one to fifteen decimal digits representing a non-negative safe integer. Empty, repeated `after` parameters, signed, fractional, non-decimal, and oversized values return 400.

The server does not promise exactly-once delivery across a broken network. It provides ordered, resumable delivery: clients reconnect using the last event ID they actually processed, and the exclusive database cursor replays any later event. A reconnect may replay an event if the client received bytes but did not persist its cursor.

## Lifetime and failure behavior

The stream polls every 1,000 ms by default and sends a heartbeat every 15,000 ms. Both intervals, the monotonic clock, and the abortable wait are injectable through `createTaskRoutes` for deterministic tests. A terminal task is replayed through its final persisted event and then the stream closes. A client disconnect aborts its wait and stops future polls. On API shutdown, the process shutdown hook aborts registered stream loops, stops accepting requests, and closes remaining HTTP connections before ending the PostgreSQL pool. An already-running database query is allowed to settle; no subsequent poll is started after abort.

An EventStore failure after headers have been sent ends that connection without changing task state. The client can reconnect from its last received sequence because events remain durable. The regular `GET /events` endpoint remains available as a polling fallback.

## Coverage

| Area           | Coverage                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor parsing | Default zero, query cursor, Last-Event-ID, equal and conflicting dual cursors, duplicate query key, malformed and oversized values                                                                            |
| Replay         | More than two pages, persisted sequence order, append during catch-up, terminal task replay                                                                                                                   |
| Reconnect      | Cancel after a received event, reconnect from Last-Event-ID, no skipped or repeated processed sequence over multiple connections                                                                              |
| Security       | No/invalid token, cross-tenant 404 before event read, shared event DTO redaction contract                                                                                                                     |
| Lifecycle      | Heartbeat comment without cursor advance, client cancellation, shutdown abort, initial EventStore failure before SSE headers, production HTTP and pool shutdown                                               |
| Integration    | PostgreSQL-backed events transported through Hono and a real Node HTTP socket; multiple reconnections, a committed write during restoration, client socket abort, and production `SIGTERM` with pool shutdown |

## Known limits

Polling adds up to one poll interval of discovery latency and one database read per active stream per interval. This is the intended P0-B single-database approach; no external queue or notification service is required. Shutdown closes remaining HTTP connections after aborting SSE loops, so other accepted requests may be interrupted at the SIGTERM cutoff. If a database query is already in flight when a client disconnects or shutdown begins, the route stops scheduling further work and lets the PostgreSQL client query settle before the pool can finish closing.

## Verification record

The task started from `origin/main` commit `68cc45df9554851698ff550ea52f90349d0bb38f`. Commands and results are recorded here after implementation verification.

| Command                                                                                    | Result                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                        | PASS                                                                                                                                                                                              |
| `pnpm typecheck`                                                                           | PASS                                                                                                                                                                                              |
| `pnpm lint`                                                                                | PASS                                                                                                                                                                                              |
| `pnpm build`                                                                               | PASS                                                                                                                                                                                              |
| `pnpm test`                                                                                | Unit: 29 files / 523 tests passed. Integration setup failed because `TEST_DATABASE_URL` is unset; 17 suites could not connect (176 tests skipped), including this SSE integration file (6 tests). |
| `vitest run --config vitest.integration.config.ts tests/integration/http-task-sse.test.ts` | Blocked by missing `TEST_DATABASE_URL`; 6 test bodies were skipped. No Docker or local PostgreSQL executable/listener is available in this environment.                                           |

The exact SSE unit file passed separately with 15 tests. PostgreSQL transport behavior is covered in `tests/integration/http-task-sse.test.ts`, but remains unverified here until run with the repository's local integration database.

### CI verification for the original PR head

GitHub Actions run [#40977927904](https://github.com/basicv8vc/Ember/actions/runs/40977927904) completed successfully for PR #16 at `bba07cbdff306565f19d7bca03774c7c9444f354`. This is CI evidence from PostgreSQL 17 and complements the local environment record above; it does not indicate CTO approval or merge readiness.

| CI check                                      | Result                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit tests                                    | PASS — 29 files / 523 tests                                                        |
| PostgreSQL integration tests                  | PASS — 17 files / 174 tests                                                        |
| SSE PostgreSQL integration                    | PASS — 4 tests                                                                     |
| PostgreSQL migrations, first and repeated run | PASS — 5 applied on first run; 0 applied and 5 already applied on the repeated run |
| Lint / format / typecheck / build             | PASS                                                                               |

### CI verification after the P2 follow-up, before latest-main integration

GitHub Actions run [#40987136715](https://github.com/basicv8vc/Ember/actions/runs/40987136715) passed for PR #16 at `172a92cfca7e86ddc1b0553c812e94d0328bd856` on Node 24 and PostgreSQL 17. This is the final P2-follow-up run before integrating PR #15; it includes both requested Socket-level checks and all repository checks.

| CI check                                      | Result                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit tests                                    | PASS — 29 files / 523 tests                                                        |
| PostgreSQL integration tests                  | PASS — 17 files / 176 tests                                                        |
| SSE PostgreSQL / Node HTTP integration        | PASS — 6 tests, including client socket disconnect and production `SIGTERM`        |
| PostgreSQL migrations, first and repeated run | PASS — 5 applied on first run; 0 applied and 5 already applied on the repeated run |
| Lint / format / typecheck / build             | PASS                                                                               |

The first run of the new production SIGTERM test exposed an HTTP server close that remained pending after the SSE response ended. Shutdown now closes remaining HTTP connections after stopping new accepts and aborting SSE loops; this CI run verifies the API process exits successfully after both HTTP server and pool closure. This CI evidence supplements the original PR-head run above and does not indicate CTO approval or merge readiness.

### CI verification after integrating latest main

GitHub Actions run [#40997680451](https://github.com/basicv8vc/Ember/actions/runs/40997680451) passed on Node 24 and PostgreSQL 17 for integrated source commit `c7a3d11328dd28314b5165c6d1236f575b9415d3`, based on latest `main` commit `34c7fb8206c6d2c88bfe04f79669d6dfed2c8592` (PR #15). This run validates the combined Artifact HTTP and SSE routes; a documentation-only commit follows it and receives its own final-head CI run.

| CI check                                      | Result                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit tests                                    | PASS — 30 files / 531 tests                                                        |
| PostgreSQL integration tests                  | PASS — 18 files / 180 tests                                                        |
| SSE PostgreSQL / Node HTTP integration        | PASS — 6 tests, including client socket disconnect and production `SIGTERM`        |
| PostgreSQL migrations, first and repeated run | PASS — 5 applied on first run; 0 applied and 5 already applied on the repeated run |
| Lint / format / typecheck / build             | PASS                                                                               |
