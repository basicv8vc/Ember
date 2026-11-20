# Ember V2-M1 local runtime

Run the conversation smoke from the repository root with Node 24 and pnpm 12.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m1-runtime-assembly.test.ts
```

The Agent D harness starts local workerd and the loopback Fake Model Gateway,
applies the D1 recovery migration, and disposes both after the test. The smoke
exercises B1 session creation, receipt recovery after an unknown ACK, durable
dispatch, SSE, disconnect and query-only handoff, cancellation, transcript
clear, and settlement in the actual GlobalBudgetDO SQLite ledger.

For manual HTTP testing, start the same fake gateway in one terminal.

```sh
pnpm exec tsx --input-type=module -e 'import { FakeModelGatewayServer } from "./apps/benchmark/src/v2-m1/fake-model-gateway-server.ts"; const gateway = new FakeModelGatewayServer(); console.log(await gateway.start());'
```

In a second terminal, copy the printed loopback origin into the Wrangler
variable and start the local Worker.

```sh
pnpm --filter @ember/api exec wrangler d1 migrations apply D1_RECOVERY --local --config wrangler.local-v2.jsonc
pnpm --filter @ember/api exec wrangler dev --local --config wrangler.local-v2.jsonc --ip 127.0.0.1 --var FAKE_MODEL_GATEWAY_URL:http://127.0.0.1:12345
```

Use `POST /v1/auth/session` with provider `dev`, an identity token, and a nonce.
Use the returned bearer token for `GET /v1/me` to discover the main conversation
and transcript epoch. The B1 message endpoint uses Durable Queue. The local
`POST /v2/conversations/{id}/messages/stream` endpoint accepts the same request
body, streams provisional deltas, and emits an acknowledgement after a commit
or handoff. Recover an unknown submission response with
`GET /v1/message-submissions/{client_submission_id}`. After SSE disconnect,
read the authoritative Turn and message cursor using the B1 endpoints.

This entrypoint uses dev identity and stores session token digests in the local
D1 binding. AgentHead SQLite owns turns, messages and model attempts. Global
Budget owns global grants and charges. Task claims without model attempts use
the ordinary task failure result because the local conversation runtime has
no sandbox driver.
