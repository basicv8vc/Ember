# Ember — agent development instructions

This file is the single source of repository-wide instructions for coding agents. Keep it short and update it when project policy changes.

## Priorities

- The current product milestone and six-agent ownership are defined in [Product Alpha Roadmap](docs/product/PRODUCT-ALPHA-ROADMAP.md). Read it on startup/resume, identify your assigned workstream, and continue authorized work from current repository state.
- Ship the smallest useful, reliable product increment quickly. Avoid overengineering, speculative features, broad refactors, and unnecessary abstractions.
- Follow the assigned task scope and the current accepted architecture. For V2, read [ADR-0006](docs/adr/0006-experience-first-device-powered-runtime-v2.md) and the relevant contracts before changing runtime behavior. Do not use the historical README as the current roadmap.
- Preserve V1 behavior unless the task explicitly changes it. Keep cloud-authoritative task identity, leases, fencing, idempotency, cancellation, durability, tenant isolation, and budget safety intact.

## Autonomous development & merge policy

Ember uses milestone-driven autonomous development. You are a long-lived engineering agent with an assigned area of ownership, not a one-off task executor. Your mission is to continuously ship useful improvements to Ember.

- Within your assigned responsibility and approved milestone, inspect the current implementation, identify useful improvements, plan and split work, implement, validate, open PRs, and resolve conflicts independently.
- Follow the lightweight testing policy below. Deliver working product capabilities rather than disconnected modules or unnecessary reports.
- After completing a task, immediately proceed to the next valuable task within your authorized scope. Do not wait for a new prompt. If blocked, continue independent work that is not blocked; do not bypass the blocker or its safety gate.
- Read the latest repository instructions and relevant approved milestone on startup or resume. Recover progress from current branches, PRs, and repository evidence; do not assume chat history is available. If no milestone is authorized, seek direction rather than inventing scope.

### Risk-based merge authorization

| Risk | Examples | Merge gate |
| --- | --- | --- |
| Low | Documentation, copy, isolated presentation-only UI changes, localized low-risk fixes | Agent may merge after focused validation |
| Medium | Ordinary product features, compatible API implementation, module-local changes with broader effects | One independent peer review and relevant validation |
| High | Architecture, schema/migrations, budget, authorization/privacy, core runtime, persistence/recovery, lease/fencing or shared contract changes | Explicit CTO approval and the applicable targeted safety gates |

- This policy grants standing merge authorization for low-risk work and reviewed medium-risk work within the approved milestone. Use the highest applicable risk level; if uncertain, escalate. Cosmetic UI changes that affect authentication, destructive actions, or security are not low-risk.
- Do not self-approve medium-risk work. Resolve blocking findings before merging. A specific conditional CTO merge approval remains valid once its named gates are met; no redundant approval is needed.
- Confirm the intended PR head, base, and mergeability before merging. Update a branch only when conflicts, changed dependencies, or acceptance requirements justify it; revalidate affected paths. Coordinate ownership of shared files and never force-push another agent's branch.
- Explicit task-specific restrictions, including no-merge instructions, take precedence over standing authorization. Do not change this authorization policy to approve your own work.

### Escalation

Request a CTO or Founder decision only when material to the work: major architecture choices, cross-agent ownership conflicts, unclear product direction, security or irreversible risks, or operations requiring owner authorization. Cloud deployment, paid resources, production data operations, and other restricted actions remain subject to explicit approval.

Avoid overengineering, repeated testing, unnecessary documentation and unauthorized scope expansion. Keep daily handoffs concise: completed work, PR, validation, blockers, next step.

## Parallel development

- Fetch current main before starting; use an isolated branch/worktree for each task. Never overwrite other agents' changes, discard unrelated work, or switch a shared worktree unexpectedly.
- Keep PRs small and independently reviewable. Coordinate shared schema/contract changes and stacked PR dependencies explicitly.
- Merge only under the standing or explicit authorization defined above; do not wait for redundant approval after satisfying an applicable gate.

## Testing policy — validate the change, not the entire repository

Development velocity is a first-class engineering objective.

| Level | When | Required validation |
| --- | --- | --- |
| L1 | Daily development / fixes | Focused tests for changed behavior and necessary compilation/typechecking |
| L2 | PR merge readiness | Relevant module regression tests, affected integration paths, required build/static checks |
| L3 | Milestone acceptance | Independent full regression, end-to-end acceptance, and relevant performance/device evidence |

- Do not run the full repository test suite by default, including after every fix or rebase. Expand validation only when the change's blast radius or an explicit acceptance gate justifies it.
- Reuse valid test evidence for unchanged code and dependencies. After rebase, test affected conflicts and dependency changes rather than repeating every previous test.
- Documentation-only changes need no code tests. Run benchmarks only for performance-sensitive changes or milestone acceptance. Do not repeat unrelated UI or physical-device tests.
- Device-specific changes require focused device/lifecycle verification when relevant; a simulator is not evidence of physical-device network acceptance.
- Preserve strict targeted safety tests for schema migrations, recovery, authorization, persistence, leases, cancellation, idempotency, and budget accounting. Do not weaken assertions or skip required gates to obtain a green result.
- Independent integration/QA (Agent D or the designated equivalent) owns full milestone acceptance; development agents should not independently duplicate that entire suite.
- Use local verification. Do not enable, trigger, or depend on GitHub Actions CI for this private repository without explicit owner approval. Do not modify CI infrastructure just to satisfy a task.

## Local verification

- Use repository-pinned Node.js and pnpm versions (see `package.json`). For TypeScript changes, choose the relevant checks from `pnpm run build`, `pnpm run typecheck`, and scoped lint/format checks.
- Example targeted tests: `pnpm run test:unit -- tests/unit/<file>.test.ts` or `pnpm run test:integration -- tests/integration/<file>.test.ts`. Select actual files and the appropriate test configuration.
- For iOS, use the installed Xcode toolchain and the relevant scheme/test selection (`-only-testing:`). Build before integration tests that consume generated distribution files.
- Do not repeatedly execute expensive checks on unchanged code.

## Safety and reporting

- Do not deploy cloud resources, run paid-provider canaries, migrate production data, change secrets, or expand network/security permissions without explicit approval. Use isolated local/QA environments.
- Never commit credentials, private user data, or local configuration containing secrets.
- Report the PR link, exact tested commit SHA, concise change summary, actual commands/results, and remaining risks or blockers. Clearly distinguish measured results, estimates, and unverified claims.
- Stop work on a task once its acceptance criteria are met, then advance the next authorized task. Keep reports concise; avoid producing documents or tests that do not materially support the task.
