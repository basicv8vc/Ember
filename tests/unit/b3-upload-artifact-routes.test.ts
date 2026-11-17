import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { B3StagedUploadReceiptDtoSchema, ErrorResponseSchema } from '@ember/contracts';
import type { AuthContext } from '@ember/domain';
import type {
  B3ArtifactDownload,
  B3StagedUploadRepository,
  B1AuthenticatedSession,
  B1ProvisionedSession,
  B1SessionRotationResult,
  StageUploadInput,
} from '@ember/postgres';
import { Hono } from 'hono';
import {
  createSessionService,
  type B1SessionPorts,
} from '../../apps/api/src/auth/session-service.js';
import { generateSessionToken } from '../../apps/api/src/auth/session-token.js';
import { requestIdMiddleware, type AppBindings } from '../../apps/api/src/http/app-context.js';
import { createB3UploadArtifactRoutes } from '../../apps/api/src/uploads/b3-upload-artifact-routes.js';

const REQUEST_ID = 'b3-upload-route-test-req';
const TENANT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const TOKEN = generateSessionToken();
const MAX_UPLOAD_REQUEST_BYTES = 16_777_216;

function createTestSessionService() {
  const authenticated: B1AuthenticatedSession = {
    session: {
      sessionId: randomUUID(),
      consumerId: randomUUID(),
      tenantId: TENANT_ID,
      expiresAt: '2026-12-05T00:00:00.000Z',
      idleExpiresAt: '2026-11-19T00:00:00.000Z',
      revokedAt: null,
    },
    principalId: PRINCIPAL_ID,
    policyVersion: 1,
  };
  const ports: B1SessionPorts = {
    provisioning: {
      provisionIdentityAndCreateSession(): Promise<B1ProvisionedSession> {
        return Promise.reject(new Error('unused'));
      },
    },
    sessions: {
      findActiveSession(): Promise<B1AuthenticatedSession> {
        return Promise.resolve(authenticated);
      },
      rotateSession(): Promise<B1SessionRotationResult> {
        return Promise.resolve({ kind: 'inactive' });
      },
      revokeSession(): Promise<void> {
        return Promise.resolve();
      },
    },
    me: {
      getMeForTenant() {
        return Promise.resolve(null);
      },
    },
  };
  return createSessionService({ ports });
}

function buildTestApp(uploads: B3StagedUploadRepository): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use(
    '*',
    requestIdMiddleware(() => REQUEST_ID),
  );
  app.route(
    '/v1',
    createB3UploadArtifactRoutes({
      session: createTestSessionService(),
      uploads,
    }),
  );
  return app;
}

function makeFakeUploadsRepo(
  recorded: Array<{ ctx: AuthContext; input: StageUploadInput }>,
): B3StagedUploadRepository {
  return {
    stageUpload(ctx, input) {
      recorded.push({ ctx, input });
      return Promise.resolve(
        B3StagedUploadReceiptDtoSchema.parse({
          upload_id: randomUUID(),
          filename: input.filename,
          media_type: input.mediaType,
          size: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          expires_at: '2026-11-17T00:00:00.000Z',
          created_at: '2026-11-16T00:00:00.000Z',
        }),
      );
    },
    listTaskArtifacts(_ctx, taskId) {
      return Promise.resolve({ task_id: taskId, artifacts: [] });
    },
    getTaskArtifactDownload(_ctx, _artifactId): Promise<B3ArtifactDownload | null> {
      return Promise.resolve(null);
    },
    sweepExpiredUnboundUploads() {
      return Promise.resolve({ removed: 0 });
    },
  };
}

function encodeMultipartParts(
  boundary: string,
  parts: readonly {
    readonly name: string;
    readonly value: string;
    readonly filename?: string;
    readonly contentType?: string;
  }[],
): Uint8Array {
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if (part.filename !== undefined) {
      chunks.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
      );
      if (part.contentType !== undefined) {
        chunks.push(`Content-Type: ${part.contentType}\r\n`);
      }
      chunks.push(`\r\n${part.value}\r\n`);
    } else {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`);
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return new TextEncoder().encode(chunks.join(''));
}

function chunkedStream(
  payload: Uint8Array,
  chunkSize: number,
  onStats?: { chunksRead: number; bytesEnqueued: number; cancelled: boolean },
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      const nextEnd = Math.min(payload.byteLength, offset + chunkSize);
      const slice = payload.slice(offset, nextEnd);
      offset = nextEnd;
      if (onStats !== undefined) {
        onStats.chunksRead += 1;
        onStats.bytesEnqueued += slice.byteLength;
      }
      controller.enqueue(slice);
    },
    cancel() {
      if (onStats !== undefined) {
        onStats.cancelled = true;
      }
    },
  });
}

describe('B3 upload and artifact routes', () => {
  it('requires session auth and rejects client-supplied tenant or principal scope', async () => {
    const recorded: Array<{ ctx: AuthContext; input: StageUploadInput }> = [];
    const app = buildTestApp(makeFakeUploadsRepo(recorded));

    const unauth = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'a.csv', media_type: 'text/csv', content: 'a,b\n1,2\n' }),
    });
    expect(unauth.status).toBe(401);

    const headerScope = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-tenant-id': randomUUID(),
      },
      body: JSON.stringify({ filename: 'a.csv', media_type: 'text/csv', content: 'a,b\n1,2\n' }),
    });
    expect(headerScope.status).toBe(400);

    const queryScope = await app.request(`/v1/me/uploads?principal_id=${randomUUID()}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ filename: 'a.csv', media_type: 'text/csv', content: 'a,b\n1,2\n' }),
    });
    expect(queryScope.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });

  it('stages valid JSON and multipart uploads under verified session AuthContext', async () => {
    const recorded: Array<{ ctx: AuthContext; input: StageUploadInput }> = [];
    const app = buildTestApp(makeFakeUploadsRepo(recorded));

    const jsonRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'revenue.csv',
        media_type: 'text/csv',
        content: 'region,amount\napac,200\n',
      }),
    });
    expect(jsonRes.status).toBe(201);
    expect(B3StagedUploadReceiptDtoSchema.safeParse(await jsonRes.json()).success).toBe(true);

    const boundary = 'emberTestBoundary123';
    const mpBytes = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'notes.md',
        contentType: 'text/markdown',
        value: '# Summary\nhello\n',
      },
      { name: 'filename', value: 'notes.md' },
      { name: 'media_type', value: 'text/markdown' },
    ]);
    const mpRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: mpBytes,
    });
    expect(mpRes.status).toBe(201);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.ctx).toEqual({
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      policyVersion: 1,
    });
    expect(recorded[1]!.ctx).toEqual({
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      policyVersion: 1,
    });
    expect(recorded[1]!.input.filename).toBe('notes.md');
    expect(recorded[1]!.input.mediaType).toBe('text/markdown');
    expect(new TextDecoder().decode(recorded[1]!.input.bytes)).toBe('# Summary\nhello\n');

    const pdfBytes = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        value: '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n',
      },
      { name: 'filename', value: 'report.pdf' },
      { name: 'media_type', value: 'application/pdf' },
    ]);
    const pdfRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: pdfBytes,
    });
    expect(pdfRes.status).toBe(201);
    expect(recorded[2]!.input.mediaType).toBe('application/pdf');

    const imgBytes = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        value: '\xff\xd8\xff\xe0JFIF',
      },
      { name: 'filename', value: 'photo.jpg' },
      { name: 'media_type', value: 'image/jpeg' },
    ]);
    const imgRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: imgBytes,
    });
    expect(imgRes.status).toBe(201);
    expect(recorded[3]!.input.mediaType).toBe('image/jpeg');

    for (const blockedMime of ['text/html', 'image/svg+xml']) {
      const blockedRes = await app.request('/v1/me/uploads', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'payload.txt',
          media_type: blockedMime,
          content: 'blocked',
        }),
      });
      expect(blockedRes.status).toBe(400);
    }
  });

  it('aborts streamed multipart upload with no Content-Length before reading past MAX_UPLOAD_REQUEST_BYTES', async () => {
    const recorded: Array<{ ctx: AuthContext; input: StageUploadInput }> = [];
    const app = buildTestApp(makeFakeUploadsRepo(recorded));

    const boundary = 'emberNoLenBoundary';
    const hugePayload = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'big.csv',
        contentType: 'text/csv',
        value: 'x'.repeat(MAX_UPLOAD_REQUEST_BYTES + 200_000),
      },
    ]);
    const stats = { chunksRead: 0, bytesEnqueued: 0, cancelled: false };
    const req = new Request('http://localhost/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: chunkedStream(hugePayload, 16_384, stats),
      duplex: 'half',
    });

    const res = await app.request(req);
    expect(res.status).toBe(400);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe('INVALID_ARGUMENT');
    expect(stats.cancelled).toBe(true);
    expect(stats.bytesEnqueued).toBeLessThan(hugePayload.byteLength);
    expect(recorded).toHaveLength(0);
  });

  it('rejects multipart upload with spoofed small Content-Length when streamed body exceeds limit', async () => {
    const recorded: Array<{ ctx: AuthContext; input: StageUploadInput }> = [];
    const app = buildTestApp(makeFakeUploadsRepo(recorded));

    const boundary = 'emberSpoofLenBoundary';
    const oversized = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'small.csv',
        contentType: 'text/csv',
        value: 'a,b\n1,2\n',
      },
      {
        name: 'extra_blob',
        value: 'z'.repeat(MAX_UPLOAD_REQUEST_BYTES + 128_000),
      },
    ]);
    const stats = { chunksRead: 0, bytesEnqueued: 0, cancelled: false };
    const req = new Request('http://localhost/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': '64',
      },
      body: chunkedStream(oversized, 16_384, stats),
      duplex: 'half',
    });

    const res = await app.request(req);
    expect(res.status).toBe(400);
    expect(stats.cancelled).toBe(true);
    expect(stats.bytesEnqueued).toBeLessThan(oversized.byteLength);
    expect(recorded).toHaveLength(0);
  });

  it('rejects unexpected extra fields and duplicate fields in multipart uploads even within body limit', async () => {
    const recorded: Array<{ ctx: AuthContext; input: StageUploadInput }> = [];
    const app = buildTestApp(makeFakeUploadsRepo(recorded));

    const boundary = 'emberUnexpectedBoundary';
    const withExtraField = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'ok.csv',
        contentType: 'text/csv',
        value: 'a,b\n1,2\n',
      },
      {
        name: 'unexpected_junk',
        value: 'x'.repeat(200_000),
      },
    ]);

    const extraRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: withExtraField,
    });
    expect(extraRes.status).toBe(400);
    expect(ErrorResponseSchema.parse(await extraRes.json()).error.code).toBe('INVALID_ARGUMENT');

    const withDuplicateFile = encodeMultipartParts(boundary, [
      {
        name: 'file',
        filename: 'first.csv',
        contentType: 'text/csv',
        value: 'a,b\n1,2\n',
      },
      {
        name: 'file',
        filename: 'second.csv',
        contentType: 'text/csv',
        value: 'c,d\n3,4\n',
      },
    ]);
    const dupRes = await app.request('/v1/me/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: withDuplicateFile,
    });
    expect(dupRes.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });
});
