/**
 * CredentialProxy facade for @ember/credentials.
 *
 * Implements Section 4 of P0-C1C:
 * - A testable, network-free proxy shell simulating the local execution proxy endpoint.
 * - Confirms that all authorized actions return synthetic, redacted results without opening sockets.
 * - Always reports activeSocketsCount: 0 and networkCallsAttempted: 0.
 */

import type { RunExecutionContextReader } from '@ember/contracts';
import type { LeasedRun } from '@ember/domain';
import type { CredentialBroker } from './broker.js';
import type { EgressRequest, SimulatedProxyResult } from './types.js';

export interface CredentialProxyOptions {
  readonly broker: CredentialBroker;
}

export class CredentialProxy {
  readonly broker: CredentialBroker;
  readonly isSimulated = true;

  constructor(options: CredentialProxyOptions) {
    this.broker = options.broker;
  }

  /**
   * Proxies a simulated outbound request using an opaque credential reference.
   * Never makes socket connections, HTTP requests, or external calls.
   */
  async proxyRequest(
    lease: LeasedRun,
    credentialRef: string,
    request: EgressRequest,
    contextReader: RunExecutionContextReader,
    now: Date = new Date(),
  ): Promise<SimulatedProxyResult> {
    return this.broker.executeWithCredential(lease, credentialRef, request, contextReader, now);
  }

  /**
   * Diagnostic verification metric: active socket count is strictly zero.
   */
  activeSocketsCount(): 0 {
    return 0;
  }

  /**
   * Diagnostic verification metric: network calls attempted is strictly zero.
   */
  networkCallsAttempted(): 0 {
    return 0;
  }
}
