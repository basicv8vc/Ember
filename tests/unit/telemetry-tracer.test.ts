import { describe, expect, it } from 'vitest';
import {
  generateSpanId,
  generateTraceId,
  InMemorySpanExporter,
  JsonLineSpanExporter,
  LocalTracer,
  SpanRecordSchema,
  type SpanRecord,
} from '@ember/telemetry';

describe('telemetry local tracer and spans', () => {
  it('generates valid 32-hex traceId and 16-hex spanId', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('records attributes, events, and ends span with OK status', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LocalTracer([exporter]);

    const span = tracer.startSpan('gateway.task.create', {
      attributes: {
        'http.method': 'POST',
        'http.route': '/v1/tasks',
        authorization: 'Bearer secret_token_12345678',
      },
    });

    span.setAttribute('task.kind', 'mock.chat');
    span.addEvent('validated', { 'input.valid': true });
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);

    const record = finished[0]!;
    expect(record.name).toBe('gateway.task.create');
    expect(record.status.code).toBe('OK');
    expect(record.attributes['http.method']).toBe('POST');
    expect(record.attributes['task.kind']).toBe('mock.chat');
    expect(record.attributes['authorization']).toBe('[REDACTED]');
    expect(record.events).toHaveLength(1);
    expect(record.events[0]?.name).toBe('validated');

    // Validate with strict schema
    expect(() => SpanRecordSchema.parse(record)).not.toThrow();
  });

  it('records exception and sets status ERROR on failure', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LocalTracer([exporter]);

    const span = tracer.startSpan('worker.run.execute');
    span.recordException(new Error('simulated sandbox failure'));
    span.end();

    const record = exporter.getFinishedSpans()[0]!;
    expect(record.status.code).toBe('ERROR');
    expect(record.status.description).toBe('UNEXPECTED');
    expect(record.events[0]?.attributes?.['exception.message']).toBe('[REDACTED]');
    expect(record.events[0]?.name).toBe('exception');
  });

  it('propagates parent-child relationships across spans', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LocalTracer([exporter]);

    const parent = tracer.startSpan('parent.operation');
    const child = tracer.startSpan('child.step', {
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
    });

    child.end();
    parent.end();

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(2);

    const childRecord = finished.find((s) => s.name === 'child.step')!;
    const parentRecord = finished.find((s) => s.name === 'parent.operation')!;

    expect(childRecord.trace_id).toBe(parentRecord.trace_id);
    expect(childRecord.parent_span_id).toBe(parentRecord.span_id);
  });

  it('runs startActiveSpan and manages lifecycle automatically', async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LocalTracer([exporter]);

    const result = await tracer.startActiveSpan('active.task', async (span) => {
      span.setAttribute('step.no', 1);
      await Promise.resolve();
      return 'task-completed';
    });

    expect(result).toBe('task-completed');
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe('OK');
  });

  it('startActiveSpan records error and rethrows when inner function throws', async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LocalTracer([exporter]);

    await expect(
      tracer.startActiveSpan('failing.task', async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe('ERROR');
  });

  it('exports JSON line spans through JsonLineSpanExporter', () => {
    const lines: string[] = [];
    const exporter = new JsonLineSpanExporter((line) => lines.push(line));
    const tracer = new LocalTracer([exporter]);

    const span = tracer.startSpan('test.span');
    span.end();

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { type: string; name: string };
    expect(parsed.type).toBe('otel_span');
    expect(parsed.name).toBe('test.span');
  });

  describe('privacy and redaction negative tests (P1)', () => {
    it('redacts sensitive credentials from recordException and status description in serialized output', () => {
      const lines: string[] = [];
      const exporter = new JsonLineSpanExporter((line) => lines.push(line));
      const tracer = new LocalTracer([exporter]);

      const span = tracer.startSpan('worker.secure_execution');
      const sensitiveError = new Error(
        'Connection to postgres://admin:super_secret_db_pass@127.0.0.1:5432 failed with Bearer secret_bearer_token_xyz999',
      );
      span.recordException(sensitiveError);
      span.end();

      expect(lines).toHaveLength(1);
      const rawSerializedLine = lines[0]!;

      // NEGATIVE TESTS: Ensure zero leakage of sensitive credentials anywhere in serialized JSON
      expect(rawSerializedLine).not.toContain('super_secret_db_pass');
      expect(rawSerializedLine).not.toContain('secret_bearer_token_xyz999');

      // Verify status description and event are sanitized
      const parsed = JSON.parse(rawSerializedLine) as { type: string } & SpanRecord;
      expect(parsed.type).toBe('otel_span');
      expect(parsed.status.code).toBe('ERROR');
      expect(parsed.status.description).toBe('UNEXPECTED');
      expect(parsed.events[0]?.attributes?.['exception.code']).toBe('UNEXPECTED');
      expect(parsed.events[0]?.attributes?.['exception.message']).toBe('[REDACTED]');

      // Strict schema validation passes on the span record
      expect(() => SpanRecordSchema.parse(span.toRecord())).not.toThrow();
    });

    it('never exports raw task input from an arbitrary Error message or stack', () => {
      const lines: string[] = [];
      const tracer = new LocalTracer([new JsonLineSpanExporter((line) => lines.push(line))]);
      const privatePrompt = 'user draft: My confidential product launch is on Thursday';
      const error = new Error(`worker failed while handling ${privatePrompt}`);
      error.stack = `Error: ${privatePrompt}\\n  at processPrompt`;

      const span = tracer.startSpan('worker.execute');
      span.recordException(error);
      span.end();

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(privatePrompt);
      expect(lines[0]).not.toContain('processPrompt');
      const parsed = JSON.parse(lines[0]!) as { type: string } & SpanRecord;
      expect(parsed.status.description).toBe('UNEXPECTED');
      expect(parsed.events[0]?.attributes?.['exception.message']).toBe('[REDACTED]');
      expect(parsed.events[0]?.attributes?.['exception.stacktrace']).toBeUndefined();
    });

    it('redacts sensitive credentials directly passed to setStatus description', () => {
      const lines: string[] = [];
      const exporter = new JsonLineSpanExporter((line) => lines.push(line));
      const tracer = new LocalTracer([exporter]);

      const span = tracer.startSpan('gateway.auth_check');
      span.setStatus('ERROR', 'Access denied with token Bearer unredacted_auth_token_456');
      span.end();

      const rawSerializedLine = lines[0]!;
      expect(rawSerializedLine).not.toContain('unredacted_auth_token_456');
      expect(rawSerializedLine).toContain('Bearer [REDACTED]');

      const parsed = JSON.parse(rawSerializedLine) as { type: string } & SpanRecord;
      expect(parsed.type).toBe('otel_span');
      expect(parsed.status.description).toBe('Access denied with token Bearer [REDACTED]');
      expect(() => SpanRecordSchema.parse(span.toRecord())).not.toThrow();
    });

    it('prevents single setAttribute from bypassing tenantId hashing and prohibits raw tenant UUID', () => {
      const lines: string[] = [];
      const exporter = new JsonLineSpanExporter((line) => lines.push(line));
      const tracer = new LocalTracer([exporter]);

      const rawTenantId = '7ac16c27-3932-4752-96ea-45b78fbe296e';
      const span = tracer.startSpan('task.run');

      // Attempt direct single-attribute bypass
      span.setAttribute('tenantId', rawTenantId);
      span.setAttribute('tenant_id', rawTenantId);
      span.setAttribute('password', 'raw_password_secret_123');
      span.setAttribute('prompt', 'Sensitive user instructions to LLM');
      span.end();

      expect(lines).toHaveLength(1);
      const rawSerializedLine = lines[0]!;

      // NEGATIVE TESTS: Raw tenant UUID must NEVER be present anywhere in the output
      expect(rawSerializedLine).not.toContain(rawTenantId);
      expect(rawSerializedLine).not.toContain('raw_password_secret_123');
      expect(rawSerializedLine).not.toContain('Sensitive user instructions to LLM');

      const parsed = JSON.parse(rawSerializedLine) as { type: string } & SpanRecord;
      expect(parsed.type).toBe('otel_span');
      // Key 'tenantId' and 'tenant_id' must NOT exist
      expect(parsed.attributes).not.toHaveProperty('tenantId');
      expect(parsed.attributes).not.toHaveProperty('tenant_id');

      // Key 'tenant_hash' must be present with safe 16-hex hash
      expect(parsed.attributes['tenant_hash']).toMatch(/^[a-f0-9]{16}$/);
      expect(parsed.attributes['password']).toBe('[REDACTED]');
      expect(parsed.attributes['prompt']).toBe('[REDACTED_PROMPT]');

      // SpanRecordSchema passes with strict refinement forbidding raw tenantId
      expect(() => SpanRecordSchema.parse(span.toRecord())).not.toThrow();
    });

    it('rejects SpanRecord containing raw tenantId at schema validation time', () => {
      const invalidSpan = {
        name: 'test',
        trace_id: '0123456789abcdef0123456789abcdef',
        span_id: '0123456789abcdef',
        parent_span_id: null,
        kind: 'INTERNAL',
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        duration_ms: 10,
        status: { code: 'OK' },
        attributes: {
          tenantId: '7ac16c27-3932-4752-96ea-45b78fbe296e',
        },
        events: [],
      };

      expect(() => SpanRecordSchema.parse(invalidSpan)).toThrow(
        /Raw tenantId \/ tenant_id must never appear/,
      );
    });
  });
});
