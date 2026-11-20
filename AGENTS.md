# Ember — agent development instructions

This file is the single source of repository-wide instructions for coding agents. Keep it short and update it when project policy changes.

## Priorities

- Ship the smallest useful, reliable product increment quickly. Avoid overengineering, speculative features, broad refactors, and unnecessary abstractions.
- Follow the assigned task scope and the current accepted architecture. For V2, read [ADR-0006](docs/adr/0006-experience-first-device-powered-runtime-v2.md) and the relevant contracts before changing runtime behavior. Do not use the historical README as the current roadmap.
- Preserve V1 behavior unless the task explicitly changes it. Keep cloud-authoritative task identity, leases, fencing, idempotency, cancellation, durability, tenant isolation, and budget safety intact.

## Parallel development

- Fetch current main before starting; use an isolated branch/worktree for each task. Never overwrite other agents' changes, discard unrelated work, or switch a shared worktree unexpectedly.
- Keep PRs small and independently reviewable. Coordinate shared schema/contract changes and stacked PR dependencies explicitly.
- Do not auto-merge without authorization. If conditional merge approval is given, satisfy its stated gate and merge without waiting for redundant approval.

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
- Stop once the assigned acceptance criteria are met. Keep reports concise; avoid producing documents or tests that do not materially support the task.
