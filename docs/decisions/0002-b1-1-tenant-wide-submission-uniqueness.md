# CTO Decision 0002 — Tenant-wide submission ID uniqueness (B1-1)

- **Status:** Approved CTO amendment to ADR-0004
- **Date:** 2026-11-04
- **Authority:** ADR-0004 and CTO acceptance of Agent C's P1 finding on PR #97
- **Original normative annex blob:** `2e06b47691b71b05e3903f0bd65d5b9f381776c0`
- **Scope:** B1-1 persistence invariant and associated tests/documentation only

## Problem

The frozen Annex §6.4 and §11.2 specify
`UNIQUE (tenant_id, conversation_id, client_submission_id)`, while §10.1 N-2/N-5
and the approved repository method
`findSubmissionReceipt({ tenantId, clientSubmissionId })`
reconcile Unknown ACK using only the authenticated tenant and submission ID.
With two conversations inside one tenant, the old database key permits two
different receipts for the same lookup key. The ambiguity violates N-2.

## Decision

The live `conversation_messages` row is unique on
`(tenant_id, client_submission_id)`, without `conversation_id`.
The constraint retains the name `conversation_messages_tenant_submission_unique`.

- A repeated submission ID in a different conversation of the **same tenant**
  conflicts with `409 IDEMPOTENCY_CONFLICT`, even if the text matches.
- A legitimate replay uses the same tenant, conversation, ID, text and current
  `transcript_epoch`; it returns the original receipt, never a new Turn.
- Different tenants may use the same submission ID; lookup is tenant-qualified,
  and foreign IDs are indistinguishable from missing IDs (404).
- Deleting the transcript deletes the message rows, so their IDs may be reused
  after deletion. The existing `transcript_epoch` fence still rejects stale
  outbox retries. No tombstone or cross-conversation cache is introduced.
- The HTTP route `GET /v1/message-submissions/{client_submission_id}`, DTOs,
  and repository method parameters remain unchanged.

A conversation-scoped lookup would require changing the frozen HTTP route and
the Unknown-ACK client recovery procedure. A tenant-wide unique key closes the
ambiguity at the persistence boundary with no wire migration.

## Contract amendment and implementation

This decision explicitly supersedes only the original conversation-scoped
uniqueness assertions in Annex §6.4, §11.2, §11.4 and Decision D-6. The annex
working copy is updated with a pointer to this decision; the originally
approved blob stays immutable and auditable in Git history. ADR-0004 itself,
other frozen wire semantics, and CTO Decision 0001 remain unchanged.

In B1-1, update `migrations/0012_conversation.sql` (not a new 0014, because
0012 has not shipped on `main`), pin the new migration SHA-256, and prove
same-tenant cross-conversation rejection, cross-tenant acceptance, distinct-ID
acceptance and two-connection concurrency against actual PostgreSQL 17.

The B1-3 write path must map duplicate submission IDs across conversations
to the existing 409 error without creating a message or Turn. No new API
behavior is authorized in B1-1.
