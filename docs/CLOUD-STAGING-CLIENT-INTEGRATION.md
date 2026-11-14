# Ember Cloud — Client Integration (iOS)

Audience: iOS Lead. This is the hand-off document for pointing the Ember client at the current
shared Ember Cloud API. The endpoint and Apple audience are listed in [Ember Cloud](cloud-staging.md).

The Worker and Queue resource names still include `staging`; they identify the existing Ember Cloud
resources and do not indicate a separate release environment.

---

## 1. Base URL

| Environment | Base URL                                               | Notes                                                             |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| Ember Cloud | `https://ember-cloud-api-staging.10kpaper.workers.dev` | Existing Cloudflare HTTPS endpoint; keep this URL stable for iOS. |
| Local       | `http://127.0.0.1:8787`                                | Loopback development only.                                        |

Rules:

- HTTPS only. Every request must go to `https://`, with no port suffix (443 implied).
- No certificate pinning is required or supported at this stage: the certificate is
  short-lived and renewed automatically. If pinning is added later, pin the CA, not the leaf.
- No App Transport Security exception is needed: TLS 1.2+ with standard cipher suites, HSTS
  enabled (`Strict-Transport-Security: max-age=31536000; includeSubDomains`).
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

`POST /v1/auth/session` with `"provider": "dev"` returns **404** on Ember Cloud by design. Use
Apple Sign In for the shared cloud endpoint.

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

## 5. Ember Cloud expectations

1. **Private Alpha real-model scope.** Authenticated Apple Sign In users receive real model
   replies (`simulated: false`) bounded by per-Turn, per-Principal, per-Tenant, and global daily
   ledger budgets plus the server-side OpenRouter key cap. Anonymous requests remain rejected.
2. **No dev sign-in.** The client must not attempt the development provider against Ember Cloud.
3. **Recover writes by idempotency key.** A Worker version change or network interruption can make
   a response ambiguous. Retry idempotent reads, and reconcile writes through
   `/v1/message-submissions/{client_submission_id}` before re-submitting.
4. **Sessions survive deploys.** Session tokens are opaque, stored as digests in PostgreSQL, so an
   API Worker update does not sign the user out.

## 6. Wiring it in a development build

The client currently reads its base URL from its own configuration; this document supplies
the value, it does not change the code. For a local run:

```sh
# terminal 1 — optional local Docker Compose stack
EMBER_STAGING_ENV_FILE=/tmp/ember-staging-verify.env \
  docker compose -f infra/staging/compose.yaml up -d --wait

# terminal 2 — verify the client's exact path works
curl -sS http://127.0.0.1:8787/readyz
```

`http://127.0.0.1:8787` reaches the local API from Mac loopback only. A physical iPhone cannot reach
it; use the existing Ember Cloud HTTPS endpoint from the table above.

## 7. What the client must never do

- Send `X-Tenant-Id` / `X-Principal-Id` / `X-Policy-Version`, or any identity field in a query
  string. These are rejected at the API and would be logged by the edge.
- Put a token in a URL. Credentials belong in the `Authorization` header only.
- Disable TLS verification, or run against `http://` outside loopback.
- Treat a 404 from `/v1/auth/session` as retryable.
- Assume the assistant reply arrives within one request. It does not; Turns are asynchronous
  by contract.
