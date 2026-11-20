import { z } from 'zod';
import type { AgentHeadCallerScope } from './agent-head-rpc.js';

export const DEVICE_CAPABILITY = 'mock.compute';
export const DEVICE_TEXT_CAPABILITY = 'device.text.process';
export const DEVICE_CAPABILITY_VERSION = 1;
export const DEVICE_READY_TTL_MS = 30_000;
export const DEVICE_LEASE_MS = 2_000;
export const DEVICE_TEXT_LEASE_MS = 30_000;

export const deviceIdSchema = z.uuid().transform((id) => id.toLowerCase());
const capabilitySchema = z.enum([DEVICE_CAPABILITY, DEVICE_TEXT_CAPABILITY]);
export type DeviceCapability = z.infer<typeof capabilitySchema>;
export const deviceRegistrationSchema = z.strictObject({
  capability: capabilitySchema,
  version: z.literal(DEVICE_CAPABILITY_VERSION),
});

const textPayload = z.strictObject({ text: z.string().min(1).max(4_096) });
export const deviceTextInputSchema = z.strictObject({
  operation: z.literal('stats'),
  text: z
    .string()
    .max(4_096)
    .refine((text) => !/\p{Surrogate}/u.test(text)),
});
export const deviceTextStatsSchema = z.strictObject({
  utf8Bytes: z.number().int().min(0).max(12_288),
  unicodeScalars: z.number().int().min(0).max(4_096),
  lines: z.number().int().min(0).max(4_097),
});
export type DeviceTextStats = z.infer<typeof deviceTextStatsSchema>;

const dispatchFields = {
  deviceId: deviceIdSchema,
  operationId: deviceIdSchema,
  deadlineMs: z.number().int().min(100).max(120_000).default(60_000),
};
export const deviceDispatchSchema = z.union([
  z.strictObject({
    ...dispatchFields,
    capability: z.literal(DEVICE_CAPABILITY).default(DEVICE_CAPABILITY),
    version: z.literal(DEVICE_CAPABILITY_VERSION).default(DEVICE_CAPABILITY_VERSION),
    input: textPayload,
  }),
  z.strictObject({
    ...dispatchFields,
    capability: z.literal(DEVICE_TEXT_CAPABILITY),
    version: z.literal(DEVICE_CAPABILITY_VERSION),
    input: deviceTextInputSchema,
  }),
]);

const resultFence = {
  operationId: deviceIdSchema,
  runId: deviceIdSchema,
  leaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const deviceRenewSchema = z.strictObject(resultFence);
export const deviceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...resultFence,
    status: z.literal('completed'),
    output: z.union([textPayload, deviceTextStatsSchema]),
  }),
  z.strictObject({ ...resultFence, status: z.literal('failed') }),
]);
export type DeviceResultSubmission = z.infer<typeof deviceResultSchema>;

export const deviceClaimSchema = z.strictObject({});

type DeviceIdentity = { readonly deviceId: string; readonly tokenDigest: string };
type DeviceRun = { readonly taskId: string } & DeviceIdentity;
export type DeviceExecutionCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | ({ readonly kind: 'register' } & DeviceIdentity & z.infer<typeof deviceRegistrationSchema>)
    | { readonly kind: 'revoke'; readonly deviceId: string }
    | ({ readonly kind: 'dispatch' } & z.infer<typeof deviceDispatchSchema>)
    | { readonly kind: 'status' | 'cancel'; readonly taskId: string }
    | ({ readonly kind: 'claim' } & DeviceIdentity)
    | ({ readonly kind: 'renew' } & DeviceRun & z.infer<typeof deviceRenewSchema>)
    | ({ readonly kind: 'result' } & DeviceRun & DeviceResultSubmission)
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
  readonly result: { readonly text: string } | DeviceTextStats | null;
  readonly replayed?: boolean;
}

interface DeviceOffer {
  readonly kind: 'claimed';
  readonly taskId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly leaseExpiresAtMs: number;
  readonly deadlineAtMs: number;
  readonly version: typeof DEVICE_CAPABILITY_VERSION;
}

export type DeviceClaim =
  | { readonly kind: 'idle' }
  | (DeviceOffer &
      (
        | {
            readonly capability: typeof DEVICE_CAPABILITY;
            readonly input: z.infer<typeof textPayload>;
          }
        | {
            readonly capability: typeof DEVICE_TEXT_CAPABILITY;
            readonly input: z.infer<typeof deviceTextInputSchema>;
          }
      ));

export type DeviceExecutionResponse =
  | DeviceTaskSnapshot
  | DeviceClaim
  | { readonly kind: 'fenced' }
  | { readonly kind: 'renewed'; readonly leaseExpiresAtMs: number }
  | { readonly kind: 'committed'; readonly replayed: boolean }
  | { readonly status: 'revoked' }
  | {
      readonly deviceId: string;
      readonly capability: DeviceCapability;
      readonly version: typeof DEVICE_CAPABILITY_VERSION;
      readonly readyUntilMs: number;
    };

export interface DeviceExecutionRpc {
  deviceExecution(cmd: DeviceExecutionCommand): Promise<DeviceExecutionResponse>;
}
