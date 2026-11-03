import {
  CONSENT_STATUSES,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  type ConsentDenialCode,
  type ConsentDecision,
  type ConsentGeneration,
  type ConsentOperation,
  type ConsentStatus,
} from '@ember/contracts';
import { DomainError } from '@ember/domain';

/**
 * Shared consent SQL and evaluation for every PostgreSQL writer that needs an authorization
 * decision: `PostgresConsentRepository` (API surface) and `PostgresConsentPublicationGuard`
 * (dispatch + publication fence).
 *
 * All rows are read with the *same* projection, and `expired` is derived from `expires_at`:
 *
 * - in production (no clock supplied) PostgreSQL evaluates it against `clock_timestamp()`, so a
 *   skewed web/worker host cannot widen a grant;
 * - a caller MAY supply an explicit clock (the conformance suite does, to be deterministic). That
 *   clock replaces the database clock entirely rather than being combined with it: combining them
 *   would make the evaluation depend on wall time and could not be replayed in a test.
 *
 * Only server-side code ever supplies a clock. The HTTP boundary never does.
 */
export interface ConsentGrantRow {
  id: string;
  tenant_id: string;
  source_profile_id: string;
  status: string;
  allowed_operations: string[];
  scopes: string[];
  granted_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  /** `true` when `expires_at` has passed according to the DATABASE clock. */
  is_expired: boolean;
  /** Stored status with the database-clock expiry folded in. */
  effective_status: string;
}

/**
 * Column list shared by every consent read. The expiry decision happens here, once, in SQL, so a
 * caller cannot accidentally reintroduce a host-clock comparison.
 */
export const CONSENT_COLUMNS_SQL = `
  id,
  tenant_id,
  source_profile_id,
  status,
  allowed_operations,
  scopes,
  granted_at,
  expires_at,
  revoked_at,
  version,
  created_at,
  updated_at,
  (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS is_expired,
  CASE
    WHEN status = 'revoked' THEN 'revoked'
    WHEN expires_at IS NOT NULL AND expires_at <= clock_timestamp() THEN 'expired'
    ELSE 'active'
  END AS effective_status
`;

/** Read one grant inside the caller's transaction and lock it for the rest of that transaction. */
export const SELECT_CONSENT_FOR_UPDATE_SQL = `
  SELECT ${CONSENT_COLUMNS_SQL}
  FROM consent_grants
  WHERE tenant_id = $1 AND source_profile_id = $2
  FOR UPDATE
`;

/** Read one grant without locking (read/list paths). */
export const SELECT_CONSENT_SQL = `
  SELECT ${CONSENT_COLUMNS_SQL}
  FROM consent_grants
  WHERE tenant_id = $1 AND source_profile_id = $2
`;

/** Human-readable, non-sensitive diagnostics for each denial reason (internal only). */
const DENIAL_DIAGNOSTICS: Readonly<Record<ConsentDenialCode, string>> = Object.freeze({
  CONSENT_NOT_FOUND: 'no consent grant authorises this source profile',
  CONSENT_REVOKED: 'consent for this source profile has been revoked',
  CONSENT_EXPIRED: 'consent for this source profile has expired',
  CONSENT_FENCE_MISSING:
    'the occurrence records no consent generation, so its source read cannot be attributed',
  CONSENT_FENCE_STALE: 'consent changed after this work was dispatched; the fence is stale',
  CONSENT_GENERATION_MISMATCH:
    'the recorded consent generation is not the current authoritative generation',
  OPERATION_NOT_ALLOWED: 'the consent grant does not allow this operation',
  SCOPE_NOT_GRANTED: 'the consent grant does not carry the scope this operation requires',
});

/** Effective status of a row, honouring an explicitly supplied clock when one is given. */
export function deriveRowStatus(row: ConsentGrantRow, now?: Date | null): ConsentStatus {
  if (row.status === 'revoked') {
    return 'revoked';
  }

  if (now !== undefined && now !== null) {
    if (Number.isNaN(now.getTime())) {
      return 'expired';
    }

    if (row.expires_at !== null) {
      const expiresAtMs = Date.parse(String(row.expires_at));
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
        return 'expired';
      }
    }

    return 'active';
  }

  return row.is_expired ? 'expired' : 'active';
}

export interface EvaluateConsentParams {
  /** Operation the caller wants to perform. Read paths pass `read_snapshot`. */
  readonly operation?: ConsentOperation;
  /** Scopes the operation requires. Read paths require `source.readonly`. */
  readonly requiredScopes?: readonly string[];
  /** Generation the work was dispatched under; `null`/absent means "no fence was recorded". */
  readonly fence?: ConsentGeneration | null;
  /** Explicit evaluation clock. Server-side only; omit in production. */
  readonly now?: Date | null;
  /**
   * Whether an absent fence is acceptable. It is NEVER acceptable for publication: an occurrence
   * without a recorded generation cannot prove which consent authorized its source read.
   */
  readonly requireFence?: boolean;
}

/**
 * Pure evaluation of one locked/read consent row. Side-effect free, so the API, the dispatch gate
 * and the publication gate all reuse exactly one verdict and unit tests can exercise the matrix
 * without a database.
 *
 * Order matters: the specific reason wins over the generic fence staleness, so an operator can
 * tell "revoked" from "re-granted", and a scope problem never masquerades as a missing grant.
 */
export function evaluateConsentRow(
  row: ConsentGrantRow | undefined,
  params: EvaluateConsentParams = {},
): ConsentDecision {
  const denied = (denialCode: ConsentDenialCode): ConsentDecision => ({
    allowed: false,
    denialCode,
    grantId: null,
    grantVersion: null,
  });

  if (row === undefined) {
    return denied('CONSENT_NOT_FOUND');
  }

  const status = deriveRowStatus(row, params.now);

  if (status === 'revoked') {
    return denied('CONSENT_REVOKED');
  }

  if (status !== 'active') {
    return denied('CONSENT_EXPIRED');
  }

  if (params.operation !== undefined && !row.allowed_operations.includes(params.operation)) {
    return denied('OPERATION_NOT_ALLOWED');
  }

  const requiredScopes = params.requiredScopes ?? [];

  if (requiredScopes.some((scope) => !row.scopes.includes(scope))) {
    return denied('SCOPE_NOT_GRANTED');
  }

  const fence = params.fence ?? null;

  if (fence === null) {
    if (params.requireFence === true) {
      return denied('CONSENT_FENCE_MISSING');
    }
  } else if (fence.grantId !== row.id) {
    // A different generation is authoritative now (revoke + re-grant, or a changed-terms
    // re-grant). The recorded fence can never authorize against it.
    return denied('CONSENT_GENERATION_MISMATCH');
  } else if (fence.version !== row.version) {
    return denied('CONSENT_FENCE_STALE');
  }

  return { allowed: true, denialCode: null, grantId: row.id, grantVersion: row.version };
}

/**
 * Turn a denial into the transport-neutral failure every writer already uses for authorization.
 * The reason stays in `diagnostic`; a client only ever sees the fixed `POLICY_DENIED` text.
 */
export function assertConsentAllowed(
  decision: ConsentDecision,
  operation: string,
): asserts decision is ConsentDecision & { allowed: true } {
  if (decision.allowed || decision.denialCode === null) {
    return;
  }

  throw new DomainError(
    'POLICY_DENIED',
    `${DENIAL_DIAGNOSTICS[decision.denialCode]} (operation='${operation}', reason=${decision.denialCode})`,
  );
}

/** The operation + scope a source read requires, per the frozen connector contract. */
export const READ_SNAPSHOT_REQUIREMENTS = Object.freeze({
  operation: SOURCE_READ_OPERATION,
  requiredScopes: [SOURCE_READ_SCOPE] as readonly string[],
});

/** Guard against a stored status the code does not know how to interpret. */
export function assertKnownStatus(value: string): ConsentStatus {
  const match = CONSENT_STATUSES.find((status) => status === value);

  if (match === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'persisted consent status is invalid');
  }

  return match;
}
