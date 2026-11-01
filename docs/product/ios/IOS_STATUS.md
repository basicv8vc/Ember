# Ember iOS — Status / CTO Review Request

> Updated: **2026-11-01 (Asia/Shanghai)**
> Mission: **IOS-LEAD-001 / M0 docs-only Draft PR**
> Initial code audit main SHA: **`f02075b7d8139149efdb6bc28ac05d7f5d764ae5`**
> Post-audit main refresh (2026-11-01): **`3b6c87092d856277d6b0fce71926a5f7fcd8bc06`** (merged PR #35; iOS HTTP routes unchanged)
> Verified Shua main SHA at audit: **`13711dcb1516f99ca95af7a084caf4e7bda496fe`**
> Draft PR: **see PR that contains this file**; actual PR number/head SHA must be taken from GitHub (this file intentionally avoids a guessed ID).

## Completed & verified (read-only evidence)

- Read `IOS_PRODUCT_LEAD.md` and `FIRST_MISSION_PROMPT.md` from main, both introduced by merged #36.
- Audited Git tree: current repo has TS API/Worker/CLI/Benchmark/contracts/PostgreSQL and tests; **no `apps/ios` or iOS Xcode project**.
- Code confirms authenticated local-dev HTTP Agent/Task/Event/SSE/Cancel/Approval/Artifact routes; server Task/Run/Workspace and tenant-scoped persistence. Test files are present for them. **No test command was executed in this docs-only session**.
- Only `mock.*` task kinds, FakeLLM/FakeSandbox, and mock approval. No production end-user Auth, server Task list, rich result text API, APNs or real safe model gateway detected in audited main.
- P0-B 10A/B/C merged via PRs #25/#26/#27 and CI evidence PR #28; top-level README's historical P0-B status/endpoints paragraphs lag behind actual code.
- P0-C1 policy/sandbox-smoke/credential foundations merged (#30–#32), P0-C2 prompt docs merged (#33–#34); **At original audit PR #35 was Draft; it subsequently merged into main** (`3b6c8709`). Its five changed files are a credential broker, tests and spec; it does not wire production Worker, real Vault, external egress or remote sandbox. P0-C2A #39 and P0-C2B #38 are still open at the refresh.
- Read Shua CoPaper specified five SwiftUI files (plus QuickSetup/Typography/Persona references) at pinned SHA; recorded decisions and risk in `IOS_UI_REFERENCE_AUDIT.md`.
- Prepared M0 design documents and three **unexecuted** Coding Agent prompt drafts; no mobile production code, login integration, paid service, deployment, or merge.

## Proposed (NOT implemented)

- First consumer-value cut: note paste → trustworthy cloud-generated action list delivered as durable Task outcome, iPhone-only capable; requires CTO-approved real cloud model route + identity + result API.
- M2 simulated SwiftUI interactive milestone, with explicit MOCK ONLY markings; M3 first authorized real-user pilot.
- Monorepo `apps/ios` and iOS 17+ recommended but not established. No UI/simulator result yet.

## Exactly three CTO decision requests (with recommendation)

| #      | Decision and owner                                                     | Recommended option                                                                                                                                                                                              | Alternative / impact                                                                                                          | Required response                                                             |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **D1** | **Mobile project baseline** (CTO)                                      | `apps/ios` in monorepo, iOS 17+, Apple native stack, single-owner Xcode project integration                                                                                                                     | Separate repo adds contract drift; iOS 16+ expands coverage but raises compatibility matrix                                   | Approve/change target/path before code                                        |
| **D2** | **Real user-value Platform gate** (CTO + Platform, Jia confirms value) | Bounded notes→action-items cloud execution using controlled Model Gateway **only after security/privacy/budget approval**, plus real account/default agent, Task Inbox and readable Result contracts            | Mac-coding hero-first excludes iPhone-only users and device security isn't ready; generic chat lacks promise/progress/outcome | Assign Platform owner and contract priority; choose privacy/usage constraints |
| **D3** | **Reliability/security release gates** (CTO)                           | Resolve unknown ACK via server-side authenticated idempotency lookup or approved protected outbox; postpone production human approval and APNs until ActionIntent and notifications privacy are designed/tested | Client-only caching may lose recoverability; enabling digest-only approval unsafe; fake APNs would be dishonest               | Approve gate order and owner; no release before resolution                    |

Requested review window: **next CTO review cycle** (suggest within 3 working days; not an assumed approval deadline). If decision not recorded, maintain blocked state and do not launch agents.

## Risks / blockers

- [BLOCKED] Real model, Auth, Task list/result gaps; iOS cannot launch as consumer App on current API.
- [BLOCKED] Production approval digest-only view; cannot safely communicate what would be authorized.
- [BLOCKED] iOS deployment target, auth/storage and app layout require CTO sign-off.
- [NOT RUN] All xcodebuild, Swift unit/UI/simulator, real API, notification and device tests.
- [OPEN] Repo main may advance; agents must fetch actual main and include SHA in each PR, not blindly reuse this audit base.

## Next three actions (owners)

1. **Jia → CTO**: forward design Draft PR for D1–D3 decision, record formal outcome in GitHub.
2. **CTO → Platform**: clarify secure identity/inbox/result/model contracts and Gate A, determine critical-path ownership.
3. **iOS Lead**, only after approval: freeze shared DTO/protocols, create Issues and separate worktree prompts, start up to three mobile Coding Agents with strict file boundaries.

## Document manifest

- `IOS_MVP_PRD.md` · `IOS_USER_JOURNEY.md` · `IOS_ARCHITECTURE_PROPOSAL.md`
- `IOS_API_DEPENDENCIES.md` · `IOS_UI_REFERENCE_AUDIT.md` · `IOS_SPRINT_PLAN.md`
- `agents/IOS_AGENT_A_UI_DESIGN.md` · `agents/IOS_AGENT_B_API_STATE.md` · `agents/IOS_AGENT_C_TASK_EXPERIENCE.md`

After review, update this status with actual PR/head SHA and links to decided follow-on Issues. This document and GitHub PR constitute the async handoff; no other ChatGPT conversation is auto-notified.
