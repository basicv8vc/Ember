# Staging secrets — credentials are never committed

This directory is where PostgreSQL and the optional Cloudflare Tunnel connector read Docker
secrets. Real credentials are ignored by git; only the clearly unusable tunnel-token example
is tracked.

Expected contents on a host:

```text
secrets/postgres_password   0600 root:root   the application database password
secrets/cloudflare_tunnel_token 0600 root:root the remotely-managed Tunnel token
```

Rules:

- No secret is ever stored in the repository, in `compose.yaml`, in an environment file that is
  tracked by git, or in a CI log. `cloudflare_tunnel_token.example` contains instructions only,
  not a usable credential.
- The earlier AWS deployment profile stores the password as an SSM `SecureString` under
  `/ember/staging/secrets/POSTGRES_PASSWORD`. For the local-host tunnel path, keep it in the
  approved local secret store and render the file with mode 0600; do not provision AWS SSM as
  part of this issue without separate approval.
- The tunnel token is issued by the Cloudflare dashboard only after the domain owner authorizes
  this staging hostname. Store it at `/etc/ember/secrets/cloudflare_tunnel_token` with mode 0600;
  it is mounted read-only into the `cloudflared` service and never passed as an environment
  value or command-line argument.
- Rotation means: change the parameter, `ALTER ROLE ember PASSWORD …` inside PostgreSQL,
  re-render, restart the stack. Rotating only one side is an outage.
