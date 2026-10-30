# P0B-07d — Agent HTTP API (`POST /v1/agents` & `GET /v1/agents/:agentId`)

## Endpoints

Both endpoints require a bearer token accepted by the configured local-development tenant
authenticator (`requireTenantAuth`).

### `POST /v1/agents`

Creates a logical Agent and its initial version-0 Workspace for the authenticated tenant in one
PostgreSQL transaction.

- **Request headers**:
  - `Authorization: Bearer <token>` (required; mapped to a server-verified `AuthContext`).
  - `Content-Type: application/json` (required).
- **Request body** (`CreateAgentRequestSchema`, bounded to `MAX_AGENT_BODY_BYTES = 4096` UTF-8 bytes):
  ```json
  {
    "name": "primary research agent"
  }
  ```
  - `name` (`AgentNameSchema`): required string, `1..128` characters, not whitespace-only, and free
    of ASCII control characters (`U+0000`–`U+001F`, `U+007F`).
  - Strict object validation (`z.strictObject`): any attempt to supply `tenant_id`, `tenantId`,
    `principal_id`, `principalId`, `policy_version`, `policyVersion`, `agent_id`, `workspace_id`,
    `workspace_version`, or any unknown property is rejected with `400 INVALID_ARGUMENT` before
    reaching persistence.
- **Response (`201 Created`)**:
  - Header: `Location: /v1/agents/<agent_id>` and `X-Request-Id: <request_id>`.
  - Body (`AgentDtoSchema`):
    ```json
    {
      "agent_id": "00000000-0000-4000-8000-000000000011",
      "name": "primary research agent",
      "policy_version": 1,
      "workspace_id": "00000000-0000-4000-8000-000000000022",
      "workspace_version": 0,
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
    ```

### `GET /v1/agents/:agentId`

Reads a tenant-owned Agent and its current Workspace pointer/version.

- **Path parameter**:
  - `:agentId` must be a valid UUID (`IdSchema`). A malformed UUID is rejected with `400 INVALID_ARGUMENT`
    before any database query runs.
- **Response (`200 OK` / `404 Not Found`)**:
  - `200 OK`: returns the `AgentDto` (`AgentDtoSchema`) when the Agent belongs to `ctx.tenantId`.
  - `404 Not Found`: returns the standard `NOT_FOUND` `ErrorResponse` (`"Resource not found"`) both
    when the Agent does not exist and when it belongs to another tenant.

## Transaction and isolation guarantees

1. **Single-transaction Agent + Workspace creation**: `createAgentRoutes` delegates to
   `PostgresAgentRepository.create(auth, command)`, which runs inside a single PostgreSQL
   transaction (`withTransaction`):
   - verifies that `(ctx.tenantId, ctx.principalId)` exists in `principals` (otherwise throws
     `UNAUTHENTICATED` → `401`);
   - inserts the `agents` row with `policy_version = ctx.policyVersion`;
   - inserts the `workspaces` row with `(tenant_id, agent_id)` primary key and `version = 0`;
   - commits before returning `201 Created`. Any failure on either insert or on `COMMIT` rolls
     back both tables so a half-initialized Agent or orphan Workspace can never persist.
2. **Tenant isolation and non-disclosure**:
   - `tenantId`, `principalId`, and `policyVersion` come exclusively from `AuthContext`.
   - `PostgresAgentRepository.get(auth, agentId)` filters by `WHERE a.tenant_id = $1 AND a.id = $2`.
   - Foreign-tenant and non-existent Agent IDs return the exact same `404 Not Found` status and
     error structure.
3. **Response schema enforcement and redaction**:
   - `toAgentDto()` copies only the seven public wire fields and validates the result with
     `AgentDtoSchema` (`z.strictObject`). Internal columns (`tenant_id`, `principal_id`,
     `manifest_ref`), SQL text, and driver diagnostics are never serialized or logged.

## Validation

Automated coverage is in:

- `tests/unit/api-agent-http.test.ts` (13 unit tests): `201 Created` + `Location` header +
  `AgentDtoSchema` validation, `AuthContext` propagation, `401` on missing/malformed/unknown
  tokens, `400` on forged tenant/principal/policy/workspace fields, `name` length/blank/control-char
  bounds, `4 KiB` body cap boundary, malformed JSON / content-type checks, indistinguishable `404`
  for missing vs. cross-tenant agents, `400` for non-UUID `:agentId`, and `503` fail-closed mapping
  when the store is unconfigured, throws `DB_UNAVAILABLE`, or returns a corrupted row.
- `tests/integration/http-agent-api.test.ts` (11 real PostgreSQL 17 integration tests): covers all
  11 required end-to-end scenarios against a migrated throwaway schema (`ember_it_<hex>`),
  including independent `observerPool` commit verification, uncommitted transaction invisibility,
  cross-tenant `404` indistinguishability, forged `tenant_id` / `tenantId` rejection with zero DB
  writes, 24-way concurrent creation across Tenant A and Tenant B, and injected workspace/commit
  trigger failures proving atomic rollback.

## Known limits

- Listing (`GET /v1/agents`), updating, or deleting Agents is out of scope for P0B-07d.
- `POST /v1/agents` creates a new logical Agent on each call; idempotency keys are defined on
  `POST /v1/tasks` rather than Agent creation in P0-B.
- An Agent's initial `policy_version` is taken from the authenticated credential's `AuthContext`
  (`EMBER_DEV_AUTH_TENANT_<SLOT>_POLICY_VERSION`, defaulting to `1`).
