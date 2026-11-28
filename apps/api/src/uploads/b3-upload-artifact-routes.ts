import {
  ArtifactFilenameSchema,
  B3StagedUploadMediaTypeSchema,
  B3StagedUploadReceiptDtoSchema,
  B3TaskArtifactsListDtoSchema,
  IdSchema,
  PYTHON_AGENT_LIMITS,
  isSafeArtifactFilename,
  type B3StagedUploadRepository,
} from '@ember/contracts';
import { isDomainError } from '@ember/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSessionAuth } from '../auth/session-authenticator.js';
import type { SessionService } from '../auth/session-service.js';
import { requestIdOf, type AppBindings, type AppContext } from '../http/app-context.js';
import {
  readBoundedBodyBytes,
  readJsonBody,
  type BodyRejectionReason,
} from '../http/bounded-body.js';
import {
  INTERNAL_ERROR_CODE,
  UnexpectedNonErrorFault,
  respondInvalidArgument,
  respondNotFound,
  respondWithDomainError,
  toInternalErrorResponse,
  unexpectedErrorCategory,
} from '../http/error-mapping.js';
import type { Logger } from '../logger.js';

const MAX_MULTIPART_UPLOAD_REQUEST_BYTES = 16_777_216;
// Base64 encoding inflates the 15 MiB decoded file cap by 4/3 (~20 MiB) before JSON envelope overhead.
const MAX_JSON_UPLOAD_REQUEST_BYTES = 22_020_096;
const ALLOWED_MULTIPART_FIELDS = new Set(['file', 'filename', 'media_type']);
const MULTIPART_CONTENT_TYPE = /^multipart\/form-data(?:\s*;.*)?$/i;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;.*)?$/i;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

const FORBIDDEN_SCOPE_QUERY_KEYS = [
  'tenant_id',
  'principal_id',
  'policy_version',
  'tenantId',
  'principalId',
  'policyVersion',
] as const;
const FORBIDDEN_SCOPE_HEADERS = ['x-tenant-id', 'x-principal-id', 'x-policy-version'] as const;

const BODY_REJECTION_MESSAGES: Readonly<Record<Exclude<BodyRejectionReason, 'too_large'>, string>> =
  Object.freeze({
    missing_content_type: 'Content-Type header is required',
    unsupported_content_type: 'Content-Type must be application/json or multipart/form-data',
    empty_body: 'request body must be a non-empty JSON object or multipart payload',
    invalid_encoding: 'request body must be UTF-8 encoded JSON',
    invalid_json: 'request body must be valid JSON',
  });

function bodyRejectionMessage(reason: BodyRejectionReason, maxBytes: number): string {
  return reason === 'too_large'
    ? `request body must not exceed ${maxBytes} bytes`
    : BODY_REJECTION_MESSAGES[reason];
}

const jsonUploadSchema = z
  .strictObject({
    filename: ArtifactFilenameSchema,
    media_type: B3StagedUploadMediaTypeSchema,
    content: z.string().optional(),
    content_base64: z.string().optional(),
  })
  .refine(
    (value) => (value.content !== undefined) !== (value.content_base64 !== undefined),
    'supply exactly one of content or content_base64',
  );

export interface B3UploadArtifactRouteDependencies {
  readonly session: SessionService;
  readonly uploads: B3StagedUploadRepository;
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

function rejectClientScope(c: AppContext): Response | undefined {
  const query = c.req.query();
  const hasQueryScope = FORBIDDEN_SCOPE_QUERY_KEYS.some((key) => query[key] !== undefined);
  const hasHeaderScope = FORBIDDEN_SCOPE_HEADERS.some(
    (header) => c.req.header(header) !== undefined,
  );

  if (hasQueryScope || hasHeaderScope) {
    return respondInvalidArgument(c, 'client-supplied identity scope fields are not allowed');
  }

  return undefined;
}

function hasAnyQueryParam(searchParams: URLSearchParams): boolean {
  for (const _key of searchParams.keys()) {
    return true;
  }
  return false;
}

function decodeStrictBase64(encoded: string): Uint8Array | null {
  const normalized = encoded.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }

  try {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function normalizeMediaType(raw: string): string {
  const semi = raw.indexOf(';');
  const base = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  return base;
}

async function parseUploadPayload(c: AppContext): Promise<
  | {
      readonly ok: true;
      readonly filename: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const contentType = c.req.header('content-type')?.trim() ?? '';
  if (contentType.length === 0) {
    return {
      ok: false,
      response: respondInvalidArgument(c, BODY_REJECTION_MESSAGES.missing_content_type),
    };
  }

  if (JSON_CONTENT_TYPE.test(contentType)) {
    const body = await readJsonBody(c.req.raw, MAX_JSON_UPLOAD_REQUEST_BYTES);
    if (!body.ok) {
      return {
        ok: false,
        response: respondInvalidArgument(
          c,
          bodyRejectionMessage(body.reason, MAX_JSON_UPLOAD_REQUEST_BYTES),
        ),
      };
    }

    const parsed = jsonUploadSchema.safeParse(body.value);
    if (!parsed.success) {
      return {
        ok: false,
        response: respondInvalidArgument(c, 'request body does not match upload schema'),
      };
    }

    let bytes: Uint8Array;
    if (parsed.data.content !== undefined) {
      bytes = new TextEncoder().encode(parsed.data.content);
    } else {
      const decoded = decodeStrictBase64(parsed.data.content_base64 ?? '');
      if (decoded === null) {
        return {
          ok: false,
          response: respondInvalidArgument(c, 'content_base64 must be valid base64'),
        };
      }
      bytes = decoded;
    }

    if (bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
      return {
        ok: false,
        response: respondInvalidArgument(
          c,
          `uploaded file exceeds ${PYTHON_AGENT_LIMITS.maxFileBytes} byte limit`,
        ),
      };
    }

    return {
      ok: true,
      filename: parsed.data.filename,
      mediaType: parsed.data.media_type,
      bytes,
    };
  }

  if (MULTIPART_CONTENT_TYPE.test(contentType)) {
    const bounded = await readBoundedBodyBytes(c.req.raw, MAX_MULTIPART_UPLOAD_REQUEST_BYTES);
    if (!bounded.ok) {
      return {
        ok: false,
        response: respondInvalidArgument(
          c,
          bodyRejectionMessage(bounded.reason, MAX_MULTIPART_UPLOAD_REQUEST_BYTES),
        ),
      };
    }

    let form: FormData;
    try {
      const boundedRequest = new Request(c.req.url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: bounded.bytes,
      });
      form = await boundedRequest.formData();
    } catch {
      return {
        ok: false,
        response: respondInvalidArgument(c, 'request body must be valid multipart/form-data'),
      };
    }

    const seenFields = new Set<string>();
    let fileEntry: Blob | null = null;
    let explicitFilename: string | undefined;
    let explicitMediaType: string | undefined;

    for (const [key, value] of form.entries()) {
      if (!ALLOWED_MULTIPART_FIELDS.has(key)) {
        return {
          ok: false,
          response: respondInvalidArgument(c, 'multipart form contains unexpected fields'),
        };
      }
      if (seenFields.has(key)) {
        return {
          ok: false,
          response: respondInvalidArgument(c, 'multipart form contains duplicate fields'),
        };
      }
      seenFields.add(key);

      if (key === 'file') {
        if (!(value instanceof Blob)) {
          return {
            ok: false,
            response: respondInvalidArgument(c, 'multipart form must include a file field'),
          };
        }
        fileEntry = value;
      } else if (key === 'filename') {
        if (typeof value !== 'string') {
          return {
            ok: false,
            response: respondInvalidArgument(c, 'filename field must be text'),
          };
        }
        explicitFilename = value;
      } else if (key === 'media_type') {
        if (typeof value !== 'string') {
          return {
            ok: false,
            response: respondInvalidArgument(c, 'media_type field must be text'),
          };
        }
        explicitMediaType = value;
      }
    }

    if (fileEntry === null) {
      return {
        ok: false,
        response: respondInvalidArgument(c, 'multipart form must include a file field'),
      };
    }

    if (fileEntry.size > PYTHON_AGENT_LIMITS.maxFileBytes) {
      return {
        ok: false,
        response: respondInvalidArgument(
          c,
          `uploaded file exceeds ${PYTHON_AGENT_LIMITS.maxFileBytes} byte limit`,
        ),
      };
    }

    const rawFilename =
      explicitFilename !== undefined
        ? explicitFilename
        : 'name' in fileEntry && typeof fileEntry.name === 'string'
          ? fileEntry.name
          : '';
    const filenameParsed = ArtifactFilenameSchema.safeParse(rawFilename);
    if (!filenameParsed.success) {
      return {
        ok: false,
        response: respondInvalidArgument(c, 'filename must be a safe ASCII filename'),
      };
    }

    const rawMediaType = explicitMediaType !== undefined ? explicitMediaType : fileEntry.type;
    const mediaTypeParsed = B3StagedUploadMediaTypeSchema.safeParse(
      normalizeMediaType(rawMediaType),
    );
    if (!mediaTypeParsed.success) {
      return {
        ok: false,
        response: respondInvalidArgument(c, 'media_type must be a supported safe MIME type'),
      };
    }

    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    if (bytes.byteLength > PYTHON_AGENT_LIMITS.maxFileBytes) {
      return {
        ok: false,
        response: respondInvalidArgument(
          c,
          `uploaded file exceeds ${PYTHON_AGENT_LIMITS.maxFileBytes} byte limit`,
        ),
      };
    }

    return {
      ok: true,
      filename: filenameParsed.data,
      mediaType: mediaTypeParsed.data,
      bytes,
    };
  }

  return {
    ok: false,
    response: respondInvalidArgument(c, BODY_REJECTION_MESSAGES.unsupported_content_type),
  };
}

/**
 * B3 Session-authenticated pre-delegation upload staging and Task artifact download routes:
 * - `POST /v1/me/uploads`
 * - `GET /v1/me/tasks/:taskId/artifacts`
 * - `GET /v1/me/artifacts/:artifactId`
 */
export function createB3UploadArtifactRoutes(
  deps: B3UploadArtifactRouteDependencies,
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const sessionAuth = requireSessionAuth({ service: deps.session, logger: deps.logger });

  routes.post('/me/uploads', sessionAuth, async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      if (hasAnyQueryParam(new URL(c.req.url).searchParams)) {
        return respondInvalidArgument(c, 'upload endpoint accepts no query parameters');
      }

      const payload = await parseUploadPayload(c);
      if (!payload.ok) {
        return payload.response;
      }

      const receipt = await deps.uploads.stageUpload(c.get('auth'), {
        filename: payload.filename,
        mediaType: payload.mediaType,
        bytes: payload.bytes,
      });

      return c.json(B3StagedUploadReceiptDtoSchema.parse(receipt), 201);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.get('/me/tasks/:taskId/artifacts', sessionAuth, async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      if (hasAnyQueryParam(new URL(c.req.url).searchParams)) {
        return respondInvalidArgument(c, 'task artifacts lookup takes no query parameters');
      }

      const taskIdParsed = IdSchema.safeParse(c.req.param('taskId'));
      if (!taskIdParsed.success) {
        return respondInvalidArgument(c, 'task_id must be a UUID');
      }

      const list = await deps.uploads.listTaskArtifacts(c.get('auth'), taskIdParsed.data);
      if (list === null) {
        return respondNotFound(c, 'task is not visible in this tenant');
      }

      return c.json(B3TaskArtifactsListDtoSchema.parse(list), 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.get('/me/artifacts/:artifactId', sessionAuth, async (c) => {
    try {
      const rejected = rejectClientScope(c);
      if (rejected !== undefined) {
        return rejected;
      }

      if (hasAnyQueryParam(new URL(c.req.url).searchParams)) {
        return respondInvalidArgument(c, 'artifact download takes no query parameters');
      }

      const artifactIdParsed = IdSchema.safeParse(c.req.param('artifactId'));
      if (!artifactIdParsed.success) {
        return respondInvalidArgument(c, 'artifact_id must be a UUID');
      }

      const download = await deps.uploads.getTaskArtifactDownload(
        c.get('auth'),
        artifactIdParsed.data,
      );
      if (download === null) {
        return respondNotFound(c, 'artifact is not available in this tenant');
      }

      if (!MEDIA_TYPE_PATTERN.test(download.mediaType)) {
        return respondNotFound(c, 'artifact is not available in this tenant');
      }

      c.header('Content-Type', download.mediaType);
      c.header('Content-Length', String(download.bytes.byteLength));
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'private, no-store');
      if (download.filename !== null && isSafeArtifactFilename(download.filename)) {
        c.header('Content-Disposition', `attachment; filename="${download.filename}"`);
      }

      const responseBytes = new ArrayBuffer(download.bytes.byteLength);
      new Uint8Array(responseBytes).set(download.bytes);
      return c.body(responseBytes, 200);
    } catch (error) {
      throw error instanceof Error ? error : new UnexpectedNonErrorFault();
    }
  });

  routes.onError((error, c) => {
    const route = { requestId: requestIdOf(c), method: c.req.method, path: c.req.path };

    if (isDomainError(error)) {
      deps.logger?.warn('b3 upload/artifact route rejected', { ...route, code: error.code });
      return respondWithDomainError(c, error);
    }

    deps.logger?.error('b3 upload/artifact route fault', {
      ...route,
      code: INTERNAL_ERROR_CODE,
      category: unexpectedErrorCategory(error),
    });

    return c.json(toInternalErrorResponse(requestIdOf(c)), 500);
  });

  return routes;
}
