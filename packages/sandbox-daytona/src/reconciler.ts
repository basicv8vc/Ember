import { DAYTONA_LABEL_MANAGED, DAYTONA_LABEL_OWNER, DAYTONA_LABEL_TENANT } from './limits.js';
import { DAYTONA_LIVE_STATES, type DaytonaSandboxClient } from './port.js';

/**
 * Orphan reconciliation for crashed workers.
 *
 * The failure this exists for: a worker calls `create()`, the process is killed (OOM, deploy,
 * SIGKILL) before `destroy()`, and nobody is left who knows the sandbox id. Local bookkeeping
 * is worthless in exactly that case, so the sweep must reconstruct ownership from the vendor
 * control plane alone — which is why every sandbox carries an owner label at creation.
 *
 * The sweep is intentionally *not* part of the provider contract. It is an operator/job entry
 * point that a restarted worker (or a cron) runs once at startup, before it accepts work.
 */
export interface OrphanSweepInput {
  readonly client: DaytonaSandboxClient;
  /** Owner label written by the provider that created the sandboxes. */
  readonly owner: string;
  /** Optional tenant scoping; omitted means "every tenant owned by this deployment". */
  readonly tenantId?: string;
  /** Sandboxes the caller is actively using and must not lose. */
  readonly keepSandboxIds?: readonly string[];
  /**
   * Grace period. A sandbox created moments ago may belong to a sibling worker that is still
   * starting up, so sweeping it would kill live work. Defaults to 30 s.
   */
  readonly minAgeMs?: number;
  readonly dryRun?: boolean;
  readonly now?: () => number;
}

export interface OrphanSweepFailure {
  readonly sandboxId: string;
  readonly reason: string;
}

export interface OrphanSweepResult {
  readonly dryRun: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly scanned: number;
  readonly liveCount: number;
  readonly destroyed: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly OrphanSweepFailure[];
  readonly elapsedMs: number;
}

/** Removes sandboxes owned by `owner` that no live caller claims. */
export async function sweepOrphanedSandboxes(input: OrphanSweepInput): Promise<OrphanSweepResult> {
  const now = input.now ?? Date.now;
  const minAgeMs = input.minAgeMs ?? 30_000;
  const dryRun = input.dryRun ?? false;
  const startedAt = now();
  const keep = new Set(input.keepSandboxIds ?? []);

  const labels: Record<string, string> = {
    [DAYTONA_LABEL_OWNER]: input.owner,
    [DAYTONA_LABEL_MANAGED]: 'true',
    ...(input.tenantId === undefined ? {} : { [DAYTONA_LABEL_TENANT]: input.tenantId }),
  };

  const sandboxes = await input.client.list({ labels, states: DAYTONA_LIVE_STATES });

  const destroyed: string[] = [];
  const kept: string[] = [];
  const failed: OrphanSweepFailure[] = [];

  for (const sandbox of sandboxes) {
    if (keep.has(sandbox.sandboxId)) {
      kept.push(sandbox.sandboxId);
      continue;
    }

    const ageMs =
      sandbox.createdAtMs === null ? Number.POSITIVE_INFINITY : now() - sandbox.createdAtMs;

    if (ageMs < minAgeMs) {
      kept.push(sandbox.sandboxId);
      continue;
    }

    if (dryRun) {
      destroyed.push(sandbox.sandboxId);
      continue;
    }

    try {
      const gone = await input.client.delete(sandbox.sandboxId, 60_000);

      if (gone) {
        destroyed.push(sandbox.sandboxId);
      } else {
        failed.push({
          sandboxId: sandbox.sandboxId,
          reason: 'delete accepted but destruction was not confirmed',
        });
      }
    } catch (error) {
      failed.push({
        sandboxId: sandbox.sandboxId,
        reason: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  return {
    dryRun,
    labels: Object.freeze(labels),
    scanned: sandboxes.length,
    liveCount: sandboxes.length,
    destroyed: Object.freeze([...destroyed]),
    kept: Object.freeze([...kept]),
    failed: Object.freeze([...failed]),
    elapsedMs: now() - startedAt,
  };
}
