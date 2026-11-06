import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepOrphanedSandboxes } from '@ember/sandbox-daytona';

import { runDaytonaCli } from '../../apps/cli/src/sandbox-smoke-daytona/cli.js';
import { validateDaytonaSmokeReport } from '../../apps/cli/src/sandbox-smoke-daytona/runner.js';
import { sanitizeText } from '../../apps/cli/src/sandbox-smoke-daytona/sanitize.js';
import {
  DAYTONA_SMOKE_EXIT,
  DAYTONA_SMOKE_STEPS,
  type DaytonaSmokeReport,
  type DaytonaSmokeStepDetail,
} from '../../apps/cli/src/sandbox-smoke-daytona/types.js';
import { FakeDaytonaClient } from './support/fake-daytona-client.js';

function capture(): {
  streams: { stdout: (text: string) => void; stderr: (text: string) => void };
  stdout: () => string;
  stderr: () => string;
} {
  let out = '';
  let err = '';

  return {
    streams: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function reportFrom(stdout: string): DaytonaSmokeReport {
  const start = stdout.indexOf('{');
  const parsed = JSON.parse(stdout.slice(start)) as DaytonaSmokeReport;

  return parsed;
}

/** In-process stand-in for the child process the real CLI spawns. */
function reconcileWith(client: FakeDaytonaClient) {
  return async (input: { owner: string; tenantId: string }) => {
    const result = await sweepOrphanedSandboxes({
      client,
      owner: input.owner,
      tenantId: input.tenantId,
      minAgeMs: 0,
    });

    return {
      swept: result.destroyed.length,
      failures: result.failed.length,
      processId: 'in-process-test',
      elapsedMs: result.elapsedMs,
    };
  };
}

describe('daytona smoke harness', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'daytona-smoke-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('blocks without a credential instead of fabricating a measurement', async () => {
    const sink = capture();
    let clientBuilt = false;

    const code = await runDaytonaCli(
      ['--format', 'both'],
      sink.streams,
      {},
      {
        createClient: () => {
          clientBuilt = true;
          return new FakeDaytonaClient();
        },
      },
    );

    expect(code).toBe(DAYTONA_SMOKE_EXIT.blocked);
    expect(clientBuilt).toBe(false);

    const report = reportFrom(sink.stdout());

    expect(report.status).toBe('BLOCKED');
    expect(report.blockedReason).toContain('DAYTONA_API_KEY');
    expect(report.measurements).toBeNull();
    expect(report.steps.create.status).toBe('SKIP');
  });

  it('completes the full flow and reports every measurement', async () => {
    const sink = capture();
    const client = new FakeDaytonaClient();
    const jsonOut = join(workspace, 'report.json');

    const code = await runDaytonaCli(
      ['--format', 'json', '--json-out', jsonOut, '--owner', 'poc:test'],
      sink.streams,
      { DAYTONA_API_KEY: 'dtn_test_key_value_123456' },
      { createClient: () => client, reconcile: reconcileWith(client) },
    );

    expect(code).toBe(DAYTONA_SMOKE_EXIT.pass);

    const report = reportFrom(sink.stdout());

    expect(report.status).toBe('PASS');

    for (const step of DAYTONA_SMOKE_STEPS) {
      expect(report.steps[step].status, `step ${step}`).toBe('PASS');
    }

    expect(report.measurements?.createLatencyMs).not.toBeNull();
    expect(report.measurements?.readyLatencyMs).not.toBeNull();
    expect(report.measurements?.firstCommandLatencyMs).not.toBeNull();
    expect(report.measurements?.timeoutObservedMs).not.toBeNull();
    expect(report.measurements?.cancelObservedMs).not.toBeNull();
    expect(report.measurements?.stopLatencyMs).not.toBeNull();
    expect(report.measurements?.destroyLatencyMs).not.toBeNull();

    expect(report.isolation?.metadataTcpReachable).toBe(false);
    expect(report.isolation?.metadataHttpReachable).toBe(false);
    expect(report.isolation?.metadataHttpStatus).toBeNull();
    expect(report.isolation?.metadataImdsV2TokenStatus).toBeNull();
    expect(report.isolation?.dnsBlocked).toBe(true);
    expect(report.isolation?.publicTcpBlocked).toBe(true);
    expect(report.isolation?.egressBlocked).toBe(true);
    expect(report.isolation?.crossTenantHandleDenied).toBe(true);
    expect(report.isolation?.crossTenantFileVisible).toBe(false);
    expect(report.isolation?.cgroupDriver).toBe('container-namespaces');

    expect(report.cleanup?.orphanSweptCount).toBe(1);
    expect(report.cleanup?.vendorLiveAfterDestroy).toBe(0);
    expect(report.cleanup?.ownerWideLiveAfterDestroy).toBe(0);

    expect(report.usage?.cpuSeconds).toBeGreaterThanOrEqual(0);
    expect(report.usage?.basis).toBe('RESERVATION_WALL_CLOCK');
    expect(report.cost?.estimatedPerMinuteUsd).toBeCloseTo(0.001_11, 6);

    // Every sandbox created during the run was deleted by the end of it.
    expect(client.sandboxes.size).toBeGreaterThanOrEqual(4);
    expect([...client.sandboxes.values()].every((entry) => entry.state === 'destroyed')).toBe(true);

    const written = JSON.parse(readFileSync(jsonOut, 'utf8')) as DaytonaSmokeReport;
    expect(written.status).toBe('PASS');
  });

  it('reports an HTTP-layer metadata gap without ever claiming credential exposure', async () => {
    const sink = capture();
    const client = new FakeDaytonaClient({ metadataReachable: true });

    const code = await runDaytonaCli(
      ['--format', 'json'],
      sink.streams,
      { DAYTONA_API_KEY: 'dtn_test_key_value_123456' },
      { createClient: () => client, reconcile: reconcileWith(client) },
    );

    // The functional flow completes, but the validator must refuse a PASS.
    expect(code).toBe(DAYTONA_SMOKE_EXIT.fail);

    const report = reportFrom(sink.stdout());

    expect(report.status).toBe('FAIL');
    expect(report.isolation?.metadataTcpReachable).toBe(true);
    expect(report.isolation?.metadataHttpReachable).toBe(true);
    expect(report.isolation?.metadataHttpStatus).toBe(401);

    const finding = report.findings.find(
      (entry) => entry.startsWith('SECURITY') && entry.includes('metadata'),
    );

    expect(finding).toBeDefined();
    expect(finding).toContain('CONFIRMED at HTTP layer');
    expect(finding).toContain('Credential exposure NOT tested and NOT proven');
  });

  it('distinguishes a TCP-only metadata gap from an HTTP-layer one', async () => {
    const sink = capture();
    const client = new FakeDaytonaClient({ metadataTcpOnly: true });

    await runDaytonaCli(
      ['--format', 'json'],
      sink.streams,
      { DAYTONA_API_KEY: 'dtn_test_key_value_123456' },
      { createClient: () => client, reconcile: reconcileWith(client) },
    );

    const report = reportFrom(sink.stdout());

    expect(report.isolation?.metadataTcpReachable).toBe(true);
    expect(report.isolation?.metadataHttpReachable).toBe(false);
    expect(report.isolation?.metadataHttpStatus).toBeNull();

    const finding = report.findings.find(
      (entry) => entry.startsWith('SECURITY') && entry.includes('metadata'),
    );

    expect(finding).toBeDefined();
    expect(finding).toContain('CONFIRMED at TCP layer only');
    expect(finding).toContain('unproven');
  });

  it('never writes the api key into a report', async () => {
    const sink = capture();
    const client = new FakeDaytonaClient();
    const secret = 'dtn_supersecretvalue987654321';

    await runDaytonaCli(
      ['--format', 'both'],
      sink.streams,
      { DAYTONA_API_KEY: secret },
      { createClient: () => client, reconcile: reconcileWith(client) },
    );

    expect(sink.stdout()).not.toContain(secret);
    expect(sink.stderr()).not.toContain(secret);
  });

  it('redacts credentials that appear inside vendor error text', () => {
    const secret = 'dtn_supersecretvalue987654321';
    const text = sanitizeText(`401 unauthorized for key=${secret} header=Bearer ${secret}`);

    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
  });
});

describe('report validation', () => {
  const passing = (): DaytonaSmokeReport => {
    const steps = {} as Record<string, DaytonaSmokeStepDetail>;

    for (const step of DAYTONA_SMOKE_STEPS) {
      steps[step] = { step, status: 'PASS', durationMs: 1 };
    }

    return {
      schemaVersion: '1.0',
      status: 'PASS',
      startedAt: '2026-11-06T00:00:00.000Z',
      finishedAt: '2026-11-06T00:00:10.000Z',
      elapsedMs: 10_000,
      environment: {
        sdkVersion: '0.230.0',
        pinnedSdkVersion: '0.230.0',
        nodeVersion: 'v24.0.0',
        platform: 'darwin/arm64',
        apiHost: 'app.daytona.io',
        target: null,
        snapshot: 'daytona-small',
        sandboxClass: 'container',
        profileId: 'container-small',
        owner: 'poc:test',
        tenantA: 'a',
        tenantB: 'b',
        tierNote: 'tier 1',
        startedAt: '2026-11-06T00:00:00.000Z',
      },
      steps: steps as DaytonaSmokeReport['steps'],
      measurements: {
        createLatencyMs: 1,
        readyLatencyMs: 1,
        firstCommandLatencyMs: 1,
        commandLatencyMs: 1,
        fileWriteLatencyMs: 1,
        fileReadLatencyMs: 1,
        timeoutObservedMs: 1,
        cancelObservedMs: 1,
        stopLatencyMs: 1,
        destroyLatencyMs: 1,
        reconcileLatencyMs: 1,
      },
      isolation: {
        dnsBlocked: true,
        publicTcpBlocked: true,
        egressBlocked: true,
        metadataTcpReachable: false,
        metadataHttpStatus: null,
        metadataImdsV2TokenStatus: null,
        metadataHttpReachable: false,
        crossTenantHandleDenied: true,
        crossTenantFileVisible: false,
        sandboxClassReported: 'container',
        snapshotReported: 'daytona-small',
        kernelRelease: '6.8.0',
        cgroupDriver: 'container-namespaces',
        cgroupCpuMax: '100000 100000',
        uid: 0,
        networkBlockAllReported: true,
      },
      cleanup: {
        liveBeforeDestroy: 1,
        vendorLiveAfterDestroy: 0,
        ownerWideLiveAfterDestroy: 0,
        orphanSweptCount: 1,
        orphanSweepFailures: 0,
        orphanSweepProcessId: '123',
      },
      usage: {
        cpuSeconds: 1,
        memoryGiBSeconds: 1,
        egressBytes: 0,
        basis: 'RESERVATION_WALL_CLOCK',
      },
      cost: { estimatedUsd: 0.001, estimatedPerMinuteUsd: 0.001_11, rateCard: {} },
      limits: {
        requestedCpu: 1,
        requestedMemoryMiB: 1_024,
        maxLifetimeSec: 120,
        vendorTtlMinutes: 2,
        idleStopMinutes: 2,
        concurrencyCap: 2,
      },
      findings: [],
    };
  };

  it('accepts a fully measured pass', () => {
    expect(validateDaytonaSmokeReport(passing())).toEqual([]);
  });

  it('rejects a pass with a missing measurement', () => {
    const report = passing();

    const problems = validateDaytonaSmokeReport({
      ...report,
      measurements: { ...report.measurements!, createLatencyMs: null },
    });

    expect(problems).toContain('measurement createLatencyMs is missing');
  });

  it('rejects a pass that did not disprove metadata reachability at the HTTP layer', () => {
    const report = passing();

    const problems = validateDaytonaSmokeReport({
      ...report,
      isolation: { ...report.isolation!, metadataHttpReachable: null },
    });

    expect(problems.some((problem) => problem.includes('metadata endpoint HTTP-layer'))).toBe(true);
  });

  it('rejects a pass that only disproved the HTTP layer but not TCP', () => {
    const report = passing();

    const problems = validateDaytonaSmokeReport({
      ...report,
      isolation: { ...report.isolation!, metadataTcpReachable: true },
    });

    expect(problems.some((problem) => problem.includes('metadata endpoint TCP-layer'))).toBe(true);
  });

  it('rejects a pass with live sandboxes left behind', () => {
    const report = passing();

    const problems = validateDaytonaSmokeReport({
      ...report,
      cleanup: { ...report.cleanup!, vendorLiveAfterDestroy: 2 },
    });

    expect(problems.some((problem) => problem.includes('live sandboxes'))).toBe(true);
  });

  it('requires a reason on a blocked report', () => {
    const report = passing();

    const problems = validateDaytonaSmokeReport({
      ...report,
      status: 'BLOCKED',
      blockedReason: '',
    });

    expect(problems).toEqual(['a blocked report must state why']);
  });
});
