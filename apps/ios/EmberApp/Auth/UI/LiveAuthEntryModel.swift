import Foundation
import Observation

/// Presentation state for the isolated Live authentication entry point.
///
/// The model holds no credential. It asks the coordinator for the authoritative profile and renders
/// the outcome, so a SwiftUI view can never accidentally remember or compare token values.
@MainActor
@Observable
final class LiveAuthEntryModel {
    /// What the entry point is currently doing.
    ///
    /// `cancelled` is deliberately separate from `failed`: a person dismissing the Apple sheet has not
    /// experienced an error, and showing one would be untruthful.
    enum Phase: Equatable {
        case idle
        case authorizing
        case cancelled
        case failed(AuthError)
        case signedIn(EmberMeDTO)

        var isBusy: Bool { self == .authorizing }
    }

    typealias SignInAction = @MainActor () async throws -> EmberMeDTO

    private(set) var phase: Phase = .idle

    @ObservationIgnored
    private let signInAction: SignInAction

    /// Production wiring: sign in, then read the authoritative projection.
    convenience init(coordinator: LiveAuthSessionCoordinator) {
        self.init {
            try await coordinator.signInWithApple()
            return try await coordinator.restoreSession()
        }
    }

    /// Injected action, used by previews and tests so no Apple account or network is required.
    init(signInAction: @escaping SignInAction) {
        self.signInAction = signInAction
    }

    var isBusy: Bool { phase.isBusy }

    /// A short, truthful status line. It never claims that chat is available.
    var statusMessage: String {
        switch phase {
        case .idle:
            "Sign in with Apple to create a secure Ember session on this device."
        case .authorizing:
            "Signing in with Apple…"
        case .cancelled:
            "Sign-in was cancelled. You are not signed in."
        case .failed(let error):
            Self.message(for: error)
        case .signedIn(let profile):
            "Signed in as \(profile.agent.displayName). Live chat is not enabled in this build."
        }
    }

    var signedInProfile: EmberMeDTO? {
        if case .signedIn(let profile) = phase { return profile }
        return nil
    }

    func signIn() async {
        guard !isBusy else { return }

        phase = .authorizing
        do {
            let profile = try await signInAction()
            phase = .signedIn(profile)
        } catch let error as AuthError {
            phase = error == .appleCancelled ? .cancelled : .failed(error)
        } catch is CancellationError {
            phase = .cancelled
        } catch {
            phase = .failed(.transportFailure)
        }
    }

    /// Dismisses a cancel or error notice, returning to the actionable state.
    func clearNotice() {
        switch phase {
        case .cancelled, .failed:
            phase = .idle
        case .idle, .authorizing, .signedIn:
            break
        }
    }

    /// User-facing wording for a typed failure. Recoverable conditions say so; a dead session says so.
    static func message(for error: AuthError) -> String {
        switch error {
        case .appleCancelled:
            String(localized: "auth.error.apple_cancelled", table: "Conversation")
        case .keychainUnavailable:
            String(localized: "auth.error.keychain_unavailable", table: "Conversation")
        case .offline, .timedOut, .transportFailure, .nonHTTPResponse:
            String(localized: "auth.error.network_unreachable", table: "Conversation")
        case .serverUnavailable:
            String(localized: "auth.error.server_unavailable", table: "Conversation")
        case .rateLimited:
            String(localized: "auth.error.rate_limited", table: "Conversation")
        case .unauthenticated, .sessionMissing, .sessionEnded:
            String(localized: "auth.error.session_invalid", table: "Conversation")
        case .accessDenied:
            String(localized: "auth.error.access_denied", table: "Conversation")
        case .rotationOutcomeUnknown:
            String(localized: "auth.error.rotation_unknown", table: "Conversation")
        case .recoveryFenceUnavailable:
            String(localized: "auth.error.recovery_fence_unavailable", table: "Conversation")
        case .storedSessionCorrupt:
            String(localized: "auth.error.stored_session_corrupt", table: "Conversation")
        case .invalidResponse, .unexpectedStatus, .notFound, .invalidRequest:
            String(localized: "auth.error.unexpected_response", table: "Conversation")
        case .invalidBaseURL:
            String(localized: "auth.error.invalid_base_url", table: "Conversation")
        case .appleAuthorizationFailed, .appleCredentialInvalid, .appleAttemptExpired,
            .appleAuthorizationInProgress:
            String(localized: "auth.error.apple_incomplete", table: "Conversation")
        case .superseded:
            String(localized: "auth.error.superseded", table: "Conversation")
        case .requestRejectedBeforeExecution, .unknownWriteOutcome:
            String(localized: "auth.error.request_not_completed", table: "Conversation")
        }
    }
}
