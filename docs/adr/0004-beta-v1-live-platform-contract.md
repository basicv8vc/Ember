# ADR-0004 — Beta V1 Live Platform Contract (conversation-first Alpha)

- **Status:** Proposed — Round 1 CTO review corrections applied to PR #92; approval pending
- **Decision date:** 2026-11-03
- **Owner:** Ember Architecture / CTO
- **Decision:** Issue #91 — freeze one versioned, CTO-approved Beta V1 live platform contract before any
  Live HTTP, auth implementation, migration or model spend
- **Scope:** B1 only — consumer session, one persistent conversation, assistant turns, message→Task
  linkage, Task result retrieval, deletion/retention. B2 (Model Gateway, spend ceiling) and B3
  (activity/commitment/outcome messages, real tools) are explicitly out of scope.
- **Normative annex:** [`docs/product/B1_PLATFORM_CONTRACT.md`](../product/B1_PLATFORM_CONTRACT.md),
  pinned by git blob SHA in the approval record below
- **Related:** #91 (authority), #90 (iOS client plan — not an authority), #92 (this contract PR),
  ADR-0001, ADR-0002, ADR-0003
- **Supersedes:** `docs/product/ios/IOS_M3_CONVERSATION_API_PROPOSAL.md` on every overlapping surface.
  `IOS_CONTRACT_FREEZE.md` is unaffected: no EXISTING endpoint changes behaviour.

## Context

Issue #91 required one thing before parallel iOS/API/Worker work: a _single_ versioned decision record
that fixes wire semantics, so a client and a server cannot each guess a different contract. Two separate
artefacts had started to accumulate — the requirement in #91, which named
`docs/adr/0004-beta-v1-live-platform-contract.md` as the authority, and a detailed specification written
as `docs/product/B1_PLATFORM_CONTRACT.md` in PR #92.

Two authoritative documents would guarantee drift within a week: the ADR would be read as policy and the
annex as detail, and any disagreement would be resolved differently by different agents. The alternative —
deleting the annex and keeping only a short ADR — throws away the only artefact precise enough to
implement against (DTO shapes, invariants, constraint names, test matrix).

## Decision

1. **ADR-0004 (this file) is the single versioned CTO decision record.** It owns approval, scope and
   decisions D-1…D-15. It is immutable once merged except by a superseding ADR.
2. **`docs/product/B1_PLATFORM_CONTRACT.md` is the normative annex to this ADR**, not a second contract.
   It owns wire detail: routes, DTOs, invariants, migration sketches, test matrix. It is pinned by blob
   SHA in the approval record below; a change after approval requires a new ADR or an explicit CTO
   amendment, never a silent edit.
3. **Precedence:** where the ADR and the annex could be read differently, the ADR wins and the annex is
   corrected in the same PR. Where the annex is silent, the ADR governs. Where both are silent, no
   behaviour may be invented — that is a stop-and-ask condition.
4. Nothing else is an authority: PR #90 is a client plan, the iOS M2 Task contract remains authoritative
   only for Tasks, and the earlier iOS M3 proposal is superseded for the surfaces it overlaps.
5. Machine-checked request/response schemas belong in `packages/contracts/src/**` and must match this
   annex when B1-1 lands. This ADR and its annex add no code.

## Approval scope and gates

Approval of this ADR and its annex authorizes **B1-1 only**: migrations `0011`–`0013` plus repository
interfaces, with no route and no behaviour. Each later slice (B1-2…B1-8, annex §14) starts only after the
previous slice's gates are green.

It does **not** authorize: any Live HTTP call from iOS, a real model provider integration, provider keys
or egress, a data-retention policy for a real model, account deletion implementation, APNs, multi-agent,
connectors, or a general API framework. Those stay behind the B2 gate in Issue #91.

## Recorded decisions (CTO, PR #92 Round 1)

| Q   | Decision                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-1 | `provider: "dev"` is **conditionally approved** for isolated local/test/CI only: explicit non-production config **and** a loopback-only listener; never on publicly reachable staging or production; must never let arbitrary subjects create real consumer sessions in a shared live environment. Dev bearer tokens remain for route-independent tests. |
| Q-2 | **200 messages per rolling 24 h per conversation** is approved as the internal-Alpha safety quota, evaluated atomically and tenant-scoped. This is **not** model billing: B2 needs a separate measured per-user/global inference spend cap before provider egress.                                                                                       |
| Q-3 | Clearing the transcript **preserves `task_results`**, and the iOS confirmation must say so explicitly: Tasks, results and artifacts remain. Clearing chat is not account/data deletion; full account deletion stays a release gate before external beta (Apple 5.1.1(v)).                                                                                |

## Round 1 corrections incorporated before approval

The first review of PR #92 (head `1c665a1`) requested five P0 corrections plus three clarifications. All
are applied in the annex (§17.1 maps each to its section). Four of them changed decisions, not just
wording, so they are recorded here:

- **Deletion fencing replaced "IDs are reusable" as the whole story.** `client_submission_id` reuse after
  a transcript deletion stays legal, but every send now carries a server-owned `transcript_epoch`, and a
  stale epoch is rejected with the existing 409. Without it, an old outbox entry or a lost-ACK retry could
  re-insert deleted text (annex §6.7, D-6, D-11).
- **Task linkage is frozen by first persistence.** The EXISTING `tasks.digest` is unchanged, but a replay
  compares the requested linkage with what was persisted inside the transaction and conflicts on any
  difference, including none→some (annex §8.1 L-7…L-11, D-10).
- **Database-level guarantees replaced two claims that only held in application code:** `UNIQUE (tenant_id)`
  on `consumers`, and turn→message foreign keys through generated columns, so a turn's response must be an
  `ember` message in the same conversation (annex §7.5, §11.2).
- **Conflict causes share one 409 body.** No field is added to `ErrorResponse` (D-12), because that
  `strictObject` is already parsed by every existing client, and all three causes require the same client
  action.

## Consequences

- iOS and Platform can work in parallel against one pinned text, and a reviewer can name a merged commit
  SHA as the frozen contract — the acceptance criterion in #91.
- The annex is long, but it is _annex_ long: no decision lives only in the annex, because every decision
  has a `D-n` in §16 of the annex.
- Approval is cheap to audit: the annex's §11.4 records an executed PostgreSQL 17 run of the migration
  sketch, so "the SQL does not parse" cannot recur silently.
- Cost of being wrong: an approved-but-flawed fence or constraint is now a data-model problem rather than
  a documentation problem, which is why B1-1 must reproduce the §11.4 evidence through the real migration
  runner and the T-10/T-12/T-17 suites before B1-2 begins.
- The frozen scope is intentionally narrow. Anything not in the annex's §2.2 non-goals requires a new ADR;
  "it was implied by the contract" is not a license.

## B1-1 handoff (prepared, NOT authorized before merge)

Implementation may start only after the CTO approves and merges this ADR and its normative
annex. Ownership is deliberately narrow: B1 owns identity, the Conversation/Message/Assistant
Turn wire and persistence, and the existing Task linkage/result additions. B2 owns only a
future model responder and its **separately reviewed** durable claim/lease extension. Do not
create a second Assistant Turn state machine, change existing Task kind enums or silently
authorize external model egress.

**First implementation PR (B1-1) scope:** migrations 0011–0013, checked-in contract schemas
and repository interfaces for consumer/session, Conversation, Message, Assistant Turn and
Task result, plus deterministic tests. No HTTP routes, new real provider, credentials,
deployment or production data processing in B1-1.

**Acceptance gates before B1-2:**

- Run forward migration and checksum-stable repeat application from a clean PostgreSQL 17
  database using the repository's actual migrator; do not rely only on SQL copied from docs.
- Assert tenant-qualified foreign keys and malformed-row rejections, including wrong
  source/response message kinds, foreign Conversation, invalid message union fields, and
  Consumer 1:1 uniqueness.
- Test concurrent ordered appends and assigned sequence consistency, message
  idempotency/unknown ACK, and deletion-epoch stale-send rejection using separate
  PostgreSQL connections.
- Verify Task-linkage identity does not silently mutate on replay (including no-link →
  linked replay), and terminal result reads do not report pending for already-terminal
  Tasks.
- Preserve existing M2 Task/Commitment/Consent routes and the complete CI suite.
- Report exact migration SHAs, test commands, results, and targeted negative cases in
  the implementation PR; require review before B1-2 session routes begin.

**Cross-team boundary:** B2 shall use the B1-defined
`assistant_turns (tenant_id,id)` identity and server-authoritative terminal transitions.
Its future `model_turn_attempts` and lease fields (not part of B1-1) require a separate
forward-only migration and a fencing/cancellation review. iOS shall use this ADR's
versioned wire semantics only after the frozen B1 contract is merged.

## Approval record

| Field          | Value                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Contract PR    | #92 (`cto/b1-platform-contract`)                                                     |
| Annex path     | `docs/product/B1_PLATFORM_CONTRACT.md`                                               |
| Annex blob SHA | `1eae8ec3332040b3089e62a425fde13e7590966b`                                           |
| Approved by    | CTO (Round 2 review pending)                                                         |
| Frozen from    | the merge commit of this ADR onward                                                  |
