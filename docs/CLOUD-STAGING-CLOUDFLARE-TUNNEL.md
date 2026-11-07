# Ember staging via Cloudflare Named Tunnel

Status: **configuration draft; not connected to Cloudflare and no public URL exists yet.**
This issue uses the existing host to keep the first iPhone integration step low-cost. The
current CTO direction is Cloudflare-first and pay-as-you-grow; AWS remains an option for a
later cloud runtime. No new paid resource is provisioned without prior approval. The existing
host runs the API, Worker and PostgreSQL; a remotely-managed Cloudflare Tunnel provides the
public HTTPS route.

Before creating the tunnel or DNS record, the owner must explicitly confirm the Cloudflare
account, existing domain and staging hostname, and authorize that hostname's DNS change. No
domain, account or DNS permission was supplied for this worktree, so this runbook stops before
those actions.

## Shape and security

```text
iPhone ── HTTPS ──▶ Cloudflare edge ── encrypted Tunnel ──▶ cloudflared
                                                               │
                                                               ▼ local Docker bridge
                                                        Caddy :80 ──▶ API ──▶ PostgreSQL
```

- The tunnel is outbound only. Caddy's host mappings bind to `127.0.0.1`; PostgreSQL has no
  published port. No inbound firewall rule or public IP is required.
- Cloudflare terminates public HTTPS. Set minimum TLS to 1.2 and enable **Always Use HTTPS**;
  the public smoke test checks that cleartext HTTP redirects. `cloudflared` uses an encrypted
  connection to Cloudflare, then forwards to Caddy over the same host's private Docker bridge.
  This is not end-to-end TLS to the local Caddy container.
- Cloudflare Tunnel is available on all Cloudflare plans. This path does not put Cloudflare
  Access in front of the iOS API: the app's Apple sign-in/session Bearer contract supplies
  access control, and a Cloudflare Access login would prevent the current iOS client from
  reaching it. Protected API routes must continue to reject missing or forged sessions.
- Development auth, legacy dev bearer tokens, Fake Model and provider credentials remain
  disabled by the staging preflight. Caddy keeps the 2 MB body limit, HSTS and security
  headers; API, Caddy and connector logs are rotated. The tunnel token is mounted read-only
  from a mode-0600 file and never appears in the environment or process arguments.
- A tunnel has one host as its availability boundary. When that host sleeps, loses power or
  loses Internet access, the public hostname stops serving the API.

## Growth path

The tunnel is the staging bridge for real-device auth testing, not the scaled production
target. Keep Cloudflare as the DNS/TLS/security edge; when availability or traffic requires
it, move the existing API and Worker containers to a managed cloud container runtime without
changing their HTTP contract. Keep PostgreSQL as PostgreSQL. Evaluate database hosting only
after Agent D's independent Neon comparison; any database move must be a separately reviewed
PostgreSQL migration, not part of this tunnel task. Do not add infrastructure until its
capacity need, monthly estimate, rollback and owner approval are reviewable.

Cloudflare documents public hostname routing, free-plan availability and the fact that a
published hostname is Internet-accessible unless the application or an Access policy protects
it in [Published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).
The remote tunnel's token-file support is documented for `cloudflared` 2025.4.0 and later in
[Tunnel run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/); the image is pinned to
`2026.10.7`.

## One-time setup after authorization

1. Confirm a domain already active in the authorized Cloudflare account and choose a
   single-level staging hostname such as `staging.example.com`. Do not buy a domain or create
   any paid resource.
2. In **Networking → Tunnels**, create a remotely-managed Named Tunnel. Add one public hostname
   route with service `http://edge:80`; preserve the incoming `Host` header so it matches the
   approved staging hostname. The `cloudflared` connector joins the same Compose `edge`
   network and resolves `edge` there.
3. Let the dashboard create the hostname's proxied CNAME to `<TUNNEL_ID>.cfargotunnel.com`.
   Set minimum TLS to 1.2 and turn on **Always Use HTTPS**. Leave Cloudflare Access disabled for
   this API hostname; Ember's Apple/session auth is the access control.
4. Copy the remote tunnel token to `/etc/ember/secrets/cloudflare_tunnel_token` using a secure
   editor or secret manager, then run `chmod 600` on that file. Never paste it into
   `staging.env`, a command argument, CI output or this repository. The token can start the
   tunnel and must be rotated if exposed; see [Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).
5. Copy `infra/staging/env/staging.env.example` to `/etc/ember/staging.env` and replace every
   placeholder, including `EMBER_STAGING_HOSTNAME` and the database password. Set both files
   to mode 0600. The bundle ID is `com.basicv8vc.ember`, matching the current iOS Xcode target;
   the iOS Lead must give final sign-off before testing a real Apple identity token.

The config route and token are account-specific and intentionally are not included in the
repository. The only tracked token file is an unusable placeholder for Compose validation.

## Start, stop and rollback

On the authorized host, use these commands from the repository root. The first deployment
still requires the explicit migration step; `deploy.sh` never migrates automatically.

```sh
infra/staging/scripts/preflight.sh --env-file /etc/ember/staging.env
infra/staging/scripts/migrate.sh --env-file /etc/ember/staging.env --confirm --verify-idempotent
infra/staging/scripts/deploy.sh --env-file /etc/ember/staging.env
```

`deploy.sh` builds the pinned API/Worker images, starts the local services and tunnel, then
runs the HTTPS smoke suite, Apple JWKS egress probe and log-redaction probe. After the first
deployment, `tunnel-start.sh` starts existing images and repeats those probes; it does not
run migrations or build images.

```sh
infra/staging/scripts/tunnel-start.sh --env-file /etc/ember/staging.env
infra/staging/scripts/tunnel-stop.sh --env-file /etc/ember/staging.env
infra/staging/scripts/rollback.sh --env-file /etc/ember/staging.env --previous
```

`tunnel-stop.sh` stops/removes only `cloudflared`, leaving the API, database and data volumes
intact. It does not delete DNS. For a code rollback, `rollback.sh --previous` restores the
previous API/Worker image and re-runs the public smoke checks; migrations remain forward-only.
If the public endpoint itself must be closed immediately, run `tunnel-stop.sh` first.

## Evidence and remaining gate

The existing [local verification report](./CLOUD-STAGING-VERIFICATION.md) records 14/14
checks against a local Caddy internal-CA endpoint. That is not evidence for the public
Cloudflare URL. This environment has no Docker CLI, and no authorized hostname, Cloudflare
account or tunnel token was provided, so this branch cannot produce the requested public
`/healthz`, `/readyz`, unauthorized-session, Apple JWKS, migration-idempotency or
secret-redaction evidence. The scripts above collect those checks after authorization; until
then the public deployment is blocked and the reusable configuration remains reviewable.
