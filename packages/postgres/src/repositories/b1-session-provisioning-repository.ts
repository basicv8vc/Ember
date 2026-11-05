import type pg from 'pg';
import type { B1ConsumerProvisioningRepository, B1ProvisionedSession } from './b1-interfaces.js';
import {
  B1_DEFAULT_AGENT_NAME,
  B1_DEFAULT_AGENT_POLICY_VERSION,
  B1_MAIN_CONVERSATION_KIND,
  SELECT_MAIN_CONVERSATION_SQL,
  insertB1Session,
  lockConsumer,
  lockIdentity,
  newId,
  readDigest,
  readProvider,
  readProviderSubject,
  readTimestamp,
  requireMainConversation,
  toSessionRecord,
  withB1SessionTransaction,
  type B1Provider,
  type MainConversationRow,
} from './b1-session-support.js';

/**
 * B1-2A: atomic Consumer provisioning (ADR-0004 I-2, I-3, I-4).
 *
 * One `READ COMMITTED` transaction creates or resolves Tenant -> owner Principal -> Consumer ->
 * Provider Identity -> default Ember Agent -> main Conversation -> Consumer Session. The session
 * digest is written last, so a failure at any point leaves *no* token issued and *no* partial
 * identity graph behind.
 *
 * Concurrency is a database property, not an application preflight:
 *
 * - a transaction-scoped advisory lock on `(provider, provider_subject)` serializes the first
 *   sign-in for one identity even though there is no row to lock yet; because `READ COMMITTED`
 *   takes a fresh snapshot per statement, the waiter sees the winner's committed identity row;
 * - the frozen unique constraints (`consumer_identities_provider_unique`,
 *   `consumers_one_per_tenant_unique`, `consumers_tenant_principal_unique`,
 *   `conversations_one_per_kind_unique`, `consumer_sessions_digest_unique`) are the final
 *   authority if any other writer tries the same thing;
 * - `READ COMMITTED` + `FOR UPDATE` + bounded deadlock retry keep every decision inside the
 *   transaction that owns the lock, so a replay cannot be overtaken by a stale read.
 *
 * A repeated sign-in reuses Consumer/Tenant/Principal/Agent/Conversation and mints a *fresh*
 * Session (contract §5.2: always 201). Display name and email are never accepted (I-3).
 */
export interface B1ProvisioningRepositoryOptions {
  /**
   * Fault-injection point used only by the integration test that proves full rollback: it runs
   * after every identity row has been written and immediately before the session insert, i.e.
   * at the point where a partial commit would be most damaging. Never set in production.
   */
  readonly beforeSessionInsert?: () => Promise<void>;
}

/** Non-PII, bounded by `tenants.name`'s CHECK (1..128). */
const TENANT_NAME = 'Ember consumer';

interface IdentityRow {
  identity_id: string;
  tenant_id: string;
  consumer_id: string;
  principal_id: string;
}

interface IdentityGraph {
  readonly identityId: string;
  readonly tenantId: string;
  readonly consumerId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly conversationId: string;
}

const SELECT_IDENTITY_SQL = `
SELECT ci.id AS identity_id,
       ci.tenant_id,
       ci.consumer_id,
       c.principal_id
  FROM consumer_identities ci
  JOIN consumers c ON c.tenant_id = ci.tenant_id AND c.id = ci.consumer_id
  JOIN principals p
    ON p.tenant_id = c.tenant_id AND p.id = c.principal_id AND p.role = 'owner'
 WHERE ci.provider = $1 AND ci.provider_subject = $2
`;

const INSERT_TENANT_SQL = 'INSERT INTO tenants (id, name) VALUES ($1, $2)';
const INSERT_PRINCIPAL_SQL =
  "INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')";
const INSERT_CONSUMER_SQL =
  'INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)';
const INSERT_IDENTITY_SQL = `
INSERT INTO consumer_identities
  (id, tenant_id, consumer_id, provider, provider_subject)
VALUES ($1, $2, $3, $4, $5)
`;
const INSERT_AGENT_SQL = `
INSERT INTO agents (id, tenant_id, name, policy_version)
VALUES ($1, $2, $3, $4)
`;
const INSERT_CONVERSATION_SQL = `
INSERT INTO conversations (id, tenant_id, agent_id, kind)
VALUES ($1, $2, $3, $4)
`;

/** `last_seen_at` slides at most once per hour, on the database clock. */
const TOUCH_IDENTITY_SQL = `
UPDATE consumer_identities
   SET last_seen_at = clock_timestamp()
 WHERE id = $1
   AND last_seen_at <= clock_timestamp() - interval '1 hour'
`;

async function readIdentity(
  client: pg.PoolClient,
  provider: B1Provider,
  providerSubject: string,
): Promise<IdentityRow | null> {
  const result = await client.query<IdentityRow>(SELECT_IDENTITY_SQL, [provider, providerSubject]);
  return result.rows[0] ?? null;
}

async function createIdentityGraph(
  client: pg.PoolClient,
  provider: B1Provider,
  providerSubject: string,
): Promise<IdentityGraph> {
  const tenantId = newId();
  const principalId = newId();
  const consumerId = newId();
  const identityId = newId();
  const agentId = newId();
  const conversationId = newId();

  // Ordering follows the composite foreign keys. All six rows are invisible to every other
  // transaction until COMMIT, so a failure below rolls back the entire graph.
  await client.query(INSERT_TENANT_SQL, [tenantId, TENANT_NAME]);
  await client.query(INSERT_PRINCIPAL_SQL, [principalId, tenantId]);
  await client.query(INSERT_CONSUMER_SQL, [consumerId, tenantId, principalId]);
  await client.query(INSERT_IDENTITY_SQL, [
    identityId,
    tenantId,
    consumerId,
    provider,
    providerSubject,
  ]);
  await client.query(INSERT_AGENT_SQL, [
    agentId,
    tenantId,
    B1_DEFAULT_AGENT_NAME,
    B1_DEFAULT_AGENT_POLICY_VERSION,
  ]);
  await client.query(INSERT_CONVERSATION_SQL, [
    conversationId,
    tenantId,
    agentId,
    B1_MAIN_CONVERSATION_KIND,
  ]);

  return { identityId, tenantId, consumerId, principalId, agentId, conversationId };
}

async function resolveExistingGraph(
  client: pg.PoolClient,
  identity: IdentityRow,
): Promise<IdentityGraph> {
  await client.query(TOUCH_IDENTITY_SQL, [identity.identity_id]);

  // I-4: a valid session implies the default Agent and main Conversation. Re-read them from
  // the store rather than trusting a caller-supplied id, and fail loudly if they vanished.
  const result = await client.query<MainConversationRow>(SELECT_MAIN_CONVERSATION_SQL, [
    identity.tenant_id,
  ]);
  const main = requireMainConversation(result.rows[0]);

  return {
    identityId: identity.identity_id,
    tenantId: identity.tenant_id,
    consumerId: identity.consumer_id,
    principalId: identity.principal_id,
    agentId: main.agent_id,
    conversationId: main.conversation_id,
  };
}

export class PostgresB1ConsumerProvisioningRepository implements B1ConsumerProvisioningRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: B1ProvisioningRepositoryOptions = {},
  ) {}

  async provisionIdentityAndCreateSession(command: {
    readonly provider: 'apple' | 'dev';
    readonly providerSubject: string;
    readonly tokenDigest: Uint8Array;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }): Promise<B1ProvisionedSession> {
    const provider = readProvider(command.provider);
    const providerSubject = readProviderSubject(command.providerSubject);
    const digest = readDigest(command.tokenDigest, 'tokenDigest');
    const expiresAt = readTimestamp(command.expiresAt, 'expiresAt');
    const idleExpiresAt = readTimestamp(command.idleExpiresAt, 'idleExpiresAt');

    return withB1SessionTransaction(this.pool, async (client) => {
      // Serialize all sign-ins for this provider identity, including the very first one.
      await lockIdentity(client, provider, providerSubject);

      const existing = await readIdentity(client, provider, providerSubject);
      const graph =
        existing === null
          ? await createIdentityGraph(client, provider, providerSubject)
          : await resolveExistingGraph(client, existing);

      // Serialize with rotation / replay / logout for this consumer before writing the new
      // session, so a replay cannot be overtaken by an unrevoked session from a sign-in.
      await lockConsumer(client, graph.consumerId);

      await this.options.beforeSessionInsert?.();

      const row = await insertB1Session(client, {
        sessionId: newId(),
        tenantId: graph.tenantId,
        consumerId: graph.consumerId,
        digest,
        expiresAt,
        idleExpiresAt,
        rotatedFromSessionId: null,
      });

      return {
        identity: {
          consumerId: graph.consumerId,
          tenantId: graph.tenantId,
          principalId: graph.principalId,
          agentId: graph.agentId,
          conversationId: graph.conversationId,
        },
        session: toSessionRecord(row),
      };
    });
  }
}
