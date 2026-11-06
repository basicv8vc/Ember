# L2 local QA evidence (2026-11-06)

Captured on a Mac, Xcode 26.3 (17C529), iOS 26.2 Simulator (build `23C52`), dedicated device
`Ember-L2-Final-QA` (iPhone 17 Pro), app signed ad-hoc (`CODE_SIGN_IDENTITY=-`).

Provenance matters more than the images here, so each file states what it is and — just as
importantly — what it is not.

| File                                   | What it shows                                                                  | What it does **not** prove            |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `live-entry-sign-in.png`               | `--ember-live-cloud` with `EMBER_CLOUD_BASE_URL=https://ember-staging.invalid` | Any Cloud request, session, or Turn   |
| `live-invalid-config-fails-closed.png` | The same flag with `http://…` and with no origin at all                        | Nothing beyond the fail-closed branch |
| `mock-conversation-unchanged.png`      | Default App Root, no launch flags: the existing conversation-first UI          | Nothing about Live behaviour          |

All three are simulator captures. None is a staging or physical-device result.

## Why the Live chat states are missing

Sending, waiting for a Turn, failure, cancellation and a real `simulated: true` reply all require an
authenticated session. Two things are absent on this host and in this project:

1. `Ember.xcodeproj` has no `com.apple.developer.applesignin` entitlement and no `DEVELOPMENT_TEAM`,
   so Sign in with Apple cannot complete even if an Apple ID is present in the Simulator.
2. There is no deployed HTTPS B1 origin. `apps/api` only accepts `EMBER_ENV` of `local`, `test` or
   `ci`, binds loopback by default, and serves plain HTTP; the iOS client refuses anything but
   `https`.

The absence of these screenshots is therefore a statement about the environment, not about the code.

## Reproducing

```bash
xcrun simctl runtime match set iphoneos26.2 23C52   # only if xcodebuild lists no simulator
xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -configuration Debug \
  -destination 'platform=iOS Simulator,name=Ember-L2-Final-QA' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  SWIFT_STRICT_CONCURRENCY=complete \
  OTHER_SWIFT_FLAGS="-Xfrontend -disable-sandbox" test
```

Then launch with `--ember-live-cloud` and either a valid HTTPS origin or a deliberately invalid one.
