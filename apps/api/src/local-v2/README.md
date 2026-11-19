# Ember V2-M1-F local Edge Worker

`createLocalV2EdgeWorker` returns a Worker-compatible `fetch` handler for a
loopback runtime host. The host supplies B1 sessions, an Agent Head-backed
`/v1/me` projection, and a resolver from verified identity to the canonical
Agent Head RPC stub. Session, conversation and attachment routing use trusted
host ports. The production API entry point does not import this module.

The B1 chat routes return the existing receipts, transcript pages and Turn
DTOs. B1 submissions select the durable queue with the original 60-second
deadline. The Agent Head creates the dispatch obligation and grants no
interactive lease on that path. Unknown ACKs reconcile through
`GET /v1/message-submissions/{client_submission_id}`.

Supplying the fake streaming gateway enables the local-only
`POST /v2/conversations/{id}/messages/stream` experiment. Clients receive
`turn.accepted`, provisional `turn.delta` frames, and an acknowledgement of
a successful commit or handoff. On reconnect, read the authoritative Turn and
transcript cursor through the B1 endpoints. A submission replay returns the
original receipt and opens no provider stream.

The executor checks a positive simulated global reservation and the
`markAttemptSent` authorization before starting the Fake Provider. Active
streams renew 45-second leases every 15 seconds. At 110 seconds the executor
can hand off the original job handle to Durable. The original total deadline
caps both the interactive stream and job queries. The host must share the
same fake provider job store between the Edge and Durable executors for
query-only recovery. The store retains simulated provider usage by operation
ID for accounting queries beyond the user-facing deadline.

After an abort, the executor can observe the single pending provider read for
up to one second. It sends known usage through the host's accounting-only
reporter for the original attempt when publication is fenced or its commit
ACK is uncertain. The reporter has a separate one-second wait budget and
must be idempotent alongside commit and recovery. It receives numeric usage
and attempt identifiers. Turn state, publication and settlement revisions
live in Agent Head and Global Budget.

Run the local contract and loopback transport tests with
`pnpm test:unit tests/unit/local-v2-edge-worker.test.ts`. The tested host uses
mock RPC and a test provider store. The shared Agent Head RPC, Global Budget
and Queue bindings are required for the separate local workerd acceptance.
