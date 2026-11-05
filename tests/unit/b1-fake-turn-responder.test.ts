import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { B1AssistantTurnDtoSchema, type B1AssistantTurnDto } from '@ember/contracts';
import type { B1AssistantTurnRepository } from '@ember/postgres';
import {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  B1_ASSISTANT_TURN_MODEL_LABEL,
} from '../../packages/postgres/src/repositories/b1-assistant-turn-repository.js';
import {
  createFakeTurnResponder,
  FAKE_TURN_REPLY_PREFIX,
  type FakeTurnResponderRepository,
} from '../../apps/worker/src/b1/fake-turn-responder.js';

const tenantId = randomUUID();
const conversationId = randomUUID();
const turnId = randomUUID();
const sourceMessageId = randomUUID();
const privateSource = 'a user-only secret that must never enter logs';

class MemoryTurnRepository implements FakeTurnResponderRepository {
  status: B1AssistantTurnDto['status'] = 'running';
  failureReason: B1AssistantTurnDto['failure_reason'] = null;
  responseMessageId: string | null = null;
  readonly persistedResults: Array<
    Parameters<B1AssistantTurnRepository['finishTurn']>[0]['result']
  > = [];

  listRunningTurns() {
    return Promise.resolve(this.status === 'running' ? [{ tenantId, conversationId, turnId }] : []);
  }

  getSourceMessage() {
    return Promise.resolve({
      tenantId,
      conversationId,
      turnId,
      text: privateSource,
      deadlineAt: '2026-11-05T00:01:00.000Z',
    });
  }

  getTurn(): Promise<B1AssistantTurnDto> {
    return Promise.resolve(
      B1AssistantTurnDtoSchema.parse({
        turn_id: turnId,
        conversation_id: conversationId,
        source_message_id: sourceMessageId,
        status: this.status,
        created_at: '2026-11-05T00:00:00.000Z',
        updated_at: '2026-11-05T00:00:01.000Z',
        response_message_id: this.responseMessageId,
        failure_reason: this.failureReason,
      }),
    );
  }

  finishTurn(
    command: Parameters<B1AssistantTurnRepository['finishTurn']>[0],
  ): Promise<B1AssistantTurnDto> {
    this.persistedResults.push(command.result);
    if (this.status === 'running') {
      if (command.result.status === 'completed') {
        this.status = 'completed';
        this.responseMessageId = randomUUID();
      } else {
        this.status = 'failed';
        this.failureReason = command.result.failureReason;
        this.responseMessageId = randomUUID();
      }
    }
    return this.getTurn();
  }
}

describe('fake assistant Turn responder', () => {
  it('uses deterministic local generation and persists visibly simulated metadata', async () => {
    const repository = new MemoryTurnRepository();
    const responder = createFakeTurnResponder({ repository });
    const summary = await responder.processOnce();
    const persisted = repository.persistedResults[0];

    expect(summary.completed).toBe(1);
    expect(persisted?.status).toBe('completed');
    if (persisted?.status === 'completed') {
      expect(persisted.text.startsWith(FAKE_TURN_REPLY_PREFIX)).toBe(true);
      expect(persisted.modelLabel).toBe(B1_ASSISTANT_TURN_MODEL_LABEL);
      expect(persisted.simulated).toBe(true);
      expect(persisted.text).not.toContain(privateSource);
    }
  });

  it('maps generator exceptions to a fixed internal failure without persisting diagnostics', async () => {
    const repository = new MemoryTurnRepository();
    const responder = createFakeTurnResponder({
      repository,
      generator: {
        generate() {
          return Promise.reject(new Error(`provider-style fault containing ${privateSource}`));
        },
      },
    });
    const summary = await responder.processOnce();
    const persisted = repository.persistedResults[0];

    expect(summary.failed).toBe(1);
    expect(persisted).toMatchObject({
      status: 'failed',
      failureReason: 'internal_error',
      safeMessage: 'ignored by the PostgreSQL repository',
    });
    expect(JSON.stringify(persisted)).not.toContain(privateSource);
    expect(B1_ASSISTANT_TURN_FAILURE_MESSAGE).not.toContain(privateSource);
  });

  it('drains on stop and logs only a safe category when an iteration fails', async () => {
    const warningLines: string[] = [];
    const brokenRepository: FakeTurnResponderRepository = {
      listRunningTurns() {
        return Promise.reject(new Error(`iteration fault including ${privateSource}`));
      },
      getSourceMessage() {
        return Promise.resolve(null);
      },
      getTurn() {
        return Promise.resolve(null);
      },
      finishTurn() {
        return Promise.reject(new Error('not reached'));
      },
    };
    const responder = createFakeTurnResponder({
      repository: brokenRepository,
      logger: {
        warn(message, context) {
          warningLines.push(JSON.stringify({ message, context }));
        },
      },
      sleep: async (_duration, signal) => {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const runner = responder.start();
    runner.stop();
    await runner.done;

    expect(warningLines.join('\n')).not.toContain(privateSource);
    expect(warningLines.join('\n')).toContain('"category":"error"');
  });
});
