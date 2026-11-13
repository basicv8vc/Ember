# Legacy Compose infrastructure

> This directory contains the earlier Docker Compose deployment path. It is retained for historical
> compatibility and does not define the current Ember Cloud environment or release flow. Use
> [Ember Cloud on Cloudflare](../../docs/cloud-staging.md) and `pnpm cloud:deploy` for current work.

The files below support only that legacy host deployment and do not participate in `pnpm cloud:deploy`.

| Path                            | What it is                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `compose.yaml`                  | the whole stack: postgres, api, worker, edge, and an opt-in migrate job       |
| `docker/Dockerfile`             | one build, two runtime targets (`api`, `worker`), pinned Node and pnpm        |
| `caddy/Caddyfile`               | public TLS (ACME) for `$EMBER_STAGING_HOSTNAME`                               |
| `caddy/Caddyfile.internal`      | local verification only: Caddy's internal CA                                  |
| `env/staging.env.example`       | the complete configuration template, with no secrets                          |
| `env/local-verify.env.example`  | the same configuration for a laptop, internal CA, unprivileged ports          |
| `scripts/preflight.mjs`         | the fail-closed environment guard (no dev auth, no provider keys, private DB) |
| `scripts/preflight.sh`          | operator wrapper: file permissions, then the guard                            |
| `scripts/render-env.sh`         | AWS SSM → `/etc/ember/staging.env` (0600)                                     |
| `scripts/migrate.sh`            | explicit, confirmed, idempotency-checkable migration                          |
| `scripts/deploy.sh`             | guard → build → up → smoke, one release                                       |
| `scripts/rollback.sh`           | return to a previously built image tag                                        |
| `scripts/smoke.sh`              | 14 positive and negative checks against a running deployment                  |
| `scripts/worker-health.sh`      | backlog / lease / turn metrics for a process with no socket                   |
| `scripts/worker-probe.mjs`      | the Worker container healthcheck (shipped inside the image)                   |
| `scripts/verify-durability.mjs` | restart durability, conversation history and log redaction                    |

Start here: [docs/CLOUD-STAGING-DEPLOYMENT.md](../../docs/CLOUD-STAGING-DEPLOYMENT.md).

Quick local check of the guard, without Docker:

```sh
node infra/staging/scripts/preflight.mjs infra/staging/env/staging.env.example
```

It must fail: every placeholder in the template is a deployment error by design.
