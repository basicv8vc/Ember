/**
 * Structured recorder and diagnostics reporter for chaos fault injections.
 */

export interface FaultRecord {
  readonly timestamp: string;
  readonly testName: string;
  readonly faultType: string;
  readonly point: string;
  readonly targetId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly details?: Record<string, unknown>;
  readonly seed?: number;
}

export class ChaosFaultRecorder {
  private readonly records: FaultRecord[] = [];

  record(event: {
    testName: string;
    faultType: string;
    point: string;
    targetId?: string;
    taskId?: string;
    runId?: string;
    details?: Record<string, unknown>;
    seed?: number;
  }): void {
    const entry: FaultRecord = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.records.push(entry);
  }

  getRecords(): readonly FaultRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }

  formatSummary(): string {
    if (this.records.length === 0) {
      return 'No chaos faults injected.';
    }

    const lines = ['=== Chaos Fault Injection Log ==='];
    for (const r of this.records) {
      const target = r.targetId ? ` [target: ${r.targetId}]` : '';
      const task = r.taskId ? ` [task: ${r.taskId}]` : '';
      const run = r.runId ? ` [run: ${r.runId}]` : '';
      const seed = r.seed !== undefined ? ` [seed: ${r.seed}]` : '';
      const details = r.details ? ` ${JSON.stringify(r.details)}` : '';
      lines.push(
        `[${r.timestamp}] ${r.testName}: ${r.faultType} at "${r.point}"${target}${task}${run}${seed}${details}`,
      );
    }
    lines.push('=================================');
    return lines.join('\n');
  }
}

export const globalFaultRecorder = new ChaosFaultRecorder();

export function dumpFailureDiagnostics(testName: string, seed: number, error?: unknown): void {
  const summary = globalFaultRecorder.formatSummary();
  let errorStr = '';
  if (error !== undefined) {
    if (error instanceof Error) {
      errorStr = error.stack ?? error.message;
    } else if (typeof error === 'string') {
      errorStr = error;
    } else {
      try {
        errorStr = JSON.stringify(error);
      } catch {
        errorStr = '[Unserializable Error]';
      }
    }
  }

  console.error(
    `\n❌ [Chaos Failure Diagnostics]\n` +
      `Test: ${testName}\n` +
      `PRNG Seed: ${seed} (reproduce via: CHAOS_SEED=${seed})\n` +
      (errorStr ? `Error: ${errorStr}\n` : '') +
      summary +
      '\n',
  );
}
