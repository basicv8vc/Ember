import { SOURCE_READ_SCOPE } from '@ember/contracts';
import type { Id } from '@ember/domain';
import type pg from 'pg';
import type { ConsentDispatchFence, ConsentPublicationGuard } from './commitment-repository.js';
import {
  SELECT_CONSENT_FOR_UPDATE_SQL,
  assertConsentAllowed,
  evaluateConsentRow,
  type ConsentGrantRow,
} from './consent-fence.js';

/**
 * Transaction-scoped consent gate for the commitment repository (P0-C3D).
 *
 * Both methods run on the CALLER'S connection, inside the caller's transaction, and both read the
 * grant with `FOR UPDATE`. That is what makes the two consent races decidable:
 *
 * - **revoke-before-publication**: a revocation that committed first holds the row lock first, so
 *   the publication's `FOR UPDATE` waits and then observes `revoked`;
 * - **publication-before-revoke**: the publication holds the lock first, the revocation waits, and
 *   the outcome is committed against the generation that was current when it was authorized.
 *
 * The generation the occurrence was dispatched under is compared with the locked row, so a
 * revoke + re-grant between dispatch and publication is observed as a generation mismatch even
 * though consent is active again.
 */
export class PostgresConsentPublicationGuard implements ConsentPublicationGuard {
  /**
   * Dispatch gate: resolve (and lock) the authoritative generation, or reject.
   *
   * The returned fence is persisted on the occurrence, so the publication gate never has to guess
   * which consent authorized the read. A read grant must carry the operation AND the
   * `source.readonly` scope; a grant without the scope fails closed here rather than at the source
   * boundary.
   */
  async authorizeFence(
    client: pg.PoolClient,
    params: { readonly tenantId: Id; readonly sourceProfileId: string },
  ): Promise<ConsentDispatchFence> {
    const result = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
      params.tenantId,
      params.sourceProfileId,
    ]);

    const decision = evaluateConsentRow(result.rows[0], {
      operation: 'read_snapshot',
      requiredScopes: [SOURCE_READ_SCOPE],
    });

    assertConsentAllowed(decision, 'dispatch');

    if (decision.grantId === null || decision.grantVersion === null) {
      throw new Error('consent decision allowed without a generation');
    }

    return Object.freeze({ grantId: decision.grantId, version: decision.grantVersion });
  }

  /**
   * Publication gate: the recorded fence must still BE the authoritative generation.
   *
   * A `null` fence is a hard denial. An occurrence that records no generation cannot prove which
   * consent authorized its source read, and "the current grant happens to be active" is not a
   * proof: it may be a completely different approval that never covered this work.
   */
  async assertFenceCurrent(
    client: pg.PoolClient,
    params: {
      readonly tenantId: Id;
      readonly sourceProfileId: string;
      readonly fence: ConsentDispatchFence | null;
    },
  ): Promise<void> {
    const result = await client.query<ConsentGrantRow>(SELECT_CONSENT_FOR_UPDATE_SQL, [
      params.tenantId,
      params.sourceProfileId,
    ]);

    const decision = evaluateConsentRow(result.rows[0], {
      fence: params.fence,
      requireFence: true,
    });

    assertConsentAllowed(decision, 'publication');
  }
}
