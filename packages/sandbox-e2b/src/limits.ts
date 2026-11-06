/**
 * Hard resource and security ceilings for the E2B adapter.
 *
 * Every value here is enforced **client-side** by the adapter before an E2B API call is
 * issued. They exist because the E2B control plane is a paid, multi-tenant boundary:
 * an unbounded argument (lifetime, argv, output) becomes unbounded vendor spend and an
 * unbounded data-exfiltration channel.
 *
 * These limits are deliberately stricter than E2B's own service limits. Raising them is a
 * reviewed change, not a configuration toggle on a per-run basis.
 */
export const E2B_SANDBOX_LIMITS = Object.freeze({
  /** Maximum wall-clock lifetime of one sandbox (PoC budget ceiling: 120s). */
  maxSandboxLifetimeSec: 120,
  /** Minimum lifetime we are willing to allocate; below this the sandbox is useless. */
  minSandboxLifetimeSec: 5,
  /** Maximum concurrent sandboxes this adapter instance will allocate. */
  maxConcurrentSandboxes: 2,
  /** Readiness polling ceiling. */
  maxReadyDeadlineMs: 60_000,
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
  /** Single text-file transfer ceiling (PoC-only extension). */
  maxFileBytes: 262_144,
  /** Number of characters allowed in a confined file path. */
  maxFilePathChars: 256,
  /** Number of live sandbox records this provider instance will track. */
  maxTrackedSandboxes: 16,
});

/**
 * Programs the adapter is willing to run.
 *
 * This is an allowlist, not a denylist: anything absent is rejected before the argv is
 * rendered into a command string. The defaults cover the smoke harness (`python3`, `true`,
 * `cat`, `test`, `sleep`) and nothing that can reach a network client, package manager,
 * container runtime or the E2B control plane.
 */
export const E2B_DEFAULT_ALLOWED_PROGRAMS: readonly string[] = Object.freeze([
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
]);

/**
 * Egress policy presets, addressed by `SandboxSpec.networkPolicyId`.
 *
 * `deny-all` is the default and the only policy that the smoke harness is allowed to use.
 * E2B applies `denyOut`/`allowOut` at the sandbox network boundary, so this is the adapter's
 * only lever against reaching cloud metadata endpoints or Ember-internal services.
 */
export interface E2bNetworkPolicy {
  readonly id: string;
  readonly allowInternetAccess: boolean;
  readonly allowOut?: readonly string[];
  readonly denyOut?: readonly string[];
  readonly dnsServers?: readonly string[];
}

export const E2B_NETWORK_POLICIES: Readonly<Record<string, E2bNetworkPolicy>> = Object.freeze({
  /** No internet access at all; also denies RFC1918 and link-local metadata ranges. */
  'deny-all': Object.freeze({
    id: 'deny-all',
    allowInternetAccess: false,
    denyOut: Object.freeze([
      '0.0.0.0/0',
      '169.254.169.254/32',
      '169.254.170.2/32',
      '100.100.100.200/32',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]),
  }),
  /** Explicit allowlist for later evaluation; still denies every metadata endpoint. */
  'allowlist-pypi': Object.freeze({
    id: 'allowlist-pypi',
    allowInternetAccess: true,
    allowOut: Object.freeze(['pypi.org', 'files.pythonhosted.org']),
    denyOut: Object.freeze(['169.254.169.254/32', '169.254.170.2/32', '10.0.0.0/8']),
  }),
});

export const E2B_DEFAULT_NETWORK_POLICY_ID = 'deny-all';
