# iOS L2 — Live Conversation Integration

Status: Draft PR #121. Base: `main@c6c9c3d`. Owner: iOS Lead.

This is a B1-only cloud conversation path. It does not authorize live model inference, change ADR-0004, or modify the server.

The default App Root stays Mock. Live Alpha launch requires both `--ember-live-cloud` and an HTTPS `EMBER_CLOUD_BASE_URL`; invalid configuration fails closed rather than falling back to Mock.

## Data flow

- L1 Apple sign-in and Keychain authentication provide a server-scoped Bearer token.
- `GET /v1/me` provides the authoritative default Agent, Conversation and transcript epoch.
- A fresh UUIDv4 `client_submission_id`, its exact text and the current epoch are persisted to a protected Application Support journal **before** the first POST.
- `POST /v1/conversations/{id}/messages` is accepted only after verifying the server receipt matches the intent, consumer-scoped Conversation, text, ID and epoch.
- A lost acknowledgement stays unresolved. On relaunch, bootstrap the latest epoch, then `GET /v1/message-submissions/{id}`. Only a confirmed 404 allows a POST with the **same** immutable id/body/epoch.
- A definitive HTTP 409 transitions the original submission atomically from the pending outbox to a durable rejected draft. App relaunch neither looks up nor replays that terminal ID, even if the receipt endpoint would answer 404. A new UUID is minted only when the user explicitly sends another message. Reconciled receipts and server-issued IDs remain authoritative.
- Paginated history uses `after` and `limit` from the frozen B1 schema; no locally generated message ID or sequence is displayed as canonical.
- `GET /v1/conversations/{id}/turns/{id}` is limited to one poll per Conversation per second. Cancellation uses the frozen POST cancel route. The active Turn ID is saved across relaunch.
- A response with `simulated: true` visibly carries the `[SIMULATED]` label. No local Mock responder is reachable from Live composition.
- L1 logout invokes a narrow Journal cleanup hook to prevent previously unsent text from crossing sessions.

## Security and scope

The journal stores private pending message text in an app-local protected file, excluded from backup. Tokens, Apple assertions, nonces and authorization headers are never put in it. No client-supplied tenant/principal/policy identity is sent. The pending send is isolated by the authenticated, server-issued consumer ID.

This branch deliberately leaves existing Mock UI, frozen backend contracts, cloud runtime and model providers unchanged.

## Validation boundaries

GitHub Actions `iOS L2 Validation` run `42145467363` on `01c51fd` executed signed iOS Simulator Build and **299/299 Unit Tests**, **9/9 UI Tests**, zero failures. The new terminal-409 regression requires a fresh run on the updated HEAD. Local Mac screenshot/recording and real iPhone staging E2E remain outstanding.

Run the full signed iOS QA suite on the Mac, using the existing `.xctestrun` approach if necessary. Verify URLProtocol test fixtures, cold start recovery, concurrency, Keychain cleanup, strict concurrency compilation and real simulator Live-mode screenshot. The repository GitHub workflow is Node/TypeScript/PG17-only; its success does not certify Swift compilation.

For iPhone staging E2E, CTO must provide a deployed HTTPS origin, configured Apple Sign in entitlement/provisioning, valid session verification, the approved Fake Responder, and reachable B1 routes. The Apple account must be real, and `simulated: true` must stay visible.
