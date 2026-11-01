/**
 * Public entrypoint for @ember/connectors.
 *
 * Exposes the provider-neutral, strictly read-only source port and consent security boundary.
 */

export * from './types.js';
export * from './errors.js';
export * from './canonical.js';
export * from './sanitizer.js';
export * from './fake-consent-registry.js';
export * from './source-policy.js';
export * from './fake-source-reader.js';
export * from './guarded-source-reader.js';
export * from './audit.js';
export * from './fixtures.js';
export * from './factory.js';
