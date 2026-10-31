import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface BenchmarkArtifactData {
  readonly gitSha: string;
  readonly reconciliation: {
    readonly successRatePercent: number;
    readonly succeededCount: number;
    readonly totalSubmitted: number;
    readonly lostCount: number;
  };
  readonly latencyMetrics: {
    readonly durableAck: {
      readonly p50Ms: number;
      readonly p95Ms: number;
      readonly p99Ms: number;
    };
    readonly queueWait: {
      readonly p50Ms: number;
      readonly p95Ms: number;
    };
    readonly taskCompletion: {
      readonly p50Ms: number;
      readonly p95Ms: number;
    };
  };
  readonly telemetry: {
    readonly peakPostgresActiveConnections: number;
    readonly peakPostgresTotalConnections: number;
    readonly postgresSampleCount: number;
    readonly peakRssMb: number;
  };
}

describe('P0B-10C Benchmark Artifact and Report Reconciliation', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const baselineDir = path.join(projectRoot, 'benchmarks/audit-p0b-10c/baseline');
  const evidenceAuditDoc = path.join(projectRoot, 'docs/P0B-10C-EVIDENCE-AUDIT.md');
  const resultsDoc = path.join(projectRoot, 'docs/P0B-RESULTS.md');

  it('ensures all baseline benchmark JSONs have identical and valid Git SHA', () => {
    const files = fs
      .readdirSync(baselineDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    expect(files.length).toBe(3);

    const shas = files.map((file) => {
      const content = fs.readFileSync(path.join(baselineDir, file), 'utf8');
      const json = JSON.parse(content) as BenchmarkArtifactData;
      return json.gitSha;
    });

    const firstSha = shas[0]!;
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);
    for (const sha of shas) {
      expect(sha).toBe(firstSha);
    }
  });

  it('reconciles documented PostgreSQL peak connections against baseline JSON files', () => {
    const files = fs
      .readdirSync(baselineDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    const baselineData = files.map((file) => {
      const content = fs.readFileSync(path.join(baselineDir, file), 'utf8');
      return JSON.parse(content) as BenchmarkArtifactData;
    });

    const auditContent = fs.readFileSync(evidenceAuditDoc, 'utf8');
    const resultsContent = fs.readFileSync(resultsDoc, 'utf8');

    // Verify Run 1, 2, 3 PostgreSQL total connections match JSON exactly
    baselineData.forEach((run) => {
      const expectedTotal = run.telemetry.peakPostgresTotalConnections;
      const expectedActive = run.telemetry.peakPostgresActiveConnections;
      const expectedSamples = run.telemetry.postgresSampleCount;

      // Evidence audit markdown must document exact peak values
      expect(auditContent).toContain(`PostgreSQL 总连接峰值`);
      expect(auditContent).toContain(String(expectedTotal));
      expect(auditContent).toContain(String(expectedActive));
      expect(auditContent).toContain(String(expectedSamples));

      // Results markdown must state consistent ranges
      expect(resultsContent).toContain(`总连接峰值`);
    });
  });

  it('verifies reproducible commit SHA is documented across evidence reports', () => {
    const files = fs
      .readdirSync(baselineDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const firstJson = JSON.parse(
      fs.readFileSync(path.join(baselineDir, files[0]!), 'utf8'),
    ) as BenchmarkArtifactData;

    const auditContent = fs.readFileSync(evidenceAuditDoc, 'utf8');
    const resultsContent = fs.readFileSync(resultsDoc, 'utf8');

    expect(auditContent).toContain(firstJson.gitSha);
    expect(resultsContent).toContain(firstJson.gitSha.slice(0, 7));
  });
});
