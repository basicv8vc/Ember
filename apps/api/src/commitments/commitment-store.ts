import type { CommitmentRepository } from '@ember/contracts';
import { DomainError } from '@ember/domain';

export type CommitmentStore = CommitmentRepository;

export function unconfiguredCommitmentStore(): CommitmentStore {
  const unavailable = (): never => {
    throw new DomainError(
      'DB_UNAVAILABLE',
      'commitment storage is not configured for this process',
    );
  };

  return {
    create: () => unavailable(),
    get: () => unavailable(),
    list: () => unavailable(),
    pause: () => unavailable(),
    resume: () => unavailable(),
    cancel: () => unavailable(),
    listOutcomes: () => unavailable(),
  };
}
