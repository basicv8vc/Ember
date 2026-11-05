# iOS UI Test Stability (iOS 27 Simulator)

This note records the two UI test failures that were fixed in this change and the
environment facts needed to reproduce the run. It is documentation only; no product
behaviour changes are described here beyond the accessibility identifiers on message
bubbles.

## 1. Message bubbles were counted twice (PR #98 regression test)

`ConversationRootLaunchUITests.testOnboardingChatSendShowsMockAcknowledgementOnce` asserted
`XCTAssertEqual(count, 1)` on `app.descendants(matching: .any).matching(label CONTAINS …)`.
On the iOS 27 runtime the combined message bubble **and** its inner text node are both
exported as `StaticText` with the message text, so a single message matched twice:

```text
StaticText  label: 'You, Verify the first chat mock acknowledgement., 1:37 PM'   (bubble)
StaticText  label: 'Verify the first chat mock acknowledgement.'                 (inner text)
```

The bubble therefore carries a stable identifier (`conversation-message-user` /
`conversation-message-ember`) and the test resolves bubbles inside the
`conversation-timeline` scroll view instead of scanning the whole app with `.any`.
One identifier element is produced per rendered message, so a genuinely duplicated
message still fails the `count == 1` assertion.

## 2. `compose-submit` was not the problem; the tap target was covered

Compose pins its submit button over the scroll content with `safeAreaInset`. At the
default scroll offset the "演示回执丢失" switch sits directly behind that bar:

```text
Switch 'compose-simulate-unknown-receipt'  y 715.0 … 769.7
Button 'compose-submit'                    y 718.7 … 783.0   (drawn above, sibling of the ScrollView)
```

XCUITest still reports the covered switch as `isHittable == true`, so the tap was
delivered to the submit button. The form submitted, the receipt sheet replaced Compose,
and the following `app.buttons["compose-submit"]` lookup failed with
`No matches found`. The `Automation type mismatch … PopUpButton` line in the failure
output is unrelated: `compose-submit` is a plain `Button` (`elementType == .button`,
`popUpButtons` match is empty); that diagnostic belongs to the Inbox demo-states `Menu`
that happened to be in the tree after the app navigated to Inbox.

`MockTaskJourneyLaunchUITests` now scrolls the switch clear of the bar, then proves the
switch itself flipped (`value == "1"`) and that no receipt appeared before Submit was
pressed. Coverage is unchanged and no assertion was removed.

Follow-up for the iOS Lead (not fixed here, no blocking defect): the switch is effectively
hidden under the submit bar at rest. The content scrolls 99 pt, so it stays reachable, but
the affordance would read better with extra bottom content padding on Compose.

## 3. How the suite was executed here

Xcode 26.3 (17C529) cannot enumerate simulator destinations on this host because the
system `CoreSimulator.framework` is the 1166 / `DTXcodeBuild 27A5209c` component. The
`-xctestrun` + `test-without-building` path bypasses destination enumeration:

```bash
xcodebuild -xctestrun Build/Products/Ember-ui.xctestrun \
  -derivedDataPath <dd> -destination 'platform=iOS Simulator,id=<udid>' \
  -resultBundlePath <run>.xcresult -parallel-testing-enabled NO \
  test-without-building
```

Two environment constraints apply on this host and are unrelated to the app:

- Swift macro expansion needs `-Xfrontend -disable-sandbox`, otherwise
  `swift-plugin-server` reports "produced malformed response" (nested `sandbox_apply` is
  refused in this build session).
- After the last UI test case, xcodebuild can hang on a `simctl` child whose CoreSimulator
  XPC call never returns, leaving the bundle unreadable (no `Info.plist`). Terminating that
  single child once the test summary is printed lets xcodebuild finalise the `.xcresult`.
