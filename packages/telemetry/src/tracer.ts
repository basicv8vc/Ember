import { randomBytes } from 'node:crypto';
import { sanitizeContext, sanitizeValue } from './privacy.js';
import { SpanRecordSchema } from './schemas.js';
import type {
  SpanAttributes,
  SpanAttributeValue,
  SpanEvent,
  SpanKind,
  SpanRecord,
  SpanStatus,
  SpanStatusCode,
} from './types.js';

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface SpanOptions {
  readonly traceId?: string;
  readonly parentSpanId?: string | null;
  readonly kind?: SpanKind;
  readonly attributes?: Record<string, unknown>;
  readonly startTime?: Date;
}

export interface SpanExporter {
  export(spans: readonly SpanRecord[]): void;
}

/**
 * OpenTelemetry-style Local Span representation.
 */
export class LocalSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly kind: SpanKind;
  readonly name: string;
  private readonly startTime: Date;
  private endTime: Date | null = null;
  private status: SpanStatus = { code: 'UNSET' };
  private attributes: Record<string, SpanAttributeValue> = {};
  private readonly events: SpanEvent[] = [];
  private ended = false;
  private readonly onEnd?: (span: SpanRecord) => void;

  constructor(name: string, options: SpanOptions = {}, onEnd?: (span: SpanRecord) => void) {
    this.name = name;
    this.traceId = options.traceId ?? generateTraceId();
    this.spanId = generateSpanId();
    this.parentSpanId = options.parentSpanId ?? null;
    this.kind = options.kind ?? 'INTERNAL';
    this.startTime = options.startTime ?? new Date();
    this.onEnd = onEnd;

    if (options.attributes) {
      this.setAttributes(options.attributes);
    }
  }

  isRecording(): boolean {
    return !this.ended;
  }

  setAttribute(key: string, value: unknown): this {
    if (this.ended) {
      return this;
    }
    const sanitized = sanitizeValue(value, key);
    if (
      typeof sanitized === 'string' ||
      typeof sanitized === 'number' ||
      typeof sanitized === 'boolean'
    ) {
      this.attributes[key] = sanitized;
    } else if (Array.isArray(sanitized)) {
      this.attributes[key] = sanitized.map((item) => String(item));
    }
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    if (this.ended) {
      return this;
    }
    const sanitized = sanitizeContext(attributes);
    for (const [key, value] of Object.entries(sanitized)) {
      this.setAttribute(key, value);
    }
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>, time?: Date): this {
    if (this.ended) {
      return this;
    }
    const sanitizedAttrs = attributes ? (sanitizeContext(attributes) as SpanAttributes) : undefined;
    this.events.push({
      name,
      time: (time ?? new Date()).toISOString(),
      attributes: sanitizedAttrs,
    });
    return this;
  }

  setStatus(code: SpanStatusCode, description?: string): this {
    if (this.ended) {
      return this;
    }
    this.status = { code, description };
    return this;
  }

  recordException(error: unknown): this {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;

    this.setStatus('ERROR', code ?? message);
    this.addEvent('exception', {
      'exception.type': error instanceof Error ? error.name : 'UnknownError',
      'exception.message': message,
      ...(code ? { 'exception.code': code } : {}),
    });
    return this;
  }

  end(endTime?: Date): SpanRecord {
    if (this.ended) {
      return this.toRecord();
    }
    this.ended = true;
    this.endTime = endTime ?? new Date();

    if (this.status.code === 'UNSET') {
      this.status = { code: 'OK' };
    }

    const record = this.toRecord();
    if (this.onEnd) {
      this.onEnd(record);
    }
    return record;
  }

  toRecord(): SpanRecord {
    const end = this.endTime ?? new Date();
    const durationMs = Math.max(0, end.getTime() - this.startTime.getTime());

    const candidate: SpanRecord = {
      name: this.name,
      trace_id: this.traceId,
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      kind: this.kind,
      start_time: this.startTime.toISOString(),
      end_time: end.toISOString(),
      duration_ms: durationMs,
      status: this.status,
      attributes: { ...this.attributes },
      events: [...this.events],
    };

    return SpanRecordSchema.parse(candidate);
  }
}

/**
 * In-memory Span Exporter useful for unit and integration testing without cloud services.
 */
export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: SpanRecord[] = [];

  export(spans: readonly SpanRecord[]): void {
    this.spans.push(...spans);
  }

  getFinishedSpans(): readonly SpanRecord[] {
    return [...this.spans];
  }

  findByName(name: string): readonly SpanRecord[] {
    return this.spans.filter((s) => s.name === name);
  }

  findByTraceId(traceId: string): readonly SpanRecord[] {
    return this.spans.filter((s) => s.trace_id === traceId);
  }

  clear(): void {
    this.spans.length = 0;
  }
}

/**
 * Local JSON Line Span Exporter (OpenTelemetry-style JSON lines to stdout or test sink).
 */
export class JsonLineSpanExporter implements SpanExporter {
  private readonly sink: (line: string) => void;

  constructor(sink?: (line: string) => void) {
    this.sink =
      sink ??
      ((line: string) => {
        process.stdout.write(`${line}\n`);
      });
  }

  export(spans: readonly SpanRecord[]): void {
    for (const span of spans) {
      this.sink(JSON.stringify({ type: 'otel_span', ...span }));
    }
  }
}

/**
 * Local Tracer creating Spans and delivering finished Spans to configured Exporters.
 */
export class LocalTracer {
  private readonly exporters: SpanExporter[] = [];

  constructor(exporters: readonly SpanExporter[] = []) {
    this.exporters.push(...exporters);
  }

  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  startSpan(name: string, options: SpanOptions = {}): LocalSpan {
    return new LocalSpan(name, options, (record) => {
      for (const exporter of this.exporters) {
        exporter.export([record]);
      }
    });
  }

  async startActiveSpan<T>(
    name: string,
    fn: (span: LocalSpan) => Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      if (span.isRecording()) {
        span.setStatus('OK');
      }
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
