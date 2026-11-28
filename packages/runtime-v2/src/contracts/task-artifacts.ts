import {
  ArtifactFilenameSchema,
  B3StagedUploadMediaTypeSchema,
  IdSchema,
  PYTHON_AGENT_LIMITS,
  TaskTitleSchema,
  type B1TaskCancelDto,
  type B1TaskDetailDto,
  type B1TaskEventPageDto,
  type B1TaskListDto,
  type B1TaskResultDto,
  type B3StagedUploadReceiptDto,
  type B3TaskArtifactsListDto,
} from '@ember/contracts';
import type { TaskStatus } from '@ember/domain';
import { z } from 'zod';
import type { AgentHeadCallerScope, ResolvedMessageAttachment } from './agent-head-rpc.js';

/**
 * Bounded inline artifact ceiling for DO SQLite storage when no R2 bucket is configured
 * (e.g. unit tests or isolated local runs without R2). Keeps SQLite rows well below
 * Cloudflare DO's 2 MiB value limit.
 */
export const V2_MAX_INLINE_ARTIFACT_BYTES = 1_048_576;

export const V2_UPLOAD_R2_KEY_PATTERN = /^v2\/uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
export const V2_ARTIFACT_R2_KEY_PATTERN =
  /^v2\/artifacts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const v2TaskIdSchema = IdSchema.transform((id) => id.toLowerCase());

/** Build the deterministic tenant-scoped R2 object key for a V2 staged upload. */
export function v2UploadR2Key(tenantId: string, uploadId: string): string {
  const tenant = v2TaskIdSchema.parse(tenantId);
  const upload = v2TaskIdSchema.parse(uploadId);
  return `v2/uploads/${tenant}/${upload}`;
}

/** Build the deterministic tenant-scoped R2 object key for a V2 run output artifact. */
export function v2ArtifactR2Key(
  tenantId: string,
  taskId: string,
  runId: string,
  artifactId: string,
): string {
  const tenant = v2TaskIdSchema.parse(tenantId);
  const task = v2TaskIdSchema.parse(taskId);
  const run = v2TaskIdSchema.parse(runId);
  const artifact = v2TaskIdSchema.parse(artifactId);
  return `v2/artifacts/${tenant}/${task}/${run}/${artifact}`;
}

export const submitPythonTaskRequestSchema = z.strictObject({
  title: TaskTitleSchema.optional(),
  prompt: z.string().trim().min(1).max(PYTHON_AGENT_LIMITS.promptMaxChars),
  instructions: z.string().trim().min(1).max(PYTHON_AGENT_LIMITS.instructionsMaxChars).optional(),
  attachment_ids: z
    .array(v2TaskIdSchema)
    .max(PYTHON_AGENT_LIMITS.maxAttachmentsPerMessage)
    .refine((ids) => new Set(ids).size === ids.length, 'attachment_ids must be unique')
    .optional(),
  client_request_id: v2TaskIdSchema.optional(),
});

export type SubmitPythonTaskRequest = z.infer<typeof submitPythonTaskRequestSchema>;

export const v2StageUploadInputSchema = z.strictObject({
  filename: ArtifactFilenameSchema,
  mediaType: B3StagedUploadMediaTypeSchema,
  contentBase64: z.string(),
});

export const v2StageUploadR2InputSchema = z.strictObject({
  id: v2TaskIdSchema,
  filename: ArtifactFilenameSchema,
  mediaType: B3StagedUploadMediaTypeSchema,
  sizeBytes: z.number().int().min(0).max(PYTHON_AGENT_LIMITS.maxFileBytes),
  sha256: z.string().regex(SHA256_HEX_PATTERN),
  r2Key: z.string().min(1).max(512),
});

export interface V2PythonTaskSubmitResultDto {
  readonly task: B1TaskDetailDto;
  readonly created: boolean;
}

export interface V2TaskArtifactDownloadDto {
  readonly artifactId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
  readonly contentBase64?: string;
  readonly r2Key?: string;
}

export interface V2TaskInputFileDto {
  readonly artifactId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentBase64?: string;
  readonly r2Key?: string;
}

export type V2TaskOutputFileInput =
  | {
      readonly filename: string;
      readonly mediaType: string;
      readonly contentBase64: string;
    }
  | {
      readonly artifactId: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly r2Key: string;
    };

export type V2StageUploadCommand =
  | {
      readonly kind: 'stage_upload';
      readonly filename: string;
      readonly mediaType: string;
      readonly contentBase64: string;
    }
  | {
      readonly kind: 'stage_upload';
      readonly uploadId: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly r2Key: string;
    };

export type TaskArtifactCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | {
        readonly kind: 'resolve_staged_uploads';
        readonly uploadIds: readonly string[];
        readonly clientSubmissionId?: string;
      }
    | V2StageUploadCommand
    | {
        readonly kind: 'submit_python_task';
        readonly input: SubmitPythonTaskRequest;
      }
    | {
        readonly kind: 'list_tasks';
        readonly status?: TaskStatus;
        readonly limit?: number;
        readonly after?: string;
      }
    | { readonly kind: 'get_task'; readonly taskId: string }
    | { readonly kind: 'list_task_events'; readonly taskId: string; readonly after?: number }
    | { readonly kind: 'get_task_result'; readonly taskId: string }
    | { readonly kind: 'cancel_task'; readonly taskId: string }
    | { readonly kind: 'list_task_artifacts'; readonly taskId: string }
    | { readonly kind: 'download_artifact'; readonly artifactId: string }
    | {
        readonly kind: 'check_artifacts_committed';
        readonly artifactIds: readonly string[];
      }
    | {
        readonly kind: 'load_task_inputs';
        readonly taskId: string;
        readonly runId: string;
        readonly leaseEpoch: number;
        readonly workerId: string;
      }
    | {
        readonly kind: 'publish_task_outputs';
        readonly taskId: string;
        readonly runId: string;
        readonly leaseEpoch: number;
        readonly workerId: string;
        readonly simulated?: boolean;
        readonly outputs: readonly V2TaskOutputFileInput[];
      }
  );

export interface V2PublishTaskOutputsResultDto {
  readonly accepted: boolean;
  readonly artifactIds: readonly string[];
}

export interface V2CheckArtifactsCommittedDto {
  readonly existingIds: readonly string[];
}

export type TaskArtifactResponse =
  | readonly ResolvedMessageAttachment[]
  | B3StagedUploadReceiptDto
  | V2PythonTaskSubmitResultDto
  | B1TaskListDto
  | B1TaskDetailDto
  | B1TaskEventPageDto
  | B1TaskResultDto
  | B1TaskCancelDto
  | B3TaskArtifactsListDto
  | V2TaskArtifactDownloadDto
  | V2CheckArtifactsCommittedDto
  | readonly V2TaskInputFileDto[]
  | V2PublishTaskOutputsResultDto
  | null;

export interface TaskArtifactRpc {
  taskArtifacts(cmd: TaskArtifactCommand): Promise<TaskArtifactResponse>;
}
