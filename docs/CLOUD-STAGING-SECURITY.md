# Ember Cloud Staging — Security Review

Scope: the deployment surface introduced by `feature/cloud-staging-deployment`. It does not
review the application's domain logic, the Model Gateway (Agent A) or the iOS client (iOS
Lead).

Every claim below is tied to a file in this PR or to a check in
[CLOUD-STAGING-VERIFICATION.md](./CLOUD-STAGING-VERIFICATION.md).

---

## 1. Requirement → control map

| #   | Requirement                                                       | Control                                                                                                                                                                                                                             | Where                                                                           |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | PostgreSQL not exposed publicly                                   | no `ports:` on the `postgres` service; attached only to a network declared `internal: true`, so the container also has no route off-host                                                                                            | `infra/staging/compose.yaml`                                                    |
| 2   | No development Bearer token bypass                                | no `EMBER_DEV_AUTH_TENANT_*` may appear in the environment file — a violation, not a warning                                                                                                                                        | `infra/staging/scripts/preflight.mjs` (`E_DEV_TENANT_TOKEN`)                    |
| 3   | No insecure mock auth in a public environment                     | `EMBER_DEV_PROVIDER_ENABLED` / `_ISOLATED` must be false; the runtime gate additionally denies any listener that is not loopback, and denies `NODE_ENV=staging` outright                                                            | `preflight.mjs` (`E_DEV_PROVIDER`) + `apps/api/src/auth/dev-provider-policy.ts` |
| 4   | No leak of Apple tokens, sessions, provider keys or user messages | structured JSON logs carry route/status/request-id/codes only; the error boundary never reads `error.message`; the durability harness scans real process logs for a session token, a provider assertion, a nonce and a message body | §5 of the verification report                                                   |
| 5   | Restrict API port and network entry                               | API published on `127.0.0.1:${EMBER_API_HOST_PORT}` only; the public surface is the edge on 80/443                                                                                                                                  | `compose.yaml`, host security group                                             |
| 6   | Paid model calls disabled by default                              | no provider credential may exist in the environment (`E_PROVIDER_SECRET`); the Worker only has the deterministic executor; the simulated responder is refused                                                                       | `preflight.mjs`, `apps/worker/src/config.ts`                                    |
| 7   | E2B disabled by default                                           | any `*E2B*` variable is a preflight violation; staging runs no sandbox vendor                                                                                                                                                       | `preflight.mjs`                                                                 |
| 8   | No automatic production migration                                 | the `migrate` service is behind `profiles: [tools]`; `migrate.sh` requires `--confirm`; `deploy.sh` never migrates                                                                                                                  | `compose.yaml`, `migrate.sh`, `deploy.sh`                                       |
| 9   | Never touch Shua production resources                             | any environment value containing `shua` is a violation; the database host must be the compose service `postgres`; credentials come from this deployment's own SSM tree                                                              | `preflight.mjs` (`E_FOREIGN_ESTATE`, `E_DATABASE_HOST`)                         |

## 2. Authentication: what actually runs on staging

Staging has exactly one authentication path: a real Apple identity token, verified with
RS256 against Apple's JWKS, with the Ember bundle id as the audience
(`apps/api/src/auth/apple-identity.ts`). There is no decode-only path and no local key
override in the runtime composition.

The three development conveniences are all closed, by two independent layers:

| Convenience                         | Layer 1 (deployment guard)                   | Layer 2 (runtime gate)                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider: "dev"` sign-in           | must be `false`; any `true` fails the deploy | denied unless the _actual bound socket_ is loopback **and** `NODE_ENV` is not `production`/`staging` **and** an explicit isolated-environment opt-in is set. In a container the listener is `0.0.0.0`, so the path is unreachable by construction. |
| Legacy dev Bearer tokens on `/v1/*` | `EMBER_DEV_AUTH_TENANT_*` is a violation     | none — **this is residual risk R-2**                                                                                                                                                                                                               |
| Simulated turn responder            | must be `false`                              | refuses `production`/`staging` processes at startup                                                                                                                                                                                                |

The smoke suite asserts the outcome end to end against the running stack: `POST
/v1/auth/session` with `provider:"dev"` returns **404**, a forged Apple assertion returns
**401**, `/v1/me` without a token returns **401**, and a well-formed dev-style bearer token is
rejected on `/v1/agents` and `/v1/tasks`.

## 3. Credential handling

```text
AWS SSM (/ember/staging/secrets/POSTGRES_PASSWORD, SecureString)
        │  render-env.sh (root, on the host)
        ▼
/etc/ember/staging.env            0600 root   DATABASE_URL=postgres://…  + non-secret config
/etc/ember/secrets/postgres_password 0600 root  mounted as the Compose secret
        │
        ▼
container env (api, worker, migrate)   postgres reads POSTGRES_PASSWORD_FILE, never env
```

- No secret is committed: the template contains placeholders, and the guard rejects any value
  still containing `REPLACE_WITH`/`CHANGEME`/`PLACEHOLDER` (`E_PLACEHOLDER_VALUE`).
- `preflight.sh` refuses to run if the environment file (or the password file) is readable by
  group or other.
- The generated password is restricted to URL-safe characters so it cannot be silently
  altered by URL parsing (`E_DATABASE_ENCODING` rejects percent-encoding).
- `postgres` receives the password through a file, not through its environment, so it does not
  appear in `docker inspect`.
- Database logs and the startup log line print host/port/database only
  (`describeDatabaseTarget`); the connection string never reaches a log.

## 4. Network and container hardening

- `db` network is `internal: true`: no egress, no ingress from the host.
- `postgres` has no published port.
- `api` and `worker` run `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, with a
  `tmpfs` for `/tmp`, as UID/GID `10001` (created in the image).
- The edge disables the Caddy admin API, hides the `Server` header, sends HSTS, refuses to
  proxy unknown `Host` values, and caps request bodies at 2 MB.
- Image references are exact versions (`postgres:17.6-alpine`, `caddy:2.10.2-alpine`,
  `node:24.22.1-bookworm-slim`); the application images are installed strictly from
  `pnpm-lock.yaml` with `--frozen-lockfile`, and the build fails if any compiled entry point
  is missing.

## 5. Log redaction

What may be logged: request id, method, path, status class, duration, domain error codes,
counts, lease and budget metadata, `host/port/database`.

What may not, and is structurally prevented:

- Bodies and headers are never logged (the error boundary reads neither
  `c.req.header()` nor the body).
- `error.message` / `error.stack` / `String(error)` are never logged on the request path; a
  driver error can carry a connection string or SQL text.
- Rejections log a closed set of fields (`auth.session.rejected` with a reason code).
- The Worker logs `safeWorkerErrorCategory()`, which is a class name, not a message.

Verified, not assumed: `verify-durability.mjs` runs a real sign-in, a real message and a real
turn completion, then greps the concatenated stdout/stderr of all four process lifetimes for
the session token, the provider assertion, the nonce, the message text and the database
password. All five were absent across the scanned log lines.

## 6. Residual risks

These are the gaps this PR cannot close without touching runtime code or spending money. Each
one is a deliberate, reviewable decision, not an oversight.

### R-1 — The API has no `production`/`staging` runtime mode _(blocker for real production)_

`apps/api/src/env.ts` accepts `EMBER_ENV` ∈ `local | test | ci`, and
`loadDevAuthConfig()` throws when `NODE_ENV=production`. A process with
`NODE_ENV=production` therefore cannot start the API at all. Staging runs
`NODE_ENV=staging` + `EMBER_ENV=ci`, which is a truthful safety combination (the dev provider
denies `staging`) but a misleading label in logs.

Proposed follow-up, owned by the API owner, not this PR: split the dev-credential loader out
of the production composition root and add `staging`/`production` to the enum and to the
`ISOLATED_EMBER_ENVS` exclusion list. Until that lands, **no production deployment should be
attempted** — the failure mode is a crash loop, not a silent weakness, but it makes production
impossible.

### R-2 — Legacy dev Bearer tokens are only refused by the deployment guard

`loadDevAuthConfig()` refuses development tenant tokens only under `NODE_ENV=production`. On
`NODE_ENV=staging` they would load and authenticate `/v1/{agents,tasks,artifacts,approvals,commitments,consents}`.
The only thing preventing that today is `preflight.mjs` (`E_DEV_TENANT_TOKEN`), which every
deploy path calls.

Proposed follow-up: extend the refusal to `NODE_ENV ∈ {production, staging}` inside
`loadDevAuthConfig`, so the code fails closed on its own. That is a three-line change plus
tests, but it edits an authentication boundary, so it belongs to a reviewed PR of its own
rather than riding along with deployment work.

### R-3 — No application-level rate limiting on the sign-in route

The stock Caddy image has no rate-limit module, and the API does not implement one. Exposure:
credential-less endpoint abuse and CPU exhaustion on JWT verification. Mitigations in place:
2 MB body cap, 404 for the dev path, short-lived identity assertions, no bypass surface, and a
single-purpose staging host. Follow-up: add a rate limiter at the edge (custom Caddy build) or
in the API before any public launch.

### R-4 — Worker health is a proxy signal

The Worker has no listener, so health is measured from PostgreSQL (reachability plus overdue
unleased backlog). A poll loop that is alive but permanently erroring would be caught only
after the grace window, or by log-based alarming. A first-class in-process probe is a Worker
change and therefore out of this PR's scope.

### R-5 — The edge access log records the request URI

Caddy logs `request.uri`, including a query string. The API rejects client-supplied identity
scope fields in the query (I-1) and no endpoint accepts a credential in the query, so the
realistic exposure is a buggy client putting data where it does not belong. Retention is
bounded by log rotation (5 × 10 MB per container). Follow-up: strip or hash query strings if
the logs ever leave the host.

### R-6 — Single host, manual backups

One EC2 instance is a single point of failure, and there is no managed backup. A restore
procedure (`pg_dump`/`pg_restore` between hosts) is documented in the runbook, but the RPO is
whatever the operator's last dump allows. Acceptable for a first staging environment; not
acceptable for production.

### R-7 — Images are built on the host, unsigned

There is no registry and no signature verification; the host builds from a git checkout.
Reproducibility comes from the lockfile and pinned base images, not from provenance. Before
production: push immutable tags to ECR, sign them, and deploy by digest.

### R-8 — Sign-in depends on outbound access to Apple

If egress to `appleid.apple.com:443` is blocked, every Apple sign-in fails closed with 401.
This is a availability dependency, not a security weakness, but it must be in the security
group's allow-list.

### R-9 — Turns accumulate as `running` until the Model Gateway lands

Deliberately no simulated responder on staging, so a submitted Turn remains durably `running`
until a real executor exists. `worker-health.sh` reports `pending_turns` so this is visible
rather than surprising. It also means staging cannot be used to demonstrate an assistant reply
until Agent A's gateway is wired.

## 7. What this PR deliberately did not do

- No AWS resource created: no EC2 instance, no EBS volume, no Elastic IP, no security group,
  no SSM parameters.
- No domain purchased and no DNS record changed.
- No secret written into the repository, the compose file or a CI log.
- No change to `apps/api`, `apps/worker`, `packages/*` or `apps/ios`: the deployment owns
  configuration and packaging only. Two runtime gaps were found and are reported as R-1/R-2
  instead of being patched from here.
- No automatic migration, and no migration executed against any shared database.
