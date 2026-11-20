# Ember — Product Alpha: Integrated Acceptance & Founder Daily Use

**Status:** Proposed execution plan for CTO/Founder approval.  
**Baseline:** `main @ 935c1d9` (2026-11-21). Start from current main rather than resetting to this snapshot.  
**Authority:** [Product Alpha Roadmap](PRODUCT-ALPHA-ROADMAP.md), [AGENTS.md](../../AGENTS.md), [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md). This plan specifies the next work for the six existing owners; it does not replace the roadmap, architecture, or approval policy.

## Mission

Deliver the integrated iPhone + cloud Personal AI Agent that the Founder can use every day. Stop speculative infrastructure work. All six agents start in parallel, coordinate shared contracts, and fix only defects or missing connections that block the five Product Alpha scenarios.

## Starting evidence and gaps

- V2 M1 local runtime acceptance is complete. M2-D1 physical iPhone LAN execution passed 6/6 (#227); cloud-staging routing remains a separate gate.
- Memory CRUD, iOS integration and explicit in-chat save/dedup (#206, #210, #215, #222, #224, #231, #233) are merged.
- Proactive schedules, context, iOS UI and natural-language schedule creation (#213, #218, #219, #225, #232) are merged.
- V2 bounded Python task/artifact slice (#230) is merged; its local executor is simulated, not real Daytona. Do not assume natural-language Python delegation is fully wired.
- Isolated V2 staging and smoke tooling (#214, #220, #226, #228, #229) exist. Earlier Apple sign-in/chat and Memory UI evidence predates this baseline. Check the deployed version and routes; do not infer deployment from a merge.
- The V2 worker currently resolves a fake gateway only; the Python task path also checks `EMBER_MODEL_MODE === 'fake'`. A and F must implement the real-provider paths, not merely change environment variables.
- [Independent acceptance matrix](PRODUCT-ALPHA-ACCEPTANCE.md) was written against an older baseline; D owns updating it. Code merged, local tests, deployed fake, physical device, and real-provider acceptance are distinct evidence levels.

## Shared execution rules

Read this plan and the authority documents on startup/resume. Work in isolated branches/worktrees, fetch current main, coordinate shared files, and follow risk-based merge gates. Low/medium work follows standing authorization; high-risk runtime, schema, auth, budget, privacy, recovery and shared contract changes require explicit CTO approval. Use focused L1/L2 checks; D owns L3 integration. No GitHub Actions CI or routine full-suite repeats. Do not create new frameworks, duplicate completed work, or wait for unnecessary approvals.

**Authorization boundary:** Local implementation and fake-provider validation may proceed within the approved roadmap. Existing [Stage 1 authorization](../V2-STAGING-DEPLOYMENT-AUTHORIZATION.md) covers isolated fake-provider staging only, within its $10/month envelope and zero external-provider spend. A must verify that redeployment/smoke is covered by the existing approval or obtain confirmation before proceeding. This document/PR is not a new cloud operation or provider-spend approval. Separate Founder approval is required for real LLM/Daytona calls, secret changes, additional paid resources, production migration or cutover. Preserve V1 and all account/environment separation. Never use real user files or personal data in provider canaries without specific permission.

## Agent A — V2 Staging & Real LLM

**Mission:** Deliver a verified latest-main V2 staging environment and the smallest safe real-LLM path.

1. Check deployed SHA/version and preflight isolated configuration. Within the existing authorized scope, deploy latest main in fake mode, validate DO v8 upgrade with existing data, and retain a compatible rollback path. No new cloud resources unless approved.
2. Run the existing staging smoke verifier (health/readiness, anonymous Memory/Schedule/auth rejection, dev denied, V1 non-regression); verify authenticated Memory, Schedules, Tasks and Artifacts with synthetic fixtures. Report deployment version and tested SHA to C/D/B/E/F.
3. Wire a real LLM gateway into V2 using existing provider interfaces, rate catalog and budget protocol. Preserve authorization-before-send, settlement, lease/deadline, cancellation and truthful Fast/Durable execution. Never treat an unrecoverable provider job as safely retryable; retain conservative unknown-outcome handling. Keep fake support and V1 behavior intact.
4. Prepare a bounded, allowlisted real-LLM canary approval request with chosen provider/model, request and token/cost caps, credentials handling, expected evidence, kill switch and rollback. Obtain CTO approval for the implementation and separate Founder approval before external calls.
5. Coordinate the shared gateway with F, including separate model and sandbox capability settings; help C/D verify cloud device routing.

**Done:** Latest staging fake build independently usable by C/D, with exact deployed version/smoke evidence; real model path reviewed and locally verified, or a specific remaining blocker and approval request. Do not claim a real-provider pass before an authorized canary.

## Agent B — Personal Memory

**Mission:** Make explicit memory saving and later personalized behavior reliable in the integrated app.

1. Reuse merged #231/#233. Verify natural-language save, repeated exact-content save, key-based update, in-place edit, inspect/delete, account isolation and cap handling on the latest staging build.
2. Verify saved preferences survive a new conversation and influence a later answer; deleted memory is no longer injected into subsequent context. Distinguish simulated context assertions from actual model behavior.
3. With A, verify real model tool selection and truthful save confirmation under the approved canary; with C/D, test the complete iPhone journey.
4. Fix only discovered product or safety defects. Preserve verified provenance, user-requested scope, fenced atomic commits, and idempotent API retries.

**Done:** D can reproduce remember → new conversation → inspect/edit/delete, with no duplicate or cross-account effect. No automatic extraction, embeddings, vector search, memory graph, or silent sensitive-data collection.

## Agent C — iOS Product Experience

**Mission:** Deliver a single usable iPhone build connected to the isolated V2 environment.

1. Build latest main, install on physical iPhone using the existing V2 staging selector; verify Apple login, session restoration, Keychain/journal/recovery-fence separation from V1.
2. Integrate chat, natural-language memory saving, Memory settings, natural-language reminders and recurring schedules, task progress, uploads and artifact download. Coordinate B/E/F rather than duplicating server logic. Close any missing user-facing submission/delegation connection.
3. Verify background/foreground transitions, app restart, network loss, retry, cancellation and readable results. Ensure simulated work is labeled, and failure or pending state is truthful.
4. With A/F/D, verify the cloud-to-device execution path on a real iPhone. Reuse the existing adapter and approved permissions; report truthful waiting/fallback when unavailable. No assumption of unattended iOS execution.
5. Prioritize fixes blocking Founder Daily Use. No broad UI rewrite, new app architecture, or changes to production endpoint defaults.

**Done:** One integrated installable iOS build with documented backend SHA/version, launch configuration, real-device evidence, and known blockers. C owns shared UI changes.

## Agent D — Independent Product Acceptance

**Mission:** Independently determine whether Product Alpha is ready for Founder daily use.

1. Update [PRODUCT-ALPHA-ACCEPTANCE.md](PRODUCT-ALPHA-ACCEPTANCE.md) from current evidence. Record main SHA, deployed Worker version, device/app build, environment, provider mode, exact test outcomes, and remaining blockers. M2-D1 LAN is already passed; do not repeat unrelated tests.
2. Verify the five scenarios below on the integrated build. First use fake staging; repeat the relevant scenarios with real providers only after separate authorization. A simulator or mock cannot establish real-device/provider acceptance.
3. Include app-closed delivery, restart, offline recovery, cancellation, retries/lost ACK and no duplicate committed effects where relevant. Test cloud device routing without weakening leases or permissions.
4. Assign findings to A/B/C/E/F; verify fixes independently. Do not reimplement feature work or require every agent to repeat L3.
5. Return a concise GO/NO-GO report for Product Alpha, with explicit PASS/FAIL/BLOCKED per scenario and any residual risks. Do not silently mark approval-blocked work passed.

**Done:** Current independent acceptance matrix and GO/NO-GO decision with reproducible evidence, not aggregate test counts alone.

## Agent E — Proactive Agent

**Mission:** Make Ember's proactive behavior useful and observable without the app open.

1. Reuse #213/#218/#225/#232. Verify chat-created one-time reminders, follow-ups and recurring Morning Briefs with explicit user intent, supported cadence and correct timezone. Ambiguous times require clarification; past absolute triggers must not start unexpected work.
2. Confirm cloud execution while iOS is fully closed, then visible persisted delivery after relaunch. Validate the declared timing window and pause/resume/cancel, including no extra committed occurrence after cancellation under the supported contract.
3. Verify stored Memory and recent bounded conversation context are incorporated; non-conversation scheduled executions must not advertise or execute conversation-only side-effect tools.
4. With A/B/C/D, verify real-model briefs in the approved canary, and fix actual integration defects. Preserve authoritative turn commit, D1 recovery coverage, durable results and replay fencing.

**Done:** D can reproduce an app-closed reminder/brief and durable follow-up through the iOS UI; delivery, timing, controls and context behavior are verified. No new schedule types, external monitoring, connector expansion, or scheduler rewrite.

## Agent F — Real Sandbox & Artifact Delivery

**Mission:** Deliver one complete bounded data-analysis task with a downloadable artifact through V2.

1. Reuse #230 and existing V1 Daytona/SandboxProvider contracts and safety limits. Implement the smallest V2-compatible real execution adapter; resolve runtime compatibility with A instead of introducing a new sandbox framework.
2. Decouple sandbox provider selection from LLM mode with explicit fail-closed configuration. Keep the local fake executor available and ensure enabling real LLM cannot accidentally enable paid Daytona or disable a permitted sandbox path.
3. With C/A, connect user-authorized file upload and natural-language Python/data-task delegation to the existing V2 task path. Verify task reference, durable execution, progress/result, authorized download and actual file integrity. Fill only missing wiring.
4. Validate lease/run fencing, cancellation, expiry, staged-output visibility, aggregate limits, tenant isolation, SHA-256 verification, timeout, retry and resource cleanup. Preserve existing v8 data and proactive task behavior.
5. Adapt [existing Daytona readiness checklist](ALPHA-F-DAYTONA-CANARY-READINESS.md) to the V2 path, including an allowlisted synthetic fixture, bounded runs/files/model calls/cost, no uncontrolled outbound access, kill switch, and sandbox cleanup. Submit for CTO review and separate Founder authorization before paid calls.

**Done:** End-to-end fake staging task with actual artifact download, reviewed V2 real sandbox implementation and a bounded canary request; after authorization, real Daytona evidence with no leaked sandboxes or duplicate committed artifacts.

## Parallel handoff and exit gates

| Stage | Owner / handoff | Evidence required |
| --- | --- | --- |
| G1 — Latest fake staging | A → B/C/D/E/F | Approved isolated deploy; migration/health/auth/route smoke; V1 unchanged; exact version |
| G2 — Integrated fake product | B/C/E/F → D | Physical iPhone and cloud-staging evidence for all five scenarios as supported; remaining real-only gaps explicit |
| G3 — Provider readiness (parallel with G1/G2) | A + F → CTO/Founder | Reviewed real-LLM and real-Daytona implementation, local validation, separate bounded canary approval requests |
| G4 — Real provider acceptance | A/B/C/E/F + D | Explicit approval before calls; real-model and real-sandbox evidence, budget/recovery/security constraints satisfied |
| G5 — Founder Daily Use | D → CTO/Founder | Final integrated acceptance matrix, no blocking defects, agreed GO; no production cutover implied |

G1 and G3 are parallel; G2 work starts with local fixtures while A deploys. Agents B/E/F and C should not wait for real-provider approval before doing fake integration. D begins reviewing delivered evidence immediately. No mandatory sequential PR chain beyond actual shared-code dependencies.

| Scenario | Product-level acceptance |
| --- | --- |
| Remember my preference | Save explicitly, use later, inspect and delete; no unauthorized or duplicate memory |
| Prepare my morning brief | User-authorized recurrence fires within its window, app closed, result visible |
| Analyze data and deliver a file | Authorized delegation, bounded execution, progress and a valid downloadable artifact |
| Follow up on something | Persistence across restart, permitted work, observable result, working cancellation |
| Use the appropriate executor | Eligible work executes on ready authorized iPhone or allowed cloud alternative; otherwise truthful waiting; no silent uploads or duplicate effects |

## Reporting

Each agent posts a short handoff in its PR or existing acceptance record: completed work, exact SHA, measured checks, blockers, next step, and who needs to act. Escalate real safety, provider or scope decisions immediately. Do not create repetitive progress documents.

**Definition of success:** the Founder can actually use Ember for all five product scenarios. Once D records acceptance and the Founder authorizes daily use, switch to real-experience-driven iteration. Do not declare Product Alpha complete merely because its feature PRs have merged.
