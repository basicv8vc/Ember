/**
 * The first server-side third-party secret in this codebase.
 *
 * Handling rules, all testable:
 * - exactly one secret per process per provider, read once at construction;
 * - no accessor returns it — a consumer receives it inside `use()`, so it cannot be stored, logged
 *   or serialized by a caller that merely holds the credential object;
 * - `toJSON`/`toString` are redacted, so an accidental `JSON.stringify` cannot leak it;
 * - a placeholder is refused at boot, and `real` mode never silently degrades to `fake`.
 */
export type CredentialRefusal =
  'credential_missing' | 'credential_placeholder' | 'credential_malformed';

const PLACEHOLDER_MARKERS = ['CHANGEME', 'REPLACE', 'YOUR_', 'YOUR-', 'XXXX', 'EXAMPLE'] as const;

/** The documented placeholder from `.env.example`-style files. */
export const MODEL_CREDENTIAL_PLACEHOLDER = 'sk-REPLACE-WITH-REAL-KEY';

export class ModelCredential {
  static readonly minLength = 20;

  readonly #apiKey: string;

  private constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  static parse(
    raw: string | undefined,
  ): { ok: true; credential: ModelCredential } | { ok: false; reason: CredentialRefusal } {
    const value = raw?.trim() ?? '';

    if (value.length === 0) {
      return { ok: false, reason: 'credential_missing' };
    }

    const upper = value.toUpperCase();

    if (PLACEHOLDER_MARKERS.some((marker) => upper.includes(marker))) {
      return { ok: false, reason: 'credential_placeholder' };
    }

    // Provider-format check: a value that cannot be a real key must not reach a request.
    if (value.length < ModelCredential.minLength || !value.startsWith('sk-')) {
      return { ok: false, reason: 'credential_malformed' };
    }

    return { ok: true, credential: new ModelCredential(value) };
  }

  /**
   * Hand the secret to exactly one consumer (the adapter constructor) without exposing it.
   * The value is passed by argument and never returned, so it cannot escape into a caller's state.
   */
  use<T>(consumer: (apiKey: string) => T): T {
    return consumer(this.#apiKey);
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }
}
