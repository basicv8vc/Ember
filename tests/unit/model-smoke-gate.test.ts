import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOKE_PROMPT,
  MAX_SMOKE_TURNS,
  buildEvidence,
  evaluateSmokePreconditions,
  parseSmokeArgs,
  type SmokePlan,
  type SmokePreconditions,
} from '../../apps/cli/src/model-smoke/cli.js';

/**
 * The paid smoke gate, tested without a database, a credential or a network.
 *
 * Every case below is a way an operator could accidentally spend money: pointing the command at a
 * deployment that is not real, forgetting to restate the approval id, asking for more turns than
 * were authorised, or confirming by accident. Each one must refuse *before* a connection is opened.
 */

const PLAN: SmokePlan = {
  approvalId: 'L4B-A1',
  providerId: 'openai',
  modelId: 'gpt-5.6-luna',
  rateVersion: 'openai-gpt-5.6-luna-published-2026-11-10',
  maxTurns: 1,
  database: 'postgres:5432/ember',
};

function preconditions(overrides: Partial<SmokePreconditions> = {}): SmokePreconditions {
  return {
    modelMode: 'real',
    modelId: 'gpt-5.6-luna',
    providerId: 'openai',
    rateVersion: 'openai-gpt-5.6-luna-published-2026-11-10',
    approvalIdFromConfig: 'L4B-A1',
    approvalIdFromEnv: 'L4B-A1',
    maxTurns: 1,
    confirmed: true,
    ...overrides,
  };
}

describe('paid smoke gate', () => {
  it('passes only when the mode is real, the id matches and the run was confirmed', () => {
    expect(evaluateSmokePreconditions(preconditions())).toStrictEqual({
      ok: true,
      approvalId: 'L4B-A1',
    });
  });

  it.each([
    ['disabled', 'approval_not_real'],
    ['fake', 'approval_not_real'],
  ] as const)('refuses when model execution resolved as %s', (mode, refusal) => {
    expect(evaluateSmokePreconditions(preconditions({ modelMode: mode }))).toStrictEqual({
      ok: false,
      refusal,
    });
  });

  it('refuses without a restated approval id', () => {
    for (const value of [undefined, '', '   ']) {
      expect(evaluateSmokePreconditions(preconditions({ approvalIdFromEnv: value }))).toStrictEqual(
        { ok: false, refusal: 'approval_missing' },
      );
    }
  });

  it('refuses an approval id that is not the one recorded for the model', () => {
    expect(
      evaluateSmokePreconditions(preconditions({ approvalIdFromEnv: 'L4B-A2' })),
    ).toStrictEqual({ ok: false, refusal: 'approval_mismatch' });

    expect(evaluateSmokePreconditions(preconditions({ approvalIdFromConfig: null }))).toStrictEqual(
      { ok: false, refusal: 'approval_mismatch' },
    );
  });

  it('refuses a turn count outside the authorised range', () => {
    for (const maxTurns of [0, -1, MAX_SMOKE_TURNS + 1, 1.5]) {
      expect(evaluateSmokePreconditions(preconditions({ maxTurns }))).toStrictEqual({
        ok: false,
        refusal: 'max_turns_invalid',
      });
    }

    expect(evaluateSmokePreconditions(preconditions({ maxTurns: MAX_SMOKE_TURNS })).ok).toBe(true);
  });

  it('refuses to spend without an explicit confirmation', () => {
    expect(evaluateSmokePreconditions(preconditions({ confirmed: false }))).toStrictEqual({
      ok: false,
      refusal: 'not_confirmed',
    });
  });

  it('reports the most fundamental refusal first', () => {
    const everythingWrong = evaluateSmokePreconditions({
      modelMode: 'disabled',
      modelId: null,
      providerId: 'openai',
      rateVersion: null,
      approvalIdFromConfig: null,
      approvalIdFromEnv: undefined,
      maxTurns: 99,
      confirmed: false,
    });

    expect(everythingWrong).toStrictEqual({ ok: false, refusal: 'approval_not_real' });
  });
});

describe('paid smoke arguments', () => {
  it('defaults to one turn, no confirmation and a fixed prompt', () => {
    const args = parseSmokeArgs([]);

    expect(args.maxTurns).toBe(1);
    expect(args.confirm).toBe(false);
    expect(args.evidencePath).toBeNull();
    expect(args.text).toBe(DEFAULT_SMOKE_PROMPT);
  });

  it('reads an explicit turn count, prompt and evidence path', () => {
    const args = parseSmokeArgs([
      '--max-turns=1',
      '--confirm',
      '--text=hello',
      '--evidence=/tmp/e.json',
    ]);

    expect(args).toStrictEqual({
      confirm: true,
      maxTurns: 1,
      text: 'hello',
      evidencePath: '/tmp/e.json',
    });
  });
});

describe('paid smoke evidence', () => {
  const base = {
    startedAt: new Date('2026-11-08T00:00:00Z'),
    finishedAt: new Date('2026-11-08T00:00:04Z'),
    plan: PLAN,
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    summary: { completed: 1 },
    turn: { status: 'completed', failureReason: null, responseMessageId: 'message-1' },
    reply: { messageId: 'message-1', modelLabel: PLAN.modelId, simulated: false, characters: 42 },
    attempt: {
      attemptNo: 1,
      state: 'settled',
      outcomeCode: 'ok',
      reservedMicroUsd: '1115',
      appliedCostMicroUsd: '118',
      observedCostMicroUsd: '118',
      inputTokens: '402',
      outputTokens: '17',
    },
  } as const;

  it('passes a complete, non-simulated, settled observation', () => {
    const evidence = buildEvidence(base);

    expect(evidence.verdict).toBe('pass');
    expect(evidence.reasons).toEqual([]);
    // Content-free: no prompt, no reply text, no credential.
    expect(JSON.stringify(evidence)).not.toContain('hello');
  });

  it.each([
    ['a simulated reply', { reply: { ...base.reply, simulated: true } }, 'marked simulated'],
    [
      'a reply labelled with another model',
      { reply: { ...base.reply, modelLabel: 'gpt-other' } },
      'pinned model id',
    ],
    ['an empty reply', { reply: { ...base.reply, characters: 0 } }, 'empty'],
    ['no reply row', { reply: null }, 'no Ember reply row'],
    [
      'an unsettled attempt',
      { attempt: { ...base.attempt, state: 'unknown_billed' } },
      'settled as unknown_billed',
    ],
    ['no attempt row', { attempt: null }, 'no attempt row'],
    ['a failed turn', { turn: { ...base.turn, status: 'failed' } }, 'status is failed'],
    ['a responder that did nothing', { summary: { completed: 0 } }, 'exactly one completed'],
  ])('fails the verdict on %s', (_label, override, expectedReason) => {
    const evidence = buildEvidence({ ...base, ...override });

    expect(evidence.verdict).toBe('fail');
    expect(evidence.reasons.join(' ')).toContain(expectedReason);
  });
});
