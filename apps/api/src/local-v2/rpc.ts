import type {
  AgentHeadCallerScope,
  AgentHeadRpc,
  PrepareTurnRequest as CanonicalPrepare,
  PrepareTurnResult as CanonicalResult,
} from '@ember/runtime-v2';

export type { CommitTurnRequest, ResolvedMessageAttachment } from '@ember/runtime-v2';

export type HeadScope = Pick<AgentHeadCallerScope, 'tenantId' | 'agentId'>;
export type PrepareTurnRequest = CanonicalPrepare & {
  readonly modelReservation: NonNullable<CanonicalPrepare['modelReservation']>;
};
export type PreparedTurn = Omit<
  Extract<CanonicalResult, { kind: 'prepared' }>,
  'utcDay' | 'attachments'
>;
type PrepareTurnResult = PreparedTurn | Extract<CanonicalResult, { kind: 'replay' }>;

export interface EdgeAgentHeadRpc extends Omit<
  AgentHeadRpc,
  'prepareTurn' | 'getMainConversation'
> {
  prepareTurn(request: PrepareTurnRequest): Promise<PrepareTurnResult>;
}
