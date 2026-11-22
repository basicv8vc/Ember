# Product Alpha — Agent F: V2 Daytona Provider-Canary Readiness & Approval Request

Status: **V2 real Daytona adapter & decoupled configuration implemented and locally verified (zero external spend); awaiting CTO review and separate Founder authorization before any real Daytona provider-canary call.**  
Owner: Agent F (Tools & Execution)  
Date: 2026-11-22  
Related: [Integrated Acceptance Plan](./PRODUCT-ALPHA-INTEGRATED-ACCEPTANCE-PLAN.md), [Product Alpha Roadmap](./PRODUCT-ALPHA-ROADMAP.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md), [V2 Staging Authorization](../V2-STAGING-DEPLOYMENT-AUTHORIZATION.md), [P0-C4 Daytona Security Gap Report](../P0-C4-DAYTONA-SECURITY-GAP-REPORT.md)

---

## 1. Approval Request Summary

No real Daytona sandbox has been created or billed during Product Alpha V2 execution. This document adapts the Daytona canary readiness checklist to the **V2 isolated staging path** (`ember-v2-staging`) and requests **separate CTO review + Founder authorization** for a **single bounded V2 Daytona provider-canary** to close the real-sandbox acceptance gate for _"Analyze data and deliver a file"_:

- **Requested canary scope (1–3 synthetic runs, allowlisted internal/Founder tenant only):**
  - Stage a synthetic CSV (`< 10 KiB`, no personal/user data) via `POST /v1/me/uploads`.
  - Exercise both:
    1. Natural-language chat delegation (`POST /v1/conversations/:id/messages` or `POST /v2/conversations/:id/messages/stream` with `attachment_ids` → `delegate_python_agent`), and/or
    2. Direct bounded Python task submission (`POST /v2/tasks/python`).
  - Execute inside `ember-v2-staging` Queue Worker (`apps/api/src/local-v2/runtime-durable.ts` → `python-agent-runner.ts` → `DaytonaSandboxProvider` / `DaytonaSdkSandboxClient`).
  - Verify bounded Python execution, progress events (`GET /v1/me/tasks/:id/events`), authorized downloadable output artifact (`GET /v1/me/tasks/:id/artifacts` + `GET /v1/me/artifacts/:artifactId`) with SHA-256 integrity, and confirmed sandbox destruction (`0` live sandboxes after completion or cancellation).
- **Explicitly NOT requested here:**
  - Broad tenant rollout or V1/V2 production cutover.
  - External connectors, outbound network egress from sandboxes (`networkBlockAll: true`), or new subscriptions.
  - Changing V1 wire contracts or shared schemas.

---

## 2. Decoupled Configuration & Fail-Closed Guardrails

Sandbox provider selection is explicitly decoupled from LLM mode (`EMBER_MODEL_MODE`) via `resolveV2SandboxConfig(env)` in `apps/api/src/local-v2/runtime-config.ts`:

- `EMBER_SANDBOX_MODE="fake"` (default in `wrangler.local-v2.jsonc` and `wrangler.v2-staging.jsonc`): uses the zero-spend local fake executor; enabling real LLM (`EMBER_MODEL_MODE="real"`) cannot implicitly enable paid Daytona or disable the permitted fake sandbox path.
- `EMBER_SANDBOX_MODE="disabled"` or unset: fails closed (`sandbox_mode_unset` / `sandbox_disabled`) even if `DAYTONA_API_KEY` is bound.
- `EMBER_SANDBOX_MODE="daytona"`: requires non-empty `DAYTONA_API_KEY` and a non-empty, validated tenant UUID allowlist (`EMBER_DAYTONA_ALLOWED_TENANTS`); fails closed (`daytona_allowlist_missing`, `daytona_allowlist_invalid`, or `sandbox_tenant_not_allowed`) before any model call or sandbox creation.
- Model execution pairing: uses the approved `V2StreamingModelGateway.stepPythonAgent` with real `ModelRateRow`, `budgetMode: 'real'`, and `simulated: false` (no fallback to `FakeModelGateway`; fails closed with `model_gateway_unavailable` if unavailable), `EMBER_MODEL_ALLOW_RECURRING_BRIEFS="false"`, and `/v2/tasks/python` ingress allowlist (`authorizeModelTurn`) + `EMBER_MODEL_ALPHA_TENANT_IDS` enforcement.

---

## 3. Hard Runtime & Spend Bounds (Code-Enforced on V2 Path)

All limits below are enforced in `packages/contracts/src/task-schemas.ts` (`PYTHON_AGENT_LIMITS`), `packages/runtime-v2/src/agent-head/task-artifact-service.ts`, `packages/runtime-v2/src/agent-head/state-machine.ts`, `apps/api/src/local-v2/python-agent-runner.ts`, and `packages/sandbox-daytona/src/provider.ts`:

| Control                                   | Enforced Bound                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox profile                           | `daytona-small`, `sandboxClass: 'container'`, `ephemeral: true`, `networkBlockAll: true` (`deny-all`, verified post-create; fails closed with `POLICY_DENIED`)                                                                                                                                                       |
| Wall-clock lifetime / exec timeout        | `sandboxLifetimeSec <= 120s`, `execTimeoutMs <= 60s`, `readyDeadlineMs <= 90s`, task `deadline_at_ms <= 120s`                                                                                                                                                                                                        |
| Per-Run / Per-Task caps                   | `<= 1` sandbox/run, `<= 3` Python execs/run (`<= 4`/task), `<= 4` LLM calls/run (`<= 6`/task)                                                                                                                                                                                                                        |
| Model spend ceiling                       | `maxTaskCostMicroUsd = 30,000` (`$0.03` max per task), plus DO + `GlobalBudgetDO` daily principal/tenant/global ceilings                                                                                                                                                                                             |
| File & artifact bounds                    | `<= 1 MiB` V2 inline DO artifact cap (`V2_MAX_INLINE_ARTIFACT_BYTES`, within `15 MiB` `maxFileBytes`), `<= 32 MiB` aggregate per task (`maxTaskTotalFileBytes`), `<= 5` output artifacts, blocked active web MIME types (`text/html`, `image/svg+xml`, JS), safe ASCII filenames only, symlinks/directories rejected |
| Estimated Daytona compute cost (estimate) | `~$0.002–$0.005` per 1-minute `daytona-small` canary run (`< $0.05` total for the 1–3 run canary)                                                                                                                                                                                                                    |

---

## 4. Canary Execution & Kill-Switch Checklist (Post-Approval Only)

1. **Pre-flight (non-paid dry run + config validation):**
   - Run the G4 preflight check from the repo root (validates isolated staging topology, strict G3+G4 budget ceilings, `EMBER_SANDBOX_OWNER="ember-v2-staging:canary"`, and dry-runs `wrangler deploy --dry-run`):
     ```bash
     node infra/cloudflare/v2-staging-preflight.mjs \
       --allow-real-llm-canary \
       --allow-daytona-canary \
       --model-mode=real \
       --sandbox-mode=daytona \
       --require-provisioned
     ```
   - Confirm staging secrets (`wrangler secret list --name ember-v2-staging --config apps/api/wrangler.v2-staging.jsonc`) include `EMBER_MODEL_API_KEY`, `EMBER_MODEL_ALPHA_TENANT_IDS`, `DAYTONA_API_KEY`, and `EMBER_DAYTONA_ALLOWED_TENANTS` (comma-separated canary tenant UUIDs), while plaintext config keeps `EMBER_SANDBOX_MODE="fake"` by default and overrides `daytona` only for the approved canary window.
   - Verify V1 (`ember-api.slowfast.dev`) shares zero Worker, Queue, D1, Hyperdrive, or R2 resources with `ember-v2-staging`.
2. **Run bounded canary (requires explicit Founder authorization):**
   - The standalone canary runner (`infra/cloudflare/v2-g4-daytona-canary.mjs`) refuses non-loopback targets unless `--confirm-founder-authorization` is explicitly supplied, uses a zero-PII synthetic CSV fixture (`< 1 KiB`), and verifies:
     - upload -> `/v2/tasks/python` (+ idempotent replay with `simulated: false` and expected `model_label`),
     - artifact download integrity (`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Length`, SHA-256, safe ASCII filenames, no blocked active web MIME types, zero duplicate filenames),
     - optional NL chat delegation (`--include-nl-chat`), and
     - in-flight cancellation (`cancel_requested_at_ms` -> `cancelled` with zero committed output artifacts).
     ```bash
     node infra/cloudflare/v2-g4-daytona-canary.mjs \
       --base-url https://ember-v2-staging.slowfast.dev \
       --bearer-token "$CANARY_BEARER_TOKEN" \
       --confirm-founder-authorization \
       --owner ember-v2-staging:canary \
       --include-nl-chat \
       --sweep-orphans
     ```
   - Record deployed SHA/version, task IDs, artifact SHA-256, measured latency, and observed cost.
3. **Verify zero leaked sandboxes & zero duplicate artifacts:**
   - Confirm `DaytonaSandboxProvider.destroy()` succeeded and run the Daytona orphan sweep for `ember-v2-staging:canary` (must report `0` live sandboxes):
     ```bash
     DAYTONA_API_KEY="$DAYTONA_API_KEY" node infra/cloudflare/v2-g4-daytona-canary.mjs \
       --sweep-only \
       --owner ember-v2-staging:canary \
       --confirm-founder-authorization
     ```
   - Confirm `GET /v1/me/tasks/:id/artifacts` contains only bound inputs and winning committed outputs (no duplicate/uncommitted artifacts on retry or cancel).
4. **Immediate kill-switch / rollback:**
   - Set `EMBER_SANDBOX_MODE="fake"` (or `"disabled"`) in `ember-v2-staging` and/or delete `DAYTONA_API_KEY` secret -> `resolveV2SandboxConfig()` immediately stops all Daytona calls without disrupting chat turns, Memory, Schedules, or V1.
   - Or run `wrangler rollback <previous-version-id> --name ember-v2-staging --config wrangler.v2-staging.jsonc --yes`.

> **Current Status:** Code, preflight checks, synthetic canary runner, unit tests, and local `workerd` loopback integration verification are complete (`$0.00` external spend). **No live OpenRouter or live Daytona calls have been executed**; live G4 canary execution remains blocked pending explicit Founder authorization.

---

## 5. Cleanup Residual Risk & Bounded Lifetime Mitigation

- **Best-effort `finally` cleanup:** `executeV2PythonAgentTask` invokes `DaytonaSandboxProvider.destroy(sandboxId)` and `client.close()` in `finally`, which is best-effort rather than transactional (a hard Worker isolate termination or transient Daytona delete API failure can prevent immediate deletion).
- **Observability on cleanup failure:** If `destroy()` or `close()` fails, `python-agent-runner.ts` does not silently discard the failure: it emits a bounded, redacted structured incident (`v2_python_sandbox_cleanup_failed` with `tenantId`, `taskId`, `runId`, `owner`, `sandboxId`, and error code/name only—no secrets or raw messages) and records `sandbox_cleanup_failed` / `sandbox_close_failed` (or `:cleanup_failed` / `:close_failed` on failed runs) in `task_results.reason_code`.
- **Bounded orphan lifetime & recovery:** Every sandbox created via `DaytonaSandboxProvider.create()` sets `ephemeral: true`, `ttlMinutes <= 2` (`maxTtlMinutes: 5`), `autoStopIntervalMinutes: 2`, and `autoDeleteIntervalMinutes: 0`, plus `ember.owner` / `ember.tenant_id` / `ember.managed` labels. Residual orphan risk on `destroy()` failure or worker crash is therefore bounded to the <= 2–5 minute vendor TTL/idle-reclaim window, and `sweepOrphanedSandboxes` supports immediate operator sweep by `ember.owner`.
