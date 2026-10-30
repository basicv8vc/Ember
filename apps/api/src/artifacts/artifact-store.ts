import type { ArtifactLookup, ArtifactMetadata } from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';

/** The read-only persistence surface used by the Artifact HTTP API. */
export interface ArtifactHttpStore {
  listForTask(ctx: AuthContext, taskId: Id): Promise<readonly ArtifactMetadata[]>;
  find(ctx: AuthContext, artifactId: Id): Promise<ArtifactLookup | null>;
  get(ctx: AuthContext, artifactId: Id): Promise<Uint8Array>;
}

/** Fail-closed default for API processes without a configured blob root. */
export function unconfiguredArtifactHttpStore(): ArtifactHttpStore {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new DomainError('DB_UNAVAILABLE', 'artifact store is not configured for this process'),
    );

  return {
    listForTask: unavailable,
    find: unavailable,
    get: unavailable,
  };
}
