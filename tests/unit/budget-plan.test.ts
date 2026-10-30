import { describe, expect, it } from 'vitest';
import {
  SIMULATED_STEP_COSTS,
  stepCost,
  stepOperationId,
  type BudgetedStep,
} from '../../apps/worker/src/budget-plan.js';

/**
 * B08b-D2 — the simulated cost table and the stable budget operation id.
 *
 * These two functions are the only place the Worker decides *what* a step costs and *which*
 * durable charge it belongs to, so they are pinned exactly: a Task payload must never be able
 * to influence either value.
 */

const DIGEST = 'a3f1c9d2e4b5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f';

describe('simulated step costs', () => {
  it('pins the reviewed amounts', () => {
    expect(SIMULATED_STEP_COSTS).toEqual({
      produce: { steps: 1, units: 5, elapsedMs: 50, concurrencySlots: 1 },
      publish: { steps: 1, units: 1, elapsedMs: 10, concurrencySlots: 1 },
    });
  });

  it('is deeply frozen so a caller cannot scale its own charge down', () => {
    expect(Object.isFrozen(SIMULATED_STEP_COSTS)).toBe(true);
    expect(Object.isFrozen(SIMULATED_STEP_COSTS.produce)).toBe(true);
    expect(Object.isFrozen(SIMULATED_STEP_COSTS.publish)).toBe(true);
    expect(Object.isFrozen(stepCost('produce'))).toBe(true);
  });

  it('reports every amount as a non-negative safe integer with at most one slot', () => {
    const steps: BudgetedStep[] = ['produce', 'publish'];

    for (const step of steps) {
      const cost = stepCost(step);

      for (const value of Object.values(cost)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }

      expect(cost.concurrencySlots).toBeLessThanOrEqual(1);
    }
  });
});

describe('step operation ids', () => {
  it('is deterministic for the same step, input and epoch', () => {
    expect(stepOperationId('produce', DIGEST, 3)).toBe(stepOperationId('produce', DIGEST, 3));
  });

  it('truncates the digest to a fixed width', () => {
    expect(stepOperationId('produce', DIGEST, 1)).toBe('step:produce:a3f1c9d2e4b5f607:1');
  });

  it('separates steps, inputs and lease epochs', () => {
    const base = stepOperationId('produce', DIGEST, 1);

    expect(stepOperationId('publish', DIGEST, 1)).not.toBe(base);
    // Only the first 16 hex characters of the digest are part of the id.
    expect(stepOperationId('produce', `b${DIGEST.slice(1)}`, 1)).not.toBe(base);
    // A re-claimed Run re-executes the step, so its retry is charged on its own account.
    expect(stepOperationId('produce', DIGEST, 2)).not.toBe(base);
  });

  it('carries no UTC day, so a replay after midnight is still the same charge', () => {
    const id = stepOperationId('publish', DIGEST, 7);

    expect(id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Recomputing it on another day cannot produce a different id: the signature has no
    // clock, no day and no randomness.
    expect(stepOperationId('publish', DIGEST, 7)).toBe(id);
  });

  it('stays inside the persisted operation_id constraint', () => {
    // Same expression as the CHECK in migrations/0006_p0b08b_persistent_budget.sql.
    const persisted = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

    for (const step of ['produce', 'publish'] as const) {
      for (const epoch of [0, 1, 9007199254740991]) {
        const id = stepOperationId(step, DIGEST, epoch);

        expect(id.length).toBeLessThanOrEqual(128);
        expect(persisted.test(id)).toBe(true);
      }
    }
  });
});
