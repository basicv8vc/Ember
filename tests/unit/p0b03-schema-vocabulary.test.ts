import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  RUN_STATUSES,
  TASK_EVENT_PHASES,
  TASK_KINDS,
  TASK_STATUSES,
} from '@ember/domain';

const migrationSql = await readFile(
  new URL('../../migrations/0002_durable_task_inbox.sql', import.meta.url),
  'utf8',
);
const notesMigrationSql = await readFile(
  new URL('../../migrations/0020_b3_notes_action_items.sql', import.meta.url),
  'utf8',
);

describe('P0B-03 schema vocabulary', () => {
  it('keeps SQL value checks aligned with the domain vocabulary', () => {
    for (const value of [...TASK_KINDS, ...TASK_STATUSES, ...RUN_STATUSES, ...TASK_EVENT_PHASES]) {
      const targetSql = value === 'notes.action_items' ? notesMigrationSql : migrationSql;
      expect(targetSql).toContain(`'${value}'`);
    }

    for (const code of DOMAIN_ERROR_CODES) {
      expect(migrationSql).toContain(`'${code}'`);
    }
  });

  it('declares tenant-scoped idempotency uniqueness in SQL', () => {
    expect(migrationSql).toContain('UNIQUE (tenant_id, idempotency_key)');
    expect(migrationSql).toContain('PRIMARY KEY (tenant_id, agent_id)');
    expect(migrationSql).toContain('REFERENCES agents (tenant_id, id)');
    expect(migrationSql).toContain('REFERENCES tasks (tenant_id, id)');
  });

  it('does not add credential or host-path columns to the business schema', () => {
    expect(migrationSql).not.toMatch(/\b(api_key|access_token|password|client_secret)\b/i);
    expect(migrationSql).not.toMatch(/\b(host_path|absolute_path|local_path)\b/i);
  });
});
