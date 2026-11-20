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
import type { AgentHeadCallerScope } from './agent-head-rpc.js';

/**
 * Bounded inline artifact ceiling for DO SQLite storage in local/isolated V2.
 * Keeps SQLite rows well below Cloudflare DO's 2 MiB value limit while supporting
 * CSV/JSON/Markdown/text datasets and reports without requiring an R2 binding.
 */
export const V2_MAX_INLINE_ARTIFACT_BYTES = 1_048_576;

export const v2TaskIdSchema = IdSchema.transform((id) => id.toLowerCase());

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
  readonly contentBase64: string;
}

export interface V2TaskInputFileDto {
  readonly artifactId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface V2TaskOutputFileInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export interface V2PublishTaskOutputsResultDto {
  readonly accepted: boolean;
  readonly artifactIds: readonly string[];
}

export type TaskArtifactCommand = Omit<AgentHeadCallerScope, 'policyVersion'> &
  (
    | {
        readonly kind: 'stage_upload';
        readonly filename: string;
        readonly mediaType: string;
        readonly contentBase64: string;
      }
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
        readonly outputs: readonly V2TaskOutputFileInput[];
      }
  );

export type TaskArtifactResponse =
  | B3StagedUploadReceiptDto
  | V2PythonTaskSubmitResultDto
  | B1TaskListDto
  | B1TaskDetailDto
  | B1TaskEventPageDto
  | B1TaskResultDto
  | B1TaskCancelDto
  | B3TaskArtifactsListDto
  | V2TaskArtifactDownloadDto
  | readonly V2TaskInputFileDto[]
  | V2PublishTaskOutputsResultDto
  | null;

export interface TaskArtifactRpc {
  taskArtifacts(cmd: TaskArtifactCommand): Promise<TaskArtifactResponse>;
}
