import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalBudgetLedger } from '../../packages/runtime-v2/src/global-budget/ledger.js';

import { GLOBAL_BUDGET_SCHEMA } from '../../packages/runtime-v2/src/global-budget/schema.js';

const day = '2026-11-19';
const midnight = Date.parse('2026-11-20T00:00:00Z');
const start = midnight - 10_000;
const tenantId = 'tenant-a';

describe('Global budget SQLite authority', () => {
  let db: DatabaseSync;
  let ledger: GlobalBudgetLedger;
  let now: number;
  let grantSequence: number;

  function openLedger(): GlobalBudgetLedger {
    const storage = {
      sql: {
        exec<T>(query: string, ...bindings: SQLInputValue[]) {
          if (query === GLOBAL_BUDGET_SCHEMA) {
            db.exec(query);
            return { toArray: () => [] };
          }
          const rows = db.prepare(query).all(...bindings) as T[];
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(run: () => T): T {
        db.exec('BEGIN');
        try {
          const result = run();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };

    return new GlobalBudgetLedger(
      storage,
      () => now,
      () => `grant-${++grantSequence}`,
    );
  }

  function request(
    operationId: string,
    overrides: Partial<Parameters<GlobalBudgetLedger['reserveGlobal']>[0]> = {},
  ) {
    return {
      tenantId,
      principalId: 'principal-a',
      agentId: 'agent-a',
      operationId,
      leaseEpoch: 1,
      utcDay: day,
      amountMicroUsd: 250,
      ceilingMicroUsd: 1_000,
      expiresAtMs: start + 1_000,
      ...overrides,
    };
  }

  function reserve(operationId: string, overrides: Parameters<typeof request>[1] = {}) {
    const req = request(operationId, overrides);
    const result = ledger.reserveGlobal(req);
    if (result.kind !== 'reserved') throw new Error(`Expected grant, got ${result.kind}`);
    return { tenantId: req.tenantId, operationId, globalGrantId: result.globalGrantId };
  }

  function dayTotals(utcDay = day) {
    return db
      .prepare(
        `SELECT reserved_micro_usd AS reserved, consumed_micro_usd AS consumed,
              overage_micro_usd AS overage FROM global_spend_days WHERE utc_day = ?`,
      )
      .get(utcDay);
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    now = start;
    grantSequence = 0;
    ledger = openLedger();
  });

  afterEach(() => db.close());

  it('admits no more than the daily cap and persists exact reserve replay ownership', () => {
    const first = reserve('first');
    for (let index = 0; index < 3; index += 1) reserve(`operation-${index}`);
    expect(ledger.reserveGlobal(request('extra', { ceilingMicroUsd: 5_000_000 }))).toEqual({
      kind: 'budget_exceeded',
    });
    expect(ledger.reserveGlobal(request('first'))).toEqual({
      kind: 'reserved',
      globalGrantId: first.globalGrantId,
      replayed: true,
    });

    for (const mismatch of [
      { tenantId: 'tenant-b' },
      { principalId: 'other-principal' },
      { agentId: 'other-agent' },
      { leaseEpoch: 2 },
      { utcDay: '2026-11-18' },
      { amountMicroUsd: 249 },
      { ceilingMicroUsd: 999 },
      { expiresAtMs: start + 999 },
    ]) {
      expect(ledger.reserveGlobal(request('first', mismatch))).toEqual({ kind: 'budget_exceeded' });
    }

    expect(dayTotals()).toEqual({ reserved: 1_000, consumed: 0, overage: '0' });
  });

  it('rolls back the day reservation if grant insertion fails', () => {
    reserve('first');
    grantSequence = 0;
    expect(() => ledger.reserveGlobal(request('same-grant-id'))).toThrow();
    expect(dayTotals()).toEqual({ reserved: 250, consumed: 0, overage: '0' });
    expect(db.prepare('SELECT COUNT(*) AS grants FROM global_budget_reservations').get()).toEqual({
      grants: 1,
    });
  });

  it('commits one authorization across reopen and refuses a release after an unknown send ACK', () => {
    const grant = reserve('first');
    expect(ledger.authorizeGlobalSend({ ...grant, tenantId: 'other' })).toEqual({
      authorized: false,
    });
    expect(ledger.authorizeGlobalSend(grant)).toEqual({
      authorized: true,
      startBeforeMs: start + 1_000,
    });
    ledger = openLedger();
    expect(ledger.authorizeGlobalSend(grant)).toEqual({ authorized: false });
    const release = {
      ...grant,
      settlementRevision: 0,
      state: 'released',
      reservedMicroUsd: 250,
      chargeMicroUsd: 0,
    } as const;
    expect(ledger.settleGlobal(release)).toMatchObject({ conflict: true, alreadySettled: false });
    expect(
      ledger.settleGlobal({ ...release, state: 'unknown_billed', chargeMicroUsd: 250 }),
    ).toMatchObject({ applied: true, effectiveState: 'unknown_billed' });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 250, overage: '0' });
    expect(
      ledger.settleGlobal({
        ...release,
        settlementRevision: 1,
        state: 'settled',
        chargeMicroUsd: 100,
        observedCostMicroUsd: 100,
      }),
    ).toMatchObject({ applied: false, alreadySettled: true, effectiveState: 'unknown_billed' });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 250, overage: '0' });
  });

  it('allows an owned, unexpired and unauthorized grant to be released once', () => {
    const grant = reserve('first');
    const release = {
      ...grant,
      settlementRevision: 0,
      state: 'released',
      reservedMicroUsd: 250,
      chargeMicroUsd: 0,
    } as const;
    expect(ledger.settleGlobal({ ...release, globalGrantId: 'wrong' })).toMatchObject({
      conflict: true,
      alreadySettled: false,
    });
    expect(ledger.settleGlobal({ ...release, reservedMicroUsd: 251 })).toMatchObject({
      conflict: true,
      alreadySettled: false,
    });
    expect(ledger.settleGlobal(release)).toMatchObject({
      applied: true,
      effectiveState: 'released',
    });
    expect(ledger.settleGlobal(release)).toMatchObject({ alreadySettled: true, conflict: false });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 0, overage: '0' });
    expect(ledger.authorizeGlobalSend(grant)).toEqual({ authorized: false });
    expect(ledger.reserveGlobal(request('first'))).toEqual({ kind: 'budget_exceeded' });
  });

  it('extends only a live, owned grant, then conservatively expires it at the TTL boundary', () => {
    const grant = reserve('first');
    const extended = start + 2_000;
    expect(
      ledger.renewGlobalGrant({ ...grant, globalGrantId: 'wrong', newExpiresAtMs: extended }),
    ).toEqual({ renewed: false, state: 'not_found' });
    expect(ledger.renewGlobalGrant({ ...grant, newExpiresAtMs: extended })).toEqual({
      renewed: true,
      state: 'reserved',
    });
    expect(ledger.nextExpiryAtMs()).toBe(extended);
    expect(ledger.renewGlobalGrant({ ...grant, newExpiresAtMs: start + 1_500 })).toMatchObject({
      renewed: false,
    });
    now = extended - 1;
    expect(ledger.expireDue()).toBe(0);
    now = extended;
    expect(ledger.expireDue()).toBe(1);
    expect(ledger.nextExpiryAtMs()).toBeNull();
    expect(ledger.authorizeGlobalSend(grant)).toEqual({ authorized: false });
    expect(ledger.renewGlobalGrant({ ...grant, newExpiresAtMs: extended + 1_000 })).toEqual({
      renewed: false,
      state: 'expired_consumed',
    });

    const release = {
      ...grant,
      settlementRevision: 0,
      state: 'released',
      reservedMicroUsd: 250,
      chargeMicroUsd: 0,
    } as const;
    expect(ledger.settleGlobal(release)).toMatchObject({
      applied: false,
      alreadySettled: true,
      conflict: false,
      effectiveState: 'expired_consumed',
    });
    expect(
      ledger.settleGlobal({
        ...release,
        settlementRevision: 1,
        state: 'settled',
        observedCostMicroUsd: 100,
        chargeMicroUsd: 100,
      }),
    ).toMatchObject({ applied: false, alreadySettled: true, effectiveState: 'expired_consumed' });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 250, overage: '0' });
  });

  it('bounds expiry scanning and also checks expiry inline if the alarm has not fired', () => {
    for (let index = 0; index < 101; index += 1) {
      reserve(`operation-${index}`, { amountMicroUsd: 1 });
    }
    const last = reserve('later', { amountMicroUsd: 1, expiresAtMs: start + 2_000 });
    now = start + 1_000;
    expect(ledger.expireDue()).toBe(100);
    expect(ledger.nextExpiryAtMs()).toBe(start + 1_000);
    expect(ledger.expireDue()).toBe(1);
    expect(ledger.nextExpiryAtMs()).toBe(start + 2_000);
    now = start + 2_000;
    expect(ledger.authorizeGlobalSend(last)).toEqual({ authorized: false });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 102, overage: '0' });
  });

  it('persists immutable out-of-order revisions without double charging or undoing Halt', () => {
    const grant = reserve('first');
    const pending = reserve('pending', { tenantId: 'tenant-b' });
    expect(ledger.authorizeGlobalSend(grant)).toMatchObject({ authorized: true });
    const settled = { ...grant, state: 'settled', reservedMicroUsd: 250 } as const;
    const late = {
      ...settled,
      settlementRevision: 1,
      chargeMicroUsd: 275,
      observedCostMicroUsd: 275,
    };
    const initial = {
      ...settled,
      settlementRevision: 0,
      chargeMicroUsd: 200,
      observedCostMicroUsd: 200,
    };
    expect(ledger.settleGlobal(late)).toMatchObject({ applied: true, incidentOpened: true });
    expect(ledger.settleGlobal(initial)).toMatchObject({ alreadySettled: true, conflict: false });
    expect(ledger.settleGlobal(late)).toMatchObject({
      alreadySettled: true,
      applied: false,
      conflict: false,
    });
    expect(ledger.settleGlobal({ ...late, openIncidentReason: 'usage_missing' })).toMatchObject({
      conflict: true,
      alreadySettled: false,
    });
    expect(ledger.settleGlobal({ ...initial, chargeMicroUsd: 201 })).toMatchObject({
      conflict: true,
      alreadySettled: false,
    });
    expect(ledger.reserveGlobal(request('other', { tenantId: 'tenant-c' }))).toEqual({
      kind: 'budget_halted',
      reason: 'reservation_exceeded',
    });
    expect(ledger.authorizeGlobalSend(pending)).toEqual({ authorized: false });
    expect(dayTotals()).toEqual({ reserved: 250, consumed: 275, overage: '0' });
    expect(
      db
        .prepare(
          `SELECT settlement_revision AS revision, cumulative_charge_micro_usd AS cumulative,
              delta_micro_usd AS delta FROM global_budget_settlements ORDER BY settlement_revision`,
        )
        .all(),
    ).toEqual([
      { revision: 0, cumulative: 275, delta: 0 },
      { revision: 1, cumulative: 275, delta: 275 },
    ]);
  });

  it('charges an expired grant on its original UTC day, splitting ceiling overage and halting other tenants', () => {
    const grant = reserve('original', { ceilingMicroUsd: 250 });
    expect(ledger.reserveGlobal(request('wrong-day', { utcDay: '2026-11-20' }))).toEqual({
      kind: 'budget_exceeded',
    });
    now = midnight;
    const tomorrow = reserve('tomorrow', {
      utcDay: '2026-11-20',
      tenantId: 'tenant-b',
      expiresAtMs: now + 5_000,
    });
    expect(
      ledger.settleGlobal({
        ...grant,
        settlementRevision: 1,
        state: 'settled',
        reservedMicroUsd: 250,
        chargeMicroUsd: 400,
        observedCostMicroUsd: 400,
      }),
    ).toMatchObject({ applied: true, incidentOpened: true, effectiveState: 'expired_consumed' });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 250, overage: '150' });
    expect(dayTotals('2026-11-20')).toEqual({ reserved: 250, consumed: 0, overage: '0' });
    expect(ledger.authorizeGlobalSend(tomorrow)).toEqual({ authorized: false });
    expect(
      ledger.reserveGlobal(request('new', { utcDay: '2026-11-20', expiresAtMs: now + 5_000 })),
    ).toEqual({ kind: 'budget_halted', reason: 'day_ceiling_exceeded' });
    expect(
      db
        .prepare(
          'SELECT cumulative_charge_micro_usd AS cumulative, delta_micro_usd AS delta, day_overage_delta_micro_usd AS overage FROM global_budget_settlements',
        )
        .get(),
    ).toEqual({ cumulative: 400, delta: 150, overage: 150 });
  });

  it('charges missing usage at the full hold, halts globally, and audits explicit resolution', () => {
    const grant = reserve('first');
    expect(ledger.authorizeGlobalSend(grant)).toMatchObject({ authorized: true });
    const report = {
      ...grant,
      settlementRevision: 0,
      state: 'conservative_billed',
      reservedMicroUsd: 250,
      chargeMicroUsd: 250,
    } as const;
    expect(ledger.settleGlobal(report)).toMatchObject({ incidentOpened: true });
    expect(dayTotals()).toEqual({ reserved: 0, consumed: 250, overage: '0' });
    expect(ledger.reserveGlobal(request('other', { tenantId: 'tenant-b' }))).toEqual({
      kind: 'budget_halted',
      reason: 'usage_missing',
    });
    expect(ledger.resolveIncident(1, '', 'reconciled invoice')).toBe(false);
    expect(ledger.resolveIncident(1, 'admin-a', 'reconciled invoice')).toBe(true);
    expect(ledger.resolveIncident(1, 'admin-b', 'overwrite')).toBe(false);
    expect(ledger.settleGlobal({ ...report, observedCostMicroUsd: null })).toMatchObject({
      alreadySettled: true,
      incidentOpened: false,
    });
    expect(ledger.reserveGlobal(request('other', { tenantId: 'tenant-b' }))).toMatchObject({
      kind: 'reserved',
    });
    expect(
      db.prepare('SELECT resolved_by, resolution_note FROM global_budget_incidents').get(),
    ).toEqual({ resolved_by: 'admin-a', resolution_note: 'reconciled invoice' });
  });

  it('keeps exact day overage even when the sum of safe-integer charges exceeds JS precision', () => {
    const a = reserve('a');
    const b = reserve('b');
    for (const grant of [a, b]) {
      expect(
        ledger.settleGlobal({
          ...grant,
          settlementRevision: 0,
          state: 'settled',
          reservedMicroUsd: 250,
          chargeMicroUsd: Number.MAX_SAFE_INTEGER,
          observedCostMicroUsd: Number.MAX_SAFE_INTEGER,
        }),
      ).toMatchObject({ applied: true });
    }
    expect(dayTotals()).toEqual({
      reserved: 0,
      consumed: 1_000,
      overage: (2n * BigInt(Number.MAX_SAFE_INTEGER) - 1_000n).toString(),
    });
  });
});
