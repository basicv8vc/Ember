# Ember — Product Alpha Independent Acceptance Matrix

**Owner:** Agent D (Independent QA & Acceptance)  
**Baseline:** `origin/main @ ee34dd4` (2026-11-20)  
**Overall Product Alpha Status:** **IN PROGRESS / BLOCKED ON INTEGRATED STAGING, REAL PROVIDERS & PHYSICAL iPHONE**

> Local `workerd`, local PostgreSQL, fake provider, and iOS Simulator passes are development/pre-integration evidence only and do **not** satisfy real-provider, deployed staging, or physical iPhone acceptance gates defined in [PRODUCT-ALPHA-ROADMAP.md](./PRODUCT-ALPHA-ROADMAP.md).

---

## 1. Five Product Alpha Scenarios

| # | User-Visible Scenario | Local / Component QA | Integrated Real-Env Acceptance | Tested Commit / PR | Blockers & Next Action |
| --- | --- | --- | --- | --- | --- |
| 1 | **Remember my preference** | **Backend PASS** (`workerd` 1/1, unit 13/13); **iOS CHANGES REQUESTED** (`19d5808` — 2 defects found) | **BLOCKED** | Backend merged `#206` (`ee34dd4`); iOS open `#210` (`19d5808`) | Fix 2 defects in `#210`: (P1) `InlineNotice`/`EmptyPlaceholder` missing `tableName: "Conversation"` renders raw localization keys; (P2) `429 BUDGET_EXCEEDED` mapped to `.unavailable` instead of `.limitReached`. Then merge + verify on integrated V2 staging. |
| 2 | **Prepare my morning brief** | **Backend PASS** (`workerd` 2/2, unit 8/8) | **BLOCKED** | Backend open `#213` (`3e3c140`); iOS pending | Rebase `#213` onto `main` + bump DO migration v6→v7 + align PR docs/iOS on actual route `/v2/schedules` + CTO High-risk approval + iOS UI + staging deploy. |
| 3 | **Analyze data and deliver a file** | **Backend PASS / APPROVED** (unit 13/13, local HTTP+Postgres E2E 2/2) | **BLOCKED** | Backend open `#211` (`976af9d`); Daytona checklist merged `#212` (`b701f0c`) | Merge `#211`; obtain separate CTO/Owner approval for real Daytona canary (`#212`); verify end-to-end iOS artifact download on integrated build. |
| 4 | **Follow up on something** | **Backend PASS** (`workerd` one-time reminder + cancellation) | **BLOCKED** | Backend open `#213` (`3e3c140`); iOS pending | Same gates as Scenario 2 (`#213` rebase/v7/CTO approval + iOS UI + app-restart persistence E2E). |
| 5 | **Use the appropriate executor** | **Local `workerd` + Simulator E2E PASS (6/6)** | **BLOCKED** | Merged `#209` (`1664c39`) — see [v2-m2-d1-physical-acceptance-report.md](../architecture/v2-m2-d1-physical-acceptance-report.md) | Connect & unlock a physical iPhone on the same private LAN (`devicectl` shows all 3 paired physical iPhones `unavailable`) and run isolated `LocalDeviceAdapter` physical network E2E. |

---

## 2. Independent Peer Reviews & QA Gates Completed (2026-11-20)

| PR | Owner / Scope | Tested SHA | Agent D Result | Key Evidence / Notes |
| --- | --- | --- | --- | --- |
| `#209` | Agent D — M2-D1 simulator E2E + revocation relay + physical blocker report | `da75ed4` → merged `1664c39` | **MERGED** | 10/10 `workerd` M2, 24/24 iOS `CloudDeviceAdapterTests`, 6/6 real `Ember.app` Simulator E2E, `LocalDeviceAdapter` device build succeeded. |
| `#207` | Agent C2 — Chat pull-to-refresh & honest offline recovery | `2350792` → merged `413fc53` | **PASS / APPROVED** | 20/20 iOS tests passed (`SWIFT_STRICT_CONCURRENCY=complete`); protected outbox/rejected-draft/sign-out guards preserved. |
| `#206` | Agent B — Personal Memory vertical slice | `f8a631b` → merged `ee34dd4` | **PASS** | `build`/`typecheck`, 13/13 unit, 1/1 `workerd` integration; additive schema v6 + strict principal isolation verified. |
| `#211` | Agent F1 — Bounded `python.agent` data-processing task (fake sandbox) | `976af9d` | **PASS / APPROVED** | `build`/`typecheck`, 13/13 unit, 2/2 local HTTP+Postgres E2E (`1.15s`); strict in-memory path/size bounds & `mode === 'fake'` gate verified. |
| `#210` | Agent C3 — iOS Personal Memory UI (`/v2/memories`) | `19d5808` | **CHANGES REQUESTED** | 15/15 iOS tests passed, but 2 defects block merge: (P1) raw localization keys in `InlineNotice`/`EmptyPlaceholder`; (P2) HTTP `429` (`BUDGET_EXCEEDED`) mapped to `.unavailable` instead of `.limitReached`. |
| `#213` | Agent E — Proactive schedules runtime & `/v2/schedules` routes | `3e3c140` | **PASS (pending rebase/v7 + CTO)** | `build`/`typecheck`, 8/8 unit, 2/2 `workerd` integration (`2.95s`); flagged route path `/v2/schedules` (vs `/v2/agents/:agentId/schedules` in PR text) and DO migration v6→v7 bump. |

---

## 3. Open Decisions / Approvals Blocking Product Alpha Exit

1. **Physical iPhone access (M2-D1)**: Connect and unlock a paired physical iPhone on the Mac's private LAN to clear the physical network E2E gate.
2. **CTO High-risk approval**: `#213` (Proactive Schedules DO migration v7 + core recovery/alarm materialization) after rebase.
3. **Cloud staging & real-provider approvals**: V2 isolated staging deployment (`#208`) and real Daytona provider canary (`#212`).
