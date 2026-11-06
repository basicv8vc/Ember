import { randomUUID } from 'node:crypto';

import { DomainError, type Id } from '@ember/domain';
import type { SandboxSpec } from '@ember/contracts';
import {
  DAYTONA_LABEL_MANAGED,
  DAYTONA_LABEL_OWNER,
  DAYTONA_SANDBOX_LIMITS,
  DaytonaSandboxProvider,
  type DaytonaSandboxClass,
  type DaytonaSandboxClient,
  estimateCostUsd,
  estimatedCostPerMinuteUsd,
  DAYTONA_PRICING,
} from '@ember/sandbox-daytona';

import { sanitizeText } from './sanitize.js';
import {
  DAYTONA_SMOKE_STEPS,
  type DaytonaSmokeCleanup,
  type DaytonaSmokeCost,
  type DaytonaSmokeEnvironment,
  type DaytonaSmokeIsolation,
  type DaytonaSmokeMeasurements,
  type DaytonaSmokeReport,
  type DaytonaSmokeStep,
  type DaytonaSmokeStepDetail,
  type DaytonaSmokeStepStatus,
  type DaytonaSmokeUsage,
} from './types.js';

const HELLO_ARGV: readonly string[] = ['python3', '-c', "print('hello ember')"];
const HELLO_EXPECTED = 'hello ember';

const PROBE_RELATIVE_PATH = 'notes/probe.txt';
const PROBE_ABSOLUTE_PATH = `${DAYTONA_SANDBOX_LIMITS.workspaceRoot}/${PROBE_RELATIVE_PATH}`;

const EGRESS_ARGV: readonly string[] = [
  'python3',
  '-c',
  "import urllib.request;urllib.request.urlopen('https://example.com',timeout=3).read(1)",
];

/**
 * Layered egress probes (CTO review 2026-11-06: a TCP connect alone does not distinguish
 * "port open" from "HTTP reachable" from "credentials readable"). Each probe prints one JSON
 * line and exits 0 when the layer being measured succeeded.
 *
 * Safety rule for the metadata HTTP probe: status code and `Server` header ONLY. Response
 * bodies are never read, and `user-data` / IAM credential paths are never requested, so the
 * run can confirm an isolation gap without touching a single credential byte.
 */
const DNS_PROBE_ARGV: readonly string[] = [
  'python3',
  '-c',
  `import socket,json,sys
socket.setdefaulttimeout(5)
try:
    ip=socket.gethostbyname('example.com')
    print(json.dumps({"probe":"dns","result":"resolved","ip":ip}))
except Exception as e:
    print(json.dumps({"probe":"dns","result":"blocked","error":type(e).__name__}))
    sys.exit(1)`,
];

const PUBLIC_TCP_PROBE_ARGV: readonly string[] = [
  'python3',
  '-c',
  `import socket,json,sys
socket.setdefaulttimeout(5)
try:
    s=socket.create_connection(("1.1.1.1",443));s.close()
    print(json.dumps({"probe":"public_tcp","target":"1.1.1.1:443","result":"connected"}))
except Exception as e:
    print(json.dumps({"probe":"public_tcp","target":"1.1.1.1:443","result":"blocked","error":type(e).__name__}))
    sys.exit(1)`,
];

const METADATA_TCP_PROBE_ARGV: readonly string[] = [
  'python3',
  '-c',
  `import socket,json,sys
socket.setdefaulttimeout(5)
try:
    s=socket.create_connection(("169.254.169.254",80));s.close()
    print(json.dumps({"probe":"metadata_tcp","target":"169.254.169.254:80","result":"connected"}))
except Exception as e:
    print(json.dumps({"probe":"metadata_tcp","target":"169.254.169.254:80","result":"blocked","error":type(e).__name__}))
    sys.exit(1)`,
];

const METADATA_HTTP_PROBE_ARGV: readonly string[] = [
  'python3',
  '-c',
  `import json,sys,urllib.request,urllib.error,socket
socket.setdefaulttimeout(5)
def st(req):
    try:
        r=urllib.request.urlopen(req,timeout=5)
        return {"status":r.status,"server":r.headers.get("Server")}
    except urllib.error.HTTPError as e:
        return {"status":e.code,"server":(e.headers.get("Server") if e.headers else None)}
    except Exception as e:
        return {"status":None,"error":type(e).__name__}
v1=st(urllib.request.Request("http://169.254.169.254/latest/meta-data/",method="GET"))
v2=st(urllib.request.Request("http://169.254.169.254/latest/api/token",method="PUT",headers={"X-aws-ec2-metadata-token-ttl-seconds":"60"}))
print(json.dumps({"probe":"metadata_http","body_policy":"status-and-server-header-only","imds_v1":v1,"imds_v2_token":v2}))
sys.exit(0 if (v1.get("status") is not None or v2.get("status") is not None) else 1)`,
];

export interface DaytonaReconcileOutcome {
  readonly swept: number;
  readonly failures: number;
  readonly processId: string;
  readonly elapsedMs: number;
}

export interface DaytonaSmokeOptions {
  readonly client: DaytonaSandboxClient;
  readonly environment: DaytonaSmokeEnvironment;
  readonly snapshot: string;
  readonly sandboxClass: DaytonaSandboxClass;
  readonly diskGiB: number;
  readonly owner: string;
  readonly lifetimeSec: number;
  readonly execTimeoutMs: number;
  /**
   * Runs the orphan sweep. Injected so the harness can be tested without spawning, and so the
   * production CLI can use a genuinely separate process (the only honest way to prove that a
   * restarted worker reclaims a sandbox it never knew about).
   */
  readonly reconcile: (input: {
    readonly owner: string;
    readonly tenantId: string;
  }) => Promise<DaytonaReconcileOutcome>;
  readonly clock?: () => number;
}

/**
 * Executes the full Daytona smoke flow and returns a report.
 *
 * Design rule: a step never "passes by default". Every assertion has an explicit expected
 * value, and a missing measurement leaves `null` rather than a placeholder number.
 */
export class DaytonaSmokeRunner {
  private readonly options: DaytonaSmokeOptions;
  private readonly clock: () => number;

  public constructor(options: DaytonaSmokeOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
  }

  public async run(): Promise<DaytonaSmokeReport> {
    const startedAtMs = this.clock();
    const steps = emptySteps();
    const findings: string[] = [];

    const measurements = emptyMeasurements();
    const isolation = emptyIsolation();
    const cleanup = emptyCleanup();

    let usage: DaytonaSmokeUsage | null = null;
    let cost: DaytonaSmokeCost | null = null;
    let status: 'PASS' | 'FAIL' = 'PASS';

    const providerA = this.buildProvider(this.options.environment.tenantA);
    const providerB = this.buildProvider(this.options.environment.tenantB);

    let sandboxA: Id | null = null;
    let sandboxB: Id | null = null;
    let sandboxC: Id | null = null;
    let holdStartedAtMs: number | null = null;

    const markStep = (
      step: DaytonaSmokeStep,
      stepStatus: DaytonaSmokeStepStatus,
      durationMs: number,
      details?: Readonly<Record<string, unknown>>,
      error?: unknown,
    ): void => {
      steps[step] = {
        step,
        status: stepStatus,
        durationMs: Math.round(durationMs),
        ...(details === undefined ? {} : { details }),
        ...(error === undefined ? {} : { error: describeError(error) }),
      };
    };

    const attempt = async <T>(
      step: DaytonaSmokeStep,
      body: () => Promise<{ value: T; details?: Readonly<Record<string, unknown>> }>,
    ): Promise<T> => {
      const startedAt = this.clock();

      try {
        const result = await body();
        markStep(step, 'PASS', this.clock() - startedAt, result.details);
        return result.value;
      } catch (error) {
        markStep(step, 'FAIL', this.clock() - startedAt, undefined, error);
        throw error;
      }
    };

    try {
      // ---------------------------------------------------------------- preflight
      await attempt('preflight', async () => {
        const capabilities = await providerA.capabilities();

        if (this.options.snapshot.trim().length === 0) {
          throw new Error('snapshot is empty');
        }

        return {
          value: undefined,
          details: {
            capabilities,
            snapshot: this.options.snapshot,
            sandboxClass: this.options.sandboxClass,
            lifetimeSec: this.options.lifetimeSec,
            idleStopMinutes: DAYTONA_SANDBOX_LIMITS.idleStopMinutes,
          },
        };
      });

      const spec = (tenantId: string): SandboxSpec => ({
        tenantId,
        runId: randomUUID(),
        imageDigest: this.options.snapshot,
        cpuMilli: 1_000,
        memoryMiB: 1_024,
        maxLifetimeSec: this.options.lifetimeSec,
        networkPolicyId: 'deny-all',
      });

      // ---------------------------------------------------------------- create
      sandboxA = await attempt('create', async () => {
        const startedAt = this.clock();
        const created = await providerA.create(spec(this.options.environment.tenantA));

        measurements.createLatencyMs = round(this.clock() - startedAt);
        holdStartedAtMs = this.clock();

        return {
          value: created.sandboxId,
          details: { sandboxId: created.sandboxId, latencyMs: measurements.createLatencyMs },
        };
      });

      // ---------------------------------------------------------------- waitReady
      await attempt('waitReady', async () => {
        const startedAt = this.clock();
        await providerA.waitReady(sandboxA as Id, 90_000);
        measurements.readyLatencyMs = round(this.clock() - startedAt);

        const info = await this.options.client.get(sandboxA as Id);

        if (info === null) {
          throw new Error('sandbox disappeared immediately after readiness');
        }

        isolation.sandboxClassReported = info.sandboxClass;
        isolation.snapshotReported = info.snapshot;
        isolation.networkBlockAllReported = info.networkBlockAll;

        if (info.sandboxClass !== this.options.sandboxClass) {
          throw new Error(
            `vendor reported class ${String(info.sandboxClass)} but ${this.options.sandboxClass} was requested`,
          );
        }

        if (info.networkBlockAll !== true) {
          throw new Error('egress was not reported as blocked after readiness');
        }

        return {
          value: undefined,
          details: {
            latencyMs: measurements.readyLatencyMs,
            reportedClass: info.sandboxClass,
            reportedCpu: info.cpu,
            reportedMemoryGiB: info.memoryGiB,
            networkBlockAll: info.networkBlockAll,
            autoStopIntervalMinutes: info.autoStopIntervalMinutes,
            autoDeleteIntervalMinutes: info.autoDeleteIntervalMinutes,
            autoDestroyAtMs: info.autoDestroyAtMs,
          },
        };
      });

      // ---------------------------------------------------------------- execHello
      await attempt('execHello', async () => {
        const execStartedAt = this.clock();
        const result = await providerA.exec(sandboxA as Id, HELLO_ARGV, 30_000);
        measurements.firstCommandLatencyMs = round(this.clock() - execStartedAt);

        const stdout = await providerA.readOutput(sandboxA as Id, result.stdoutRef);
        const stderr = await providerA.readOutput(sandboxA as Id, result.stderrRef);

        if (result.exitCode !== 0) {
          throw new Error(`hello exited with ${result.exitCode}`);
        }

        if (stdout.trim() !== HELLO_EXPECTED) {
          throw new Error('hello stdout did not match the expected line');
        }

        if (stderr.trim() !== '') {
          throw new Error('hello wrote to stderr');
        }

        return {
          value: undefined,
          details: {
            latencyMs: measurements.firstCommandLatencyMs,
            exitCode: result.exitCode,
            stdout,
            stderr,
            stdoutRef: result.stdoutRef,
            stderrRef: result.stderrRef,
          },
        };
      });

      // ---------------------------------------------------------------- kernelProbe
      await attempt('kernelProbe', async () => {
        const uname = await runProbe(providerA, sandboxA as Id, ['uname', '-r']);
        const cgroup = await runProbe(providerA, sandboxA as Id, ['cat', '/proc/1/cgroup']);
        const cpuMax = await runProbe(providerA, sandboxA as Id, ['cat', '/sys/fs/cgroup/cpu.max']);
        const uid = await runProbe(providerA, sandboxA as Id, [
          'python3',
          '-c',
          'import os;print(os.getuid())',
        ]);

        isolation.kernelRelease = uname.succeeded ? uname.stdout.trim() : null;
        isolation.cgroupDriver = classifyCgroup(cgroup.stdout);
        isolation.cgroupCpuMax = cpuMax.succeeded ? cpuMax.stdout.trim() : null;
        isolation.uid = uid.succeeded ? Number.parseInt(uid.stdout.trim(), 10) : null;

        return {
          value: undefined,
          details: {
            kernelRelease: isolation.kernelRelease,
            cgroupDriver: isolation.cgroupDriver,
            cgroupCpuMax: isolation.cgroupCpuMax,
            uid: isolation.uid,
            cgroupRaw: cgroup.stdout.trim().split('\n').slice(0, 4).join(' | '),
          },
        };
      });

      // ---------------------------------------------------------------- fileRoundTrip
      await attempt('fileRoundTrip', async () => {
        const payload = `ember-daytona-probe ${randomUUID()}`;

        const writeStartedAt = this.clock();
        await providerA.putTextFile(sandboxA as Id, PROBE_RELATIVE_PATH, payload);
        measurements.fileWriteLatencyMs = round(this.clock() - writeStartedAt);

        const readStartedAt = this.clock();
        const readBack = await providerA.getTextFile(sandboxA as Id, PROBE_RELATIVE_PATH);
        measurements.fileReadLatencyMs = round(this.clock() - readStartedAt);

        if (readBack !== payload) {
          throw new Error('file round-trip returned different content');
        }

        // Independently confirm the upload landed in the sandbox filesystem rather than a
        // side channel owned by the adapter.
        const catStartedAt = this.clock();
        const cat = await providerA.exec(sandboxA as Id, ['cat', PROBE_ABSOLUTE_PATH], 10_000);
        measurements.commandLatencyMs = round(this.clock() - catStartedAt);

        const catStdout = await providerA.readOutput(sandboxA as Id, cat.stdoutRef);

        // `cat` output may carry a trailing newline that the payload does not, so compare on
        // trimmed content — the round-trip is what matters, not the exact byte boundary.
        if (cat.exitCode !== 0 || catStdout.trimEnd() !== payload) {
          throw new Error('uploaded file was not readable from inside the sandbox');
        }

        return {
          value: undefined,
          details: {
            path: PROBE_RELATIVE_PATH,
            bytes: Buffer.byteLength(payload, 'utf8'),
            writeLatencyMs: measurements.fileWriteLatencyMs,
            readLatencyMs: measurements.fileReadLatencyMs,
            catLatencyMs: measurements.commandLatencyMs,
          },
        };
      });

      // ---------------------------------------------------------------- execTimeout
      await attempt('execTimeout', async () => {
        const startedAt = this.clock();
        let observed: DomainError | null = null;

        try {
          await providerA.exec(sandboxA as Id, ['sleep', '30'], 2_000);
        } catch (error) {
          observed = error as DomainError;
        }

        measurements.timeoutObservedMs = round(this.clock() - startedAt);

        if (!(observed instanceof DomainError) || observed.code !== 'EXECUTION_TIMEOUT') {
          throw new Error('bounded exec did not time out with EXECUTION_TIMEOUT');
        }

        if ((measurements.timeoutObservedMs ?? 0) > 15_000) {
          throw new Error('timeout enforcement overshot by more than 13s');
        }

        return {
          value: undefined,
          details: {
            requestedTimeoutMs: 2_000,
            observedMs: measurements.timeoutObservedMs,
            code: observed.code,
          },
        };
      });

      // ---------------------------------------------------------------- cancel
      await attempt('cancel', async () => {
        const controller = new AbortController();
        const cancelProvider = new DaytonaSandboxProvider({
          tenantId: this.options.environment.tenantA,
          runId: randomUUID(),
          client: this.options.client,
          snapshot: this.options.snapshot,
          sandboxClass: this.options.sandboxClass,
          diskGiB: this.options.diskGiB,
          owner: this.options.owner,
          signal: controller.signal,
        });

        const created = await cancelProvider.create(spec(this.options.environment.tenantA));
        // Registered before any assertion so the outer cleanup always has the id.
        sandboxC = created.sandboxId;
        await cancelProvider.waitReady(created.sandboxId, 90_000);

        const pending = cancelProvider
          .exec(created.sandboxId, ['sleep', '20'], 20_000)
          .then(() => 'completed' as const)
          .catch((error: unknown) => error);

        // Let the command reach the vendor before aborting; aborting before it starts would
        // test the adapter's pre-flight check rather than the cancellation path.
        await sleep(1_500);

        const abortedAt = this.clock();
        controller.abort();

        const outcome = await pending;
        measurements.cancelObservedMs = round(this.clock() - abortedAt);

        if (!(outcome instanceof DomainError) || outcome.code !== 'CANCELLED') {
          throw new Error(
            `abort did not cancel the command (outcome: ${outcome instanceof Error ? outcome.name : String(outcome)})`,
          );
        }

        return {
          value: undefined,
          details: {
            outcome: outcome.code,
            cancelObservedMs: measurements.cancelObservedMs,
          },
        };
      });

      // ---------------------------------------------------------------- egressProbe
      await attempt('egressProbe', async () => {
        const dns = await runProbe(providerA, sandboxA as Id, DNS_PROBE_ARGV);
        const publicTcp = await runProbe(providerA, sandboxA as Id, PUBLIC_TCP_PROBE_ARGV);
        const metadataTcp = await runProbe(providerA, sandboxA as Id, METADATA_TCP_PROBE_ARGV);
        const metadataHttp = await runProbe(providerA, sandboxA as Id, METADATA_HTTP_PROBE_ARGV);
        const internet = await runProbe(providerA, sandboxA as Id, EGRESS_ARGV);

        const httpLayer = parseMetadataHttp(metadataHttp.stdout);

        isolation.dnsBlocked = !dns.succeeded;
        isolation.publicTcpBlocked = !publicTcp.succeeded;
        isolation.metadataTcpReachable = metadataTcp.succeeded;
        isolation.metadataHttpStatus = httpLayer.imdsV1Status;
        isolation.metadataImdsV2TokenStatus = httpLayer.imdsV2TokenStatus;
        isolation.metadataHttpReachable = httpLayer.reachable;
        isolation.egressBlocked = !internet.succeeded;

        // Record security findings without aborting: the remaining steps (isolation,
        // crash-recovery, cleanup) are still valuable measurements even when egress is
        // imperfect. The report validator marks the overall run FAIL on these findings.
        //
        // Wording rule from the CTO review: a reachable metadata endpoint is a CONFIRMED
        // network isolation gap. It is NOT "confirmed credential exposure" — the probe never
        // reads response bodies and never requests user-data or IAM credential paths.
        if (httpLayer.reachable) {
          findings.push(
            `SECURITY (isolation gap, CONFIRMED at HTTP layer): link-local metadata service answered despite networkBlockAll=true ` +
              `(IMDSv1 status ${String(httpLayer.imdsV1Status)}, IMDSv2 token status ${String(httpLayer.imdsV2TokenStatus)}). ` +
              'Credential exposure NOT tested and NOT proven: probe reads status codes only, never bodies, never user-data/IAM paths.',
          );
        } else if (metadataTcp.succeeded) {
          findings.push(
            'SECURITY (isolation gap, CONFIRMED at TCP layer only): link-local metadata endpoint (169.254.169.254:80) accepted a TCP connection despite networkBlockAll=true, ' +
              'but no HTTP response was received — HTTP-layer exposure and credential exposure are both unproven.',
          );
        }

        if (internet.succeeded) {
          findings.push('SECURITY: public internet reachable from a deny-all sandbox');
        }

        if (dns.succeeded) {
          findings.push(
            'SECURITY: DNS resolution succeeded in a deny-all sandbox (DNS layer not covered by networkBlockAll)',
          );
        }

        if (publicTcp.succeeded) {
          findings.push(
            'SECURITY: TCP to fixed public IP 1.1.1.1:443 succeeded in a deny-all sandbox',
          );
        }

        return {
          value: undefined,
          details: {
            probePolicy: 'layered: dns | public-tcp | metadata-tcp | metadata-http | https',
            bodyPolicy:
              'status-and-server-header-only; user-data and IAM credential paths never requested',
            dnsExitCode: dns.exitCode,
            dnsStdout: dns.stdout,
            publicTcpExitCode: publicTcp.exitCode,
            publicTcpStdout: publicTcp.stdout,
            metadataTcpExitCode: metadataTcp.exitCode,
            metadataTcpStdout: metadataTcp.stdout,
            metadataHttpExitCode: metadataHttp.exitCode,
            metadataHttpStdout: metadataHttp.stdout,
            metadataHttpStderr: metadataHttp.stderr,
            metadataHttpStatus: httpLayer.imdsV1Status,
            metadataImdsV2TokenStatus: httpLayer.imdsV2TokenStatus,
            metadataHttpReachable: httpLayer.reachable,
            metadataTcpReachable: metadataTcp.succeeded,
            internetExitCode: internet.exitCode,
            internetStdout: internet.stdout,
            internetStderr: internet.stderr,
            internetReachable: internet.succeeded,
          },
        };
      });

      // ---------------------------------------------------------------- isolationCrossTenant
      await attempt('isolationCrossTenant', async () => {
        const createdB = await providerB.create(spec(this.options.environment.tenantB));
        sandboxB = createdB.sandboxId;
        await providerB.waitReady(createdB.sandboxId, 90_000);

        // 1. Tenant B must not be able to address tenant A's sandbox id at all.
        let handleDenied = false;

        try {
          await providerB.exec(sandboxA as Id, ['true'], 5_000);
        } catch (error) {
          handleDenied = error instanceof DomainError && error.code === 'NOT_FOUND';
        }

        isolation.crossTenantHandleDenied = handleDenied;

        if (!handleDenied) {
          throw new Error("tenant B was able to address tenant A's sandbox id");
        }

        // 2. Tenant B must not see tenant A's file even when it knows the exact path.
        const crossRead = await runProbe(providerB, createdB.sandboxId, [
          'cat',
          PROBE_ABSOLUTE_PATH,
        ]);
        isolation.crossTenantFileVisible =
          crossRead.succeeded && crossRead.stdout.includes('ember-daytona-probe');

        if (isolation.crossTenantFileVisible === true) {
          throw new Error("tenant B read tenant A's file through the absolute path");
        }

        // 3. The adapter must not report it as existing either.
        const existsInB = await providerB.textFileExists(createdB.sandboxId, PROBE_RELATIVE_PATH);

        if (existsInB) {
          throw new Error('workspace path was shared between tenants');
        }

        return {
          value: undefined,
          details: {
            crossTenantHandleDenied: handleDenied,
            crossTenantFileVisible: isolation.crossTenantFileVisible,
            crossReadExitCode: crossRead.exitCode,
            sharedPathExists: existsInB,
          },
        };
      });

      // ---------------------------------------------------------------- crashRecovery
      await attempt('crashRecovery', async () => {
        // The sweep is tenant-scoped, so the crash test must own a tenant of its own. Reusing
        // tenant A here would let the reconciler delete the sandbox every later step depends
        // on — which is exactly what an unscoped, aggressive sweep would do in production.
        const crashTenant = randomUUID();
        const crashProvider = new DaytonaSandboxProvider({
          tenantId: crashTenant,
          runId: randomUUID(),
          client: this.options.client,
          snapshot: this.options.snapshot,
          sandboxClass: this.options.sandboxClass,
          diskGiB: this.options.diskGiB,
          owner: this.options.owner,
        });

        const orphan = await crashProvider.create(spec(crashTenant));
        await crashProvider.waitReady(orphan.sandboxId, 90_000);

        // The worker "dies" here: local state is discarded and nothing calls destroy().
        const abandoned = crashProvider.abandonAllRecords();

        if (abandoned.length !== 1) {
          throw new Error('crash simulation did not discard exactly one sandbox');
        }

        const sweep = await this.options.reconcile({
          owner: this.options.owner,
          tenantId: crashTenant,
        });

        measurements.reconcileLatencyMs = round(sweep.elapsedMs);
        cleanup.orphanSweptCount = sweep.swept;
        cleanup.orphanSweepFailures = sweep.failures;
        cleanup.orphanSweepProcessId = sweep.processId;

        const after = await this.options.client.get(orphan.sandboxId);
        const stillLive =
          after !== null && after.state !== 'destroyed' && after.state !== 'destroying';

        if (stillLive) {
          // Last chance: destroy directly so the run does not leak, then fail.
          await this.options.client.delete(orphan.sandboxId, 60_000).catch(() => undefined);
          throw new Error('orphaned sandbox survived reconciliation');
        }

        return {
          value: undefined,
          details: {
            orphanId: orphan.sandboxId,
            crashTenant,
            swept: sweep.swept,
            failures: sweep.failures,
            reconcilerProcessId: sweep.processId,
            reconcilerElapsedMs: measurements.reconcileLatencyMs,
            stateAfterSweep: after?.state ?? 'gone',
          },
        };
      });

      // ---------------------------------------------------------------- usage
      await attempt('usage', async () => {
        const record = await providerA.usage(sandboxA as Id);
        const basis = providerA.usageBasis(sandboxA as Id);

        usage = { ...record, basis };

        const elapsedSec = ((this.clock() - (holdStartedAtMs ?? this.clock())) / 1_000) | 0;

        cost = {
          estimatedUsd: round6(
            estimateCostUsd({
              cpu: 1,
              memoryGiB: 1,
              diskGiB: this.options.diskGiB,
              seconds: Math.max(elapsedSec, 1),
            }),
          ),
          estimatedPerMinuteUsd: round6(estimatedCostPerMinuteUsd(1, 1, this.options.diskGiB)),
          rateCard: {
            vCpuHourUsd: DAYTONA_PRICING.vCpuHourUsd,
            memoryGiBHourUsd: DAYTONA_PRICING.memoryGiBHourUsd,
            storageGiBHourUsd: DAYTONA_PRICING.storageGiBHourUsd,
          },
        };

        const metrics = providerA.lastMetrics(sandboxA as Id);

        return {
          value: undefined,
          details: {
            usage,
            basis,
            estimatedUsd: cost.estimatedUsd,
            elapsedSec,
            vendorMetrics: metrics,
          },
        };
      });

      // ---------------------------------------------------------------- stop
      await attempt('stop', async () => {
        const startedAt = this.clock();
        await providerA.stop(sandboxA as Id);
        measurements.stopLatencyMs = round(this.clock() - startedAt);

        return { value: undefined, details: { latencyMs: measurements.stopLatencyMs } };
      });

      // ---------------------------------------------------------------- destroy
      await attempt('destroy', async () => {
        const startedAt = this.clock();
        await providerA.destroy(sandboxA as Id);
        measurements.destroyLatencyMs = round(this.clock() - startedAt);
        sandboxA = null;

        return { value: undefined, details: { latencyMs: measurements.destroyLatencyMs } };
      });

      // ---------------------------------------------------------------- cleanupVerify
      await attempt('cleanupVerify', async () => {
        // Snapshot the live count *before* destroying the remaining sandboxes: a request for
        // "how many were still billing at this point" cannot be answered afterwards.
        const beforeDestroy = await providerA.verifyNoLiveSandboxes();
        cleanup.liveBeforeDestroy = beforeDestroy.liveSandboxIds.length;

        const remainingB = sandboxB;
        if (remainingB !== null) {
          await providerB.destroy(remainingB);
          sandboxB = null;
        }

        const remainingC = sandboxC;
        if (remainingC !== null) {
          await providerA.destroy(remainingC);
          sandboxC = null;
        }

        const tenantAudit = await providerA.verifyNoLiveSandboxes();
        const ownerAudit = await this.options.client.list({
          labels: {
            [DAYTONA_LABEL_OWNER]: this.options.owner,
            [DAYTONA_LABEL_MANAGED]: 'true',
          },
        });

        cleanup.vendorLiveAfterDestroy = tenantAudit.liveSandboxIds.length;
        cleanup.ownerWideLiveAfterDestroy = ownerAudit.length;

        if (tenantAudit.liveSandboxIds.length > 0) {
          throw new Error(
            `tenant still owns live sandboxes: ${tenantAudit.liveSandboxIds.join(',')}`,
          );
        }

        if (ownerAudit.length > 0) {
          throw new Error(
            `owner still owns live sandboxes across tenants: ${ownerAudit.map((entry) => entry.sandboxId).join(',')}`,
          );
        }

        return {
          value: undefined,
          details: { ...tenantAudit, ownerWideLive: ownerAudit.length },
        };
      });

      // ---------------------------------------------------------------- findings
      if (isolation.uid === 0) {
        findings.push('processes run as uid 0 inside the sandbox (expected for both classes)');
      }

      if (isolation.kernelRelease !== null) {
        findings.push(`sandbox kernel release reported as ${isolation.kernelRelease}`);
      }
    } catch (error) {
      status = 'FAIL';
      findings.push(`run aborted: ${describeError(error)}`);
    } finally {
      // Cleanup is best-effort but never silent: a failure here is appended as a finding so the
      // report cannot claim a clean run while a sandbox is still billing.
      for (const [label, id] of [
        ['A', sandboxA],
        ['B', sandboxB],
        ['C', sandboxC],
      ] as const) {
        if (id === null) {
          continue;
        }

        try {
          await this.options.client.delete(id, 60_000);
        } catch (error) {
          findings.push(`cleanup of sandbox ${label} failed: ${describeError(error)}`);
          status = 'FAIL';
        }
      }
    }

    return {
      schemaVersion: '1.0',
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(this.clock()).toISOString(),
      elapsedMs: Math.round(this.clock() - startedAtMs),
      environment: this.options.environment,
      steps,
      measurements,
      isolation,
      cleanup,
      usage,
      cost,
      limits: {
        requestedCpu: 1,
        requestedMemoryMiB: 1_024,
        maxLifetimeSec: this.options.lifetimeSec,
        vendorTtlMinutes: Math.max(Math.ceil(this.options.lifetimeSec / 60), 1),
        idleStopMinutes: DAYTONA_SANDBOX_LIMITS.idleStopMinutes,
        concurrencyCap: DAYTONA_SANDBOX_LIMITS.maxConcurrentSandboxes,
      },
      findings,
    };
  }

  private buildProvider(tenantId: string): DaytonaSandboxProvider {
    return new DaytonaSandboxProvider({
      tenantId,
      runId: randomUUID(),
      client: this.options.client,
      snapshot: this.options.snapshot,
      sandboxClass: this.options.sandboxClass,
      diskGiB: this.options.diskGiB,
      owner: this.options.owner,
    });
  }
}

/**
 * Validates a report before it can be published.
 *
 * A PASS with a null measurement is rejected: that is exactly the failure mode this harness
 * exists to prevent.
 */
export function validateDaytonaSmokeReport(report: DaytonaSmokeReport): readonly string[] {
  const problems: string[] = [];

  if (report.status === 'BLOCKED') {
    return report.blockedReason === undefined || report.blockedReason.length === 0
      ? ['a blocked report must state why']
      : [];
  }

  if (report.status !== 'PASS') {
    return problems;
  }

  for (const step of DAYTONA_SMOKE_STEPS) {
    if (report.steps[step].status !== 'PASS') {
      problems.push(`step ${step} is ${report.steps[step].status}`);
    }
  }

  const required: readonly (keyof DaytonaSmokeMeasurements)[] = [
    'createLatencyMs',
    'readyLatencyMs',
    'firstCommandLatencyMs',
    'fileWriteLatencyMs',
    'fileReadLatencyMs',
    'timeoutObservedMs',
    'stopLatencyMs',
    'destroyLatencyMs',
  ];

  for (const key of required) {
    if (report.measurements?.[key] === null || report.measurements?.[key] === undefined) {
      problems.push(`measurement ${key} is missing`);
    }
  }

  if (report.cleanup?.vendorLiveAfterDestroy !== 0) {
    problems.push('vendor still reports live sandboxes after cleanup');
  }

  if (report.isolation?.metadataHttpReachable !== false) {
    problems.push(
      'metadata endpoint HTTP-layer reachability was not disproven (any status code, including 401/403, counts as reachable)',
    );
  }

  if (report.isolation?.metadataTcpReachable !== false) {
    problems.push('metadata endpoint TCP-layer reachability was not disproven');
  }

  if (report.isolation?.crossTenantHandleDenied !== true) {
    problems.push('cross-tenant handle rejection was not proven');
  }

  return problems;
}

async function runProbe(
  provider: DaytonaSandboxProvider,
  sandboxId: Id,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; succeeded: boolean }> {
  const result = await provider.exec(sandboxId, argv, 15_000);
  const stdout = await provider.readOutput(sandboxId, result.stdoutRef);
  const stderr = await provider.readOutput(sandboxId, result.stderrRef);

  return { exitCode: result.exitCode, stdout, stderr, succeeded: result.exitCode === 0 };
}

interface MetadataHttpLayer {
  readonly imdsV1Status: number | null;
  readonly imdsV2TokenStatus: number | null;
  readonly reachable: boolean;
}

/**
 * Parses the metadata HTTP probe's single JSON line.
 *
 * Deliberately tolerant: anything unparseable becomes `null` (unmeasured), never a fabricated
 * status code. `reachable` is true only when at least one real HTTP status was observed.
 */
function parseMetadataHttp(stdout: string): MetadataHttpLayer {
  const empty: MetadataHttpLayer = {
    imdsV1Status: null,
    imdsV2TokenStatus: null,
    reachable: false,
  };

  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{'))
    .pop();

  if (line === undefined) {
    return empty;
  }

  try {
    const parsed = JSON.parse(line) as {
      imds_v1?: { status?: unknown };
      imds_v2_token?: { status?: unknown };
    };
    const v1 = typeof parsed.imds_v1?.status === 'number' ? parsed.imds_v1.status : null;
    const v2 =
      typeof parsed.imds_v2_token?.status === 'number' ? parsed.imds_v2_token.status : null;

    return {
      imdsV1Status: v1,
      imdsV2TokenStatus: v2,
      reachable: v1 !== null || v2 !== null,
    };
  } catch {
    return empty;
  }
}

/**
 * Classifies PID 1's cgroup path.
 *
 * This is the cheapest observable evidence of the isolation class: a shared-kernel container
 * runs under `docker`/`kubepods`/`containerd` scopes, while a VM boots its own init and shows
 * an `init.scope` (or root `0`) path. It is evidence, not proof — the definitive boundary is
 * the vendor's published class definition, which the report cites.
 */
function classifyCgroup(raw: string): string | null {
  const text = raw.toLowerCase();

  if (text.trim().length === 0) {
    return null;
  }

  if (text.includes('kubepods') || text.includes('docker') || text.includes('containerd')) {
    return 'container-namespaces';
  }

  if (text.includes('init.scope') || /^0::\/$/m.test(text)) {
    return 'vm-init-scope';
  }

  return 'unclassified';
}

function describeError(error: unknown): string {
  if (error instanceof DomainError) {
    return sanitizeText(`${error.code}: ${error.diagnostic}`);
  }

  if (error instanceof Error) {
    return sanitizeText(`${error.name}: ${error.message}`);
  }

  return sanitizeText(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function emptyMeasurements(): DaytonaSmokeMeasurements {
  return {
    createLatencyMs: null,
    readyLatencyMs: null,
    firstCommandLatencyMs: null,
    commandLatencyMs: null,
    fileWriteLatencyMs: null,
    fileReadLatencyMs: null,
    timeoutObservedMs: null,
    cancelObservedMs: null,
    stopLatencyMs: null,
    destroyLatencyMs: null,
    reconcileLatencyMs: null,
  };
}

function emptyIsolation(): DaytonaSmokeIsolation {
  return {
    dnsBlocked: null,
    publicTcpBlocked: null,
    egressBlocked: null,
    metadataTcpReachable: null,
    metadataHttpStatus: null,
    metadataImdsV2TokenStatus: null,
    metadataHttpReachable: null,
    crossTenantHandleDenied: null,
    crossTenantFileVisible: null,
    sandboxClassReported: null,
    snapshotReported: null,
    kernelRelease: null,
    cgroupDriver: null,
    cgroupCpuMax: null,
    uid: null,
    networkBlockAllReported: null,
  };
}

function emptyCleanup(): DaytonaSmokeCleanup {
  return {
    liveBeforeDestroy: null,
    vendorLiveAfterDestroy: null,
    ownerWideLiveAfterDestroy: null,
    orphanSweptCount: null,
    orphanSweepFailures: null,
    orphanSweepProcessId: null,
  };
}

function skipped(step: DaytonaSmokeStep): DaytonaSmokeStepDetail {
  return { step, status: 'SKIP', durationMs: 0 };
}

/** Fully explicit so the compiler proves the table is exhaustive over `DAYTONA_SMOKE_STEPS`. */
function emptySteps(): Record<DaytonaSmokeStep, DaytonaSmokeStepDetail> {
  return {
    preflight: skipped('preflight'),
    create: skipped('create'),
    waitReady: skipped('waitReady'),
    execHello: skipped('execHello'),
    kernelProbe: skipped('kernelProbe'),
    fileRoundTrip: skipped('fileRoundTrip'),
    execTimeout: skipped('execTimeout'),
    cancel: skipped('cancel'),
    egressProbe: skipped('egressProbe'),
    isolationCrossTenant: skipped('isolationCrossTenant'),
    crashRecovery: skipped('crashRecovery'),
    usage: skipped('usage'),
    stop: skipped('stop'),
    destroy: skipped('destroy'),
    cleanupVerify: skipped('cleanupVerify'),
  };
}
