/**
 * Consent contract access for `@ember/connectors`.
 *
 * The contract itself is defined ONCE, in `@ember/contracts` (`consent.ts`). This module is a
 * re-export boundary only: it keeps `@ember/connectors`' public surface stable for the connector
 * tests, the fake registry and the guarded source reader while guaranteeing that they can never
 * drift from the definitions the Worker and the PostgreSQL persistence layer use.
 *
 * Do not re-implement anything here. A second copy of the fence digest, the status precedence or
 * the generation comparison would let two layers disagree about whether a generation is still
 * current, which is exactly the failure this consolidation removes.
 */

export {
  CONSENT_FENCE_DIGEST_DOMAIN,
  CONSENT_FENCE_DIGEST_REGEX,
  CONSENT_FENCE_MAX_CLOCK_SKEW_MS,
  CONSENT_FENCE_VALIDATION_CODES,
  CONSENT_GENERATION_BINDING_CODES,
  CONSENT_GRANT_ID_MAX_CHARS,
  CONSENT_LIFECYCLE_REVISION,
  SOURCE_READ_OPERATION,
  SOURCE_READ_SCOPE,
  computeConsentFenceDigest,
  createConsentAuthorizationFence,
  deriveConsentStatus,
  describeConsentDenialCode,
  isConsentAuthority,
  isConsentGrantActive,
  isValidConsentGrantRecord,
  toAuthorizedConsentGeneration,
  validateConsentAuthorizationFence,
  validateConsentGenerationBinding,
  type ConsentFenceBody,
  type ConsentFenceValidation,
  type ConsentFenceValidationCode,
  type ConsentGenerationBindingCode,
  type ConsentGenerationBindingValidation,
  type ConsentGrant,
  type ValidateConsentAuthorizationFenceParams,
  type ValidateConsentGenerationBindingParams,
} from '@ember/contracts';
