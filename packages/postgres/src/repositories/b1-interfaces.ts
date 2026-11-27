/**
 * Re-export B1-1..B1-4 persistence boundaries from `@ember/contracts` so existing V1
 * `@ember/postgres` consumers remain compatible while V2/API routes depend only on contracts.
 */
export type {
  B1AssistantTurnRepository,
  B1AuthenticatedSession,
  B1ConsumerIdentity,
  B1ConsumerProvisioningRepository,
  B1ConsumerSessionRepository,
  B1ConversationIdentity,
  B1ConversationRepository,
  B1ProvisionedIdentity,
  B1ProvisionedSession,
  B1SessionRecord,
  B1SessionRotationResult,
  B1TaskListQuery,
  B1TaskReadRepository,
  B1TaskResultRepository,
  B1TranscriptClearResult,
} from '@ember/contracts';
