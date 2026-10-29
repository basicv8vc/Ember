/**
 * Size-bounded request-body reading for `/v1` (P0B-07a).
 *
 * `await request.text()` buffers whatever the client sends, so a hostile or buggy client can
 * force unbounded allocation before any schema runs. This reader enforces the byte limit on
 * the *stream*: the first chunk that would exceed the cap aborts the read and the body is
 * discarded. `Content-Length` is never trusted as the only signal, because it can be absent
 * (chunked) or wrong.
 */

/** Why a body was rejected. Mapped to `INVALID_ARGUMENT`; never returned verbatim. */
export const BODY_REJECTION_REASONS = [
  'missing_content_type',
  'unsupported_content_type',
  'empty_body',
  'too_large',
  'invalid_encoding',
  'invalid_json',
] as const;

export type BodyRejectionReason = (typeof BODY_REJECTION_REASONS)[number];

export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: BodyRejectionReason };

/**
 * Accept `application/json` with optional parameters (`; charset=utf-8`).
 *
 * P0-B has no vendor media types and no JSON-patch semantics, so the check is deliberately
 * narrow: a client that forgets the header gets a clear 400 instead of a body parsed by
 * guesswork.
 */
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;.*)?$/i;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Read at most `maxBytes` and parse the result as JSON.
 *
 * The returned object is untrusted: every caller must still validate it against a strict
 * schema. Nothing here is logged or echoed back, so an oversized or malformed body cannot
 * leak through an error message.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentType = request.headers.get('content-type');

  if (contentType === null || contentType.trim() === '') {
    return { ok: false, reason: 'missing_content_type' };
  }

  if (!JSON_CONTENT_TYPE.test(contentType.trim())) {
    return { ok: false, reason: 'unsupported_content_type' };
  }

  const declaredLength = request.headers.get('content-length');

  if (declaredLength !== null) {
    const declared = Number(declaredLength);

    // A declared length above the cap is rejected before a single byte is read. A
    // non-numeric length is ignored here and still bounded by the streaming check below.
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
  }

  const body = request.body;

  if (body === null) {
    return { ok: false, reason: 'empty_body' };
  }

  // `request.body` is typed by the platform as `ReadableStream<any>`; pin the chunk type so
  // the length arithmetic below cannot be an unchecked `any` operation.
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value === undefined) {
        continue;
      }

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    return { ok: false, reason: 'empty_body' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid_encoding' };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
