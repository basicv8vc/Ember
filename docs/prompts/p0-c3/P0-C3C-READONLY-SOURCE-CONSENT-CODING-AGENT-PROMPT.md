# Ember P0-C3C — Read-Only Source Port & Consent Boundary Coding Agent Prompt (v0.1)

> Role: Coding Agent C / Connector Trust Boundary Engineer.
>
> Status: PROPOSED. **No implementation before CTO approval of the P0-C3 doc PR, PR #43 merged confirmation, and C3-0 shared contract freeze.**
>
> Read first: docs/P0-C3-ARCHITECTURE-AND-TASK-SPEC.md; docs/P0C-C-CREDENTIAL-EGRESS.md; P0-C2C wiring evidence. Resolve origin/main SHA at coding kickoff.

## Mission

Prepare a **provider-neutral, consent-aware, strictly read-only source interface** for a future Ember promise loop. For this round, deliver deterministic fixture sources with a provable zero-network default, plus a precise trust boundary for later real public-source or user-authorized connectors.

Do **not** activate real Gmail, Google Drive, private GitHub, OAuth, production secrets, webhooks, paid model providers, or network egress in this PR. The existing Sentinel network.egress/credential.use hard-deny policy remains intact.

## Ownership / exact file boundaries

Allowed:

- New packages/connectors/** (including its own package.json, tsconfig and src/**).
- New tests/unit/p0c3-source-_.test.ts, tests/integration/p0c3-source-_.test.ts when fixture-only.
- docs/P0C3-C-SOURCE-CONSENT.md.
- Append-only root workspace project references, unit Vitest includes and pnpm-lock.yaml **only if necessary** to register @ember/connectors. C is sole owner of these specific root files in this round.

Forbidden: packages/contracts/**, packages/postgres/**, migrations/**, packages/execution/**, apps/worker/**, apps/api/**, apps/ios/**, packages/credentials/src/broker.ts or existing credential lifecycle code, historical evidence and CI files. No Worker composition root wiring in this PR.

Treat SourceReader, SourceProfile, TrustedSourceAccessContext and ConsentGrant as **structural ports** until A freezes shared interfaces. C must not define a conflicting public DTO or require B to import an unmerged package.

## Required implementation

1. SourceReader and bounded result
   - Interface supports readSnapshot(profile, trustedContext, signal): Promise<SourceSnapshot>. Profile is an opaque server-owned reference, **not** a caller-provided URL.
   - Snapshot has source_profile_id, observed_at, stable digest and strictly bounded safe items. Deep freeze or defensive copy returned objects to prevent test-caller mutation.
   - Every field has length/size ceilings; no raw credential reference or secret-bearing URL path/query. Errors are static codes, not the original exception message.
   - A FakeSourceReader returns deterministic snapshots by fixture/scenario seed. It performs exactly zero network connections and zero filesystem reads outside explicit fixtures.

2. Consent and access policy kernel
   - A server-owned policy lists allowed source profile IDs, read-only operations, tenant scope, optional expiry, max items/bytes and allowed source categories.
   - TrustedSourceAccessContext comes from verified server-side AuthContext/lease-derived binding, **never** directly from user JSON.
   - Missing, expired, wrong-tenant, revoked, empty or malformed grant must deny before calling the reader. A user's display label does not confer authority.
   - Implement in-memory FakeConsentRegistry only for deterministic tests and an interface for later durable grant storage. Never describe in-memory revocation as production-persistent.
   - Denial/audit results carry safe reason codes, hashed/opaque tenant and source IDs where useful; never raw tokens, prompts, headers, URL paths/query or exception stacks.

3. Future HTTP/connector hardening specification (design, not live activation)
   - Document HTTPS-only, exact host/path allowlists, method GET/HEAD only, bounded redirects (prefer none), response size, timeout, DNS/IP SSRF and private/link-local network restrictions, decompression limits, content-type limits and TLS validation.
   - A future real network policy exception **must** be gated through Sentinel and an explicit CTO security review; a new source plugin cannot turn network.egress into mock.read.
   - Document OAuth least privilege, explicit user consent, short-lived tokens, revocation and secrets isolation as **future work**, with no actual OAuth/token storage in P0-C3C.
   - Treat fetched text as hostile data (prompt injection). The output port supplies data, never instructions to change policy, call tools, or exfiltrate credentials.

4. Integration interface handoff
   - Export a narrow factory and source policy evaluator that B can inject into its runtime after Gate 3.
   - Document any needed durable grant repository for A's later migration rather than editing A-owned packages yourself.
   - Preserve the existing CredentialBroker as a synthetic control-plane facade. No calls to executeWithCredential in the live Worker for this lane.

## Mandatory adversarial tests

- Unknown source ID, wrong tenant, wrong operation, missing/expired/revoked grant: 0 reader callbacks and fixed denial code.
- Fake consent revocation during pending read: no new snapshot publish after cancellation; explicitly document limits of an already completed read.
- Prompt injection inside fixture text or metadata: never changes allowed source IDs, sentinel policy, action category or trusted context.
- Oversized source payload, control characters, malformed source identifiers, forged AuthContext and unexpected fields fail closed.
- Mutation attempts on exported constants and returned decisions/snapshots are rejected or cannot affect another tenant.
- Spy/intercept Node socket, HTTP/HTTPS, fetch and DNS paths under tests; network calls = 0.
- No production URL, bearer token, secret reference or raw provider error in serialized audit and user-facing output.
- Package typecheck/build and full existing unit regressions.

Quality gates, with true exit codes: pnpm install --frozen-lockfile; pnpm format:check; pnpm lint; pnpm typecheck; pnpm build; pnpm test:unit; pnpm test:integration; pnpm test:chaos; pnpm test:e2e; pnpm demo --scenario fast. Database-dependent tests may use CI PostgreSQL; unrun tests must be marked NOT RUN, not PASS.

## DoD and negative claims

- All default source operations use deterministic fixture data and make 0 real outbound calls.
- Denied or revoked operations perform 0 source callbacks.
- No caller-controlled URL, credential ref, tenant identity or policy override can cross into the trusted side.
- Future live source/provider HTTP and OAuth grant persistence remain **NOT IMPLEMENTED**.
- Real credential execution, external mutation and paid cloud/model cost remain **NOT IMPLEMENTED / NOT AUTHORIZED**.

## Draft PR handoff

Use clean independent worktree from actual post-docs-merge origin/main, feature/p0c-3c-readonly-source-consent. Create Draft PR titled “feat(connectors): P0-C3C source ports and consent-first fake adapters”.

Include exact base/head SHA, file boundary diff, trust boundary matrix, 0-network assertion evidence, static and dynamic tests with counts/exit codes, scope audit, declared future integration ports for A/B, rollback, and unimplemented capabilities. No auto-merge, external activation, secret ingestion or deployment.
