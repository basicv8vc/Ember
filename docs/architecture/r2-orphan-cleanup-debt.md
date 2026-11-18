# Technical Debt: Best-Effort R2 Deletion Failures and Untracked Orphan Objects

> Status: **Deferred Technical Debt** (No new GC framework implemented in PR #165)
> Context: Recorded during the PR #165 R2 multimodal upload review (`packages/postgres/src/repositories/b3-staged-upload-repository.ts`, `packages/postgres/src/storage/r2-blob-store.ts`, `packages/postgres/src/storage/bytea-blob-store.ts`).

## 1. Summary of Known Orphan / Best-Effort Paths

Ember writes payload bytes to Cloudflare R2 before committing metadata pointers in PostgreSQL (`user_staged_uploads`, `bytea_staged_blobs`, `bytea_blobs`), and deletes R2 objects after deleting or rolling back metadata pointers. Because Cloudflare R2 and Neon PostgreSQL cannot share an atomic distributed transaction, three bounded classes of unreferenced R2 objects can remain in the bucket:

1. **Best-effort R2 deletion failures (`deleteR2Keys`)**:
   - `deleteR2Keys` (`packages/postgres/src/storage/r2-blob-store.ts`) intentionally swallows R2 `bucket.delete(...)` exceptions on cleanup paths (`sweepExpiredUnboundUploads`, `sweepOrphans`, `stageUpload` rollback cleanup, and `cleanupUnreferencedR2Keys`) so transient R2 errors do not mask database outcomes or fail cron sweeps.
   - Once the corresponding PostgreSQL metadata rows are deleted or rolled back, those R2 keys are unreachable from any tenant query but remain stored in R2 until reconciled.
2. **Process crashes / aborts between `putR2Bytes` and PostgreSQL `COMMIT`**:
   - If a Worker or process terminates after `putR2Bytes` succeeds and before the PostgreSQL transaction reaches `COMMIT` and executes its `catch` cleanup, no PostgreSQL record exists to track the uploaded R2 key.
3. **Ambiguous `COMMIT` retention when confirmation cannot verify absence**:
   - In `PostgresB3StagedUploadRepository.stageUpload`, when `COMMIT` is attempted and throws a client-side exception (e.g., lost ACK), cleanup reacquires the upload advisory lock (`ember.upload:<tenantId>:<principalId>`) and deletes the R2 object **only** if `user_staged_uploads` positively confirms the row does not exist.
   - If the confirmation query itself fails (e.g., database outage), `stageUpload` retains the R2 object rather than risking R2 data loss for a committed upload. If the original `COMMIT` had actually rolled back, that retained R2 object becomes an untracked orphan.

## 2. Why Deferred (Out of Scope for PR #165)

- None of these paths cause data loss, cross-tenant leakage, or dangling references in PostgreSQL: committed rows always retain their R2 objects, and unreferenced R2 objects are unreachable via API/Worker queries (`uploads/<tenant>/<uploadId>`, `staged/<tenant>/<sha256>`, `blobs/<tenant>/<sha256>`).
- Adding a full R2 bucket-listing + PostgreSQL reconciliation sweep (with quarantine window, cursor pagination, and lock coordination) requires dedicated operational testing and quota/cost review, and is deferred rather than introducing an unvalidated GC framework inside PR #165.

## 3. Recommended Future Remediation

When R2 storage volume or V2 migration warrants full orphan reconciliation:

1. Add a low-frequency, paginated R2 prefix reconciliation job (`uploads/`, `staged/`, `blobs/`) with a conservative minimum-age quarantine (`lastModified` older than e.g. 24h) so in-flight uploads and staged blobs are never touched.
2. Before deleting any candidate R2 key, verify absence in PostgreSQL (`user_staged_uploads`, `bytea_staged_blobs`, `bytea_blobs`, `blobs`, `artifacts`) under the relevant advisory lock (`ember.upload:<tenant>:<principal>` or `blobLockKey(tenant, sha256)`).
3. Emit structured metrics/counters for `r2_delete_failures` and `r2_orphans_reclaimed`.
