import AuthenticationServices
import SwiftUI

/// The minimal, clearly isolated Live authentication entry point.
///
/// It is **not** wired into `AppCompositionRoot`, which keeps running the Mock experience by default.
/// Nothing switches this on because a token exists or because the network is reachable: composition
/// is an explicit, reviewed decision (IOS_LIVE_REPOSITORY_INTEGRATION_PLAN §3).
///
/// The copy never claims that cloud chat works. It says what the session does and that Live
/// conversation is not enabled in this build, which is the truth at L1.
struct LiveAuthEntryView: View {
    @State private var model: LiveAuthEntryModel

    init(model: LiveAuthEntryModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            AppleSignInControl(isEnabled: !model.isBusy) {
                Task { await model.signIn() }
            }
            .frame(height: 50)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("live-auth-sign-in")
            .accessibilityLabel("Sign in with Apple")
            .accessibilityHint("Creates a secure Ember session on this device.")

            if model.isBusy {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(model.statusMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("live-auth-progress")
            }

            switch model.phase {
            case .cancelled:
                InlineNotice(
                    title: "Sign-in cancelled",
                    message: "No credentials were stored. You are not signed in.",
                    tone: .neutral
                )
                .accessibilityIdentifier("live-auth-cancelled")
            case .failed(let error):
                InlineNotice(
                    title: "Sign-in failed",
                    message: LocalizedStringKey(LiveAuthEntryModel.message(for: error)),
                    tone: .error
                )
                .accessibilityIdentifier("live-auth-error")
            case .signedIn:
                InlineNotice(
                    title: "Session stored in Keychain",
                    message: "Live chat is not enabled yet. This session will be reused when it is.",
                    tone: .success
                )
                .accessibilityIdentifier("live-auth-signed-in")
            case .idle, .authorizing:
                EmptyView()
            }

            if !model.isBusy,
                case .idle = model.phase
            {
                Text(model.statusMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if model.phase == .cancelled {
                Button("Dismiss") { model.clearNotice() }
                    .font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("live-auth-dismiss-notice")
            }

            if case .failed = model.phase {
                Button("Dismiss") { model.clearNotice() }
                    .font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("live-auth-dismiss-notice")
            }
        }
        .padding(20)
        .frame(maxWidth: 520)
        .background(EmberDesignTokens.groupedBackground)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Live account")
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)

            Text("A secure Ember session is required before Live conversation can be enabled.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The native Sign in with Apple control.
///
/// `ASAuthorizationAppleIDButton` is used rather than a custom-styled button so the control keeps the
/// platform's required appearance, wording and hit target. The tap handler is a plain closure because
/// authorization itself lives behind `AppleSignInAuthorizing`, which is testable.
struct AppleSignInControl: UIViewRepresentable {
    let isEnabled: Bool
    let action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(type: .signIn, style: .black)
        button.addTarget(
            context.coordinator,
            action: #selector(Coordinator.activate),
            for: .touchUpInside
        )
        button.isAccessibilityElement = true
        button.accessibilityLabel = "Sign in with Apple"
        return button
    }

    func updateUIView(_ button: ASAuthorizationAppleIDButton, context: Context) {
        context.coordinator.action = action
        button.isEnabled = isEnabled
        button.alpha = isEnabled ? 1 : 0.5
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func activate() {
            action()
        }
    }
}

#Preview("Live auth entry") {
    LiveAuthEntryView(
        model: LiveAuthEntryModel {
            throw AuthError.offline
        }
    )
}
