# L4-B — Model, cost and credential approval request

| field              | value                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| requested by       | L4-B (`feature/l4b-first-real-llm-response`, base `main@db9fab1`)                                           |
| requested of       | **CTO / Jia**                                                                                               |
| status             | **OPEN — nothing below is approved, and nothing is enabled**                                                |
| effect of sign-off | one reviewed code diff plus one deployment configuration change (see §5). No schema change, no new service. |

Sign by filling the two boxes at the end. This sheet is the only document L4-B treats as an
authorization; the technical rationale, evidence and cost model are in
`docs/product/L4B-FIRST-REAL-LLM-RESPONSE.md`.

---

## 1. What is being asked

| ID     | Decision requested                                                                                                                                                   | Recommended answer                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A1** | Approve provider **OpenAI** and pinned snapshot **`gpt-5-mini-2025-08-07`** for Alpha text chat                                                                      | Approve                                                  |
| **A2** | Confirm **$0.25 / 1M input**, **$2.00 / 1M output** for that exact snapshot, from an invoice-grade source                                                            | Confirm, with the invoice or console screenshot attached |
| **A3** | Confirm the spend ceilings: **$0.005** per attempt, **$0.25** per principal/day, **$1.00** per tenant/day, **$5.00** global/day, **60** paid Turns per principal/day | Confirm                                                  |
| **A5** | Name the alert destination for `model_auth_failed`, unresolved `model_budget_incidents`, and ≥ 80 % of the global day's budget                                       | _to be named_                                            |
| **C5** | Accept up to **2** attempts per Turn and ≤ **$0.010** per Turn                                                                                                       | Accept                                                   |
| **C6** | Confirm that "refuse to boot" is the right behaviour for a misconfigured `real` mode                                                                                 | Confirm                                                  |
| **B1** | Accept that the last **≤ 8 messages** of one conversation leave the platform, and say so in the privacy copy                                                         | Accept, with copy                                        |
| **B2** | Provider retention and training terms, named source, dated                                                                                                           | _to be named_                                            |

A1 and A2 are blocking. A3, A5, C5, C6 block the first day of real traffic. B1, B2 block the first
real user.

---

## 2. The model, and why not the cheaper ones

| Candidate                   | $/1M in · out   | Provider shutdown  | Reasoning | Verdict                          |
| --------------------------- | --------------- | ------------------ | --------- | -------------------------------- |
| `gpt-4o-mini-2024-07-18`    | 0.15 · 0.60     | **2027-01-14**     | no        | rejected — retires in 68 days    |
| `gpt-4.1-mini-2025-04-14`   | 0.40 · 1.60     | **2027-01-14**     | no        | rejected — same date, 1.6× price |
| **`gpt-5-mini-2025-08-07`** | **0.25 · 2.00** | **none announced** | **yes**   | **recommended**                  |

Evidence read on **2026-11-07**:

- `developers.openai.com/api/docs/deprecations` — 2026-10-14 notice, shutdown 2027-01-14 for
  `gpt-4o-mini-2024-07-18`, `gpt-4.1-2025-04-14`, `gpt-4.1-mini-2025-04-14`.
- `platform.openai.com/docs/models/gpt-5-mini` — $0.25 / $2.00 per 1M, cached input $0.025, 400 000
  context, 128 000 max output, Chat Completions supported, snapshots `gpt-5-mini` and
  `gpt-5-mini-2025-08-07`, no shutdown date.

**Caveat, stated plainly:** the primary pricing pages answer HTTP 403 from this environment. The
figures above are the provider's own documentation read through a search index plus the deprecations
page read directly. That is enough to nominate and to cost — it is **not** invoice-grade, which is why
A2 exists.

`gpt-5-mini` is a **reasoning** model. Its hidden reasoning tokens are billed as output and are charged
against the 512-token completion allowance, so L4-B pins `reasoning_effort = 'minimal'` next to the
price in reviewed code. Without that pin, a paid Turn can return an empty reply and still be billed.

---

## 3. Cost

### 3.1 Per Turn, at $0.25 / $2.00

| Case                              | tokens in · out | cost      |
| --------------------------------- | --------------- | --------- |
| Worst case the preflight admits   | 8 000 · 512     | $0.003024 |
| Typical Alpha turn                | ~770 · ~220     | $0.00063  |
| Worst case, both attempts allowed | 8 000 · 1 024   | $0.006048 |

### 3.2 Monthly envelope

| Assumption                                 | Cost                                            |
| ------------------------------------------ | ----------------------------------------------- |
| 25 users × 20 Turns/day × 30 days, typical | ≈ **$9.45 / month**                             |
| Same volume at absolute worst case         | ≈ **$45 / month**                               |
| Hard stop (the $5/day global ceiling)      | **$150 / month**, not raisable by configuration |

### 3.3 Smoke test

| Item                | Bound                                      |
| ------------------- | ------------------------------------------ |
| Turns per run       | 1 by default, 5 maximum in code            |
| Worst case per run  | ≈ **$0.030**                               |
| Expected real spend | **$0.0006 – $0.003**                       |
| Aggregate           | `maxPaidSmokeTurns` in the manifest (≤ 50) |

There is no recurring charge until A1/A2 are signed and the enablement diff is merged.

---

## 4. Credential

| Item            | Value                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Variable        | `EMBER_MODEL_API_KEY`                                                                                 |
| Reach           | the **worker** process only; blanked inside the `api` container                                       |
| Kind            | an OpenAI **project** key with a hard monthly spend limit set at the provider — not a personal key    |
| Storage         | SSM Parameter Store `SecureString` under `/ember/staging/secrets/`, rendered to a `0600` file         |
| Never           | in git, in `compose.yaml`, in CI, in a log, in an attempt row, in an evidence file                    |
| Rotation        | new SSM value → `render-env.sh` → restart the worker → revoke the old key                             |
| Refused at boot | placeholder markers (`REPLACE`, `CHANGEME`, `YOUR_`, `XXXX`, `EXAMPLE`), non-`sk-` values, < 20 chars |

The provider account is the separate, blocking prerequisite: this repository cannot create one.

---

## 5. What signing changes

Nothing automatically. After A1 and A2, enablement is one reviewed diff plus deployment config:

1. `packages/model-gateway/src/rates.ts` — add the `APPROVED_REAL_MODELS` entry with the approval
   record, and flip the `gpt-5-mini-2025-08-07` rate row to `provenance: 'invoice_verified'` with the
   invoice as its `source`.
2. `infra/staging/model-authorization.json` — add one entry with the same id, the same rate version,
   the approved ceilings and `maxPaidSmokeTurns`.
3. Deployment environment (SSM + rendered env file) — the eight `EMBER_MODEL_*` variables.
4. Run the smoke test once; attach `docs/evidence/l4b-paid-smoke-01.json`.

Until then, `EMBER_MODEL_EXECUTION=disabled` is the default everywhere, the staging guard refuses
`real` and every provider credential, and `pnpm model:smoke` exits before opening a connection.

---

## 6. Sign-off

| Field                                                                     | Value                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A1 — provider + model id                                                  | ☐ approved / ☐ rejected · `______________________`          |
| A2 — invoice-grade price                                                  | ☐ confirmed / ☐ rejected · source: `______________________` |
| Attribution (name / role)                                                 | `______________________`                                    |
| Date (UTC)                                                                | `______________________`                                    |
| Approval id (goes into `ModelApprovalRecord.approvalId` and the manifest) | `L4B-A1`                                                    |
| Validity requested                                                        | 90 days from the date above                                 |

The approval id and expiry are not decoration: `resolveModelExecution` refuses to boot `real` after
`expiresAt`, and the staging guard refuses `real` without a matching, unexpired manifest entry.
