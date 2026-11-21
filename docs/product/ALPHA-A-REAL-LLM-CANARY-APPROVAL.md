# Product Alpha — Agent A: V2 Bounded Real-LLM Canary Approval Request

**Status:** Implementation ready & locally verified with mock transport (`EMBER_MODEL_MODE="fake"` remains active on staging). **Awaiting CTO review of implementation + separate Founder authorization before binding secrets or enabling real external LLM calls.**  
**Owner:** Agent A (V2 Staging & Real LLM)  
**Date:** 2026-11-21  
**Related:** [PRODUCT-ALPHA-INTEGRATED-ACCEPTANCE-PLAN.md](./PRODUCT-ALPHA-INTEGRATED-ACCEPTANCE-PLAN.md), [V2-STAGING-DEPLOYMENT-AUTHORIZATION.md](../V2-STAGING-DEPLOYMENT-AUTHORIZATION.md), [OPENROUTER-AND-P1-SECURITY.md](./OPENROUTER-AND-P1-SECURITY.md), [ALPHA-F-DAYTONA-CANARY-READINESS.md](./ALPHA-F-DAYTONA-CANARY-READINESS.md)

---

## 1. Requested Decision Summary

This request asks for:

1. **CTO review & merge approval** for the V2 real-LLM gateway wiring (`apps/api/src/local-v2/model-runtime.ts`, `edge-worker.ts`, `interactive-executor.ts`, `runtime-durable.ts`, `runtime-head.ts`, `runtime-worker.ts`).
2. **Separate Founder authorization** to execute a **bounded, allowlisted real-LLM canary** on the isolated V2 staging Worker (`https://ember-v2-staging.slowfast.dev`) after merge.

Explicitly **OUT OF SCOPE**:

- Production deployment, V1 traffic cutover, or real-user data migration.
- Enabling real Daytona sandboxes (`EMBER_SANDBOX_MODE` remains explicitly decoupled and defaults to `"disabled"` when `EMBER_MODEL_MODE="real"`).
- Any unallowlisted tenant or open public traffic.

---

## 2. Chosen Provider, Model & Verified Routing

Reuse the existing code-owned `stagingAlpha` grant in `packages/model-gateway/src/rates.ts` (`APPROVED_REAL_MODELS`) and `infra/staging/model-authorization.json`:

| Property         | Pinned Value                                                                                                        | Basis / Policy                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Provider         | `openrouter`                                                                                                        | Fixed `https://openrouter.ai/api/v1/chat/completions`, `redirect: 'manual'`, `credentials: 'omit'`               |
| Model ID         | `deepseek/deepseek-v4.1-flash-1017` (canonical `deepseek/deepseek-v4.1-flash-20261017`)                             | Supports text, image input, and closed tools (`save_personal_memory`, `create_proactive_schedule`, `delegate_*`) |
| Upstream Routing | `only: ['deepinfra']`, `allow_fallbacks: false`, `data_collection: 'deny'`, `zdr: true`, `require_parameters: true` | Code-pinned in `APPROVED_REAL_MODELS`; caller cannot override                                                    |
| Reasoning Effort | `none`                                                                                                              | Code-pinned on rate row                                                                                          |
| Published Rate   | `$0.098 / 1M` input tokens, `$0.294 / 1M` output tokens                                                             | `provenance: 'official_price_verified'` (`openrouter-deepseek-v4.1-flash-1017-deepinfra-fp8-2026-11-17`)         |
| Existing Grant   | `EMBER-CLOUD-INTERNAL-VISION-MULTI-TURN` (approved by CTO 2026-11-17)                                               | `executionPurpose: 'staging_alpha'`, `maxProviderAttemptsPerTurn: 1`                                             |

---

## 3. Bounded Request, Token & Cost Caps

All ceilings are enforced server-side before any outbound provider call (`AgentHeadDO` + `GlobalBudgetDO` + `preflightConversationTurn`):

| Control                      | Proposed Canary Value                                                                                    | Code Enforcement                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant allowlist             | `EMBER_MODEL_ALPHA_SCOPE="allowlist"`, `EMBER_MODEL_ALPHA_TENANT_IDS="<founder-v2-tenant-uuid>"`         | Checked before `prepareTurn` / `reserveTaskModelAttempt`; unallowlisted tenants get `403 POLICY_DENIED`                                                   |
| Apple Subject allowlist      | `EMBER_V2_STAGING_ALLOWED_SUBJECTS="<founder-apple-sub>"`                                                | Enforced at `/v1/auth/session`                                                                                                                            |
| Input token cap              | `<= 8,000` tokens (`maxContextMessages: 8`, `maxContextChars: 12,000`)                                   | `preflightConversationTurn` refuses pre-send (`not_sent`)                                                                                                 |
| Output token cap             | `<= 512` tokens (`max_completion_tokens`)                                                                | Passed in every Chat Completions payload                                                                                                                  |
| Max attempts per turn        | `1`                                                                                                      | Single-shot HTTP Chat Completions has no resumable job handle; failed/interrupted sends settle conservatively as `unknown_billed` with zero blind retries |
| Per-attempt reservation      | `$0.000935` (`935` micro-USD worst-case at `8,000` in + `512` out), ceiling `$0.005` (`5,000` micro-USD) | `AgentHeadDO` + `GlobalBudgetDO`                                                                                                                          |
| Daily principal / tenant cap | **`$0.05` / day** (`50,000` micro-USD) and **`20` turns / day**                                          | `EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_MICRO_USD`, `EMBER_MODEL_BUDGET_TENANT_DAILY_MICRO_USD`, `EMBER_MODEL_BUDGET_PRINCIPAL_DAILY_TURNS`                   |
| Daily global cap             | **`$0.10` / day** (`100,000` micro-USD)                                                                  | `GLOBAL_DAILY_CEILING_MICRO_USD="100000"` + `EMBER_MODEL_BUDGET_GLOBAL_DAILY_MICRO_USD="100000"`                                                          |
| Provider key hard limit      | **`$1.00` lifetime spend cap** on dedicated OpenRouter project key                                       | Operator-configured on OpenRouter before `wrangler secret put`                                                                                            |
| Sandbox isolation            | `EMBER_SANDBOX_MODE="disabled"` (or explicit `"fake"`)                                                   | Decoupled from `EMBER_MODEL_MODE`; never activates Daytona                                                                                                |

---

## 4. Credentials Handling

- Store the `$1`-capped OpenRouter key **only** as an encrypted Cloudflare Worker secret on `ember-v2-staging`:
  ```sh
  pnpm --filter @ember/api exec wrangler secret put EMBER_MODEL_API_KEY --name ember-v2-staging --config wrangler.v2-staging.jsonc
  ```
- Never place `EMBER_MODEL_API_KEY` in `wrangler.v2-staging.jsonc`, git, logs, `model_attempts`, or evidence files.
- `ModelCredential.parse()` rejects placeholders, non-`sk-` keys, or keys `< 20` characters at boot.
- Error responses from OpenRouter never read or forward provider response bodies (`statusToFailureCode` maps to closed `ModelFailureCode`).

---

## 5. Expected Canary Evidence (Synthetic Fixtures First)

After Founder sign-off and allowlisting:

1. Synthetic / non-sensitive canary turn on Fast Path (`POST /v2/conversations/:id/messages/stream`) and Durable Queue (`POST /v1/conversations/:id/messages`):
   - Verify `simulated: false`, `model_label: "deepseek/deepseek-v4.1-flash-1017"`, valid `observed_cost_micro_usd` settlement in `AgentHeadDO` and `GlobalBudgetDO`.
2. Synthetic tool calls (only with synthetic inputs, never real personal data without explicit permission):
   - Memory save (`save_personal_memory`) -> recall in new conversation.
   - Natural-language schedule (`create_proactive_schedule`) -> durable `model_brief` firing with `enablePersonalMemorySaveTool=false` / `enableProactiveScheduleTool=false`.
3. Reconcile OpenRouter dashboard spend against `GlobalBudgetDO` / `AgentHeadDO` ledger.

---

## 6. Kill Switch & Immediate Rollback

1. **Instant secret kill switch** (halts real model egress immediately on boot/invocation):
   ```sh
   pnpm --filter @ember/api exec wrangler secret delete EMBER_MODEL_API_KEY --name ember-v2-staging --config wrangler.v2-staging.jsonc
   ```
2. **Instant Worker rollback to `fake` mode** (`EMBER_MODEL_MODE="fake"`):
   ```sh
   pnpm --filter @ember/api exec wrangler rollback 6b23e931-a9c1-466c-b6e4-1b4092cbbf36 --name ember-v2-staging --config wrangler.v2-staging.jsonc --yes
   ```
3. `infra/cloudflare/v2-staging-preflight.mjs` continues rejecting `EMBER_MODEL_MODE !== "fake"` in checked-in `wrangler.v2-staging.jsonc` until explicit authorization is recorded.

---

## 7. Sign-Off Checklist

- [ ] **CTO Implementation Review:** Approve V2 real-LLM gateway & budget/unknown-outcome wiring PR.
- [ ] **Founder Canary Authorization:** Authorize setting `EMBER_MODEL_API_KEY` (`$1` lifetime cap), `EMBER_MODEL_ALPHA_TENANT_IDS`, `EMBER_V2_STAGING_ALLOWED_SUBJECTS`, and `EMBER_MODEL_MODE="real"` on isolated `ember-v2-staging` under the `$0.10/day` global cap above.
