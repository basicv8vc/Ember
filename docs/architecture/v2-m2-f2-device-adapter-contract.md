# M2-F2 Cloud Device Adapter contract

Agent C and the runtime implementation use this contract for the isolated V2
workerd and the standalone `Ember Device QA` iPhone app. The capability is
`device.text.process`, version `1`. Its sole operation is `stats` on inline
UTF-8 text. The Cloud Agent driver selects one registered device ID and reads
the result through Agent Head.

## HTTP and payloads

All calls use the V2 local Worker with the same disposable B1 bearer session.
Register, claim, renew and result also use `X-Device-Token`, a 32-byte random
secret encoded as 64 lowercase hex characters. The app generates the device ID
and secret once and binds them to its local origin and QA account in Keychain.
Re-register the same capability to refresh readiness for 30 seconds. Changing
a registered ID's capability returns 409. The local LAN relay accepts only the
four device routes below, using an additional per-run `X-Ember-Local-Access`
secret. Cloud-side commands remain directly on the Mac's loopback Worker.

| Caller      | Endpoint                                            | Request or response                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone      | `POST /v2/devices/{deviceId}/register`              | `{ "capability": "device.text.process", "version": 1 }`. Response includes `readyUntilMs`.                                                                                                                                                                              |
| Cloud Agent | `POST /v2/device-tasks`                             | Supply UUIDs `deviceId` and `operationId`, `capability`, `version`, `input: { operation: "stats", text }` and optional relative `deadlineMs` (60 seconds by default). A matching dispatch replay returns the existing task with HTTP 200. First acceptance returns 201. |
| iPhone      | `POST /v2/devices/{deviceId}/claim`                 | Send `{}`. An idle response has `kind: "idle"`. An offer includes `kind: "claimed"`, `taskId`, `operationId`, `runId`, `leaseEpoch`, `leaseExpiresAtMs`, `deadlineAtMs`, `capability`, `version`, and `input`.                                                          |
| iPhone      | `POST /v2/devices/{deviceId}/tasks/{taskId}/renew`  | Supply `operationId`, `runId`, and `leaseEpoch`. HTTP 200 returns `{ kind: "renewed", leaseExpiresAtMs }`. An expired, cancelled or superseded fence returns HTTP 409 with `{ kind: "fenced" }`.                                                                        |
| iPhone      | `POST /v2/devices/{deviceId}/tasks/{taskId}/result` | Supply the same fence plus `status: "completed"` and `output: { utf8Bytes, unicodeScalars, lines }`. An executor can report failure with `status: "failed"` and no output. A commit returns `{ kind: "committed", replayed }`.                                          |
| Cloud Agent | `GET /v2/device-tasks/{taskId}`                     | Reads canonical Task status, device availability, reason and typed result. A device with stale readiness or an incompatible capability yields `device_unavailable` while the task is pending.                                                                           |
| Cloud Agent | `POST /v2/device-tasks/{taskId}/cancel`             | Empty body. Cancels a queued or running Task and fences its Run.                                                                                                                                                                                                        |

`text` may be empty and is limited to 4,096 UTF-16 code units with well-formed
Unicode. The app counts UTF-8 bytes and Unicode scalars without normalization.
Empty text has zero lines. Any other text has one line plus the number of LF
characters. A CRLF pair adds one line break, and a standalone CR is counted as
data. For `"𝄞\r\ne\u0301\n"`, the result is
`{ "utf8Bytes": 10, "unicodeScalars": 6, "lines": 3 }`.

## Ownership and recovery

- Agent Head's existing Task, Run, lease epoch and deadline own execution state.
  Placement records pin the capability and version. A device claim can only
  see its own matching placement. Existing `mock.compute` placements and their
  previous dispatch digests continue to work.
- The experimental native lease is 30 seconds and the foreground adapter renews
  at 10-second intervals during ongoing work. Renewal updates both lease rows
  atomically, preserves Run and epoch, and never extends beyond the deadline.
  Repeating a claim while a lease is live returns its existing Run and expiry.
- Backgrounding cancels foreground polling and renewal. After expiry, existing
  Agent Head recovery leaves the task queued for the same device if attempts
  and deadline permit it. Reclaim creates a new Run with a higher lease epoch.
  An obsolete Run cannot publish results or renew.
- Before sending a result, the adapter persists its exact Task and Run fence
  with the output. A lost response leaves that record intact. On reconnect or
  restart the adapter replays it before claiming more work. An identical
  committed result is acknowledged even after lease expiry. An explicit
  `fenced` response retires the obsolete local result. A different result
  payload for the same completed fence is a conflict and leaves the pending
  record intact for inspection.
