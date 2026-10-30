import type { ApprovalRepository } from '@ember/contracts';
import { DomainError } from '@ember/domain';

export type ApprovalHttpStore = Pick<ApprovalRepository, 'get' | 'decide' | 'listByTask'>;

export function unconfiguredApprovalHttpStore(): ApprovalHttpStore {
  const unavailable = (): Promise<never> =>
    Promise.reject(new DomainError('DB_UNAVAILABLE', 'approval store is not configured'));

  return {
    get: unavailable,
    decide: unavailable,
    listByTask: unavailable,
  };
}
