# L4-B — Model, cost and credential approval request

| field              | value                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| requested by       | L4-B (`feature/l4b-first-real-llm-response`, based on latest `main@8c84e4b`)                                |
| requested of       | **CTO / Jia**                                                                                               |
| status             | **OPEN — nothing below is approved, and nothing is enabled**                                                |
| effect of sign-off | one reviewed code diff plus one deployment configuration change (see §5). No schema change, no new service. |

Sign by filling the two boxes at the end. This sheet is the only document L4-B treats as an
authorization; the technical rationale, evidence and cost model are in
`docs/product/L4B-FIRST-REAL-LLM-RESPONSE.md`.

---

## 1. What is being asked

| ID     | Decision requested                                                                                                                                                   | Recommended answer                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A1** | Approve provider **OpenAI** and pinned model **`gpt-5.6-luna`** for Alpha text chat                                                                                  | Approve                                          |
| **A2** | Review and confirm **$0.20 / 1M input**, **$1.20 / 1M output** from OpenAI's official model page for `gpt-5.6-luna`                                                  | Confirm, recording the official source URL below |
| **A3** | Confirm the spend ceilings: **$0.005** per attempt, **$0.25** per principal/day, **$1.00** per tenant/day, **$5.00** global/day, **60** paid Turns per principal/day | Confirm                                          |
| **A5** | Name the alert destination for `model_auth_failed`, unresolved `model_budget_incidents`, and ≥ 80 % of the global day's budget                                       | _to be named_                                    |
| **C5** | Accept up to **2** attempts per Turn and ≤ **$0.010** per Turn                                                                                                       | Accept                                           |
| **C6** | Confirm that "refuse to boot" is the right behaviour for a misconfigured `real` mode                                                                                 | Confirm                                          |
| **B1** | Accept that the last **≤ 8 messages** of one conversation leave the platform, and say so in the privacy copy                                                         | Accept, with copy                                |
| **B2** | Provider retention and training terms, named source, dated                                                                                                           | _to be named_                                    |

A1 and A2 are blocking. A3, A5, C5, C6 block the first day of real traffic. B1, B2 block the first
real user.

---

## 2. The model, and why not the cheaper ones

| Candidate                 | $/1M in · out   | Provider shutdown  | Reasoning | Verdict                       |
| ------------------------- | --------------- | ------------------ | --------- | ----------------------------- |
| `gpt-4o-mini-2024-07-18`  | 0.15 · 0.60     | **2027-01-14**     | no        | rejected — deprecated         |
| `gpt-4.1-mini-2025-04-14` | 0.40 · 1.60     | **2027-01-14**     | no        | rejected — deprecated         |
| `gpt-5-mini-2025-08-07`   | 0.25 · 2.00     | **2026-12-11**     | yes       | rejected — near-term shutdown |
| **`gpt-5.6-luna`**        | **0.20 · 1.20** | **none announced** | **yes**   | **recommended**               |

Evidence read on **2026-11-10**:

- `developers.openai.com/api/docs/models/gpt-5.6-luna` — $0.20 / $1.20 per 1M, Chat Completions
  (`v1/chat/completions`) supported, and `reasoning_effort` supports `none`.
- `developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create` —
  `max_completion_tokens` and `reasoning_effort: "none"` are valid Chat Completions parameters.
- `developers.openai.com/api/docs/deprecations` — `gpt-5-mini-2025-08-07` shuts down 2026-12-11;
  the listed gpt-4o-mini and gpt-4.1-mini snapshots shut down 2027-01-14.

**A2 is an explicit price review, not an invoice prerequisite.** CTO reviews the official OpenAI model
page and records its URL above before the first call. Project access and the project-scoped key are
checked before smoke; actual provider usage and billing are reconciled afterward.

`gpt-5.6-luna` accepts `reasoning_effort = 'none'`, which L4-B pins beside its rate. The adapter keeps
using Chat Completions and sends `max_completion_tokens`; official documentation says that parameter
includes reasoning tokens. The configured maximum reservation is $0.002215 per attempt and $0.004430
for both allowed attempts, within the existing $0.005-per-attempt ceiling. Token estimation remains a
reservation estimate; the overage incident path remains active.

---

## 3. Cost

### 3.1 Per Turn, at $0.20 / $1.20

| Case                               | tokens in · out | cost      |
| ---------------------------------- | --------------- | --------- |
| Worst case reservation per attempt | 8 000 · 512     | $0.002215 |
| Typical Alpha turn                 | ~770 · ~220     | $0.00042  |
| Maximum reservation, both attempts | 16 000 · 1 024  | $0.004430 |

### 3.2 Monthly envelope

| Assumption                                 | Cost                                            |
| ------------------------------------------ | ----------------------------------------------- |
| 25 users × 20 Turns/day × 30 days, typical | ≈ **$6.27 / month**                             |
| Same volume at estimated worst case        | ≈ **$66.45 / month**                            |
| Hard stop (the $5/day global ceiling)      | **$150 / month**, not raisable by configuration |

### 3.3 Smoke test

| Item                | Bound                                  |
| ------------------- | -------------------------------------- |
| Turns per run       | exactly 1                              |
| Provider attempts   | exactly 1 for the first paid smoke     |
| Worst-case estimate | **$0.002215**                          |
| Expected real spend | **≈ $0.000418**                        |
| Aggregate           | `maxPaidSmokeTurns: 1` in the manifest |

There is no recurring charge until A1/A2 are signed and the enablement diff is merged.

---

## 4. Credential

| Item            | Value                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Variable        | `EMBER_MODEL_API_KEY`                                                                                 |
| Reach           | the **worker** process only; blanked in `api`, `migrate` and `edge` containers                        |
| Kind            | an OpenAI **project** key with a hard monthly spend limit set at the provider — not a personal key    |
| Storage         | SSM Parameter Store `SecureString` under `/ember/staging/secrets/`, rendered to a `0600` file         |
| Never           | in git, in `compose.yaml`, in CI, in a log, in an attempt row, in an evidence file                    |
| Rotation        | new SSM value → `render-env.sh` → restart the worker → revoke the old key                             |
| Refused at boot | placeholder markers (`REPLACE`, `CHANGEME`, `YOUR_`, `XXXX`, `EXAMPLE`), non-`sk-` values, < 20 chars |

The provider account is the separate, blocking prerequisite: this repository cannot create one.

---

## 5. What signing changes

Nothing automatically. After A1 and A2, enablement is one reviewed diff plus deployment config:

1. CTO signs A1/A2 and confirms the existing A3 ceilings. Record the model approval in
   `APPROVED_REAL_MODELS` and change the exact rate row to `provenance: 'official_price_verified'`
   with the official model-page URL as its source.
2. Add the matching authorization entry to `infra/staging/model-authorization.json`, including the
   same model/rate version, approval dates, official `priceSource` URL, existing ceilings and
   `maxPaidSmokeTurns: 1`.
3. Create an OpenAI project-scoped key with a provider-side spend limit, store it as an SSM
   `SecureString`, and render it to the server-side staging environment. Compose exposes it only to
   `worker`; it is blank in `api`, `migrate` and `edge`.
4. After reviewing the exact configuration, enable real mode for the worker and run
   `pnpm model:smoke --max-turns=1 --confirm --evidence=docs/evidence/l4b-paid-smoke-01.json` once.
   Reconcile its persisted usage against OpenAI billing afterward; no invoice is needed beforehand.

Until then, `EMBER_MODEL_EXECUTION=disabled` is the default everywhere, the staging guard refuses
`real` and every provider credential, and `pnpm model:smoke` exits before opening a connection.

---

## 6. Sign-off

| Field                                                                     | Value                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A1 — provider + model id                                                  | ☐ approved / ☐ rejected · `______________________`          |
| A2 — official published price reviewed                                    | ☐ confirmed / ☐ rejected · source: `______________________` |
| Attribution (name / role)                                                 | `______________________`                                    |
| Date (UTC)                                                                | `______________________`                                    |
| Approval id (goes into `ModelApprovalRecord.approvalId` and the manifest) | `L4B-A1`                                                    |
| Validity requested                                                        | 90 days from the date above                                 |

The approval id and expiry are not decoration: `resolveModelExecution` refuses to boot `real` after
`expiresAt`, and the staging guard refuses `real` without a matching, unexpired manifest entry.
