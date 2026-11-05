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
            "Sign-in was cancelled. You are not signed in."
        case .keychainUnavailable:
            "Your session could not be saved because the device keychain is locked. Unlock the device and try again."
        case .offline, .timedOut, .transportFailure, .nonHTTPResponse:
            "Ember could not reach the server. Your session was kept on this device; try again when you are online."
        case .serverUnavailable:
            "Ember is temporarily unavailable. Try again shortly."
        case .rateLimited:
            "Too many attempts. Wait a moment and try again."
        case .unauthenticated, .sessionMissing, .sessionEnded:
            "Your session is no longer valid. Sign in again to continue."
        case .storedSessionCorrupt:
            "The saved session could not be read. Sign in again to continue."
        case .invalidResponse, .unexpectedStatus, .notFound, .invalidRequest:
            "The server returned an unexpected response. Nothing was changed on this device."
        case .invalidBaseURL:
            "This build is not configured for a secure Ember endpoint."
        case .appleAuthorizationFailed, .appleCredentialInvalid, .appleAttemptExpired,
            .appleAuthorizationInProgress:
            "Apple sign-in did not complete. Try again."
        case .superseded:
            "A newer sign-in replaced this one."
        case .requestRejectedBeforeExecution, .unknownWriteOutcome:
            "The request was not completed. Nothing was saved."
        }
    }
}
