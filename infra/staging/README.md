# Ember Cloud Staging — infrastructure

Everything needed to run the Ember Cloud API and Worker as a real HTTPS service, without
touching the Shua estate.

| Path                                 | What it is                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `compose.yaml`                       | the whole stack: postgres, api, worker, edge, and an opt-in migrate job       |
| `cloudflared` profile                | optional remote Cloudflare Named Tunnel connector; token mounted as a secret  |
| `docker/Dockerfile`                  | one build, two runtime targets (`api`, `worker`), pinned Node and pnpm        |
| `caddy/Caddyfile`                    | legacy public TLS (ACME), retained for historical deployment notes            |
| `caddy/Caddyfile.tunnel`             | private HTTP origin listener for the Cloudflare Tunnel                        |
| `caddy/Caddyfile.internal`           | local verification only: Caddy's internal CA                                  |
| `env/staging.env.example`            | the complete configuration template, with no secrets                          |
| `env/local-verify.env.example`       | the same configuration for a laptop, internal CA, unprivileged ports          |
| `scripts/preflight.mjs`              | the fail-closed environment guard (no dev auth, no provider keys, private DB) |
| `scripts/preflight.sh`               | operator wrapper: file permissions, then the guard                            |
| `scripts/render-env.sh`              | legacy AWS SSM → `/etc/ember/staging.env` (0600)                              |
| `scripts/migrate.sh`                 | explicit, confirmed, idempotency-checkable migration                          |
| `scripts/deploy.sh`                  | guard → build → up → smoke, one release                                       |
| `scripts/rollback.sh`                | return to a previously built image tag                                        |
| `scripts/tunnel-start.sh`            | start the local staging stack and verify its public tunnel URL                |
| `scripts/tunnel-stop.sh`             | stop/remove only the connector; preserve local services and volumes           |
| `scripts/smoke.sh`                   | API/edge checks; tunnel mode also checks HTTP-to-HTTPS redirection            |
| `scripts/verify-apple-jwks.sh`       | verify Apple JWKS reachability from the API container                         |
| `scripts/verify-secret-redaction.sh` | probe that bearer canaries do not appear in service logs                      |
| `scripts/worker-health.sh`           | backlog / lease / turn metrics for a process with no socket                   |
| `scripts/worker-probe.mjs`           | the Worker container healthcheck (shipped inside the image)                   |
| `scripts/verify-durability.mjs`      | restart durability, conversation history and log redaction                    |

Start here: [docs/CLOUD-STAGING-CLOUDFLARE-TUNNEL.md](../../docs/CLOUD-STAGING-CLOUDFLARE-TUNNEL.md).
The older EC2/ACME runbook remains for historical reference only and is not the Issue #131 path.

Quick local check of the guard, without Docker:

```sh
node infra/staging/scripts/preflight.mjs infra/staging/env/staging.env.example
```

It must fail: every placeholder in the template is a deployment error by design.
