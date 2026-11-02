import { randomUUID } from 'node:crypto';
import {
  COMMITMENT_TITLE_LIMITS,
  CommitmentDtoSchema,
  CommitmentOutcomeDtoSchema,
  CreateCommitmentRequestSchema,
  deriveTaskCreationIdempotencyKey,
  OUTCOME_RESULT_STATUSES,
  OUTCOME_SUMMARY_LIMITS,
  SourceSnapshotSchema,
} from '@ember/contracts';
import { describe, expect, it } from 'vitest';

describe('P0-C3A Commitment Contracts & Schemas', () => {
  const validAgentId = randomUUID();
  const validTenantId = randomUUID();
  const validCommitmentId = randomUUID();
  const validOccurrenceId = randomUUID();
  const validTaskId = randomUUID();
  const validOutcomeId = randomUUID();
  const nowIso = new Date().toISOString();

  describe('CreateCommitmentRequestSchema', () => {
    it('accepts a valid interval commitment request', () => {
      const valid = {
        agent_id: validAgentId,
        title: 'Monitor security releases',
        schedule_kind: 'interval',
        interval_seconds: 900,
        due_at: nowIso,
        source_profile_id: 'fixture.github-release',
      };

      const result = CreateCommitmentRequestSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('accepts a valid once commitment request without interval_seconds', () => {
      const valid = {
        agent_id: validAgentId,
        title: 'Single scan of public updates',
        schedule_kind: 'once',
        due_at: nowIso,
        source_profile_id: 'fixture.rss-feed',
      };

      const result = CreateCommitmentRequestSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects an interval commitment when interval_seconds is missing', () => {
      const invalid = {
        agent_id: validAgentId,
        title: 'Monitor security releases',
        schedule_kind: 'interval',
        source_profile_id: 'fixture.github-release',
      };

      const result = CreateCommitmentRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          'interval_seconds is required when schedule_kind is "interval"',
        );
      }
    });

    it('rejects an interval commitment when interval_seconds is below 900 seconds (15 min minimum)', () => {
      const invalid = {
        agent_id: validAgentId,
        title: 'High frequency polling attempt',
        schedule_kind: 'interval',
        interval_seconds: 60, // below 900s
        source_profile_id: 'fixture.github-release',
      };

      const result = CreateCommitmentRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects a once commitment when interval_seconds is provided', () => {
      const invalid = {
        agent_id: validAgentId,
        title: 'Single scan with interval',
        schedule_kind: 'once',
        interval_seconds: 1800,
        source_profile_id: 'fixture.rss-feed',
      };

      const result = CreateCommitmentRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          'interval_seconds must not be provided when schedule_kind is "once"',
        );
      }
    });

    it('rejects empty, blank, or whitespace-only titles', () => {
      const blank = {
        agent_id: validAgentId,
        title: '    ',
        schedule_kind: 'once',
        source_profile_id: 'fixture.rss-feed',
      };

      const result = CreateCommitmentRequestSchema.safeParse(blank);
      expect(result.success).toBe(false);
    });

    it('rejects titles exceeding 140 characters', () => {
      const longTitle = 'a'.repeat(COMMITMENT_TITLE_LIMITS.maxChars + 1);
      const invalid = {
        agent_id: validAgentId,
        title: longTitle,
        schedule_kind: 'once',
        source_profile_id: 'fixture.rss-feed',
      };

      const result = CreateCommitmentRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects caller attempts to smuggle tenant_id, principal_id, or version', () => {
      const smuggled = {
        agent_id: validAgentId,
        title: 'Smuggle check',
        schedule_kind: 'once',
        source_profile_id: 'fixture.rss-feed',
        tenant_id: validTenantId,
        version: 1,
      };

      const result = CreateCommitmentRequestSchema.safeParse(smuggled);
      expect(result.success).toBe(false);
    });

    it('rejects invalid source_profile_id not matching pattern', () => {
      const invalidProfile = {
        agent_id: validAgentId,
        title: 'Check pattern',
        schedule_kind: 'once',
        source_profile_id: 'https://evil.example.com/steal-creds', // Raw URLs forbidden!
      };

      const result = CreateCommitmentRequestSchema.safeParse(invalidProfile);
      expect(result.success).toBe(false);
    });
  });

  describe('CommitmentDtoSchema', () => {
    it('validates a complete wire CommitmentDto', () => {
      const dto = {
        commitment_id: validCommitmentId,
        tenant_id: validTenantId,
        agent_id: validAgentId,
        title: 'Valid Commitment',
        status: 'active',
        schedule_kind: 'interval',
        interval_seconds: 1800,
        next_due_at: nowIso,
        source_profile_id: 'fixture.weather-report',
        version: 1,
        created_at: nowIso,
        updated_at: nowIso,
      };

      const result = CommitmentDtoSchema.safeParse(dto);
      expect(result.success).toBe(true);
    });

    it('rejects unknown status or schedule kind values', () => {
      const dto = {
        commitment_id: validCommitmentId,
        tenant_id: validTenantId,
        agent_id: validAgentId,
        title: 'Invalid Status Commitment',
        status: 'unknown_status',
        schedule_kind: 'interval',
        interval_seconds: 1800,
        next_due_at: nowIso,
        source_profile_id: 'fixture.weather-report',
        version: 1,
        created_at: nowIso,
        updated_at: nowIso,
      };

      const result = CommitmentDtoSchema.safeParse(dto);
      expect(result.success).toBe(false);
    });
  });

  describe('CommitmentOutcomeDtoSchema', () => {
    it('accepts valid outcome statuses: meaningful_change, no_change, failed, denied', () => {
      for (const status of OUTCOME_RESULT_STATUSES) {
        const dto = {
          outcome_id: validOutcomeId,
          commitment_id: validCommitmentId,
          occurrence_id: validOccurrenceId,
          task_id: validTaskId,
          summary: `Summary for status: ${status}`,
          result_status: status,
          created_at: nowIso,
        };

        const result = CommitmentOutcomeDtoSchema.safeParse(dto);
        expect(result.success).toBe(true);
      }
    });

    it('rejects summary exceeding 2000 characters', () => {
      const dto = {
        outcome_id: validOutcomeId,
        commitment_id: validCommitmentId,
        occurrence_id: validOccurrenceId,
        task_id: validTaskId,
        summary: 'x'.repeat(OUTCOME_SUMMARY_LIMITS.maxChars + 1),
        result_status: 'meaningful_change',
        created_at: nowIso,
      };

      const result = CommitmentOutcomeDtoSchema.safeParse(dto);
      expect(result.success).toBe(false);
    });
  });

  describe('SourceSnapshotSchema', () => {
    it('accepts valid bounded snapshot with SHA-256 digest', () => {
      const snapshot = {
        sourceProfileId: 'fixture.github-release',
        observedAt: nowIso,
        digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        boundedSafeItems: [
          {
            id: 'item-1',
            title: 'Release v1.0.0',
            contentSnippet: 'First stable release notes without credentials.',
            observedAt: nowIso,
          },
        ],
      };

      const result = SourceSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it('rejects snapshot items exceeding maxItems (50)', () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        id: `item-${i}`,
        title: `Title ${i}`,
        contentSnippet: `Snippet ${i}`,
        observedAt: nowIso,
      }));

      const snapshot = {
        sourceProfileId: 'fixture.github-release',
        observedAt: nowIso,
        digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        boundedSafeItems: items,
      };

      const result = SourceSnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(false);
    });
  });

  describe('deriveTaskCreationIdempotencyKey', () => {
    it('produces deterministic header-safe idempotency key for task creation', () => {
      const occId = '00000000-0000-4000-8000-000000000099';
      const key1 = deriveTaskCreationIdempotencyKey(occId);
      const key2 = deriveTaskCreationIdempotencyKey(occId);

      expect(key1).toBe('commitment-occ:00000000-0000-4000-8000-000000000099');
      expect(key1).toBe(key2);
    });
  });
});
