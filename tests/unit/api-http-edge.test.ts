import { describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app.js';
import { readJsonBody } from '../../apps/api/src/http/bounded-body.js';
import { REQUEST_ID_HEADER } from '../../apps/api/src/http/app-context.js';
import { parseAfterCursor } from '../../apps/api/src/tasks/routes.js';

/**
 * P0B-07a HTTP edge behaviour: correlation ids, the bounded body reader and the events
 * cursor. All three are places where a client-supplied value must be constrained rather
 * than trusted.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonRequest(
  body: string | Uint8Array | null,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  return new Request('http://localhost/v1/tasks', {
    method: 'POST',
    headers,
    ...(body === null ? {} : { body }),
  });
}

describe('request id', () => {
  it('issues an unguessable id per request and echoes it on the response', async () => {
    const app = createApp();
    const first = await app.request('/healthz');
    const second = await app.request('/healthz');

    const firstId = first.headers.get(REQUEST_ID_HEADER);
    const secondId = second.headers.get(REQUEST_ID_HEADER);

    expect(firstId).toMatch(UUID_PATTERN);
    expect(secondId).toMatch(UUID_PATTERN);
    expect(firstId).not.toBe(secondId);
  });

  it('ignores an inbound X-Request-Id so a client cannot choose the logged id', async () => {
    const app = createApp();
    const response = await app.request('/healthz', {
      headers: { [REQUEST_ID_HEADER]: 'client-supplied-id' },
    });

    expect(response.headers.get(REQUEST_ID_HEADER)).not.toBe('client-supplied-id');
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_PATTERN);
  });

  it('replaces an empty or oversized generated id instead of emitting it', async () => {
    for (const generator of [() => '', () => 'x'.repeat(129)]) {
      const response = await createApp({ requestIdGenerator: generator }).request('/healthz');

      expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID_PATTERN);
    }
  });

  it('accepts a generated id at the maximum length', async () => {
    const atLimit = 'y'.repeat(128);
    const response = await createApp({ requestIdGenerator: () => atLimit }).request('/healthz');

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(atLimit);
  });
});

describe('B1 Cloud Chat route defaults', () => {
  it('keeps the five session-authenticated chat endpoints absent without injected B1 runtime ports', async () => {
    const app = createApp();
    const endpoints = [
      { method: 'POST', path: '/v1/conversations/11111111-1111-4111-8111-111111111111/messages' },
      { method: 'GET', path: '/v1/conversations/11111111-1111-4111-8111-111111111111/messages' },
      { method: 'GET', path: '/v1/message-submissions/11111111-1111-4111-8111-111111111111' },
      {
        method: 'GET',
        path: '/v1/conversations/11111111-1111-4111-8111-111111111111/turns/22222222-2222-4222-8222-222222222222',
      },
      {
        method: 'POST',
        path: '/v1/conversations/11111111-1111-4111-8111-111111111111/turns/22222222-2222-4222-8222-222222222222/cancel',
      },
    ] as const;

    for (const endpoint of endpoints) {
      const response = await app.request(endpoint.path, { method: endpoint.method });
      expect(response.status).toBe(404);
    }
  });
});

describe('readJsonBody', () => {
  it('accepts application/json with parameters', async () => {
    const result = await readJsonBody(
      jsonRequest('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }),
      1024,
    );

    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('requires a JSON content type', async () => {
    // A string body makes `fetch` add `text/plain`; a byte body keeps the header absent.
    expect(await readJsonBody(jsonRequest(new TextEncoder().encode('{"a":1}'), {}), 1024)).toEqual({
      ok: false,
      reason: 'missing_content_type',
    });
    expect(await readJsonBody(jsonRequest('{"a":1}', { 'content-type': '  ' }), 1024)).toEqual({
      ok: false,
      reason: 'missing_content_type',
    });
    expect(
      await readJsonBody(jsonRequest('{"a":1}', { 'content-type': 'text/plain' }), 1024),
    ).toEqual({ ok: false, reason: 'unsupported_content_type' });
  });

  it('rejects an empty body and a non-JSON body', async () => {
    expect(await readJsonBody(jsonRequest(null), 1024)).toEqual({
      ok: false,
      reason: 'empty_body',
    });
    expect(await readJsonBody(jsonRequest('not json'), 1024)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
  });

  it('rejects a body declared larger than the cap before reading it', async () => {
    const request = jsonRequest(null, {
      'content-type': 'application/json',
      'content-length': '70000',
    });

    expect(await readJsonBody(request, 64 * 1024)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects a streamed body that grows past the cap', async () => {
    const chunk = 'x'.repeat(64);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const request = new Request('http://localhost/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    });

    // 4 x 64 = 256 bytes against a 128-byte cap, with no Content-Length to pre-screen it.
    expect(await readJsonBody(request, 128)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts a body of exactly the maximum size', async () => {
    const body = '{"a":"12345678"}';
    expect(new TextEncoder().encode(body).byteLength).toBe(16);

    expect(await readJsonBody(jsonRequest(body), 16)).toEqual({
      ok: true,
      value: { a: '12345678' },
    });
    expect(await readJsonBody(jsonRequest(body), 15)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects bytes that are not valid UTF-8', async () => {
    const request = jsonRequest(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]));

    expect(await readJsonBody(request, 1024)).toEqual({ ok: false, reason: 'invalid_encoding' });
  });
});

describe('parseAfterCursor', () => {
  it('defaults to the whole log when the parameter is absent', () => {
    expect(parseAfterCursor(undefined)).toEqual({ ok: true, after: 0 });
  });

  it('accepts bounded non-negative decimal integers', () => {
    expect(parseAfterCursor('0')).toEqual({ ok: true, after: 0 });
    expect(parseAfterCursor('42')).toEqual({ ok: true, after: 42 });
    expect(parseAfterCursor('123456789012345')).toEqual({ ok: true, after: 123456789012345 });
  });

  it('rejects anything it would otherwise have to coerce', () => {
    for (const raw of ['', '-1', '+1', '1.5', '1e3', ' 1', '1_000', 'abc', '0x10']) {
      expect(parseAfterCursor(raw), raw).toEqual({ ok: false });
    }
  });

  it('rejects a cursor longer than the safe-integer digit budget', () => {
    expect(parseAfterCursor('9999999999999999')).toEqual({ ok: false });
  });
});
