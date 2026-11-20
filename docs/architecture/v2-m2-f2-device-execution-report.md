# M2-F2 native device execution QA

## Local acceptance

| Check                                 | Evidence                                                                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node build, typecheck, and unit suite | 1,799 unit tests pass, including upgrading cloud Tasks and existing M2-F1 device placements in Agent Head SQLite.                                                                                                                       |
| V2 local workerd                      | All 10 M2-F1 and M2-F2 workerd cases passed. They cover capability placement, immutable registration, renewal of both lease rows, deadline clamping, expired lease recovery, cancellation fencing, and repeated or conflicting commits. |
| Swift unit tests                      | Four tests passed on the Simulator and on iPhone 12 Pro Max. They cover native Unicode statistics, local-origin checks, pending-result persistence and replay, and conflict versus explicit fencing.                                    |
| iOS Simulator lifecycle               | XCUITest covers losing foreground on Home and reactivation.                                                                                                                                                                             |
| iPhone 12 Pro Max                     | On iOS 27.0.1, the development-signed standalone app installed, received its disposable local config over USB, and reached the foreground.                                                                                              |

The iPhone integration attempt reached registration in the Swift adapter.
CFNetwork reported `-1009` with `Local network prohibited` and no registration
arrived at workerd. The physical Cloud-to-Device scenarios below require
iOS Local Network permission for Ember Device QA. Physical task execution,
including device-side renewal, disconnect and ACK-loss recovery, is unverified.
[Apple local network privacy guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)

## Run on an iPhone

1. From the repository root, install the locked dependencies and run `pnpm build`.
   Build `apps/ios/LocalDeviceAdapter/LocalDeviceAdapter.xcodeproj` with scheme
   `LocalDeviceAdapter`, using Debug configuration and a development team. Install
   the resulting standalone app. The production Ember bundle is separate.
2. Put the iPhone and Mac on the same private LAN. The relay binds only the Mac's
   supplied LAN address, creates a disposable dev session and writes a private
   config file. Use synthetic input and the disposable credentials for this run.

   ```sh
   QA_DIR=$(mktemp -d)
   pnpm exec tsx tests/integration/support/iphone-native-qa.ts <mac-private-ip> "$QA_DIR"
   ```

3. Copy the generated config to the app's data container and launch the app.
   Allow local network access on the iPhone if prompted. The relay reports
   `device_registered` when the iPhone becomes ready.

   ```sh
   xcrun devicectl device copy to --device <iphone-udid> \
     --domain-type appDataContainer \
     --domain-identifier com.basicv8vc.ember.local-device-adapter \
     --source "$QA_DIR/local-device-qa.json" \
     --destination Documents/local-device-qa.json

   xcrun devicectl device process launch --device <iphone-udid> \
     --terminate-existing --console com.basicv8vc.ember.local-device-adapter
   ```

4. Send one JSON control message per line to the relay's standard input. Use
   `{"action":"dispatch","text":"𝄞\r\ne\u0301\n","deadlineMs":90000}`
   for the reference payload. Use `{"action":"status","taskId":"<uuid>"}`
   to read the result and `{"action":"runs","taskId":"<uuid>"}` to inspect the
   corresponding DO Run rows. The relay logs RPC status, fences, and replay flags.
5. Quit with `{"action":"exit"}`. The loopback Worker and LAN relay are disposed.

## Physical scenarios

| Scenario                   | Procedure and pass evidence                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native result              | Dispatch the reference payload. Observe a device claim and result commit, then read the workerd Task as completed with `utf8Bytes: 10`, `unicodeScalars: 6`, and `lines: 3`.                                                                                                                                                                                            |
| Renewal                    | Send `{"action":"delay","workDelayMs":35000}`, copy the updated configuration, and relaunch before dispatch. Observe renewals about every 10 seconds, one unchanged Run and epoch, and one completion beyond the initial 30-second lease.                                                                                                                               |
| Network loss               | After the device claims, use `{"action":"mode","mode":"offline"}` to cut only its relay connection. Restore with `{"action":"mode","mode":"online"}`. Observe device connectivity recovery and completion. For radio loss, turn off the iPhone's Wi-Fi with cellular and other routes to the relay unavailable, then restore it. Record which condition was exercised.  |
| Background and expiry      | Hold a delayed, claimed task in the background for more than 30 seconds. Verify the first Run is `lease_expired` while the iPhone is backgrounded. Resume the app and observe a higher epoch and a new Run on the same Task.                                                                                                                                            |
| Cancellation               | Cancel a delayed claimed task via `{"action":"cancel","taskId":"<uuid>"}`. Expect a cancelled Task and a 409 fence on a late renewal or result.                                                                                                                                                                                                                         |
| Duplicates and unknown ACK | Use `{"action":"mode","mode":"drop-result-ack"}` before dispatch. The relay drops the first successful result response after workerd commits. Expect the iPhone to replay the same fence and receive `replayed: true`. Resend the Cloud dispatch with the original operation ID and identical input to verify the same Task ID. Check that there is one successful Run. |

Relay modes inject transport loss for QA without changing Worker behavior. When
relaunching after an unknown response, retain the config and the app container
so the device can reopen its pending result.
