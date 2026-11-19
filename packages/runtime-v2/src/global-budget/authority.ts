import { GlobalBudgetLedger } from './ledger.js';

type AlarmStorage = ConstructorParameters<typeof GlobalBudgetLedger>[0] & {
  getAlarm(): Promise<number | null>;
  setAlarm(atMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

/** Handler logic for one SQLite-backed GlobalBudgetDO namespace instance. */
export class GlobalBudgetAuthorityCore {
  private readonly ledger: GlobalBudgetLedger;

  constructor(
    private readonly storage: AlarmStorage,
    private readonly nowMs: () => number = Date.now,
    newGrantId: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.ledger = new GlobalBudgetLedger(storage, nowMs, newGrantId);
  }

  reserveGlobal(req: Parameters<GlobalBudgetLedger['reserveGlobal']>[0]) {
    return this.run(() => this.ledger.reserveGlobal(req));
  }

  authorizeGlobalSend(req: Parameters<GlobalBudgetLedger['authorizeGlobalSend']>[0]) {
    return this.run(() => this.ledger.authorizeGlobalSend(req));
  }

  renewGlobalGrant(req: Parameters<GlobalBudgetLedger['renewGlobalGrant']>[0]) {
    return this.run(() => this.ledger.renewGlobalGrant(req));
  }

  settleGlobal(req: Parameters<GlobalBudgetLedger['settleGlobal']>[0]) {
    return this.run(() => this.ledger.settleGlobal(req));
  }

  async alarm(): Promise<void> {
    await this.run(() => this.ledger.expireDue());
  }

  private async run<T>(mutate: () => T): Promise<T> {
    const armedAt = await this.storage.getAlarm();
    // DO input gating covers the read, and there is no await between the ledger
    // transaction and submitting its alarm update to the storage output gate.
    const result = mutate();
    const next = this.ledger.nextExpiryAtMs();
    if (next === null) {
      if (armedAt !== null) await this.storage.deleteAlarm();
    } else if (armedAt !== next) {
      await this.storage.setAlarm(Math.max(next, this.nowMs() + 1));
    }
    return result;
  }
}
