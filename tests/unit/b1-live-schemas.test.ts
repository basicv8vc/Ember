import { describe, expect, it } from 'vitest';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationMessageSchema,
  B1ConversationPageSchema,
  B1MeResponseSchema,
  B1MessageSubmissionReconciliationDtoSchema,
  B1SendMessageReceiptSchema,
  B1SendMessageRequestSchema,
  B1SessionRequestSchema,
  B1SessionResponseSchema,
  B1TaskCancelDtoSchema,
  B1TaskDetailDtoSchema,
  B1TaskEventPageDtoSchema,
  B1TaskListDtoSchema,
  B1TaskResultDtoSchema,
  B1TaskSummaryDtoSchema,
} from '@ember/contracts';

const id = '123e4567-e89b-42d3-a456-426614174000';
const submissionId = '123e4567-e89b-42d3-a456-426614174001';
const conversationId = '123e4567-e89b-42d3-a456-426614174002';
const taskId = '123e4567-e89b-42d3-a456-426614174003';
const commitmentId = '123e4567-e89b-42d3-a456-426614174004';
const createdAt = '2026-11-03T00:00:00Z';

const baseMessage = { message_id: id, sequence: 1, created_at: createdAt };
const userMessage = {
  ...baseMessage,
  kind: 'user',
  text: 'Hello Ember',
  client_submission_id: submissionId,
};

describe('B1-1 frozen live wire schemas', () => {
  describe('session and bootstrap DTOs', () => {
    it('accepts only the declared session request and rejects caller identity fields', () => {
      const request = { provider: 'apple', identity_token: 'signed-token', nonce: 'nonce' };
      expect(B1SessionRequestSchema.safeParse(request).success).toBe(true);
      expect(B1SessionRequestSchema.safeParse({ ...request, provider: 'dev' }).success).toBe(true);
      expect(B1SessionRequestSchema.safeParse({ ...request, provider: 'google' }).success).toBe(
        false,
      );
      expect(B1SessionRequestSchema.safeParse({ ...request, identity_token: '' }).success).toBe(
        false,
      );
      expect(B1SessionRequestSchema.safeParse({ ...request, nonce: undefined }).success).toBe(
        false,
      );
      const missingIdentityToken = { provider: request.provider, nonce: request.nonce };
      expect(B1SessionRequestSchema.safeParse(missingIdentityToken).success).toBe(false);
      expect(B1SessionRequestSchema.safeParse({ ...request, tenant_id: id }).success).toBe(false);
      expect(B1SessionRequestSchema.safeParse({ ...request, principal_id: id }).success).toBe(
        false,
      );
      expect(B1SessionRequestSchema.safeParse({ ...request, policy_version: 1 }).success).toBe(
        false,
      );
    });

    it('validates the session response fields and refuses internal identity fields', () => {
      const response = {
        session_id: id,
        consumer_id: submissionId,
        access_token: 'ems_opaque-token',
        expires_at: createdAt,
      };
      expect(B1SessionResponseSchema.safeParse(response).success).toBe(true);
      expect(B1SessionResponseSchema.safeParse({ ...response, session_id: 'bad-id' }).success).toBe(
        false,
      );
      expect(
        B1SessionResponseSchema.safeParse({ ...response, access_token: 'bad-token' }).success,
      ).toBe(false);
      expect(B1SessionResponseSchema.safeParse({ ...response, tenant_id: id }).success).toBe(false);
      expect(B1SessionResponseSchema.safeParse({ ...response, principal_id: id }).success).toBe(
        false,
      );
      expect(B1SessionResponseSchema.safeParse({ ...response, policy_version: 1 }).success).toBe(
        false,
      );
      const missingExpiresAt = {
        session_id: response.session_id,
        consumer_id: response.consumer_id,
        access_token: response.access_token,
      };
      expect(B1SessionResponseSchema.safeParse(missingExpiresAt).success).toBe(false);
    });

    it('validates GET /v1/me and rejects unexpected identity properties at every level', () => {
      const response = {
        consumer_id: id,
        agent: { agent_id: submissionId, display_name: 'Ember' },
        conversation: {
          conversation_id: conversationId,
          transcript_epoch: 0,
          created_at: createdAt,
          updated_at: createdAt,
        },
      };
      expect(B1MeResponseSchema.safeParse(response).success).toBe(true);
      expect(
        B1MeResponseSchema.safeParse({
          ...response,
          conversation: { ...response.conversation, transcript_epoch: -1 },
        }).success,
      ).toBe(false);
      expect(B1MeResponseSchema.safeParse({ ...response, tenant_id: id }).success).toBe(false);
      expect(
        B1MeResponseSchema.safeParse({
          ...response,
          agent: { ...response.agent, principal_id: id },
        }).success,
      ).toBe(false);
    });
  });

  describe('closed conversation message union', () => {
    it('accepts each declared message variant with only its own body fields', () => {
      const messages = [
        userMessage,
        {
          ...baseMessage,
          sequence: 2,
          kind: 'ember',
          text: 'A simulated reply',
          model_label: 'ember-fake-llm-1',
          simulated: true,
        },
        {
          ...baseMessage,
          sequence: 3,
          kind: 'activity',
          text: 'A factual update',
          source: 'platform',
        },
        { ...baseMessage, sequence: 4, kind: 'task_reference', task_id: taskId },
        {
          ...baseMessage,
          sequence: 5,
          kind: 'commitment_reference',
          commitment_id: commitmentId,
        },
        {
          ...baseMessage,
          sequence: 6,
          kind: 'outcome_reference',
          outcome: { outcome_kind: 'meaningful_change', task_id: taskId, commitment_id: null },
        },
      ];

      for (const message of messages) {
        expect(B1ConversationMessageSchema.safeParse(message).success).toBe(true);
      }
    });

    it('rejects unknown kinds, invalid enums, forged body fields, and client identity', () => {
      expect(
        B1ConversationMessageSchema.safeParse({ ...userMessage, kind: 'unknown' }).success,
      ).toBe(false);
      expect(
        B1ConversationMessageSchema.safeParse({ ...userMessage, model_label: 'forged' }).success,
      ).toBe(false);
      expect(B1ConversationMessageSchema.safeParse({ ...userMessage, tenant_id: id }).success).toBe(
        false,
      );
      expect(
        B1ConversationMessageSchema.safeParse({ ...userMessage, principal_id: id }).success,
      ).toBe(false);
      expect(
        B1ConversationMessageSchema.safeParse({
          ...baseMessage,
          kind: 'outcome_reference',
          outcome: { outcome_kind: 'unknown', task_id: taskId, commitment_id: null },
        }).success,
      ).toBe(false);
      const missingSubmissionId = {
        message_id: id,
        sequence: 1,
        kind: 'user',
        text: 'Hello Ember',
        created_at: createdAt,
      };
      expect(B1ConversationMessageSchema.safeParse(missingSubmissionId).success).toBe(false);
      expect(
        B1ConversationMessageSchema.safeParse({
          ...baseMessage,
          kind: 'task_reference',
          task_id: 'not-a-uuid',
        }).success,
      ).toBe(false);
    });

    it('requires UUID identifiers, UUID v4 submission IDs, and positive integer sequence values', () => {
      expect(
        B1ConversationMessageSchema.safeParse({ ...userMessage, message_id: 'bad-id' }).success,
      ).toBe(false);
      expect(
        B1ConversationMessageSchema.safeParse({
          ...userMessage,
          client_submission_id: '123e4567-e89b-12d3-a456-426614174001',
        }).success,
      ).toBe(false);
      expect(B1ConversationMessageSchema.safeParse({ ...userMessage, sequence: 0 }).success).toBe(
        false,
      );
      expect(B1ConversationMessageSchema.safeParse({ ...userMessage, sequence: 1.5 }).success).toBe(
        false,
      );
    });
  });

  describe('message submission and unknown-ACK recovery', () => {
    it('requires the v4 submission ID and current transcript epoch on every send', () => {
      const request = {
        client_submission_id: submissionId,
        text: 'Hello',
        transcript_epoch: 0,
        client_created_at: createdAt,
      };
      expect(B1SendMessageRequestSchema.safeParse(request).success).toBe(true);
      expect(
        B1SendMessageRequestSchema.safeParse({
          client_submission_id: submissionId,
          text: 'Hello',
        }).success,
      ).toBe(false);
      expect(
        B1SendMessageRequestSchema.safeParse({ ...request, client_created_at: 'yesterday' })
          .success,
      ).toBe(false);
      expect(
        B1SendMessageRequestSchema.safeParse({ ...request, transcript_epoch: -1 }).success,
      ).toBe(false);
      expect(
        B1SendMessageRequestSchema.safeParse({ ...request, transcript_epoch: 0.5 }).success,
      ).toBe(false);
      expect(B1SendMessageRequestSchema.safeParse({ ...request, text: '   ' }).success).toBe(false);
      expect(
        B1SendMessageRequestSchema.safeParse({
          ...request,
          client_submission_id: '123e4567-e89b-12d3-a456-426614174001',
        }).success,
      ).toBe(false);
      expect(B1SendMessageRequestSchema.safeParse({ ...request, tenant_id: id }).success).toBe(
        false,
      );
      expect(B1SendMessageRequestSchema.safeParse({ ...request, principal_id: id }).success).toBe(
        false,
      );
    });

    it('uses the exact POST receipt shape for reconciliation after an unknown ACK', () => {
      const receipt = {
        message: { ...userMessage, conversation_id: conversationId },
        turn: { turn_id: taskId, status: 'running', created_at: createdAt },
        transcript_epoch: 3,
      };
      expect(B1SendMessageReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(B1MessageSubmissionReconciliationDtoSchema.safeParse(receipt).success).toBe(true);
      expect(
        B1MessageSubmissionReconciliationDtoSchema.safeParse({
          ...receipt,
          replayed: true,
        }).success,
      ).toBe(false);
      expect(
        B1MessageSubmissionReconciliationDtoSchema.safeParse({
          ...receipt,
          message: { ...receipt.message, tenant_id: id },
        }).success,
      ).toBe(false);
      expect(
        B1MessageSubmissionReconciliationDtoSchema.safeParse({
          ...receipt,
          turn: { ...receipt.turn, status: 'completed' },
        }).success,
      ).toBe(false);
    });
  });

  describe('conversation pages', () => {
    const page = {
      conversation_id: conversationId,
      transcript_epoch: 0,
      messages: [
        userMessage,
        { ...baseMessage, sequence: 2, kind: 'task_reference', task_id: taskId },
      ],
      next_after: 2,
      has_more: false,
    };

    it('accepts ascending pages and empty recovery pages', () => {
      expect(B1ConversationPageSchema.safeParse(page).success).toBe(true);
      expect(
        B1ConversationPageSchema.safeParse({ ...page, messages: [], next_after: 8 }).success,
      ).toBe(true);
    });

    it('rejects nonascending rows, a mismatched cursor and additional identity fields', () => {
      expect(
        B1ConversationPageSchema.safeParse({
          ...page,
          messages: [page.messages[1], page.messages[0]],
          next_after: 1,
        }).success,
      ).toBe(false);
      expect(B1ConversationPageSchema.safeParse({ ...page, next_after: 7 }).success).toBe(false);
      expect(B1ConversationPageSchema.safeParse({ ...page, tenant_id: id }).success).toBe(false);
    });
  });

  describe('assistant turn state consistency', () => {
    const turn = {
      turn_id: id,
      conversation_id: conversationId,
      source_message_id: submissionId,
      created_at: createdAt,
      updated_at: createdAt,
      response_message_id: null,
      failure_reason: null,
    };

    it('accepts each state with its required response and failure fields', () => {
      expect(B1AssistantTurnDtoSchema.safeParse({ ...turn, status: 'running' }).success).toBe(true);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'completed',
          response_message_id: taskId,
        }).success,
      ).toBe(true);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'failed',
          response_message_id: taskId,
          failure_reason: 'timeout',
        }).success,
      ).toBe(true);
      expect(B1AssistantTurnDtoSchema.safeParse({ ...turn, status: 'cancelled' }).success).toBe(
        true,
      );
    });

    it('rejects missing, contradictory, malformed and unexpected state fields', () => {
      expect(B1AssistantTurnDtoSchema.safeParse({ ...turn, status: 'completed' }).success).toBe(
        false,
      );
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'running',
          response_message_id: taskId,
        }).success,
      ).toBe(false);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'completed',
          response_message_id: taskId,
          failure_reason: 'timeout',
        }).success,
      ).toBe(false);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'failed',
          failure_reason: 'timeout',
        }).success,
      ).toBe(false);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'failed',
          response_message_id: taskId,
        }).success,
      ).toBe(false);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'failed',
          response_message_id: taskId,
          failure_reason: 'provider-secret',
        }).success,
      ).toBe(false);
      expect(
        B1AssistantTurnDtoSchema.safeParse({
          ...turn,
          status: 'cancelled',
          failure_reason: 'timeout',
        }).success,
      ).toBe(false);
      expect(B1AssistantTurnDtoSchema.safeParse({ ...turn, status: 'streaming' }).success).toBe(
        false,
      );
      expect(B1AssistantTurnDtoSchema.safeParse({ ...turn, tenant_id: id }).success).toBe(false);
    });
  });

  describe('task result state consistency', () => {
    const result = {
      summary_text: 'A short summary',
      detail_text: null,
      model_label: 'ember-fake-llm-1',
      simulated: true,
      produced_at: createdAt,
    };

    it('matches pending to nonterminal status and other states to terminal status', () => {
      for (const task_status of ['queued', 'running', 'waiting_approval', 'retryable_failed']) {
        expect(
          B1TaskResultDtoSchema.safeParse({
            task_id: id,
            task_status,
            result_state: 'pending',
            result: null,
          }).success,
        ).toBe(true);
      }
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'completed',
          result_state: 'available',
          result,
        }).success,
      ).toBe(true);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'failed',
          result_state: 'unavailable',
          result: null,
        }).success,
      ).toBe(true);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'cancelled',
          result_state: 'unavailable',
          result: null,
        }).success,
      ).toBe(true);
    });

    it('rejects contradictory states, invalid enums, malformed IDs and unexpected properties', () => {
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'failed',
          result_state: 'pending',
          result: null,
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'running',
          result_state: 'available',
          result,
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'running',
          result_state: 'unavailable',
          result: null,
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'unknown',
          result_state: 'pending',
          result: null,
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: 'bad-id',
          task_status: 'queued',
          result_state: 'pending',
          result: null,
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'completed',
          result_state: 'unavailable',
          result: {},
        }).success,
      ).toBe(false);
      expect(
        B1TaskResultDtoSchema.safeParse({
          task_id: id,
          task_status: 'completed',
          result_state: 'available',
          result: { ...result, principal_id: id },
        }).success,
      ).toBe(false);
    });
  });

  describe('B3/iOS-aligned task list, detail, events and cancel DTOs', () => {
    const taskSummary = {
      task_id: taskId,
      agent_id: submissionId,
      kind: 'notes.action_items',
      title: 'Meeting Notes',
      status: 'running',
      current_run_id: commitmentId,
      attempt_count: 1,
      cancel_requested: false,
      created_at: createdAt,
      updated_at: createdAt,
      deadline_at: createdAt,
    };

    it('validates B1TaskSummaryDtoSchema and B1TaskDetailDtoSchema without embedded result fields', () => {
      expect(B1TaskSummaryDtoSchema.safeParse(taskSummary).success).toBe(true);
      expect(B1TaskDetailDtoSchema.safeParse(taskSummary).success).toBe(true);
      expect(
        B1TaskDetailDtoSchema.safeParse({
          ...taskSummary,
          title: null,
          current_run_id: null,
          deadline_at: null,
        }).success,
      ).toBe(true);

      // Detail/Summary must not embed result/result_state or leak tenant_id.
      expect(
        B1TaskDetailDtoSchema.safeParse({ ...taskSummary, result_state: 'pending' }).success,
      ).toBe(false);
      expect(B1TaskDetailDtoSchema.safeParse({ ...taskSummary, tenant_id: id }).success).toBe(
        false,
      );
    });

    it('validates B1TaskListDtoSchema pagination cursor fields and rejects missing cursor metadata', () => {
      expect(
        B1TaskListDtoSchema.safeParse({
          tasks: [taskSummary],
          next_after: 'MjAyNi0xMS0xNVQwMDowMDowMC4wMDAwMDBafDEyMw',
          has_more: true,
        }).success,
      ).toBe(true);
      expect(
        B1TaskListDtoSchema.safeParse({
          tasks: [],
          next_after: null,
          has_more: false,
        }).success,
      ).toBe(true);
      expect(B1TaskListDtoSchema.safeParse({ tasks: [taskSummary] }).success).toBe(false);
      expect(
        B1TaskListDtoSchema.safeParse({ tasks: [], next_after: '', has_more: false }).success,
      ).toBe(false);
    });

    it('validates B1TaskEventPageDtoSchema and B1TaskCancelDtoSchema', () => {
      expect(
        B1TaskEventPageDtoSchema.safeParse({
          task_id: taskId,
          events: [
            {
              task_id: taskId,
              sequence: 1,
              phase: 'accepted',
              occurred_at: createdAt,
              trace_id: submissionId,
              payload: {},
            },
          ],
        }).success,
      ).toBe(true);
      expect(
        B1TaskEventPageDtoSchema.safeParse({
          task_id: taskId,
          events: [],
          extra: true,
        }).success,
      ).toBe(false);

      expect(
        B1TaskCancelDtoSchema.safeParse({
          task_id: taskId,
          status: 'running',
          cancel_requested: true,
          cancel_requested_at: createdAt,
          terminal: false,
          updated_at: createdAt,
        }).success,
      ).toBe(true);
      expect(
        B1TaskCancelDtoSchema.safeParse({
          task_id: taskId,
          status: 'cancelled',
          cancel_requested: true,
          cancel_requested_at: null,
          terminal: true,
          updated_at: createdAt,
        }).success,
      ).toBe(true);
      expect(
        B1TaskCancelDtoSchema.safeParse({
          task_id: taskId,
          status: 'cancelled',
          cancel_requested: true,
          cancel_requested_at: createdAt,
          terminal: true,
          updated_at: createdAt,
          tenant_id: id,
        }).success,
      ).toBe(false);
    });
  });
});
