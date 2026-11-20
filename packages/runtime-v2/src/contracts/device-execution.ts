import { z } from 'zod';
import type { AgentHeadCallerScope } from './agent-head-rpc.js';

export const DEVICE_CAPABILITY = 'mock.compute';
export const DEVICE_CAPABILITY_VERSION = 1;
export const DEVICE_READY_TTL_MS = 30_000;
export const DEVICE_LEASE_MS = 2_000;

export const deviceIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const deviceRegistrationSchema = z.strictObject({
  capability: z.literal(DEVICE_CAPABILITY),
  version: z.literal(DEVICE_CAPABILITY_VERSION),
});
const textPayload = z.strictObject({ text: z.string().min(1).max(4_096) });
export const deviceDispatchSchema = z.strictObject({
  deviceId: deviceIdSchema,
  operationId: deviceIdSchema,
  input: textPayload,
  deadlineMs: z.number().int().min(100).max(120_000).default(60_000),
});

const resultFence = {
  operationId: deviceIdSchema,
  runId: deviceIdSchema,
  leaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const deviceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultFence, status: z.literal('completed'), output: textPayload }),
  z.strictObject({ ...resultFence, status: z.literal('failed') }),
]);
export type DeviceResultSubmission = z.infer<typeof deviceResultSchema>;

export const deviceClaimSchema = z.strictObject({});

type DeviceIdentity = { readonly deviceId: string; readonly tokenDigest: string };
export type DeviceExecutionCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | ({ readonly kind: 'register' } & DeviceIdentity & z.infer<typeof deviceRegistrationSchema>)
    | { readonly kind: 'revoke'; readonly deviceId: string }
    | ({ readonly kind: 'dispatch' } & z.infer<typeof deviceDispatchSchema>)
    | { readonly kind: 'status' | 'cancel'; readonly taskId: string }
    | ({ readonly kind: 'claim' } & DeviceIdentity)
    | ({ readonly kind: 'result'; readonly taskId: string } & DeviceIdentity &
        DeviceResultSubmission)
  );

export interface DeviceTaskSnapshot {
  readonly taskId: string;
  readonly operationId: string;
  readonly deviceId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly availability: 'ready' | 'device_unavailable';
  readonly reason:
    | 'device_unavailable'
    | 'deadline_exceeded'
    | 'lease_attempts_exhausted'
    | 'cancelled'
    | 'executor_failed'
    | null;
  readonly result: { readonly text: string } | null;
  readonly replayed?: boolean;
}

export type DeviceClaim =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'claimed';
      readonly taskId: string;
      readonly operationId: string;
      readonly runId: string;
      readonly leaseEpoch: number;
      readonly leaseExpiresAtMs: number;
      readonly deadlineAtMs: number;
      readonly input: { readonly text: string };
      readonly capability: typeof DEVICE_CAPABILITY;
      readonly version: typeof DEVICE_CAPABILITY_VERSION;
    };

export type DeviceExecutionResponse =
  | DeviceTaskSnapshot
  | DeviceClaim
  | { readonly kind: 'fenced' }
  | { readonly kind: 'committed'; readonly replayed: boolean }
  | { readonly status: 'revoked' }
  | {
      readonly deviceId: string;
      readonly capability: typeof DEVICE_CAPABILITY;
      readonly version: typeof DEVICE_CAPABILITY_VERSION;
      readonly readyUntilMs: number;
    };

export interface DeviceExecutionRpc {
  deviceExecution(cmd: DeviceExecutionCommand): Promise<DeviceExecutionResponse>;
}
