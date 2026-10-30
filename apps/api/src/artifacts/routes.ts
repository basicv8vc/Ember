import { IdSchema } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import { Hono } from 'hono';
import type { AppBindings, AppContext } from '../http/app-context.js';
import { respondInvalidArgument, respondNotFound } from '../http/error-mapping.js';
import type { TaskStore } from '../tasks/task-store.js';
import type { ArtifactHttpStore } from './artifact-store.js';

const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export interface ArtifactRouteDependencies {
  readonly artifacts: ArtifactHttpStore;
  readonly tasks: TaskStore;
}

function parseRouteId(c: AppContext, parameter: string): Id | Response {
  const parsed = IdSchema.safeParse(c.req.param(parameter));

  if (!parsed.success) {
    return respondInvalidArgument(c, `${parameter} must be a UUID`);
  }

  return parsed.data;
}

/** Build the independently mounted, tenant-authenticated Artifact read routes. */
export function createArtifactRoutes(deps: ArtifactRouteDependencies): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  routes.get('/tasks/:taskId/artifacts', async (c) => {
    const taskId = parseRouteId(c, 'taskId');

    if (taskId instanceof Response) {
      return taskId;
    }

    const auth = c.get('auth');
    const task = await deps.tasks.get(auth, taskId);

    if (task === null) {
      return respondNotFound(c, 'task is not visible in this tenant');
    }

    const artifacts = await deps.artifacts.listForTask(auth, taskId);
    return c.json(
      {
        task_id: taskId,
        artifacts: artifacts.map((artifact) => ({
          artifact_id: artifact.artifactId,
          sha256: artifact.sha256,
          size: artifact.size,
          media_type: artifact.mediaType,
          created_by: artifact.createdBy,
          created_at: artifact.createdAt,
        })),
      },
      200,
    );
  });

  routes.get('/artifacts/:artifactId', async (c) => {
    const artifactId = parseRouteId(c, 'artifactId');

    if (artifactId instanceof Response) {
      return artifactId;
    }

    const auth = c.get('auth');
    const lookup = await deps.artifacts.find(auth, artifactId);

    if (lookup === null) {
      return respondNotFound(c, 'artifact is not available in this tenant');
    }

    if (!MEDIA_TYPE_PATTERN.test(lookup.metadata.mediaType)) {
      throw new DomainError('DB_UNAVAILABLE', 'persisted artifact media type is invalid');
    }

    // `get` verifies SHA-256 and size on the exact byte buffer it returns. No response body
    // is constructed until that check has succeeded, so corrupted bytes fail closed.
    const bytes = await deps.artifacts.get(auth, artifactId);
    c.header('Content-Type', lookup.metadata.mediaType);
    c.header('Content-Length', String(bytes.byteLength));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, no-store');

    const responseBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(responseBytes).set(bytes);
    return c.body(responseBytes, 200);
  });

  return routes;
}
