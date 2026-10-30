import { describe, expect, it } from 'vitest';
import {
  generateSpanId,
  generateTraceId,
  InMemorySpanExporter,
  JsonLineSpanExporter,
  LocalTracer,
  SpanRecordSchema,
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
    expect(record.status.description).toBe('simulated sandbox failure');
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
});
