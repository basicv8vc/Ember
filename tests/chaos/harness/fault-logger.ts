/**
 * Structured recorder and diagnostics reporter for chaos fault injections.
 */

export interface FaultRecord {
  readonly timestamp: string;
  readonly testName: string;
  readonly faultType: string;
  readonly point: string;
  readonly targetId?: string;
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
      const seed = r.seed !== undefined ? ` [seed: ${r.seed}]` : '';
      const details = r.details ? ` ${JSON.stringify(r.details)}` : '';
      lines.push(
        `[${r.timestamp}] ${r.testName}: ${r.faultType} at "${r.point}"${target}${seed}${details}`,
      );
    }
    lines.push('=================================');
    return lines.join('\n');
  }
}

export const globalFaultRecorder = new ChaosFaultRecorder();
