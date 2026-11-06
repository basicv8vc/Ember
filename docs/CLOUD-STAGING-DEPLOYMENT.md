# Ember Cloud Staging — Deployment Runbook

Status: **reviewable configuration, not yet deployed.** No cloud resource has been created;
see [CLOUD-STAGING-RESOURCE-REQUEST.md](./CLOUD-STAGING-RESOURCE-REQUEST.md) for what is
needed from the account owner.

This document is the operator's manual: how the stack is shaped, how to deploy it, how to
update it, how to roll it back, how to migrate, how to watch it, and what to do when one of
the four containers is unhappy.

- Security model and residual risks: [CLOUD-STAGING-SECURITY.md](./CLOUD-STAGING-SECURITY.md)
- Evidence from the local verification run: [CLOUD-STAGING-VERIFICATION.md](./CLOUD-STAGING-VERIFICATION.md)
- Base URL and auth contract for the iOS client: [CLOUD-STAGING-CLIENT-INTEGRATION.md](./CLOUD-STAGING-CLIENT-INTEGRATION.md)
- Platform choice and alternatives: [CLOUD-STAGING-PLATFORM-COMPARISON.md](./CLOUD-STAGING-PLATFORM-COMPARISON.md)

---

## 1. Topology

One EC2 host, four long-running containers, one optional one-shot job.

```text
                    Internet (iPhone)
                           │  443/tcp TLS 1.2+
                           ▼
              ┌────────────────────────┐
              │ edge — Caddy 2.10      │  ACME certificate for $EMBER_STAGING_HOSTNAME
              │ :80 (challenge+redirect), :443
              └───────────┬────────────┘
                          │ docker network "edge"
                          ▼
              ┌────────────────────────┐        ┌───────────────────────────┐
              │ api — @ember/api       │        │ worker — @ember/worker    │
              │ :8787 (0.0.0.0 in      │        │ no listener, poll + reaper│
              │ container, published   │        └─────────────┬─────────────┘
              │ only on host loopback) │                      │
              └───────────┬────────────┘                      │
                          │        docker network "db" (internal: true)
                          ▼                      ▼
              ┌────────────────────────────────────────────────┐
              │ postgres — PostgreSQL 17.6, no published port  │
              │ volume ember-staging-pgdata                    │
              └────────────────────────────────────────────────┘

              migrate — same api image, `profiles: [tools]`, runs only when invoked
```

Why this shape:

- **The database has no host port at all.** It is reachable only from containers attached to
  the `db` network, which is `internal: true`, so a container on it cannot reach the Internet
  either.
- **The API is published on `127.0.0.1:8787` only.** That mapping exists so an operator (and
  `smoke.sh --base-url`) can reach it on the host; the Internet reaches it exclusively
  through the TLS edge.
- **The Worker has no listener.** It claims work, renews leases, reaps expired leases and
  runs the durable commit path. Its health is derived from PostgreSQL, not from a socket
  (§8).
- **Migrations are a separate, confirmed operation.** `docker compose up` never changes the
  schema (§6).

## 2. Host prerequisites

| Requirement      | Value used by this configuration                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OS               | Ubuntu 24.04 LTS or Amazon Linux 2023                                                                                        |
| Instance         | `t3.small` (2 vCPU / 2 GiB) is sufficient for staging traffic                                                                |
| Disk             | 20 GiB gp3; the `ember-staging-*` volumes live under `/var/lib/docker`                                                       |
| Runtime          | Docker Engine 27+ with the Compose v2 plugin; Node is **not** installed on the host                                          |
| Inbound          | `443` from `0.0.0.0/0`, `80` from `0.0.0.0/0` (ACME + redirect), `22` from the operator CIDR only                            |
| Outbound         | `443` to `registry-1.docker.io`, `deb.debian.org`/`cdn.amazonlinux.com`, `appleid.apple.com`, `acme-v02.api.letsencrypt.org` |
| Instance profile | `ssm:GetParametersByPath`, `ssm:GetParameter`, `ssm:PutParameter` on `/ember/staging/*` only                                 |

The host keeps no state that matters except the Docker volumes. A rebuilt host with the same
volumes and the same SSM tree is the same environment.

## 3. Directory layout on the host

```text
/opt/ember/          # git checkout of the release commit (compose + scripts live here)
/etc/ember/
  staging.env        # 0600 — rendered from SSM, read by preflight and by Compose
  secrets/
    postgres_password# 0600 — mounted as the Compose secret for the postgres container
  release            # tag of the deployed release (written by deploy.sh / rollback.sh)
  release.previous   # tag replaced by the last deploy/rollback — the `--previous` target
```

## 4. First deployment

```sh
# 0. On the host, as root, once
install -d -m 0700 /etc/ember /etc/ember/secrets
git clone https://github.com/basicv8vc/Ember.git /opt/ember
cd /opt/ember && git checkout <release-commit>

# 1. Render configuration from SSM (writes /etc/ember/staging.env mode 0600)
infra/staging/scripts/render-env.sh --output=/etc/ember/staging.env

# 2. Apply the schema — explicit, never automatic
infra/staging/scripts/migrate.sh --env-file=/etc/ember/staging.env --confirm

# 3. Build the images and start the stack, then run the smoke suite
infra/staging/scripts/deploy.sh --env-file=/etc/ember/staging.env
```

`deploy.sh` refuses to continue unless the preflight guard passes, waits for every container
to report healthy, and finishes with the smoke suite. It does not migrate.

### What "configuration" means here

`staging.env` is the whole configuration surface. Its template is
`infra/staging/env/staging.env.example`, which documents every variable. Three values are
load-bearing and worth restating:

| Variable                           | Value      | Why                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                         | `staging`  | Closes every development-only code path. The dev sign-in provider denies `production` **and** `staging`; the preflight guard refuses the legacy dev bearer tokens outright.                                                                                                                                                                                             |
| `EMBER_ENV`                        | `staging`  | The formal shared-deployment marker. The runtime classifies `EMBER_ENV=staging` as a staging deployment and fails every development surface closed in the process itself (deployment classification, PR #126). The old `ci` workaround is refused by preflight: `ci` is development-class and must never label a shared deployment.                                     |
| `EMBER_WORKER_SIMULATED_EXECUTION` | `disabled` | Shared deployments run `EMBER_WORKER_MODE=reaper-only` (lease reaping, the commitment scheduler, and the B2 turn responder when model execution is on). The task poll lane's deterministic executor is a local/test capability and the runtime refuses it in staging/production until P0B-06 provides durable execution results (#126). Preflight enforces both values. |
| `EMBER_MODEL_EXECUTION`            | `disabled` | B2 Model Execution stays off: no model turn responder starts, a submitted Turn remains durably pending. `fake` is refused under staging markers (B2 boundary) and `real` is refused everywhere without a reviewed approval, an invoice-verified rate and a credential. Preflight enforces all three.                                                                    |

## 5. Update (new release)

```sh
cd /opt/ember
git fetch --tags && git checkout <new-release-commit>

# If the release contains migrations, apply them FIRST and deliberately:
infra/staging/scripts/migrate.sh --env-file=/etc/ember/staging.env --confirm

infra/staging/scripts/deploy.sh --env-file=/etc/ember/staging.env
```

Release bookkeeping is automatic: once a deploy fully succeeds, `deploy.sh` copies the
outgoing tag to `/etc/ember/release.previous` before writing the new one, so
`rollback.sh --previous` always has a target. No manual copy is needed (or useful).

Rolling replacement is a `docker compose up -d`: Compose recreates one container at a time.
The Worker drains in-flight Runs on `SIGTERM` (`stop_grace_period: 45s`); a Run that does not
finish inside its lease is recovered by the reaper after the lease expires, not lost.

## 6. Migrations

Migrations are **forward-only**, checksum-verified, serialised by a PostgreSQL advisory lock
(`8657309`), and recorded in `schema_migrations`. The runner is the same code path CI
exercises (`pnpm db:migrate`).

Rules:

1. Never run migrations automatically from a deploy, an entrypoint, or a container start.
2. `migrate.sh` requires `--confirm` and prints the target `host/database` before touching it.
3. `--verify-idempotent` runs the migrator twice and proves the second run is a no-op. Run it
   on the first deployment of a release and after any migration edit.
4. A rollback does not revert the schema. Ship additive migrations first, code that depends
   on them second.

## 7. Rollback

```sh
infra/staging/scripts/rollback.sh --env-file=/etc/ember/staging.env --to=<release-tag>
# or
infra/staging/scripts/rollback.sh --env-file=/etc/ember/staging.env --previous
```

The script verifies both images for that tag exist locally, recreates the stack with
`--no-build`, and re-runs the smoke suite. It refuses to invent a tag: an image that was
never built cannot be rolled back to. A successful rollback updates the bookkeeping the
same way a deploy does — the rolled-back-to tag becomes `release`, and the abandoned one
becomes the new `release.previous`.

**Schema is not rolled back.** If a release's migration is incompatible with the previous
image, the rollback will fail its smoke test — that is the intended, loud failure.

## 8. Health and monitoring

| Signal                  | Where                                           | Meaning                                                                         |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /healthz`          | api container healthcheck, edge upstream health | the HTTP listener answers; independent of PostgreSQL                            |
| `GET /readyz`           | Compose `depends_on: service_healthy`, smoke    | PostgreSQL answers `SELECT 1`                                                   |
| worker container health | `apps/worker/worker-probe.mjs` inside the image | PostgreSQL reachable **and** no Task overdue by more than 300 s without a lease |
| `worker-health.sh`      | host timer (below)                              | backlog age, expired leases, overdue Turns, transcript size, applied migrations |

The Worker probe is deliberately a _proxy_ signal: the process owns no socket today, and
adding one is a runtime change outside this PR's scope (residual risk R-4). A dead poll loop
shows up as an overdue claimable backlog, which is exactly what the probe and the timer
check.

Install the host timer (one minute resolution, output goes to the journal):

```sh
cat >/etc/systemd/system/ember-staging-health.service <<'EOF'
[Unit]
Description=Ember staging worker health probe

[Service]
Type=oneshot
ExecStart=/opt/ember/infra/staging/scripts/worker-health.sh --env-file=/etc/ember/staging.env
EOF

cat >/etc/systemd/system/ember-staging-health.timer <<'EOF'
[Unit]
Description=Run the Ember staging worker health probe every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ember-staging-health.timer
```

Alert when: `worker_health=degraded`, `stalled_tasks > 0` for two consecutive minutes,
`overdue_turns > 0`, any container `unhealthy` for five minutes, or the edge returns 5xx.

Logs are structured JSON on stdout/stderr, collected by the `json-file` driver with
`max-size=10m`, `max-file=5` per container. They contain route, status, request id, duration
and domain error codes only — never a token, an assertion, a message body or a connection
string (verified in [CLOUD-STAGING-VERIFICATION.md](./CLOUD-STAGING-VERIFICATION.md) §5).

## 9. Certificate and TLS

`infra/staging/caddy/Caddyfile` obtains a Let's Encrypt certificate for
`$EMBER_STAGING_HOSTNAME` on first boot and renews it automatically. Requirements:

1. the DNS record already resolves to the host's public address;
2. inbound `80` and `443` reach the container.

`infra/staging/caddy/Caddyfile.internal` exists only for local verification (Caddy's local
CA). The preflight guard refuses it in `--mode=staging`.

## 10. Troubleshooting

| Symptom                                                          | Likely cause                                                                            | Check / fix                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `deploy.sh` stops at preflight                                   | an environment value weakens auth or points at a foreign estate                         | the guard prints `[violation] CODE VARIABLE: reason`; fix `staging.env` (or the SSM parameter)                            |
| api restarts with `api failed to start: … EMBER_APPLE_BUNDLE_ID` | audience missing or a placeholder                                                       | set the real bundle id in SSM                                                                                             |
| api restarts with `Refusing to bind non-loopback host`           | `EMBER_ALLOW_NON_LOOPBACK_BIND` missing                                                 | must be `true`; the guard enforces it                                                                                     |
| `/readyz` returns 503                                            | database unreachable or migrations never applied                                        | `docker compose logs postgres`; `migrate.sh --confirm`; check the `db` network attachment                                 |
| edge returns 502                                                 | api container unhealthy or not on the `edge` network                                    | `docker compose ps`; `curl 127.0.0.1:8787/healthz` on the host                                                            |
| ACME issuance fails                                              | DNS not propagated, port 80 blocked, or hostname mismatch                               | `docker compose logs edge \| grep -i acme`; `dig +short $EMBER_STAGING_HOSTNAME`; check the security group                |
| worker `unhealthy`                                               | database unreachable **or** overdue unleased backlog                                    | `docker exec <worker> node apps/worker/worker-probe.mjs` prints the reason                                                |
| turns stay `running` forever                                     | `EMBER_MODEL_EXECUTION=disabled` is the staging contract — no model turn responder runs | expected on staging; `worker-health.sh` shows `pending_turns`; turning on a model is a reviewed change, never an env flip |
| `migrate.sh` hangs                                               | another migration holds the advisory lock                                               | `SELECT * FROM pg_locks WHERE locktype='advisory'`                                                                        |
| disk filling                                                     | container logs or PostgreSQL WAL                                                        | `docker system df`; logs are capped, so check `pg_wal` and old images (`docker image prune`)                              |

## 11. Local verification (no cloud account)

The same stack runs on a laptop with an internal CA and non-privileged ports:

```sh
cp infra/staging/env/local-verify.env.example /tmp/ember-staging-verify.env
# replace REPLACE_WITH_LOCAL_THROWAWAY_PASSWORD, then:
chmod 600 /tmp/ember-staging-verify.env
mkdir -p /tmp/ember-staging-verify-secrets && chmod 700 /tmp/ember-staging-verify-secrets
printf '%s' '<the same password>' > /tmp/ember-staging-verify-secrets/postgres_password
chmod 600 /tmp/ember-staging-verify-secrets/postgres_password

infra/staging/scripts/preflight.sh --env-file=/tmp/ember-staging-verify.env --mode=local
EMBER_STAGING_ENV_FILE=/tmp/ember-staging-verify.env \
  docker compose -f infra/staging/compose.yaml up -d --wait
EMBER_STAGING_ENV_FILE=/tmp/ember-staging-verify.env \
  docker compose -f infra/staging/compose.yaml --profile tools run --rm migrate
EMBER_SMOKE_CACERT=/tmp/ember-staging-ca.crt \
  infra/staging/scripts/smoke.sh --env-file=/tmp/ember-staging-verify.env
```

Durability and log redaction are verified against the compiled artifacts (the same files the
images run) by:

```sh
node infra/staging/scripts/verify-durability.mjs \
  --admin-database-url postgres://ember:<password>@127.0.0.1:55433/ember_staging_verify
```

The full-lifecycle HTTP E2E (sign-in, conversation, message, Worker turn through the B2
Model Gateway's Fake Model, persisted reply, iOS read path, Worker restart recovery) runs
the real containers and the TLS edge in a dedicated acceptance profile:

```sh
infra/staging/scripts/cloud-e2e.sh
```

That profile (`infra/staging/env/local-e2e.env.example`, `preflight --mode=e2e`) exists
because the Worker refuses `EMBER_MODEL_EXECUTION=fake` under `NODE_ENV=staging` by design
(B2 boundary: a live-marked process must never serve simulated replies). It differs from
local-verify only in `NODE_ENV=test`, `EMBER_MODEL_EXECUTION=fake` and isolated volumes and
ports. It can never be deployed: the guard refuses staging markers in this mode and refuses
`fake` in every other mode.

`--mode=local` relaxes **only** the public-hostname rules. Every authentication, credential,
worker-mode and database rule still applies, which is what makes the local run evidence about
the staging configuration rather than about a different one.
