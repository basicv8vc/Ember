# M2-D1 Independent QA & Acceptance Status

**Owner:** Agent D (Independent QA & Acceptance)  
**Tested Baseline:** `origin/main @ da75ed4` (2026-11-20)  
**Overall M2-D1 Physical Gate:** **BLOCKED** (physical iPhones offline; local workerd + isolated Simulator E2E 6/6 PASS)

> Simulator and local workerd results are pre-physical verification evidence only and do **not** satisfy the physical iPhone network E2E gate defined in [PRODUCT-ALPHA-ROADMAP.md](../product/PRODUCT-ALPHA-ROADMAP.md).

---

## 1. Verification Matrix (`origin/main @ da75ed4`)

| Layer / Scenario | Status | Environment & Evidence |
| --- | --- | --- |
| **V2 Local `workerd` M2-F1 + M2-F2** | **PASS (10/10)** | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/v2-m2-device-execution-workerd.test.ts tests/integration/v2-m2-native-device-workerd.test.ts` — 10/10 passed in `57.84s` (capability placement, renewal, deadline clamp, 30s lease recovery, cancellation fencing, lost ACK replay, account scoping, revocation). |
| **iOS `CloudDeviceAdapterTests`** | **PASS (24/24)** | `xcodebuild test -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=8A4CCF42-FD5C-4CCE-B6B8-05E967E552EF' -only-testing:EmberTests/CloudDeviceAdapterTests SWIFT_STRICT_CONCURRENCY=complete` — 24/24 passed in `0.484s` (includes #201 concurrent reconnect teardown fix). |
| **Isolated Physical QA App Build (`LocalDeviceAdapter`)** | **PASS** | `xcodebuild build -project apps/ios/LocalDeviceAdapter/LocalDeviceAdapter.xcodeproj -scheme LocalDeviceAdapter -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO` — `BUILD SUCCEEDED`. Keeps `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription` strictly isolated from production `Ember.app`. |
| **V2 Staging Preflight Dry-Run (#203)** | **PASS** | `node infra/cloudflare/v2-staging-preflight.mjs` — config isolation and `wrangler deploy --dry-run` (`1334.33 KiB / gzip 234.22 KiB`, zero cloud calls) passed. |
| **Real `Ember.app` Simulator E2E vs `workerd` + LAN Relay** | **PASS (6/6)** | `Ember.app` (`--ember-device-executor --ember-cloud-adapter-qa`) on isolated `iPhone Duo Simulator` (`iOS 27.2`) against `tests/integration/support/iphone-native-qa.ts` (`192.168.1.19`). See §2 below. |
| **Physical iPhone Network E2E (M2-D1)** | **BLOCKED** | All 3 paired physical iPhones (`Haha🎀` iPhone 12 Pro Max `00008101-000E0D923E01001E`, `Li的 iPhone` `00008101-000C44CA01A3003A`, `phone` iPhone XR `00008020-001124EE21E8003A`) report `unavailable` / `Devices Offline` in `xcrun devicectl list devices` and `xcrun xctrace list devices`. |

---

## 2. Real `Ember.app` Simulator E2E Scenarios (6/6 PASS)

Executed against `V2LocalRuntimeHarness` (`apps/api/wrangler.local-v2.jsonc`) through `tests/integration/support/iphone-native-qa.ts` (updated with `revoke` control action and non-OK `register`/error wire logging):

| # | M2-D1 Criterion | Observed Wire & Agent Head Evidence | Result |
| --- | --- | --- | --- |
| 1 | Normal execution | Dispatched `"𝄞\r\ne\u0301\n"` (`deadlineMs: 60000`). Claimed (`leaseEpoch: 1`), committed (`replayed: false`), Task `completed` with `{ utf8Bytes: 10, unicodeScalars: 6, lines: 3 }`, 1 `succeeded` Run. | **PASS** |
| 2 | Lost ACK replay & duplicate dispatch | Enabled `mode: drop-result-ack`. Observed `result_ack_dropped` (`replayed: false`), fenced replay returning `committed` (`replayed: true`), Task `completed` `{ utf8Bytes: 21, unicodeScalars: 21, lines: 3 }`. Duplicate `POST /v2/device-tasks` with identical `operationId` returned HTTP `200` with same `taskId` and `replayed: true`; 1 `succeeded` Run. | **PASS** |
| 3 | Network loss & recovery | `workDelayMs: 3000`. Switched relay `offline` for `4s` after claim, then `online`. Device recovered connectivity and committed `{ utf8Bytes: 22, unicodeScalars: 22, lines: 1 }`; Task `completed`. | **PASS** |
| 4 | Cancellation & lease fencing | `workDelayMs: 8000`. Cancelled claimed task (`POST /v2/device-tasks/{taskId}/cancel` → `200 cancelled`). Late `/result` from `Ember.app` rejected with HTTP `409` `{ kind: "fenced" }`. | **PASS** |
| 5 | Lease renewal (>30s lease) | `workDelayMs: 35000`, `deadlineMs: 90000`. Observed 3 `/renew` RPCs at ~10s intervals (`200 renewed`) on the same `runId` and `leaseEpoch: 1`, then completion beyond 30s with 1 `succeeded` Run. | **PASS** |
| 6 | Device revocation | Sent `{"action":"revoke"}` (`POST /v2/devices/{deviceId}/revoke` → `200 { status: "revoked" }`). Active `/claim` and relaunched `/register` both failed closed with HTTP `403 POLICY_DENIED`. Subsequent dispatch remained `queued` with `availability: "device_unavailable"`, `reason: "device_unavailable"` (no silent cloud fallback). | **PASS** |

---

## 3. Physical iPhone Blocker & Unblock Runbook

### Blocker
1. **No physical iPhone online:** Connect an iPhone (e.g. `iPhone 12 Pro Max`, UDID `00008101-000E0D923E01001E`) via USB/Wi-Fi on the same private LAN as the Mac and unlock it so `xcrun devicectl list devices` shows `connected` / `available`.
2. **iOS Local Network permission:** Use the isolated `LocalDeviceAdapter` (`com.basicv8vc.ember.local-device-adapter`) app — which already includes `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription` without relaxing production `Ember.app` ATS — and tap **Allow** on the iOS Local Network prompt on first launch.

### Reproducible Physical Runbook (once device is connected)
1. Start the isolated relay on the Mac's active private LAN IPv4 (e.g. `192.168.1.19`):
   ```sh
   QA_DIR=$(mktemp -d)
   pnpm exec tsx tests/integration/support/iphone-native-qa.ts <mac-private-ip> "$QA_DIR"
   ```
2. Install/copy config and launch `LocalDeviceAdapter` on the connected iPhone:
   ```sh
   xcrun devicectl device copy to --device <iphone-udid> \
     --domain-type appDataContainer \
     --domain-identifier com.basicv8vc.ember.local-device-adapter \
     --source "$QA_DIR/local-device-qa.json" \
     --destination Documents/local-device-qa.json
   xcrun devicectl device process launch --device <iphone-udid> \
     --terminate-existing --console com.basicv8vc.ember.local-device-adapter
   ```
3. Run the 6 control scenarios via relay stdin (`dispatch`, `mode: drop-result-ack`, `mode: offline`/`online`, `delay: 35000`, `cancel`, `revoke`) plus background >30s lease expiry recovery, and update this report with the physical evidence.
