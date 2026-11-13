# Ember Cloud on Cloudflare

The existing Cloudflare deployment is Ember's only shared cloud environment. Its Workers, Queues, and Hyperdrive names still include `staging`; this does not mean a separate Staging→Production release flow. The current resource inventory, migration and deploy entry point, health checks, rollback procedure, and Private Alpha gates are documented in [Ember Cloud](../../docs/cloud-staging.md).

## Existing Worker configurations

- [API Worker](../../apps/api/wrangler.staging.jsonc) keeps `ember-cloud-api-staging.10kpaper.workers.dev` as the iOS endpoint and connects to the existing Neon database through Hyperdrive.
- [Async Runtime Worker](../../apps/cloud-async-runtime/wrangler.staging.jsonc) consumes the existing Assistant Turn Queue and uses the existing Hyperdrive, provider route, and per-Turn budget.
- `pnpm cloud:deploy` is the release entry point. It applies migrations through the existing Neon migration role, deploys these two Workers, verifies the HTTPS API and database readiness, and rolls back Worker versions if verification fails.

Resource IDs are deliberately kept in their existing configs. Do not provision replacements, repoint the app, or target the unrelated Workers and Queues used by historical PoCs.
