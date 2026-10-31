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
    readonly peakHeapUsedMb: number;
    readonly cpuPercent: number;
    readonly peakHttpInFlight: number;
    readonly peakInFlightRuns: number;
    readonly peakLiveSandboxes: number;
    readonly idleLiveSandboxes: number;
  };
}

interface BaselineTableRow {
  readonly dimension: string;
  readonly run1: string;
  readonly run2: string;
  readonly run3: string;
  readonly median: string;
  readonly range: string;
}

interface AbTableRow {
  readonly runName: string;
  readonly samplingState: string;
  readonly sampleCount: string;
  readonly durableAckP95: string;
  readonly queueWaitP95: string;
  readonly completionP95: string;
  readonly peakRss: string;
}

function parseBaselineTable(markdown: string): Map<string, BaselineTableRow> {
  const lines = markdown.split('\n');
  const table = new Map<string, BaselineTableRow>();
  let inTable = false;

  for (const line of lines) {
    if (line.includes('指标维度') && line.includes('第 1 轮 (Run 1)')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.trim().startsWith('|')) {
        break;
      }
      if (line.includes(':---') || line.includes('指标维度')) {
        continue;
      }
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cells.length >= 6) {
        const rawDim = cells[0]!.replace(/\*\*/g, '').trim();
        table.set(rawDim, {
          dimension: rawDim,
          run1: cells[1]!.replace(/[*`]/g, '').trim(),
          run2: cells[2]!.replace(/[*`]/g, '').trim(),
          run3: cells[3]!.replace(/[*`]/g, '').trim(),
          median: cells[4]!.replace(/[*`]/g, '').trim(),
          range: cells[5]!.replace(/[*`]/g, '').trim(),
        });
      }
    }
  }

  return table;
}

function parseAbTable(markdown: string): Map<string, AbTableRow> {
  const lines = markdown.split('\n');
  const table = new Map<string, AbTableRow>();
  let inTable = false;

  for (const line of lines) {
    if (line.includes('对照轮次') && line.includes('PG 采样状态')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.trim().startsWith('|')) {
        break;
      }
      if (line.includes(':---') || line.includes('对照轮次')) {
        continue;
      }
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cells.length >= 7) {
        const runName = cells[0]!.replace(/\*\*/g, '').trim();
        table.set(runName, {
          runName,
          samplingState: cells[1]!.replace(/[*`]/g, '').trim(),
          sampleCount: cells[2]!.replace(/[*`]/g, '').trim(),
          durableAckP95: cells[3]!.replace(/[*`]/g, '').trim(),
          queueWaitP95: cells[4]!.replace(/[*`]/g, '').trim(),
          completionP95: cells[5]!.replace(/[*`]/g, '').trim(),
          peakRss: cells[6]!.replace(/[*`]/g, '').trim(),
        });
      }
    }
  }

  return table;
}

describe('P0B-10C Benchmark Artifact and Report Reconciliation', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const baselineDir = path.join(projectRoot, 'benchmarks/audit-p0b-10c/baseline');
  const abSamplingDir = path.join(projectRoot, 'benchmarks/audit-p0b-10c/ab-sampling');
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

  it('strictly reconciles documented baseline data per-run and per-field against exact JSONs', () => {
    const files = fs
      .readdirSync(baselineDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    const baselineData = files.map((file) => {
      const content = fs.readFileSync(path.join(baselineDir, file), 'utf8');
      return JSON.parse(content) as BenchmarkArtifactData;
    });

    const auditContent = fs.readFileSync(evidenceAuditDoc, 'utf8');
    const table = parseBaselineTable(auditContent);

    expect(table.size).toBeGreaterThanOrEqual(20);

    const run1 = baselineData[0]!;
    const run2 = baselineData[1]!;
    const run3 = baselineData[2]!;

    // 1. Strict per-run check for PostgreSQL Total Connections (proves no swapped 52 vs 53)
    const rowTotal = table.get('PostgreSQL 总连接峰值');
    expect(rowTotal).toBeDefined();
    expect(rowTotal?.run1).toBe(String(run1.telemetry.peakPostgresTotalConnections));
    expect(rowTotal?.run2).toBe(String(run2.telemetry.peakPostgresTotalConnections));
    expect(rowTotal?.run3).toBe(String(run3.telemetry.peakPostgresTotalConnections));

    // 2. Strict per-run check for PostgreSQL Active Connections
    const rowActive = table.get('PostgreSQL 活跃连接峰值');
    expect(rowActive).toBeDefined();
    expect(rowActive?.run1).toBe(String(run1.telemetry.peakPostgresActiveConnections));
    expect(rowActive?.run2).toBe(String(run2.telemetry.peakPostgresActiveConnections));
    expect(rowActive?.run3).toBe(String(run3.telemetry.peakPostgresActiveConnections));

    // 3. Strict per-run check for PostgreSQL Sample Count
    const rowSamples = table.get('PostgreSQL 采样次数');
    expect(rowSamples).toBeDefined();
    expect(rowSamples?.run1).toBe(String(run1.telemetry.postgresSampleCount));
    expect(rowSamples?.run2).toBe(String(run2.telemetry.postgresSampleCount));
    expect(rowSamples?.run3).toBe(String(run3.telemetry.postgresSampleCount));

    // 4. Strict per-run check for Durable Ack P95
    const rowDurableP95 = table.get('Durable Ack P95');
    expect(rowDurableP95).toBeDefined();
    expect(rowDurableP95?.run1).toBe(`${run1.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowDurableP95?.run2).toBe(`${run2.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowDurableP95?.run3).toBe(`${run3.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);

    // 5. Strict per-run check for Durable Ack P50
    const rowDurableP50 = table.get('Durable Ack P50');
    expect(rowDurableP50).toBeDefined();
    expect(rowDurableP50?.run1).toBe(`${run1.latencyMetrics.durableAck.p50Ms.toFixed(2)} ms`);
    expect(rowDurableP50?.run2).toBe(`${run2.latencyMetrics.durableAck.p50Ms.toFixed(2)} ms`);
    expect(rowDurableP50?.run3).toBe(`${run3.latencyMetrics.durableAck.p50Ms.toFixed(2)} ms`);

    // 6. Strict per-run check for In-Flight concurrency & slots
    const rowHttp = table.get('HTTP 在途峰值 (In-Flight)');
    expect(rowHttp?.run1).toBe(String(run1.telemetry.peakHttpInFlight));
    expect(rowHttp?.run2).toBe(String(run2.telemetry.peakHttpInFlight));
    expect(rowHttp?.run3).toBe(String(run3.telemetry.peakHttpInFlight));

    const rowWorker = table.get('Worker 执行槽峰值 (In-Flight)');
    expect(rowWorker?.run1).toBe(String(run1.telemetry.peakInFlightRuns));
    expect(rowWorker?.run2).toBe(String(run2.telemetry.peakInFlightRuns));
    expect(rowWorker?.run3).toBe(String(run3.telemetry.peakInFlightRuns));

    // 7. Strict per-run check for Memory RSS
    const rowRss = table.get('进程峰值 RSS');
    expect(rowRss?.run1).toBe(`${run1.telemetry.peakRssMb.toFixed(1)} MB`);
    expect(rowRss?.run2).toBe(`${run2.telemetry.peakRssMb.toFixed(1)} MB`);
    expect(rowRss?.run3).toBe(`${run3.telemetry.peakRssMb.toFixed(1)} MB`);
  });

  it('strictly reconciles documented A/B sampling contrast data against exact JSON files', () => {
    const auditContent = fs.readFileSync(evidenceAuditDoc, 'utf8');
    const abTable = parseAbTable(auditContent);

    expect(abTable.size).toBe(4);

    const loadJson = (subdir: string): BenchmarkArtifactData => {
      const fullDir = path.join(abSamplingDir, subdir);
      const jsonFile = fs.readdirSync(fullDir).find((f) => f.endsWith('.json'))!;
      return JSON.parse(
        fs.readFileSync(path.join(fullDir, jsonFile), 'utf8'),
      ) as BenchmarkArtifactData;
    };

    const a1 = loadJson('run-a1-off');
    const b1 = loadJson('run-b1-on');
    const a2 = loadJson('run-a2-off');
    const b2 = loadJson('run-b2-on');

    const rowA1 = abTable.get('Run A1 (OFF)');
    expect(rowA1).toBeDefined();
    expect(rowA1?.sampleCount).toBe('0 (unverified)');
    expect(rowA1?.durableAckP95).toBe(`${a1.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowA1?.peakRss).toBe(`${a1.telemetry.peakRssMb.toFixed(1)} MB`);

    const rowB1 = abTable.get('Run B1 (ON)');
    expect(rowB1).toBeDefined();
    expect(rowB1?.sampleCount).toBe(`${b1.telemetry.postgresSampleCount} 次`);
    expect(rowB1?.durableAckP95).toBe(`${b1.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowB1?.peakRss).toBe(`${b1.telemetry.peakRssMb.toFixed(1)} MB`);

    const rowA2 = abTable.get('Run A2 (OFF)');
    expect(rowA2).toBeDefined();
    expect(rowA2?.sampleCount).toBe('0 (unverified)');
    expect(rowA2?.durableAckP95).toBe(`${a2.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowA2?.peakRss).toBe(`${a2.telemetry.peakRssMb.toFixed(1)} MB`);

    const rowB2 = abTable.get('Run B2 (ON)');
    expect(rowB2).toBeDefined();
    expect(rowB2?.sampleCount).toBe(`${b2.telemetry.postgresSampleCount} 次`);
    expect(rowB2?.durableAckP95).toBe(`${b2.latencyMetrics.durableAck.p95Ms.toFixed(2)} ms`);
    expect(rowB2?.peakRss).toBe(`${b2.telemetry.peakRssMb.toFixed(1)} MB`);
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
