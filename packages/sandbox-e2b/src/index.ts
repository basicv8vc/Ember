/**
 * E2B sandbox adapter (P0-C4 PoC).
 *
 * Deliberately a standalone package: `@ember/execution` and the API/worker runtimes must not
 * gain a vendor SDK dependency, and nothing here is wired into the B1/B2 execution path.
 */
export {
  E2B_DEFAULT_ALLOWED_PROGRAMS,
  E2B_DEFAULT_NETWORK_POLICY_ID,
  E2B_NETWORK_POLICIES,
  E2B_SANDBOX_LIMITS,
  type E2bNetworkPolicy,
} from './limits.js';
export { quotePosixToken, renderCommand, validateArgv, type ArgvPolicy } from './command.js';
export { resolveConfinedPath, truncateUtf8, utf8ByteLength } from './paths.js';
export {
  E2B_CAPABILITIES,
  E2B_OWNER_METADATA_KEY,
  E2B_OWNER_METADATA_VALUE,
  E2B_WORKSPACE_ROOT,
  E2BSandboxProvider,
  E2BSandboxProviderFactory,
  integrateUsage,
  type E2BSandboxFactoryOptions,
  type E2BSandboxProviderOptions,
  type E2bSandboxState,
  type E2bUsageBasis,
} from './provider.js';
export {
  E2B_INSTALLED_SDK_VERSION,
  E2B_PINNED_SDK_VERSION,
  E2bSdkSandboxClient,
  type E2bSdkClientOptions,
} from './sdk-client.js';
export type {
  E2bCommandResult,
  E2bCreateSandboxRequest,
  E2bListFilter,
  E2bMetricsSample,
  E2bRunCommandRequest,
  E2bSandboxClient,
  E2bSandboxHandle,
  E2bSandboxInfo,
  E2bSandboxState as E2bPortSandboxState,
} from './port.js';
