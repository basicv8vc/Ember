export interface TurnWakeupEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly tenantId: string;
  readonly turnId: string;
}

export interface TurnWakeupQueueBinding {
  send(message: TurnWakeupEnvelope): Promise<void>;
}

export interface TurnWakeupExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface TurnWakeupLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export const TURN_WAKEUP_RETRY_DELAYS_MS = [150, 600] as const;

export interface TurnWakeupDispatcherOptions {
  readonly dispatchQueue: TurnWakeupQueueBinding | undefined;
  readonly context: TurnWakeupExecutionContext;
  readonly logger: TurnWakeupLogger;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Publish an ephemeral post-commit Queue wakeup with bounded async retries inside `waitUntil`.
 * Transient Queue send errors self-heal via Queue delivery without waiting for Cron recovery;
 * PostgreSQL outbox remains authoritative if every attempt fails or the isolate exits.
 */
export function createTurnWakeupDispatcher(options: TurnWakeupDispatcherOptions) {
  const retryDelaysMs = options.retryDelaysMs ?? TURN_WAKEUP_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return (event: { readonly tenantId: string; readonly turnId: string }): void => {
    const { dispatchQueue } = options;
    if (dispatchQueue === undefined) return;

    const envelope: TurnWakeupEnvelope = {
      schemaVersion: 1,
      eventId: event.turnId,
      tenantId: event.tenantId,
      turnId: event.turnId,
    };

    const publishWithRetry = async (): Promise<void> => {
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          await dispatchQueue.send(envelope);
          return;
        } catch {
          const delayMs = retryDelaysMs[attempt];
          if (delayMs === undefined) {
            // PostgreSQL outbox relay is authoritative; keep Queue diagnostics free of body/credentials.
            options.logger.warn('Assistant Turn Queue wake failed', {
              category: 'queue_send_failed',
            });
            return;
          }
          await sleep(delayMs);
        }
      }
    };

    try {
      options.context.waitUntil(publishWithRetry());
    } catch {
      options.logger.warn('Assistant Turn Queue wake could not be scheduled', {
        category: 'queue_send_failed',
      });
    }
  };
}
