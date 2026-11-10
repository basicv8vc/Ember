# Cloud Assistant Turn Runtime

## Runtime choice

Use a Cloudflare Queue consumer with PostgreSQL as the durable scheduler and state authority. The Queue envelope is a closed four-field object (`schemaVersion`, `eventId`, `tenantId`, `turnId`); it carries no prompt, transcript, provider, or budget data. The consumer resolves the event from PostgreSQL and calls the existing B2 responder for exactly that Turn.

Cloudflare Queues deliver at least once, so the consumer treats duplicate delivery as expected ([delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)). B2's PostgreSQL lease epoch, attempt ledger, budget reservations, cancellation fence, and atomic result publication remain authoritative. A retry after result commit reads the terminal Turn and ACKs without creating another Assistant Message.

The PostgreSQL outbox is written in the same transaction as the user Message and Assistant Turn. The API attempts a fast Queue send after commit to fit the current 60-second B1 deadline. If that send fails, the successful B1 receipt remains unchanged and the scheduled relay republishes the outbox row. The relay also inserts outbox rows for any historical running Turns that predate the hook, claims rows with `FOR UPDATE SKIP LOCKED`, and retries until the Turn is terminal. A crash after Queue send but before outbox update can produce another Queue message; the B2 lease fence handles it.

Workflows are not needed for the current workload. A Turn has a 60-second deadline and the configured provider attempt timeout is 20 seconds; Cloudflare Queue consumers allow up to 15 minutes of wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Queue redelivery plus the PostgreSQL outbox already provide retry and restart recovery without a second durable execution state. Workflows would duplicate retry state and add a second recovery path while B2 still has to check PostgreSQL before every claim and publication.

The Worker sets `limits.cpu_ms` to 30 seconds. This requires Cloudflare Workers Paid Standard: Free allows only 10 ms of CPU per invocation, while Paid defaults to 30 seconds. Paid currently starts at $5/account/month and includes 30 million CPU milliseconds and 10 million Worker requests per month; Queues includes 1 million operations/month, with usage above included amounts billed separately ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)). Provider network wait is not CPU time. No account plan or production CPU profile has been verified, so Free is not a deployment target for this runtime.

## Database access

Use two database identities:

- The B1 API identity (currently `ember_worker`) needs `INSERT` on `b1_turn_dispatch_outbox`; it writes the row inside the existing submit transaction. It sends the Queue hint only after commit.
- The runtime identity should be a separate, non-superuser Hyperdrive credential. Grant it `SELECT` and `UPDATE` on `assistant_turns` and `conversations`; `SELECT` and `INSERT` on `conversation_messages`; `SELECT` on `consumers`; and `SELECT`, `INSERT`, and `UPDATE` on `model_turn_attempts`, `model_budget_incidents`, `model_global_spend_days`, `model_spend_days`, and `b1_turn_dispatch_outbox`. It does not need `DELETE`, role membership, or schema ownership.

The runtime is a trusted cross-tenant service, so it can scan the outbox. Queue fields never establish tenant authority: the consumer compares the supplied tenant and Turn IDs to the outbox row, then passes only the PostgreSQL-derived identity to B2. B2 queries remain tenant-qualified. Do not give the API identity the runtime grants. Hyperdrive supports the `pg` driver used here ([PostgreSQL with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)).

## Queue names

The default PoC names are `ember-assistant-turns` and `ember-assistant-turns-dlq`. An isolated deployment may override the consumer's expected names with the non-secret Wrangler variables `EMBER_TURN_DISPATCH_QUEUE_NAME` and `EMBER_TURN_DISPATCH_DLQ_NAME`. Leave either variable unset to use its default. The runtime's Queue producer/consumer bindings and the API's producer binding must use the same queue names; the values only select the consumer path and do not change the PostgreSQL outbox or message contract.

## Provision and deploy

1. Confirm the Cloudflare account uses Workers Paid Standard. Apply repository migrations, including `0018_b1_turn_dispatch_outbox.sql`, using the normal database migration identity. The migration creates only the outbox table, its tenant-qualified foreign key, and dispatch indexes.
2. Create the `ember-assistant-turns` and `ember-assistant-turns-dlq` Queues. Create a dedicated Hyperdrive configuration backed by the runtime database identity above, then replace `REPLACE_WITH_RUNTIME_HYPERDRIVE_ID` in `wrangler.jsonc` with that configuration ID. Keep the API Hyperdrive binding separate.
3. Keep `EMBER_ENV=production` and `EMBER_MODEL_EXECUTION=disabled` for initial deployment. The Worker can ACK and retain a pending Turn without invoking Fake Model or expiring it. Add the provider key only after model approval; enable `real` execution only with the approved provider/model and budget settings.
4. Confirm the B1 API Worker has the Queue producer binding and writes the outbox row transactionally. Deploy the API Worker and this runtime, then inspect Queue deliveries, DLQ, relay errors, and the Turn/message read endpoints.
5. Run `pnpm --filter @ember/cloud-async-runtime deploy` only after those resources and bindings are provisioned. `wrangler.jsonc` intentionally has a non-deployable Hyperdrive placeholder until then.

The Queue consumer uses batch size 1, four concurrent invocations, five retries, and a DLQ. The DLQ consumer marks the matching PostgreSQL outbox row due again; it does not change the Turn state. A one-minute Cron relay recovers rows whose API fast-send failed or whose Queue message exhausted retries, and it publishes only while model execution is enabled. With execution disabled, already-delivered messages are ACKed as pending and the relay stays paused, avoiding repeated Queue traffic; outbox rows remain durable and are picked up after execution is enabled. The relay lease lasts 30 seconds and the outbox retry window is 60 seconds after a successful send.

## Local verification

Install the pinned workspace dependencies, then run:

```sh
pnpm exec vitest run --config vitest.unit.config.ts tests/unit/cloud-async-runtime.test.ts
TEST_DATABASE_URL=postgresql://lj@127.0.0.1:5432/postgres \
  pnpm exec vitest run --config vitest.integration.config.ts tests/integration/cloud-async-runtime.test.ts
pnpm --filter @ember/cloud-async-runtime build
pnpm --filter @ember/cloud-async-runtime exec wrangler deploy --dry-run --outdir /tmp/ember-cloud-runtime-dry-run --config wrangler.jsonc
```

The PostgreSQL integration uses the Fake Model gateway in `EMBER_ENV=test`; it writes a clearly simulated reply and never opens a provider socket. It verifies outbox-gap reconciliation, a persisted reply readable through B1 repositories, duplicate delivery, a simulated isolate crash after result commit, and cancellation during generation. The existing B2 Mock Provider integration separately covers budget refusal and a stubbed provider transport.

## Verified scope and release gate

Verified locally: PostgreSQL 17.11 migrations, the Queue relay/consumer integration path, B1 Turn and transcript reads, duplicate/restart/cancel behavior, unit tests, TypeScript build, and Wrangler dry-run bundling. The Wrangler dry run does not contact Cloudflare or a model provider.

Platform GO on Workers Paid Standard: Cloudflare Queues' at-least-once semantics fit this idempotent B2 path; the 15-minute consumer wall-time limit exceeds the current B1 deadline, and Hyperdrive supports the `pg` driver used here. Free-plan CPU is limited to 10 ms and has not been profiled here, so Free is NO-GO until separately measured. Workflows are unnecessary for this single bounded Turn attempt loop.

Deployment NO-GO until Workers Paid Standard is confirmed, the outbox migration is applied remotely, the dedicated runtime Hyperdrive credential and binding exist, the API Queue producer/outbox transaction is deployed, and model authorization is approved if real inference is to be enabled. No real cloud Turn execution or paid provider request is claimed by this change.
