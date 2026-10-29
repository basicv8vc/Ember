import { randomUUID } from 'node:crypto';
import { DomainError, DOMAIN_ERROR_CODES, type DomainErrorCode } from '@ember/domain';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import {
  HTTP_STATUS_BY_DOMAIN_ERROR,
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  statusForDomainError,
  toInternalErrorResponse,
} from '../../apps/api/src/http/error-mapping.js';
import type { Logger } from '../../apps/api/src/logger.js';
import type { TaskStore } from '../../apps/api/src/tasks/task-store.js';

/**
 * P0B-07a error mapping: one closed table, total over `DomainErrorCode`, and bodies that
 * never carry internal diagnostics.
 */

const TENANT_ID = randomUUID();
const TOKEN = `token-${randomUUID()}`;
const REQUEST_ID = 'req-error-map-01';
/** Text that must never reach a client: SQL, a driver message or a secret. */
const DIAGNOSTIC = 'SELECT * FROM tasks WHERE token = super-secret-value';

function buildApp(store: TaskStore, logger?: Logger): ReturnType<typeof createApp> {
  return createApp({
    authenticator: createDevTokenAuthenticator([
      { token: TOKEN, tenantId: TENANT_ID, principalId: randomUUID(), policyVersion: 1 },
    ]),
    requestIdGenerator: () => REQUEST_ID,
    taskStore: store,
    ...(logger === undefined ? {} : { logger }),
  });
}

/** The fixed client-safe message chosen by a code (`DomainError.publicMessage`). */
function publicMessage(code: DomainErrorCode): string {
  return new DomainError(code, 'diagnostic that must never be serialised').publicMessage;
}

function failingStore(error: Error): TaskStore {
  return {
    create: () => Promise.reject(error),
    get: () => Promise.reject(error),
    listEvents: () => Promise.reject(error),
  };
}

function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe('HTTP_STATUS_BY_DOMAIN_ERROR', () => {
  it('covers every domain error code and nothing else', () => {
    expect(Object.keys(HTTP_STATUS_BY_DOMAIN_ERROR).sort()).toEqual([...DOMAIN_ERROR_CODES].sort());
  });

  it('is frozen and returns a client-error or server-error status for each code', () => {
    expect(Object.isFrozen(HTTP_STATUS_BY_DOMAIN_ERROR)).toBe(true);

    for (const code of DOMAIN_ERROR_CODES) {
      const status = statusForDomainError(code);
      expect(Number.isInteger(status), code).toBe(true);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThanOrEqual(599);
    }
  });

  it('maps the P0B-07 codes the task API actually emits', () => {
    expect(statusForDomainError('INVALID_ARGUMENT')).toBe(400);
    expect(statusForDomainError('UNAUTHENTICATED')).toBe(401);
    expect(statusForDomainError('NOT_FOUND')).toBe(404);
    expect(statusForDomainError('IDEMPOTENCY_CONFLICT')).toBe(409);
    expect(statusForDomainError('DB_UNAVAILABLE')).toBe(503);
  });

  it('never maps a cross-tenant read to a 403', () => {
    // A 403 would confirm that the identifier exists for somebody else.
    expect(statusForDomainError('NOT_FOUND')).not.toBe(403);
  });
});

describe('toInternalErrorResponse', () => {
  it('produces the fixed 500 body with an optional request id', () => {
    expect(toInternalErrorResponse(undefined)).toEqual({
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
    });
    expect(toInternalErrorResponse(REQUEST_ID)).toEqual({
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE, request_id: REQUEST_ID },
    });
  });
});

describe('app error handler', () => {
  it('maps every domain error code to its table status with a sanitised body', async () => {
    for (const code of DOMAIN_ERROR_CODES) {
      const response = await buildApp(failingStore(new DomainError(code, DIAGNOSTIC))).request(
        `/v1/tasks/${TENANT_ID}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );

      expect(response.status, code).toBe(HTTP_STATUS_BY_DOMAIN_ERROR[code]);
      const text = await response.text();
      expect(text, code).not.toContain('super-secret-value');
      expect(text, code).not.toContain('SELECT');
      expect(JSON.parse(text), code).toEqual({
        error: {
          code,
          message: publicMessage(code),
          request_id: REQUEST_ID,
        },
      });
    }
  });

  it('logs only the stable code for domain failures', async () => {
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger(), warn };

    await buildApp(failingStore(new DomainError('DB_UNAVAILABLE', DIAGNOSTIC)), logger).request(
      `/v1/tasks/${TENANT_ID}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0] as [string, Record<string, unknown>] | undefined;
    expect(call?.[0]).toBe('request failed');
    const context = call?.[1];
    expect(context).toMatchObject({ code: 'DB_UNAVAILABLE', requestId: REQUEST_ID });
    expect(JSON.stringify(context)).not.toContain('super-secret-value');
  });

  it('answers an unexpected fault with a generic 500 and no diagnostics', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger(), error };

    const response = await buildApp(failingStore(new TypeError(DIAGNOSTIC)), logger).request(
      `/v1/tasks/${TENANT_ID}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('super-secret-value');
    expect(JSON.parse(text)).toEqual(toInternalErrorResponse(REQUEST_ID));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('reports unknown routes as NOT_FOUND in the same error vocabulary', async () => {
    const response = await buildApp(failingStore(new Error('unused'))).request('/v1/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: publicMessage('NOT_FOUND'), request_id: REQUEST_ID },
    });
  });
});
