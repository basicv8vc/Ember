import type { ConsentDecision, ConsentDenialCode, ConsentOperation } from '@ember/contracts';
import { DomainError } from '@ember/domain';

/**
 * Shared consent SQL and evaluation for every PostgreSQL writer that needs an authorization
 * decision: `PostgresConsentRepository` (API surface) and `PostgresCommitmentRepository`
 * (dispatch + publication fence).
 *
 * All rows are read with the *same* projection so `is_effective` / `effective_status` are
 * always derived by PostgreSQL from `clock_timestamp()`. Expiry is therefore never decided by
 * a host clock, and a skew between web replicas cannot widen a grant.
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
  /** Stored status with expiry folded in: `active` | `revoked` | `expired`. */
  effective_status: string;
  /** `true` only while the grant may authorise an operation right now. */
  is_effective: boolean;
}

/**
 * Column list shared by every consent read. `consented_at`/`clock_timestamp()` comparisons
 * happen here, once, so callers cannot accidentally reintroduce a host-clock comparison.
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
  CASE
    WHEN status = 'revoked' THEN 'revoked'
    WHEN expires_at IS NOT NULL AND expires_at <= clock_timestamp() THEN 'expired'
    ELSE 'active'
  END AS effective_status,
  (status = 'active' AND (expires_at IS NULL OR expires_at > clock_timestamp())) AS is_effective
`;

/** Read one grant inside the caller's transaction and lock it for the rest of that transaction. */
export const SELECT_CONSENT_FOR_UPDATE_SQL = `
  SELECT ${CONSENT_COLUMNS_SQL}
  FROM consent_grants
  WHERE tenant_id = $1 AND source_profile_id = $2
  FOR UPDATE
`;

/** Read one grant without locking (list/read paths). */
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
  OPERATION_NOT_ALLOWED: 'the consent grant does not allow this operation',
  CONSENT_VERSION_STALE:
    'consent changed after this work was dispatched; the authorization fence is stale',
});

/**
 * Pure evaluation of one locked/read consent row. Kept side-effect free so both the API and the
 * publication guard can reuse exactly one verdict, and so unit tests can exercise the matrix
 * without a database.
 *
 * `requiredVersion` is the authorization fence: when it is a number, the grant must still be at
 * exactly that version. `null`/`undefined` means "no fence recorded" (work dispatched before
 * the fence existed) and only requires the grant to be effective right now.
 */
export function evaluateConsentRow(
  row: ConsentGrantRow | undefined,
  operation: ConsentOperation,
  requiredVersion?: number | null,
): ConsentDecision {
  if (row === undefined) {
    return { allowed: false, denialCode: 'CONSENT_NOT_FOUND', consentVersion: null };
  }

  if (row.status === 'revoked' || row.effective_status === 'revoked') {
    return { allowed: false, denialCode: 'CONSENT_REVOKED', consentVersion: null };
  }

  if (row.effective_status === 'expired' || !row.is_effective) {
    return { allowed: false, denialCode: 'CONSENT_EXPIRED', consentVersion: null };
  }

  if (!row.allowed_operations.includes(operation)) {
    return { allowed: false, denialCode: 'OPERATION_NOT_ALLOWED', consentVersion: null };
  }

  if (
    requiredVersion !== undefined &&
    requiredVersion !== null &&
    row.version !== requiredVersion
  ) {
    return { allowed: false, denialCode: 'CONSENT_VERSION_STALE', consentVersion: row.version };
  }

  return { allowed: true, denialCode: null, consentVersion: row.version };
}

/**
 * Turn a denial into the transport-neutral failure every writer already uses for authorization.
 * The reason stays in `diagnostic`; a client only ever sees the fixed `POLICY_DENIED` text.
 */
export function assertConsentAllowed(
  decision: ConsentDecision,
  operation: ConsentOperation,
): asserts decision is ConsentDecision & { allowed: true } {
  if (decision.allowed || decision.denialCode === null) {
    return;
  }

  throw new DomainError(
    'POLICY_DENIED',
    `${DENIAL_DIAGNOSTICS[decision.denialCode]} (operation='${operation}', reason=${decision.denialCode})`,
  );
}
