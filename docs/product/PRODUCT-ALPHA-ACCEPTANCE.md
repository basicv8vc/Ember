# Ember — Product Alpha Independent Acceptance Matrix

**Owner:** Agent D (Independent QA & Acceptance)  
**Baseline:** `origin/main @ ea85eab` (2026-11-20)  
**M2-D1 Physical iPhone Gate:** **PASS (6/6 on physical `iPhone 12 Pro Max`)**  
**Overall Product Alpha Gate:** **IN PROGRESS — Local/Physical M2 & Core Slices Verified; Blocked on `#213` CTO Approval, Staging Redeploy of Latest `main`, & Real-Provider Approvals**

> Local `workerd`, local PostgreSQL, fake provider, and iOS Simulator passes are development/pre-staging evidence only and do **not** satisfy real-provider or deployed-staging Alpha acceptance gates defined in [PRODUCT-ALPHA-ROADMAP.md](./PRODUCT-ALPHA-ROADMAP.md).

---

## 1. Five Product Alpha Scenarios (`origin/main @ ea85eab`)

| # | User-Visible Scenario | Local / Physical QA | Integrated Staging / Real-Provider Acceptance | Tested Commit / PR | Remaining Blockers |
| --- | --- | --- | --- | --- | --- |
| 1 | **Remember my preference** | **PASS** — V2 `workerd` (`1/1`, `2.45s`), iOS `PersonalMemoryTests` (`4/4` incl. `429 BUDGET_EXCEEDED`), in-place `PATCH` edit merged (`#215`, `#224`) | **BLOCKED (staging redeploy + real model)** | Merged `#206`, `#210`, `#215`, `#222`, `#224` (`ea85eab`) | Live `ember-v2-staging.slowfast.dev` currently returns `404` on `/v2/memories` until Agent A redeploys from latest `main`; real LLM provider approval still required. |
| 2 | **Prepare my morning brief** | **Backend PASS** (`#213` `workerd` `2/2`, unit `8/8`); **iOS UI Merged** (`#219`, `ProactiveScheduleTests` `3/3`) | **BLOCKED (CTO approval + staging redeploy)** | iOS merged `#219` (`d23e8aa`); backend open `#213` (High risk) + `#218` + `#225` | CTO High-risk approval for `#213` (DO migration v7 + core schedule/alarm runtime), fix `#218` pagination defect, redeploy `ember-v2-staging`, real LLM approval. |
| 3 | **Analyze data and deliver a file** | **PASS** — Local HTTP+Postgres E2E (`b3-python-agent-http.test.ts` `2/2`, `9.04s`), `cloud-async-runtime` fake sandbox merged (`#223`), iOS live `TaskDetailView` progress merged (`#216`) | **BLOCKED (real Daytona approval)** | Merged `#211`, `#216`, `#223` (`ea85eab`); Daytona checklist `#212` | Separate CTO/Owner approval for real Daytona provider canary (`#212`). |
| 4 | **Follow up on something** | **Backend PASS** (`#213` one-time reminder + cancellation in `workerd`); **iOS UI Merged** (`#219`) | **BLOCKED (CTO approval + staging redeploy)** | Same as Scenario 2 | Same gates as Scenario 2 (`#213` CTO approval + staging redeploy + integrated app-restart verification). |
| 5 | **Use the appropriate executor** | **PHYSICAL iPHONE PASS (6/6)** — `iPhone 12 Pro Max` (`00008101-000E0D923E01001E`) via isolated `LocalDeviceAdapter` over private LAN `192.168.1.19` | **M2-D1 PHYSICAL GATE PASSED** (see [v2-m2-d1-physical-acceptance-report.md](../architecture/v2-m2-d1-physical-acceptance-report.md)) | `06071f9` (physical 6/6 PASS) | Cloud-staging device-executor routing check after staging redeploy. |

---

## 2. Live V2 Staging Smoke & V1 Non-Regression (`origin/main @ ea85eab`)

Executed `node infra/cloudflare/v2-staging-smoke.mjs` on 2026-11-20:
- `[PASS] v2_healthz`: `https://ember-v2-staging.slowfast.dev/healthz` → HTTP `200`
- `[PASS] v2_readyz`: `https://ember-v2-staging.slowfast.dev/readyz` → HTTP `200` (`23ms`)
- `[PASS] v2_me_unauthenticated`: HTTP `401`
- `[PASS] v2_dev_provider_denied`: HTTP `404` (`DENY_DEV_PROVIDER` active)
- `[PASS] v1_healthz`: `https://ember-api.slowfast.dev/healthz` → HTTP `200`
- `[PASS] v1_readyz`: `https://ember-api.slowfast.dev/readyz` → HTTP `200` (`15ms`)
- Result: **`EMBER_V2_STAGING_SMOKE_OK`**

---

## 3. Independent Peer Reviews & QA Gates Completed (2026-11-20)

| PR | Owner / Scope | Tested SHA | Agent D Result | Key Evidence / Notes |
| --- | --- | --- | --- | --- |
| `#206` | Agent B1 — Personal Memory vertical slice | `f8a631b` → merged | **PASS** | 13/13 unit, 1/1 `workerd`, schema v6 + principal isolation verified. |
| `#207` | Agent C2 — Chat pull-to-refresh & offline recovery | `2350792` → merged | **PASS / APPROVED** | 20/20 iOS tests (`SWIFT_STRICT_CONCURRENCY=complete`). |
| `#210` | Agent C3 — iOS Personal Memory UI | `3bc781c` → merged | **PASS / APPROVED** | Caught & verified fixes for raw localization keys + HTTP `429 BUDGET_EXCEEDED` mapping; 4/4 `PersonalMemoryTests`. |
| `#211` | Agent F1 — Bounded `python.agent` task + artifact | `976af9d` → merged | **PASS / APPROVED** | 13/13 unit + 2/2 local HTTP+Postgres E2E. |
| `#213` | Agent E — Proactive schedules runtime & `/v2/schedules` | `3e3c140` | **PASS (pending CTO)** | 8/8 unit + 2/2 `workerd`; flagged `/v2/schedules` route alignment + DO migration v7. |
| `#214` | Agent A4 — Isolated V2 staging deploy | `7e70e87` → merged | **PASS** | 40/40 unit + `v2-staging-preflight.mjs --require-provisioned`. |
| `#215` | Agent B2 — `PATCH /v2/memories/:memoryId` | `e4f2383` → merged | **PASS / APPROVED** | 12/12 unit + 1/1 `workerd`. |
| `#216` | Agent C4 — `TaskDetailView` live bounded polling | `b6315b5` → merged | **PASS / APPROVED** | 9/9 iOS tests (`SWIFT_STRICT_CONCURRENCY=complete`). |
| `#221` / `#224` | Agent C6 — iOS in-place Personal Memory editing | `7cb36f8` → merged | **PASS / APPROVED** | Contract & generation-guard review verified. |
| `#226` | Agent C7 — iOS isolated V2 Staging (`--ember-v2-staging`) | `b2ad56e` | **PASS / APPROVED** | 9/9 iOS tests (`V2StagingIntegrationTests` 2/2, `PersonalMemoryTests` 4/4, `ProactiveScheduleTests` 3/3). |

---

## 4. Open Decisions / Actions Blocking Product Alpha Exit

1. **CTO High-risk approval**: `#213` (Proactive Schedules DO migration v7 + core alarm/recovery runtime).
2. **V2 Staging Redeploy**: Redeploy `ember-v2-staging` from latest `main` (+ `#213` once merged) so `/v2/memories` and `/v2/schedules` are live on `ember-v2-staging.slowfast.dev` for Founder daily-use testing via `--ember-v2-staging` (`#226`).
3. **Real-Provider Approvals**: Separate approval for real LLM provider canary and real Daytona sandbox canary (`#212`).
