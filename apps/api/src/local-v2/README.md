# Ember V2 local runtime

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
Budget owns global grants and charges. Cloud task claims without model attempts use the ordinary task failure result
because the local conversation runtime has no sandbox driver.

## M2-F1 device execution

Run the device acceptance test against the same isolated Wrangler entrypoint.

```sh
pnpm build
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m2-device-execution-workerd.test.ts
```

The local Cloud Agent driver dispatches a `mock.compute` v1 task through HTTP.
The simulator acts as an iPhone and normalizes whitespace in the supplied text.
The flow uses bounded inline text and the existing Agent Head Task, Run, result,
alarm and D1 recovery registry. The model gateway is unused for device tasks.

All routes require the local B1 bearer session. Device endpoints for register,
claim and result also require `X-Device-Token`, a persistent device-generated
32-byte random secret encoded as 64 lowercase hex characters. The server binds
its digest to the device and authenticated account on first registration.

| Endpoint                                            | Request and behavior                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/devices/{deviceId}/register`              | Send `{ "capability": "mock.compute", "version": 1 }`. Repeat with the same credential to refresh the 30-second readiness window.                                                                                                           |
| `POST /v2/device-tasks`                             | Send `{ deviceId, operationId, input: { text }, deadlineMs? }`. Use UUIDs and a stable operation ID for retries. The relative deadline defaults to 60 seconds. A new task returns 201 and a matching replay returns 200 with current state. |
| `GET /v2/device-tasks/{taskId}`                     | Read Task status, device availability, terminal reason and committed result. A missing or stale device leaves the task queued until the named device becomes ready or the deadline expires.                                                 |
| `POST /v2/devices/{deviceId}/claim`                 | Send `{}` to poll. The response is idle or offers one task with its operation ID, Run ID, lease epoch and deadline. Polling with an active lease returns the same offer, with the original expiry.                                          |
| `POST /v2/devices/{deviceId}/tasks/{taskId}/result` | Submit the offered operation ID, Run ID and epoch with `status: "completed"` and `output: { text }`, or `status: "failed"`. Matching replay returns a committed acknowledgment. A stale lease returns 409 with `kind: "fenced"`.            |
| `POST /v2/device-tasks/{taskId}/cancel`             | Send an empty body to cancel queued or running work and fence its result.                                                                                                                                                                   |
| `POST /v2/devices/{deviceId}/revoke`                | Send an empty body to revoke that device's credential. The task deadline and cancellation still apply.                                                                                                                                      |

Use fresh UUIDs for enrollment after revocation. The local test contract uses a
two-second lease for the fast simulated tool. Lease expiration allows the same
device to reclaim under a higher epoch, up to three total runs within the task
deadline. When the result acknowledgment is ambiguous, the simulator reopens its
pending-result file and retries the original operation and Run fence. The local
integration test uses a simulated device and dev identity.
