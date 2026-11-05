# Run the simulated B1 Cloud Chat locally

This starts the real API and Worker against PostgreSQL. The Worker reply is deterministic and marked simulated; it never calls a model provider.

## Start the services

Use Node 24 and PostgreSQL 17. Copy the local example and point `DATABASE_URL` at the local `ember` database if your PostgreSQL port or role differs:

```sh
cp .env.example .env.local
pnpm install --frozen-lockfile
pnpm dev:db
pnpm db:migrate
```

Enable the isolated dev sign-in and the simulated B1 responder for this shell, then start the API and Worker together:

```sh
EMBER_DEV_PROVIDER_ENABLED=true \
EMBER_DEV_PROVIDER_ISOLATED=true \
EMBER_B1_FAKE_RESPONDER_ENABLED=true \
pnpm dev
```

`EMBER_ENV=local`, `EMBER_APPLE_BUNDLE_ID`, the database URL, and loopback API address come from `.env.local`. The API still verifies Apple assertions for Apple sign-in. The dev provider is available only on the actual loopback listener. The B1 responder defaults to disabled and refuses `EMBER_ENV=production`.

## Exercise the HTTP flow

In another terminal, create a local Session and read its provisioned Conversation:

```sh
curl -sS http://127.0.0.1:8787/v1/auth/session \
  -H 'content-type: application/json' \
  -d '{"provider":"dev","identity_token":"local-chat-user","nonce":"local-only"}'
```

Use the returned `access_token` as a Bearer token for `GET /v1/me`, then send a message to the returned `conversation.conversation_id` with the returned `conversation.transcript_epoch` and a fresh UUID v4 `client_submission_id`. Poll the returned Turn at `GET /v1/conversations/{conversation_id}/turns/{turn_id}` until it is `completed`, then read `GET /v1/conversations/{conversation_id}/messages` to recover the durable transcript.

The development provider, local database credentials and simulated responder are for isolated local use only. Do not reuse them in a shared or production environment.
