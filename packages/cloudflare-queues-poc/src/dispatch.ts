export interface TaskDispatchEnvelope {
  readonly schemaVersion: 1;
  /** Stable ID of the committed PostgreSQL dispatch/outbox event. */
  readonly eventId: string;
  readonly tenantId: string;
  readonly taskId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDispatchEnvelope(value: unknown): TaskDispatchEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(',') !== 'eventId,schemaVersion,taskId,tenantId' ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.eventId !== 'string' ||
    typeof candidate.tenantId !== 'string' ||
    typeof candidate.taskId !== 'string' ||
    !UUID_PATTERN.test(candidate.eventId) ||
    !UUID_PATTERN.test(candidate.tenantId) ||
    !UUID_PATTERN.test(candidate.taskId)
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    eventId: candidate.eventId,
    tenantId: candidate.tenantId,
    taskId: candidate.taskId,
  };
}

/** Workflow IDs are deterministic across Queue redelivery and remain within Cloudflare's 100-char cap. */
export function workflowInstanceId(eventId: string): string {
  if (!UUID_PATTERN.test(eventId)) {
    throw new TypeError('eventId must be a UUID');
  }

  return `ember-${eventId.replaceAll('-', '').toLowerCase()}`;
}

export function queueRetryDelaySeconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError('attempts must be a positive safe integer');
  }

  return Math.min(300, 2 ** Math.min(attempts - 1, 30));
}
