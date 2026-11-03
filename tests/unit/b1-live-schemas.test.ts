import { describe, expect, it } from 'vitest';
import {
  B1AssistantTurnDtoSchema,
  B1ConversationMessageSchema,
  B1SendMessageRequestSchema,
  B1TaskResultDtoSchema,
} from '@ember/contracts';

const messageId = '123e4567-e89b-42d3-a456-426614174000';
const submissionId = '123e4567-e89b-42d3-a456-426614174001';
const conversationId = '123e4567-e89b-42d3-a456-426614174002';
const createdAt = '2026-11-03T00:00:00Z';

describe('B1-1 frozen live wire schemas', () => {
  const userMessage = {
    message_id: messageId,
    sequence: 1,
    kind: 'user',
    text: 'Hello Ember',
    client_submission_id: submissionId,
    created_at: createdAt,
  };

  it('accepts the declared user message and rejects client-supplied tenant identity', () => {
    expect(B1ConversationMessageSchema.safeParse(userMessage).success).toBe(true);
    expect(
      B1ConversationMessageSchema.safeParse({ ...userMessage, tenant_id: conversationId }).success,
    ).toBe(false);
  });

  it('rejects unknown kinds or additional assistant-only fields on user messages', () => {
    expect(
      B1ConversationMessageSchema.safeParse({ ...userMessage, kind: 'unknown' }).success,
    ).toBe(false);
    expect(
      B1ConversationMessageSchema.safeParse({ ...userMessage, model_label: 'forged' }).success,
    ).toBe(false);
  });

  it('rejects a stale-outbox send shape lacking a transcript epoch', () => {
    const send = { client_submission_id: submissionId, text: 'Hello' };
    expect(B1SendMessageRequestSchema.safeParse(send).success).toBe(false);
    expect(
      B1SendMessageRequestSchema.safeParse({ ...send, transcript_epoch: 0 }).success,
    ).toBe(true);
    expect(
      B1SendMessageRequestSchema.safeParse({
        ...send,
        transcript_epoch: 0,
        text: '   ',
      }).success,
    ).toBe(false);
  });

  it('rejects completed assistant turns without a response and fabricated free-text failures', () => {
    const completed = {
      turn_id: messageId,
      conversation_id: conversationId,
      source_message_id: submissionId,
      status: 'completed',
      created_at: createdAt,
      updated_at: createdAt,
      response_message_id: null,
      failure_reason: null,
    };
    expect(B1AssistantTurnDtoSchema.safeParse(completed).success).toBe(false);
    expect(
      B1AssistantTurnDtoSchema.safeParse({
        ...completed,
        response_message_id: messageId,
      }).success,
    ).toBe(true);
    expect(
      B1AssistantTurnDtoSchema.safeParse({
        ...completed,
        status: 'failed',
        failure_reason: 'provider secret:abc',
      }).success,
    ).toBe(false);
  });

  it('requires null result for pending or unavailable task results', () => {
    const base = { task_id: messageId, task_status: 'failed' };
    expect(
      B1TaskResultDtoSchema.safeParse({
        ...base,
        result_state: 'unavailable',
        result: null,
      }).success,
    ).toBe(true);
    expect(
      B1TaskResultDtoSchema.safeParse({
        ...base,
        result_state: 'unavailable',
        result: {},
      }).success,
    ).toBe(false);
  });
});
