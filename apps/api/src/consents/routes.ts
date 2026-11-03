import {
  SourceProfileIdSchema,
  toConsentGrantDto,
  toConsentGrantListDto,
  toConsentGrantReceiptDto,
  parseGrantConsentRequestDto,
  parseRevokeConsentRequestDto,
  type RevokeConsentRequestDto,
} from '@ember/contracts';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { readJsonBody, type BodyRejectionReason } from '../http/bounded-body.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import type { ConsentHttpStore } from './consent-store.js';
import { CONSENTS_PATH, MAX_CONSENT_BODY_BYTES } from './constants.js';

/**
 * Consent surface (P0-C3D).
 *
 * | method | path                                   | meaning                          |
 * | ------ | -------------------------------------- | -------------------------------- |
 * | GET    | /v1/consents                           | list this tenant's grants        |
 * | POST   | /v1/consents                           | grant or re-grant consent        |
 * | GET    | /v1/consents/:sourceProfileId          | read one grant                   |
 * | POST   | /v1/consents/:sourceProfileId/revoke   | revoke a grant                   |
 *
 * Every handler reads the caller from `c.get('auth')` only. There is no `tenant_id` in any
 * path, query, header or body: the tenant is always the verified credential's tenant, so a
 * client cannot address another tenant's grant. Missing and cross-tenant grants both answer
 * `404` with the same body.
 */

const BODY_REJECTION_MESSAGES: Readonly<Record<BodyRejectionReason, string>> = Object.freeze({
  missing_content_type: 'Content-Type must be application/json',
  unsupported_content_type: 'Content-Type must be application/json',
  empty_body: 'request body must be a JSON object',
  too_large: `request body must not exceed ${MAX_CONSENT_BODY_BYTES} bytes`,
  invalid_encoding: 'request body must be UTF-8 encoded JSON',
  invalid_json: 'request body must be valid JSON',
});

export interface ConsentRouteDependencies {
  readonly consents: ConsentHttpStore;
}

function parseSourceProfileIdParam(c: AppContext): string | Response {
  const parsed = SourceProfileIdSchema.safeParse(c.req.param('sourceProfileId'));

  if (!parsed.success) {
    return respondInvalidArgument(c, 'sourceProfileId must be a valid source profile identifier');
  }

  return parsed.data;
}

/**
 * Read the optional body of a revoke request.
 *
 * A revoke needs no body, so an absent body means "no compare-and-set". An unlabelled body
 * (bytes but no `Content-Type`) is rejected rather than silently ignored, so a client that
 * intended to send `expected_version` can never believe it was applied.
 */
async function readOptionalRevokeBody(c: AppContext): Promise<RevokeConsentRequestDto | Response> {
  const contentType = c.req.header('content-type');
  const declaredLength = c.req.header('content-length');

  if (contentType === undefined) {
    const hasUnlabelledBody = declaredLength !== undefined && Number(declaredLength) > 0;

    if (!hasUnlabelledBody) {
      return {};
    }

    return respondInvalidArgument(c, 'Content-Type must be application/json');
  }

  const body = await readJsonBody(c.req.raw, MAX_CONSENT_BODY_BYTES);

  if (!body.ok) {
    return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
  }

  const parsed = parseRevokeConsentRequestDto(body.value);

  return parsed;
}

export function createConsentRoutes(deps: ConsentRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const grants = await deps.consents.list(auth);

    return c.json(toConsentGrantListDto(grants), 200);
  });

  routes.post('/', async (c) => {
    const auth = c.get('auth');

    const body = await readJsonBody(c.req.raw, MAX_CONSENT_BODY_BYTES);
    if (!body.ok) {
      return respondInvalidArgument(c, BODY_REJECTION_MESSAGES[body.reason]);
    }

    const request = parseGrantConsentRequestDto(body.value);

    const result = await deps.consents.grant(auth, {
      sourceProfileId: request.source_profile_id,
      allowedOperations: request.allowed_operations,
      scopes: request.scopes,
      expiresAt: request.expires_at,
    });

    const receipt = toConsentGrantReceiptDto(result.consent, result.replayed);

    c.header('Location', `${CONSENTS_PATH}/${receipt.consent.source_profile_id}`);
    return c.json(receipt, result.replayed ? 200 : 201);
  });

  routes.get('/:sourceProfileId', async (c) => {
    const auth = c.get('auth');
    const sourceProfileId = parseSourceProfileIdParam(c);

    if (sourceProfileId instanceof Response) {
      return sourceProfileId;
    }

    const grant = await deps.consents.get(auth, sourceProfileId);

    if (grant === null) {
      return respondNotFound(c, 'consent grant not found');
    }

    return c.json({ consent: toConsentGrantDto(grant) }, 200);
  });

  routes.post('/:sourceProfileId/revoke', async (c) => {
    const auth = c.get('auth');
    const sourceProfileId = parseSourceProfileIdParam(c);

    if (sourceProfileId instanceof Response) {
      return sourceProfileId;
    }

    const request = await readOptionalRevokeBody(c);

    if (request instanceof Response) {
      return request;
    }

    const revoked = await deps.consents.revoke(auth, sourceProfileId, {
      expectedVersion: request.expected_version,
    });

    return c.json({ consent: toConsentGrantDto(revoked) }, 200);
  });

  return routes;
}
