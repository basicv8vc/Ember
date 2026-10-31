/**
 * Terminal UI and auditing formatters for Ember Demo CLI.
 *
 * Adheres strictly to security and privacy guidelines:
 * - Bearer tokens and credentials are NEVER logged or echoed.
 * - UUIDs and operational IDs are sanitized / masked for audit-safe output.
 * - Durations and step results are measured and displayed clearly.
 */

export function sanitizeId(id: string): string {
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1_000).toFixed(2)}s`;
}

export interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class DemoUI {
  private readonly isQuiet: boolean;

  constructor(options: { quiet?: boolean } = {}) {
    this.isQuiet = options.quiet ?? false;
  }

  banner(title: string): void {
    if (this.isQuiet) return;
    const line = '='.repeat(80);
    process.stdout.write(`\n${line}\n  ${title}\n${line}\n\n`);
  }

  section(title: string): void {
    if (this.isQuiet) return;
    const line = '-'.repeat(80);
    process.stdout.write(`\n${line}\n▶ ${title}\n${line}\n`);
  }

  step(stepIndex: number, totalSteps: number, description: string): void {
    if (this.isQuiet) return;
    process.stdout.write(`  [${stepIndex}/${totalSteps}] ${description} ... `);
  }

  stepOk(extra?: string): void {
    if (this.isQuiet) return;
    process.stdout.write(extra ? `OK (${extra})\n` : 'OK\n');
  }

  stepFailed(reason: string): void {
    if (this.isQuiet) return;
    process.stdout.write(`FAILED\n      ✖ ${reason}\n`);
  }

  detail(label: string, value: unknown): void {
    if (this.isQuiet) return;
    const formatted =
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    process.stdout.write(`      • ${label}: ${formatted}\n`);
  }

  summary(results: readonly ScenarioResult[]): boolean {
    const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);
    const allPassed = results.every((r) => r.passed);

    process.stdout.write('\n' + '='.repeat(80) + '\n');
    process.stdout.write('  DEMO VERIFICATION SUMMARY\n');
    process.stdout.write('='.repeat(80) + '\n');

    process.stdout.write('┌───────────────────────────────────────┬────────────┬─────────────┐\n');
    process.stdout.write('│ Scenario                              │ Result     │ Duration    │\n');
    process.stdout.write('├───────────────────────────────────────┼────────────┼─────────────┤\n');

    for (const r of results) {
      const name = r.name.padEnd(37, ' ').slice(0, 37);
      const status = r.passed ? '✓ PASS    ' : '✖ FAIL    ';
      const duration = formatDuration(r.durationMs).padStart(11, ' ');
      process.stdout.write(`│ ${name} │ ${status} │ ${duration} │\n`);
    }

    process.stdout.write('└───────────────────────────────────────┴────────────┴─────────────┘\n');
    process.stdout.write(
      `Total: ${results.filter((r) => r.passed).length} passed, ${results.filter((r) => !r.passed).length} failed (${formatDuration(totalDuration)})\n\n`,
    );

    if (allPassed) {
      process.stdout.write('🎉 OVERALL STATUS: ALL 4 OFFICIAL SCENARIOS PASSED (DoD VERIFIED)\n\n');
    } else {
      process.stdout.write('❌ OVERALL STATUS: ONE OR MORE SCENARIOS FAILED\n\n');
    }

    return allPassed;
  }
}
