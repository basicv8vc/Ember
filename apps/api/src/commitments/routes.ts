import {
  CommitmentStatusSchema,
  CreateCommitmentRequestSchema,
  IdempotencyKeySchema,
  IdSchema,
  StateTransitionRequestSchema,
  type CommitmentReceiptDto,
  type CommitmentStatus,
} from '@ember/contracts';
import type { Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import type { CommitmentStore } from './commitment-store.js';
import {
  COMMITMENTS_PATH,
  IDEMPOTENCY_KEY_HEADER,
  MAX_COMMITMENT_BODY_BYTES,
} from './constants.js';

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_COMMITMENT_BODY_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

function parseCommitmentId(c: AppContext): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return respondInvalidArgument(c, 'id must be a UUID');
  }
  return parsed.data;
}

export interface CommitmentRouteDependencies {
  readonly store: CommitmentStore;
}

export function createCommitmentRoutes(deps: CommitmentRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.post('/', async (c) => {
    const auth = c.get('auth');
    const idempotencyHeader = c.req.header(IDEMPOTENCY_KEY_HEADER);

    if (idempotencyHeader === undefined) {
      return respondInvalidArgument(c, `${IDEMPOTENCY_KEY_HEADER} header is required`);
    }

    const idempotencyKey = IdempotencyKeySchema.safeParse(idempotencyHeader);
    if (!idempotencyKey.success) {
      return respondInvalidArgument(c, `${IDEMPOTENCY_KEY_HEADER} header is malformed`);
    }

    const body = await readJsonBody(c.req.raw, MAX_COMMITMENT_BODY_BYTES);
    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const request = CreateCommitmentRequestSchema.safeParse(body.value);
    if (!request.success) {
      return respondInvalidArgument(c, 'request body does not match the commitment schema');
    }

    const data = request.data;
    const result = await deps.store.create(auth, {
      idempotencyKey: idempotencyKey.data,
      agentId: data.agent_id,
      title: data.title,
      scheduleKind: data.schedule_kind,
      intervalSeconds: data.interval_seconds,
      dueAt: data.due_at ? new Date(data.due_at) : undefined,
      sourceProfileId: data.source_profile_id,
    });

    const receipt: CommitmentReceiptDto = {
      commitment_id: result.commitment.commitment_id,
      status: result.commitment.status,
      created_at: result.commitment.created_at,
      replayed: result.replayed,
    };

    c.header('Location', `${COMMITMENTS_PATH}/${receipt.commitment_id}`);
    return c.json(receipt, result.replayed ? 200 : 201);
  });

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const limitQuery = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const statusQuery = c.req.query('status');

    let limit: number | undefined;
    if (limitQuery !== undefined) {
      const parsedLimit = Number(limitQuery);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return respondInvalidArgument(c, 'limit must be a positive integer');
      }
      limit = parsedLimit;
    }

    let status: CommitmentStatus | undefined;
    if (statusQuery !== undefined) {
      const parsedStatus = CommitmentStatusSchema.safeParse(statusQuery);
      if (!parsedStatus.success) {
        return respondInvalidArgument(c, 'status filter is not a valid commitment status');
      }
      status = parsedStatus.data;
    }

    const result = await deps.store.list(auth, { limit, cursor, status });
    return c.json(
      {
        commitments: result.commitments,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  routes.get('/:id', async (c) => {
    const id = parseCommitmentId(c);
    if (id instanceof Response) {
      return id;
    }

    const commitment = await deps.store.get(c.get('auth'), id);
    if (commitment === null) {
      return respondNotFound(c, 'commitment is not visible in this tenant');
    }

    return c.json(commitment, 200);
  });

  async function parseExpectedVersion(c: AppContext): Promise<number | undefined | Response> {
    const rawContentLength = c.req.header('Content-Length');
    if (rawContentLength === '0' || rawContentLength === undefined) {
      return undefined;
    }
    const body = await readJsonBody(c.req.raw, MAX_COMMITMENT_BODY_BYTES);
    if (!body.ok) {
      // Empty body is acceptable for pause/resume/cancel
      if (body.reason === 'empty_body') {
        return undefined;
      }
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }
    const parsed = StateTransitionRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return respondInvalidArgument(c, 'invalid state transition payload');
    }
    return parsed.data.expected_version;
  }

  routes.post('/:id/pause', async (c) => {
    const id = parseCommitmentId(c);
    if (id instanceof Response) {
      return id;
    }

    const expectedVersion = await parseExpectedVersion(c);
    if (expectedVersion instanceof Response) {
      return expectedVersion;
    }

    const updated = await deps.store.pause(c.get('auth'), id, { expectedVersion });
    return c.json(updated, 200);
  });

  routes.post('/:id/resume', async (c) => {
    const id = parseCommitmentId(c);
    if (id instanceof Response) {
      return id;
    }

    const expectedVersion = await parseExpectedVersion(c);
    if (expectedVersion instanceof Response) {
      return expectedVersion;
    }

    const updated = await deps.store.resume(c.get('auth'), id, { expectedVersion });
    return c.json(updated, 200);
  });

  routes.post('/:id/cancel', async (c) => {
    const id = parseCommitmentId(c);
    if (id instanceof Response) {
      return id;
    }

    const expectedVersion = await parseExpectedVersion(c);
    if (expectedVersion instanceof Response) {
      return expectedVersion;
    }

    const updated = await deps.store.cancel(c.get('auth'), id, { expectedVersion });
    return c.json(updated, 200);
  });

  routes.get('/:id/outcomes', async (c) => {
    const id = parseCommitmentId(c);
    if (id instanceof Response) {
      return id;
    }

    const limitQuery = c.req.query('limit');
    const cursor = c.req.query('cursor');

    let limit: number | undefined;
    if (limitQuery !== undefined) {
      const parsedLimit = Number(limitQuery);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return respondInvalidArgument(c, 'limit must be a positive integer');
      }
      limit = parsedLimit;
    }

    const result = await deps.store.listOutcomes(c.get('auth'), id, { limit, cursor });
    if (result === null) {
      return respondNotFound(c, 'commitment is not visible in this tenant');
    }

    return c.json(
      {
        commitment_id: id,
        outcomes: result.outcomes,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  return routes;
}
