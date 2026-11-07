# Ember Cloud Staging — Client Integration (iOS)

Audience: iOS Lead. This is the hand-off document for pointing the Ember client at the
staging API. **This PR does not modify iOS code.**

Status: the base URL below becomes valid once the owner-authorized Cloudflare hostname and
Named Tunnel are configured. Until then, the same contract is exercised against
`http://127.0.0.1:8787` on a developer machine (§6). See
[CLOUD-STAGING-CLOUDFLARE-TUNNEL.md](./CLOUD-STAGING-CLOUDFLARE-TUNNEL.md).

---

## 1. Base URL

| Environment | Base URL                           | Notes                                                                                                              |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Staging     | `https://<EMBER_STAGING_HOSTNAME>` | Cloudflare-managed public TLS through the Named Tunnel. The hostname is chosen and authorized by the domain owner. |
| Local       | `http://127.0.0.1:8787`            | Loopback dev sign-in only. Never a staging substitute.                                                             |

Rules:

- HTTPS only. Every request must go to `https://`, with no port suffix (443 implied).
- No certificate pinning is required or supported at this stage: Cloudflare manages the
  public certificate. If pinning is added later, pin the CA, not the leaf.
- No App Transport Security exception is needed: TLS 1.2+ with standard cipher suites, HSTS
  enabled (`Strict-Transport-Security: max-age=31536000; includeSubDomains`). TLS terminates
  at Cloudflare; `cloudflared` uses its encrypted tunnel and the origin hop stays on the local
  Docker bridge.
- `Host` must be the configured hostname. A request with any other `Host` is not proxied.
- Request bodies are capped at 2 MB at the edge; session bodies are capped at the application
  layer too.

## 2. Endpoints in scope

All protected routes take `Authorization: Bearer <access_token>` where `access_token` is the
`ems_…` value returned by sign-in. Microsoft-style identity headers (`X-Tenant-Id`,
`X-Principal-Id`, `X-Policy-Version`) are **rejected**, not ignored: identity comes from the
session only.

| Method   | Path                                                         | Auth                   | Purpose                                                            |
| -------- | ------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `POST`   | `/v1/auth/session`                                           | none (Apple assertion) | Exchange an Apple identity token for an Ember session              |
| `POST`   | `/v1/auth/session/refresh`                                   | session                | Rotate the session token                                           |
| `DELETE` | `/v1/auth/session`                                           | session                | Revoke the session                                                 |
| `GET`    | `/v1/me`                                                     | session                | Consumer identity, Agent, main Conversation and `transcript_epoch` |
| `POST`   | `/v1/conversations/{conversation_id}/messages`               | session                | Submit a user message; returns a receipt with a `turn`             |
| `GET`    | `/v1/conversations/{conversation_id}/messages?after=&limit=` | session                | Read transcript pages                                              |
| `GET`    | `/v1/message-submissions/{client_submission_id}`             | session                | Reconcile an unknown ACK after a network failure                   |
| `GET`    | `/v1/conversations/{conversation_id}/turns/{turn_id}`        | session                | Poll a Turn until it is terminal                                   |
| `POST`   | `/v1/conversations/{conversation_id}/turns/{turn_id}/cancel` | session                | Cancel a running Turn (idempotent)                                 |
| `GET`    | `/healthz`, `/readyz`                                        | none                   | Liveness / readiness. **Not for the app** — operator tooling only  |

Conversation ids and Turn ids are UUIDs; `client_submission_id` must be a fresh UUID v4 per
submission (it is the idempotency key; reusing it with different content is rejected).

## 3. Sign-in flow

```text
ASAuthorizationAppleIDProvider ──► identity_token (JWT, RS256, aud = bundle id)
                                        │
                                        ▼
POST /v1/auth/session   { "provider": "apple", "identity_token": "<jwt>", "nonce": "<nonce>" }
        201  { session_id, consumer_id, access_token, expires_at }
```

- `identity_token` is verified against Apple's JWKS with the bundle id as audience. A forged,
  expired, mis-addressed or replayed token returns **401** with the shared error envelope.
- `nonce` must be the nonce that was sent to Apple for this request.
- The assertion is single-use in practice: do not retry a failed exchange with the same token,
  re-run the Apple flow instead.
- The response's `access_token` is the only credential the client stores. `expires_at` is an
  ISO-8601 timestamp; refresh before it passes.

`POST /v1/auth/session` with `"provider": "dev"` returns **404** on staging by design. That is
not a routing bug — treat it as "this build cannot talk to staging".

## 4. Response and error contract

Success bodies follow the frozen B1 contract in `@ember/contracts`. Failures use one shape
everywhere:

```json
{ "error": { "code": "…", "message": "…", "request_id": "…" } }
```

| Status | Meaning                                              | Client behaviour                                               |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| 400    | malformed request (bad UUID, bad epoch, body schema) | fix the request; do not retry                                  |
| 401    | missing/invalid/expired session                      | refresh the session; if refresh fails, re-run Apple sign-in    |
| 404    | unknown route, foreign resource, or the dev provider | treat as not found; do not retry                               |
| 409    | epoch/state conflict (e.g. stale `transcript_epoch`) | re-read `/v1/me` and retry once                                |
| 429    | (future) rate limiting                               | back off                                                       |
| 503    | dependency unavailable                               | back off with jitter; the edge already retries upstream health |

`request_id` is present on every response, including errors. Log it client-side; the API log
line carries the same id and nothing else about the request.

## 5. Staging-specific expectations

1. **Turns will stay `running`.** There is no model provider on staging yet (paid calls are
   disabled by design). A submitted Turn is durably stored and will complete once the Model
   Gateway is wired. The client must handle a long-running Turn without treating it as an
   error — poll, show a pending state, allow cancel.
2. **No dev sign-in.** The client must not attempt the development provider against staging.
3. **Expect restarts.** Deploys recreate containers; in-flight requests may see a connection
   reset. Retry idempotent reads, and reconcile writes through
   `/v1/message-submissions/{client_submission_id}` before re-submitting.
4. **Sessions survive restarts.** Session tokens are opaque, stored as digests in PostgreSQL,
   so an API restart does not sign the user out.

## 6. Wiring it in a development build

The client currently reads its base URL from its own configuration; this document supplies
the value, it does not change the code. For a local run:

```sh
# terminal 1 — local stack (see docs/CLOUD-STAGING-DEPLOYMENT.md §11)
EMBER_STAGING_ENV_FILE=/tmp/ember-staging-verify.env \
  docker compose -f infra/staging/compose.yaml up -d --wait

# terminal 2 — verify the client's exact path works
curl -sS http://127.0.0.1:8787/readyz
```

`http://127.0.0.1:8787` reaches the API container from the Mac host loopback only. A physical
iPhone cannot reach it; use the staging hostname once it exists.

## 7. What the client must never do

- Send `X-Tenant-Id` / `X-Principal-Id` / `X-Policy-Version`, or any identity field in a query
  string. These are rejected at the API and would be logged by the edge.
- Put a token in a URL. Credentials belong in the `Authorization` header only.
- Disable TLS verification, or run against `http://` outside loopback.
- Treat a 404 from `/v1/auth/session` as retryable.
- Assume the assistant reply arrives within one request. It does not; Turns are asynchronous
  by contract.
