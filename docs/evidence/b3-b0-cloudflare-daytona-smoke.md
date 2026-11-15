# B3-B0: Cloudflare Workers + Daytona Compatibility Smoke Evidence

- **Marker:** `CLOUDFLARE_DAYTONA_SMOKE_PASS`
- **Date:** 2026-11-15
- **Base:** `origin/main` (`c3e43c6`)
- **Staging Worker:** `ember-daytona-smoke-staging` (`https://ember-daytona-smoke-staging.10kpaper.workers.dev`)
- **Deployed Version ID:** `43b6aab8-32ec-43e6-b651-af1683e56323`
- **Queue:** `ember-staging-daytona-smoke`

## 1. Compatibility & Bundling Verification

- **SDK / Adapter Reused:** `@ember/sandbox-daytona` (`@daytonaio/sdk` pinned `0.230.0`) + `SandboxAdapter` (`@ember/execution`), without adding a separate provider or Node worker.
- **Workers Configuration:** `compatibility_date: "2026-11-10"`, `compatibility_flags: ["nodejs_compat"]`, `limits.cpu_ms: 30000` (Workers Paid Standard).
- **Bundle Output (`wrangler deploy`):** `3186.20 KiB` total upload (`430.93 KiB` gzip), `Worker Startup Time: 49 ms`, `hasWebSocketPair: true`.
- **Observations & Minimal Fixes Applied:**
  1. **SDK Background WebSocket Disposal:** `@daytonaio/sdk@0.230.0` starts a Socket.IO `EventDispatcher` connection on `new Daytona(...)`. Without explicit disposal, Queue Consumer runs lingered ~308–312s (`311,692 ms` before fix) and HTTP sync runs logged `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled`. Adding `close()` / `[Symbol.asyncDispose]()` to `DaytonaSdkSandboxClient` (calling `this.daytona[Symbol.asyncDispose]()`) and invoking `await client.close?.()` in `finally` reduced Queue Consumer wall time to **`16,687 ms`** with zero warnings or exceptions.
  2. **Daytona `list()` Eventual Consistency After `delete()`:** `DaytonaSdkSandboxClient.delete()` confirms deletion via `GET /sandbox/{id}`, while `list()` can briefly report `destroying` or `started` for ~0.5–1.5s. `waitForSandboxesCleaned()` verifies `client.get(id)` is gone/`destroyed`/`destroying` before polling `list()` briefly (500ms interval, 10s max).
  3. **Bundled Version Introspection:** `DAYTONA_INSTALLED_SDK_VERSION` resolves to `"UNKNOWN"` inside Wrangler's single-file bundle because `node_modules/@daytonaio/sdk/package.json` is not on disk; `DAYTONA_PINNED_SDK_VERSION` remains `"0.230.0"`.

## 2. Live Cloudflare Queue Consumer Evidence

- **Run ID:** `a06d9190-165a-43d2-aeb6-d1f91618e8fa`
- **Owner Label:** `ember-b3-b0:a06d9190-165a-43`
- **Queue Delivery (`wrangler tail --format json` TraceItem):**
  - `event.queue`: `ember-staging-daytona-smoke`
  - `event.batchSize`: `1`
  - `messageId`: `9d772e191ce63b677814137ac902c274` (`attempts: 1`)
  - `outcome`: `"ok"`, `exceptions`: `[]`
- **Cloudflare CPU Time vs. Wall Time:**
  - **Cloudflare CPU Time (`TraceItem.cpuTime`):** **`178 ms`** (vs. `limits.cpu_ms: 30000`; note Workers Free `10 ms` CPU limit is insufficient)
  - **Cloudflare Wall Time (`TraceItem.wallTime`):** **`16,687 ms`** (inner smoke `totalWallTimeMs`: `16,612 ms`; Queue Consumer limit is 15 minutes / `900,000 ms`)

## 3. Sandbox Lifecycle, Python Smoke & Timings

| Item                                | Result                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary Sandbox ID                  | `84882f48-7da5-4db5-8ce2-8455003c867c`                                                                                                       |
| Profile / Snapshot / Class          | `container-small` / `daytona-small` / `container` (1 vCPU, 1 GiB RAM, 3 GiB disk)                                                            |
| Lifecycle Bounds                    | `ttlMinutes` capped by `maxSandboxLifetimeSec: 120`, `autoStopIntervalMinutes: 2`, `autoDeleteIntervalMinutes: 0`, `maxExecTimeoutMs: 60000` |
| `create` / `waitReady` / Cold Start | `1,635 ms` / `183 ms` (`waitReady` step incl. verify `364 ms`) / **`1,818 ms`**                                                              |
| `pythonExecOk`                      | `PASS` (`1,096 ms`), Python `3.14.10`, `uid=1001`, `exitCode=0`, `envCount=40`                                                               |
| `pythonExecFail`                    | `PASS` (`925 ms`), `exitCode=42`, `stderrMatched=true`                                                                                       |
| `pythonExecTimeout`                 | `PASS` (`2,360 ms`), `EXECUTION_TIMEOUT` at `2,000 ms` configured timeout                                                                    |
| `destroyPrimary`                    | `PASS` (`1,432 ms`)                                                                                                                          |
| `verifyPrimaryCleaned`              | `PASS` (`1,283 ms`), `initialLiveStates` showed `destroying`, settled in `2` attempts to `[]`                                                |
| Cancel Sandbox ID                   | `caec7a5f-7ddc-4167-9d6b-bc1bedad6020`                                                                                                       |
| `cancelAndAdapterCleanup`           | `PASS` (`2,892 ms`: create+ready `1,392 ms`, abort -> `CANCELLED` in `1,500 ms`)                                                             |
| `destroyCancelled`                  | `PASS` (`1,279 ms`)                                                                                                                          |
| `finalCleanupAudit`                 | `PASS` (`1,812 ms`), `orphanSweptIds=[]`, `orphanSweepFailures=0`, `finalLiveSandboxIds=[]`                                                  |

## 4. Network Isolation, Secrets & Cost

- **Network Policy (`deny-all`):** `networkBlockAllReported: true` (`networkProbeMs: 1,234 ms`):
  - `dnsBlocked: true`
  - `httpsBlocked: true`
  - `metadataHttpStatus: 403` (`169.254.169.254`)
- **Secret Hygiene:** `secretsAbsentInSandbox: true`, `forbiddenKeysFound: []` (only vendor `DAYTONA_*` metadata keys present in sandbox env; no `DAYTONA_API_KEY`, `EMBER_*`, or provider tokens).
- **Post-Run Residual Audit (`GET /sandboxes`):** `{"ok":true,"count":0,"sweptIds":[],"sandboxes":[]}`.
- **Usage & Estimated Cost (`RESERVATION_WALL_CLOCK`):**
  - Primary hold: `7.711 s` (`cpuSeconds: 5.796`, `memoryGiBSeconds: 5.796`, `egressBytes: 0`)
  - Cancel hold: `2.945 s`
  - Total estimated spend for 2-sandbox smoke: **`$0.000197`** (at `$0.0504/vCPU-hr`, `$0.0162/GiB-hr`, `$0.000108/GiB-hr` storage with 5 GiB free).

## 5. Conclusion

**GO** — Approved to proceed directly to **B1 Daytona Agent Loop** using `@ember/sandbox-daytona` inside Cloudflare Queue Consumers on Workers Paid Standard (`limits.cpu_ms: 30000`), ensuring `DaytonaSdkSandboxClient.close()` runs in `finally` on every Queue task and accounting for Daytona `list()` eventual-consistency lag during reconciliation.
