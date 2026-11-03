/** Base path of the consent surface. Mirrors `COMMITMENTS_PATH` / `APPROVALS_PATH`. */
export const CONSENTS_PATH = '/v1/consents';

/**
 * Consent bodies are tiny (a profile id, two operation flags, a handful of scopes), so the cap
 * is far below the task/commitment limits on purpose.
 */
export const MAX_CONSENT_BODY_BYTES = 16_384;
