/**
 * Hard resource and security ceilings for the Daytona adapter.
 *
 * Every value is enforced **client-side** before a Daytona API call is issued. Daytona bills
 * per vCPU-hour and per GiB-hour against a prepaid wallet, so an unbounded lifetime, argv or
 * output size is directly convertible into real spend and into an unbounded exfiltration
 * channel. Nothing here is overridable per run.
 *
 * The ceilings are deliberately tighter than the vendor's own Tier-1 pool (10 vCPU / 10 GiB),
 * because the PoC must be able to run inside a free account without any chance of exceeding it.
 */

/** Sandbox classes exposed by the Daytona control plane. */
export type DaytonaSandboxClass = 'container' | 'linux-vm' | 'windows';

export const DAYTONA_SANDBOX_CLASSES = Object.freeze({
  CONTAINER: 'container',
  LINUX_VM: 'linux-vm',
  WINDOWS: 'windows',
} as const);

export const DAYTONA_SANDBOX_LIMITS = Object.freeze({
  /** Maximum wall-clock lifetime of one sandbox. Mirrors the Ember PoC budget ceiling. */
  maxSandboxLifetimeSec: 120,
  /** Below this a sandbox is useless: cold start alone can consume the whole budget. */
  minSandboxLifetimeSec: 10,
  /** Maximum concurrent *live* sandboxes this provider instance will allocate. */
  maxConcurrentSandboxes: 2,
  /** Readiness polling ceiling. VM cold start is measurably slower than container. */
  maxReadyDeadlineMs: 90_000,
  /** Per-command execution timeout ceiling. */
  maxExecTimeoutMs: 60_000,
  /** Per-command execution timeout floor. */
  minExecTimeoutMs: 100,
  /** argv cardinality ceiling (`[program, ...args]`). */
  maxArgvLength: 16,
  /** Single-argument character ceiling. */
  maxArgChars: 4_096,
  /** Total serialized command length ceiling. */
  maxCommandChars: 8_192,
  /** Retained stdout ceiling per exec; excess is truncated and flagged. */
  maxStdoutBytes: 65_536,
  /** Retained stderr ceiling per exec; excess is truncated and flagged. */
  maxStderrBytes: 65_536,
  /** Number of retained exec outputs held in memory per sandbox. */
  maxRetainedOutputsPerSandbox: 32,
  /** Single-file transfer ceiling (matches Cloudflare R2 / upload limit). */
  maxFileBytes: 15_728_640,
  /** Number of characters allowed in a confined file path. */
  maxFilePathChars: 256,
  /** Number of live sandbox records this provider instance will track. */
  maxTrackedSandboxes: 16,
  /** vCPU ceiling per sandbox. Tier 1 exposes 10 vCPU in total for the whole org. */
  maxCpuPerSandbox: 2,
  /** Memory ceiling per sandbox, in GiB. */
  maxMemoryGiBPerSandbox: 2,
  /**
   * Idle-stop interval applied at creation, in minutes.
   *
   * This is the *primary* orphan control: if the Ember worker is killed between `create()` and
   * `destroy()`, nobody calls the delete path, and the only thing that still reclaims the
   * sandbox is the vendor-side idle timer. Zero (disabled) would leak until `ttlMinutes`.
   */
  idleStopMinutes: 2,
  /**
   * Auto-delete interval after a stop, in minutes. `0` means the vendor destroys the sandbox
   * as soon as it stops, which is what turns the idle timer into an actual reclaim.
   */
  autoDeleteMinutesAfterStop: 0,
  /** Wall-clock TTL ceiling accepted by the TTL field itself (minutes). */
  maxTtlMinutes: 5,
  /** Default workspace root inside the sandbox. Relative paths resolve under it. */
  workspaceRoot: '/home/daytona/ember',
} as const);

/**
 * Programs the adapter is willing to run.
 *
 * This is an allowlist, not a denylist: anything absent is rejected before the argv is
 * rendered into a command string. The defaults cover the smoke harness and nothing that can
 * reach a network client, a package manager, the Docker socket or the Daytona toolbox API.
 */
export const DAYTONA_DEFAULT_ALLOWED_PROGRAMS: readonly string[] = Object.freeze([
  'python3',
  'python',
  'true',
  'false',
  'echo',
  'cat',
  'ls',
  'test',
  'sleep',
  'sha256sum',
  'uname',
]);

/**
 * Vendor snapshot used for each sandbox class.
 *
 * A Daytona sandbox's class is a property of the *snapshot*, not of the create request, so the
 * adapter must be told which snapshot it was configured with and then verify the class the
 * control plane actually reports. A silent downgrade from `linux-vm` to `container` would be a
 * security regression that no other field would reveal.
 */
export interface DaytonaSandboxProfile {
  readonly id: string;
  readonly snapshot: string;
  readonly sandboxClass: DaytonaSandboxClass;
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly notes: string;
}

export const DAYTONA_SANDBOX_PROFILES: Readonly<Record<string, DaytonaSandboxProfile>> =
  Object.freeze({
    'container-small': Object.freeze({
      id: 'container-small',
      snapshot: 'daytona-small',
      sandboxClass: 'container',
      cpu: 1,
      memoryGiB: 1,
      diskGiB: 3,
      notes: 'Shared host kernel (namespaces + cgroups). Fastest cold start, weakest boundary.',
    }),
    'linux-vm-small': Object.freeze({
      id: 'linux-vm-small',
      // Snapshot names are vendor-inventory facts. The catalog lists `daytona-small`
      // (class container) and `daytona-linux-vm` (class linux-vm), but the VM snapshot is
      // NOT provisioned to this organization: create fails with `DaytonaValidationError:
      // Snapshot daytona-linux-vm not found. Did you add it through the Daytona Dashboard?`
      // (2026-11-06). Enabling it is a Dashboard action; until then VM runs are BLOCKED.
      // The earlier guess `daytona-vm-small` never existed ("not available in region us").
      snapshot: 'daytona-linux-vm',
      sandboxClass: 'linux-vm',
      cpu: 1,
      memoryGiB: 1,
      diskGiB: 3,
      notes: 'Dedicated guest kernel behind hardware virtualisation. Slower cold start.',
    }),
  });

/**
 * Egress policy presets, addressed by `SandboxSpec.networkPolicyId`.
 *
 * Daytona exposes egress control as an all-or-nothing switch plus optional allow lists; there
 * is no vendor-side CIDR *deny* list. That asymmetry matters: with `networkBlockAll: false`
 * the only thing standing between a sandbox and `169.254.169.254` is an allow list, so
 * `deny-all` is the only policy the smoke harness may use.
 */
export interface DaytonaNetworkPolicy {
  readonly id: string;
  readonly blockAll: boolean;
  /** CIDR allow list, only meaningful when `blockAll` is false. */
  readonly networkAllowList?: string;
  /** Domain allow list, only meaningful when `blockAll` is false. */
  readonly domainAllowList?: string;
}

export const DAYTONA_NETWORK_POLICIES: Readonly<Record<string, DaytonaNetworkPolicy>> =
  Object.freeze({
    'deny-all': Object.freeze({
      id: 'deny-all',
      blockAll: true,
    }),
    'allowlist-pypi': Object.freeze({
      id: 'allowlist-pypi',
      blockAll: false,
      domainAllowList: 'pypi.org,files.pythonhosted.org',
    }),
  });

export const DAYTONA_DEFAULT_NETWORK_POLICY_ID = 'deny-all';

/** Labels written on every sandbox. They are the only handle a crashed worker leaves behind. */
export const DAYTONA_LABEL_OWNER = 'ember.owner';
export const DAYTONA_LABEL_TENANT = 'ember.tenant_id';
export const DAYTONA_LABEL_RUN = 'ember.run_id';
export const DAYTONA_LABEL_PROVIDER = 'ember.provider';
export const DAYTONA_LABEL_MANAGED = 'ember.managed';
export const DAYTONA_LABEL_CREATED_BY = 'ember.created_by';

export const DAYTONA_PROVIDER_LABEL_VALUE = 'daytona';
