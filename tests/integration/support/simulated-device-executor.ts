import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  DEVICE_CAPABILITY,
  DEVICE_CAPABILITY_VERSION,
  type DeviceClaim,
  type DeviceResultSubmission,
} from '../../../packages/runtime-v2/src/contracts/device-execution.js';

type Fetch = (path: string, init: RequestInit) => Promise<Response>;
type Claim = Extract<DeviceClaim, { kind: 'claimed' }>;
type PendingResult = { taskId: string; result: DeviceResultSubmission };

interface DeviceState {
  deviceId: string;
  deviceToken: string;
  pendingResult: PendingResult | null;
}

/** Foreground device stand-in which retains the original result until the server acknowledges it. */
export class SimulatedDeviceExecutor {
  private constructor(
    private readonly fetch: Fetch,
    private readonly sessionToken: string,
    private readonly statePath: string,
    private state: DeviceState,
  ) {}

  static async create(
    fetch: Fetch,
    sessionToken: string,
    statePath: string,
    id: string = randomUUID(),
  ) {
    const state = {
      deviceId: id,
      deviceToken: randomBytes(32).toString('hex'),
      pendingResult: null,
    };
    const device = new SimulatedDeviceExecutor(fetch, sessionToken, statePath, state);
    await device.save(state);
    return device;
  }

  static async reopen(fetch: Fetch, sessionToken: string, statePath: string) {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as DeviceState;
    return new SimulatedDeviceExecutor(fetch, sessionToken, statePath, state);
  }

  get id() {
    return this.state.deviceId;
  }

  register() {
    return this.post('/register', {
      capability: DEVICE_CAPABILITY,
      version: DEVICE_CAPABILITY_VERSION,
    });
  }

  claim() {
    return this.post('/claim', {});
  }

  submitResult(taskId: string, result: DeviceResultSubmission) {
    return this.post(`/tasks/${taskId}/result`, result);
  }

  async prepare(claim: Claim) {
    if (this.state.pendingResult !== null) {
      throw new Error('A pending result already needs acknowledgment');
    }
    if (claim.capability !== DEVICE_CAPABILITY || claim.version !== DEVICE_CAPABILITY_VERSION) {
      throw new Error('Unsupported device capability');
    }
    const text = claim.input.text.replace(/\s+/gu, ' ').trim();
    const fence = {
      operationId: claim.operationId,
      runId: claim.runId,
      leaseEpoch: claim.leaseEpoch,
    };
    const result: DeviceResultSubmission =
      text === ''
        ? { ...fence, status: 'failed' }
        : { ...fence, status: 'completed', output: { text } };
    await this.save({ ...this.state, pendingResult: { taskId: claim.taskId, result } });
  }

  async flush({ discardAcknowledgment = false } = {}) {
    const pending = this.state.pendingResult;
    if (pending === null) throw new Error('No pending result to submit');
    const response = await this.submitResult(pending.taskId, pending.result);
    if (discardAcknowledgment) {
      await response.body?.cancel();
      return null;
    }

    const body = (await response.json()) as { kind?: string; replayed?: boolean };
    if (
      response.status !== 200 ||
      body.kind !== 'committed' ||
      typeof body.replayed !== 'boolean'
    ) {
      throw new Error(
        `Unexpected result receipt (HTTP ${response.status}): ${JSON.stringify(body)}`,
      );
    }
    await this.save({ ...this.state, pendingResult: null });
    return body;
  }

  private post(path: string, body: Record<string, unknown>) {
    return this.fetch(`/v2/devices/${this.id}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.sessionToken}`,
        'content-type': 'application/json',
        'x-device-token': this.state.deviceToken,
      },
      body: JSON.stringify(body),
    });
  }

  private async save(state: DeviceState) {
    const nextPath = `${this.statePath}.tmp`;
    await writeFile(nextPath, JSON.stringify(state), { mode: 0o600 });
    await rename(nextPath, this.statePath);
    this.state = state;
  }
}
