/**
 * @ember/credentials
 *
 * Simulated Credential Broker & Egress Policy Foundation (P0-C1C).
 *
 * Conforms to RFC v0.2 ADR-005:
 * - Sandboxes never directly hold long-term credentials.
 * - Outbound requests default-deny against server-configured egress policies.
 * - Credential references are strictly synthetic, tenant-isolated metadata.
 * - Zero real user tokens, zero external network calls.
 */

export * from './types.js';
export * from './errors.js';
export * from './registry.js';
export * from './egress-policy.js';
export * from './audit.js';
export * from './broker.js';
export * from './proxy.js';
export * from './fixtures.js';
