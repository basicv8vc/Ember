/**
 * Edge-safe structural contracts matching Cloudflare Workers runtime primitives
 * (`SqlStorage`, `DurableObjectStorage`, `D1Database`, `Queue`) without ambient
 * global pollution or `node:*` imports.
 */

export type SqlStorageValue = ArrayBuffer | string | number | null;

export type SqlStorageRow = Record<string, SqlStorageValue>;

export interface SqlStorageCursorLike<T extends SqlStorageRow = SqlStorageRow> extends Iterable<T> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface SqlStorageLike {
  exec<T extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T>;
}

export interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike;
  transactionSync<T>(closure: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface D1MetaLike {
  readonly changes?: number;
  readonly duration?: number;
  readonly last_row_id?: number;
  readonly rows_read?: number;
  readonly rows_written?: number;
}

export interface D1ResultLike<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta?: D1MetaLike;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
  exec?(query: string): Promise<unknown>;
}

export interface QueueSendOptionsLike {
  readonly contentType?: 'text' | 'bytes' | 'json' | 'v8';
  readonly delaySeconds?: number;
}

export interface QueueLike<Body = unknown> {
  send(message: Body, options?: QueueSendOptionsLike): Promise<unknown>;
}
