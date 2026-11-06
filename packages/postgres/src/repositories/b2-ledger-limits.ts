/**
 * Absolute day ceilings, mirrored from the CHECK constraints in `migrations/0014`.
 *
 * The database is the authority: these numbers exist so the settlement path can compute how much of
 * an over-reserved charge a day bucket can absorb *before* it performs the update that the CHECK
 * would otherwise reject. Duplicating them is a real hazard, so
 * `tests/integration/b2-model-turn-runtime.test.ts` asserts that both sides agree by driving a bucket
 * past each limit and requiring the database to refuse.
 *
 * `@ember/postgres` deliberately does not depend on `@ember/model-gateway`, so this cannot be
 * re-exported from `MODEL_BUDGET_ABSOLUTE_CEILINGS`.
 */
export const B2_ABSOLUTE_DAY_CEILINGS = Object.freeze({
  globalMicroUsd: 5_000_000,
  tenantMicroUsd: 1_000_000,
  principalMicroUsd: 250_000,
});
