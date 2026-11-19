// Import module-scoped Workers types to keep the Node-compatible package build
// free of Workers globals such as URL and crypto.
declare module 'cloudflare:workers' {
  import type { CloudflareWorkersModule } from '@cloudflare/workers-types/index.js';

  export const DurableObject: typeof CloudflareWorkersModule.DurableObject;
}
