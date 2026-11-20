# Ember — Product Alpha Roadmap

Status: Approved product direction, 2026-11-20. Local implementation and integration within the scope below are authorized. Follow [AGENTS.md](../../AGENTS.md) for autonomy, risk-based merge gates and targeted testing. [ADR-0006](../adr/0006-experience-first-device-powered-runtime-v2.md) remains the V2 architectural authority.

## Objective

Make Ember a Personal AI Agent the founder can use every day: conversational, personal, proactive and capable of completing useful work. Move from infrastructure construction to product delivery. The iPhone and cloud are the required product; desktop execution remains optional and outside this Alpha.

## Starting point

Baseline: main at `d4acd42` (2026-11-20).

- V1 cloud runtime exists; preserve its behavior and delivery path.
- V2 M1 local acceptance and A6/A7 SQLite/recovery optimizations are complete.
- M2 native executor, cloud device execution, iOS adapter and reconnect fix are merged (#192, #195, #197, #201).
- Physical iPhone network E2E, V2 cloud staging and real-provider acceptance remain open. Simulator and physical unit evidence are not a substitute for a physical network E2E pass.
- Shared Agent policy is merged (#198, #200).

## Parallel ownership

Each agent owns its workstream continuously, starting with the first useful vertical slice below. Inspect existing implementations and reuse them; do not recreate completed components. Workstreams may proceed concurrently using approved interfaces and fixtures. Agent letters refer to the Product Alpha team, not historical task labels.

| Agent | Ownership | First deliverable |
| --- | --- | --- |
| A | Infrastructure, runtime reliability and cost | V2 staging readiness and rollback plan; support D's M2 acceptance. Freeze speculative runtime optimization. |
| B | Personal Memory / Context | Persist a user-requested preference, retrieve it in a later conversation, and allow the user to inspect and remove it. |
| C | iOS product experience | Reliable conversation, task progress cards and readable results in Ember; integrate B/E/F experiences as their contracts become available. |
| D | Independent QA and acceptance | M2-D1 physical iPhone E2E on current main; then independent integrated product acceptance and founder-use feedback. |
| E | Proactive Agent | One-time and recurring user-authorized tasks, durable schedule execution and a visible result; users can pause or cancel schedules. |
| F | Tools & Execution | Reuse Notes/action-item delegation, Daytona integration and approved native capabilities; complete one bounded data-processing task with a downloadable artifact. |

## First vertical slices and boundaries

- A: prepare an isolated staging configuration, estimated cost and deployment/rollback checklist; use local dry runs and fake providers. No new infrastructure framework, cloud provisioning or real-user migration. Help resolve runtime defects that actually block product delivery.
- B: start with explicitly requested facts/preferences and bounded retrieval scoped to the account; include provenance, inspection, deletion and isolation. Do not start with a generalized memory graph, vector infrastructure or silent sensitive-data collection.
- C: prioritize the conversation-to-task-to-result journey, honest loading/error/offline states and existing device capabilities. Preserve protected outbox and deletion/account boundaries. No broad UI rewrite; coordinate API-dependent UI with B/E/F.
- D: use the existing M2-D1 criteria, including normal physical-device execution, lost ACK replay, recovery, lease fencing, cancellation and revocation. Resolve the LAN permission/reachability blocker using isolated QA. Subsequently validate the five product scenarios below on an integrated build, clearly separating pass, fail and blocked.
- E: reuse the durable runtime and schedule/recovery primitives. Start with a bounded user-defined reminder or recurring information brief, with timezone, idempotency, cancellation and observable outcomes. Do not promise unattended iPhone execution or unrestricted continuous polling; cloud execution is necessary when the device is unavailable.
- F: use the existing task path and sandbox provider abstraction; validate delegation, bounded execution, artifact access and recovery with local/fake providers first. Verify real Daytona only with separate approval. Connectors and new external side effects are not prerequisites for the first slice; scope and obtain consent before enabling any.

Shared schema/contract changes require coordination with A, affected owners and the CTO before merging. C owns shared iOS integration. D reports independent results; developers fix defects in their owned areas. Work around blocked external dependencies with local fixtures rather than expanding scope.

## Product Alpha acceptance

| User-visible scenario | Acceptance |
| --- | --- |
| Remember my preference | Explicitly saved preference survives a new conversation and is used appropriately; can be inspected and deleted. |
| Prepare my morning brief | A user-authorized recurring schedule executes on time within its declared window and produces a visible result without requiring the app to be open. |
| Analyze data and deliver a file | A delegated task executes bounded data processing, shows progress and yields an authorized downloadable artifact. |
| Follow up on something | A user-defined follow-up persists across app restart; the agent advances the permitted task and reports an outcome; cancellation works. |
| Use the appropriate executor | An eligible supported task reaches the iPhone when ready and permitted; an authorized cloud alternative or a truthful waiting state applies when unavailable. No silent upload or duplicate committed effect. |

The founder must be able to experience these scenarios in the integrated Ember app, not merely separate developer demonstrations. A simulated run is development evidence, not a real-provider or deployed Alpha pass. D records the tested commit, actual environment, outcomes and blockers.

## Delivery strategy

- First: close M2 physical acceptance and prepare a V2 staging approval request while B, C, E and F start their vertical slices.
- Next: integrate each slice into the app as soon as its reviewed contract is available. Prefer one working feature over several partially built subsystems.
- Then: obtain separate staging and provider-canary approvals, verify the integrated real environment, and begin founder daily use. Do not claim Product Alpha complete until the five scenarios work and blocking safety issues are resolved.
- Target allocation: approximately 70% product features, 20% infrastructure/reliability and 10% independent QA. This is a priority guideline, not a measured staffing quota or a limit on necessary safety validation.

## Operating rules

Read this roadmap and AGENTS.md on startup/resume. Continue from current PRs and merged code, not chat history. Work autonomously within the approved milestone, keep PRs small and use risk-based merge authorization. No full suite per routine PR, no redundant reports, no GitHub CI. If blocked, progress independent work and report the specific decision needed.

This roadmap authorizes the scoped local Product Alpha work only. It does not authorize cloud provisioning/deployment/smoke, paid-provider calls or new subscriptions, production migrations, broader V2 cutover, external access without consent, or changes to existing V1 contracts. Obtain the separate approvals required by ADR-0006 and AGENTS.md. The Product Alpha labels do not renumber or replace the ADR's technical M0–M5 milestones.
