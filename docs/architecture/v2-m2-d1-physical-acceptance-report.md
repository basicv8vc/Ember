# M2-D1 Independent QA & Physical iPhone Acceptance Report

**Owner:** Agent D (Independent QA & Acceptance)  
**Tested Baseline:** `origin/main @ 06071f9` (physical iPhone E2E) & `origin/main @ ea85eab` (V2 product pipeline verification) — 2026-11-20  
**Overall M2-D1 Physical Gate:** **PASS (6/6 on physical `iPhone 12 Pro Max` over real private LAN)**

---

## 1. Physical iPhone Network E2E Evidence (6/6 PASS)

- **Physical Device:** `Haha🎀` — `iPhone 12 Pro Max (iPhone13,4)`, UDID `00008101-000E0D923E01001E`
- **Isolated App:** `LocalDeviceAdapter` (`com.basicv8vc.ember.local-device-adapter`), keeping `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription` strictly isolated from production `Ember.app`
- **Network Path:** Real private LAN (`http://192.168.1.19:59973`) → `tests/integration/support/iphone-native-qa.ts` → `V2LocalRuntimeHarness` (`apps/api/wrangler.local-v2.jsonc`)
- **Registered Physical Device ID:** `736c5b55-9d03-488a-97b3-5cd18d0d2f96`

| # | M2-D1 Criterion | Physical iPhone Wire & Agent Head Evidence | Result |
| --- | --- | --- | --- |
| 1 | **Normal execution** | Dispatched `"𝄞\r\ne\u0301\n"` (`taskId: 646f43db-989c-462c-aa83-5d3dd6c5143d`). Claimed (`leaseEpoch: 1`), committed (`replayed: false`), Task `completed` with `{ utf8Bytes: 10, unicodeScalars: 6, lines: 3 }`, 1 `succeeded` Run (`6f9e2dd2-36c9-440e-ac35-f48f4bebfdc7`). | **PASS** |
| 2 | **Lost ACK replay & duplicate dispatch** | Enabled `mode: drop-result-ack` (`taskId: 4767d3c4-6fdf-47a1-8a6e-988dae089898`). Observed `result_ack_dropped` (`replayed: false`), fenced replay returning `200 committed` (`replayed: true`), Task `completed` `{ utf8Bytes: 21, unicodeScalars: 21, lines: 3 }`. Duplicate `POST /v2/device-tasks` with identical `operationId` returned HTTP `200` (`replayed: true`); 1 `succeeded` Run. | **PASS** |
| 3 | **Network loss & recovery** | `workDelayMs: 3000` (`taskId: 9fdad17a-bd6e-4734-87c0-da9ad7578a33`). Switched relay `offline` for `4s` after claim, then `online`. Physical iPhone recovered connectivity and committed `{ utf8Bytes: 22, unicodeScalars: 22, lines: 1 }`; Task `completed`. | **PASS** |
| 4 | **Cancellation & lease fencing** | `workDelayMs: 8000` (`taskId: 5700df28-9995-4a57-bdfe-5bf5781fb39f`). Cancelled claimed task (`200 cancelled`). Late `/result` from physical iPhone rejected with HTTP `409` (`fenced`). | **PASS** |
| 5 | **Lease renewal (>30s lease)** | `workDelayMs: 35000`, `deadlineMs: 90000` (`taskId: 5eb05027-1d97-4589-aba2-d3056b6d5544`). Observed 3 `/renew` RPCs (`200 renewed`, `leaseExpiresAtMs: 1795179348545 → 1795179359434 → 1795179368656`) on `leaseEpoch: 1`, then completion beyond 30s (`committed replayed: false`) with 1 `succeeded` Run (`778b6222-e71f-4517-a1ec-36fff0d5925c`). | **PASS** |
| 6 | **Device revocation fail-closed** | Sent `POST /v2/devices/736c5b55-9d03-488a-97b3-5cd18d0d2f96/revoke` (`200 revoked`). Relaunched physical iPhone `/register` denied with HTTP `403 POLICY_DENIED`. Subsequent dispatch (`e0b6d8f1-af94-4373-9ffe-49554688edd5`) remained `queued` with `availability: "device_unavailable"`, `reason: "device_unavailable"` (no silent cloud fallback). | **PASS** |

---

## 2. Supporting Pre-Physical & Runtime Verification Matrix

| Layer / Scenario | Status | Environment & Evidence |
| --- | --- | --- |
| **V2 Local `workerd` M2-F1 + M2-F2** | **PASS (10/10)** | `tests/integration/v2-m2-device-execution-workerd.test.ts` + `tests/integration/v2-m2-native-device-workerd.test.ts` (`da75ed4`). |
| **iOS `CloudDeviceAdapterTests`** | **PASS (24/24)** | `xcodebuild test ... -only-testing:EmberTests/CloudDeviceAdapterTests SWIFT_STRICT_CONCURRENCY=complete` (`da75ed4`). |
| **Real `Ember.app` Simulator E2E** | **PASS (6/6)** | `Ember.app` (`--ember-device-executor --ember-cloud-adapter-qa`) against `V2LocalRuntimeHarness` (`da75ed4`). |
| **Physical `iPhone 12 Pro Max` LAN E2E (M2-D1)** | **PASS (6/6)** | `LocalDeviceAdapter` (`00008101-000E0D923E01001E`) against `V2LocalRuntimeHarness` on `192.168.1.19` (`06071f9`, §1 above). |
