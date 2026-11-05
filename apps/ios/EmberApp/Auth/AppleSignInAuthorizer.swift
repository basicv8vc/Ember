import AuthenticationServices
import Foundation
import UIKit

/// Live `ASAuthorizationController` adapter for Sign in with Apple.
///
/// Responsibilities, and nothing else:
///
/// 1. Mint a fresh CSPRNG nonce for **every** attempt.
/// 2. Hand Apple the SHA-256 hex of that nonce; keep the raw value for the Ember backend.
/// 3. Bind the callback to exactly one attempt, with a bounded lifetime, so a late or superseded
///    completion cannot be mistaken for the current one.
/// 4. Turn Apple's credential into a validated identity token string.
///
/// It deliberately does **not** parse the JWT, inspect `sub`, `email` or `aud`, or decide whether the
/// token is trustworthy: the Ember backend owns Apple JWT verification and account provisioning
/// (ADR-0004 annex §5.2). Duplicating that trust policy here would create a second, weaker authority.
@MainActor
public final class AppleSignInAuthorizer: NSObject, AppleSignInAuthorizing {
    private let randomSource: SecureRandomByteSource
    private let now: @Sendable () -> Date
    private let nonceLifetime: TimeInterval
    private let anchorProvider: @MainActor () -> ASPresentationAnchor?

    private var ledger = AppleSignInAttemptLedger()
    private var continuation: CheckedContinuation<AppleSignInCredential, Error>?
    private var activeController: ASAuthorizationController?
    private var timeoutTask: Task<Void, Never>?

    public init(
        randomSource: SecureRandomByteSource = SystemSecureRandomByteSource(),
        nonceLifetime: TimeInterval = AppleNonceGenerator.defaultLifetime,
        now: @escaping @Sendable () -> Date = { Date() },
        anchorProvider: @escaping @MainActor () -> ASPresentationAnchor? =
            AppleSignInAuthorizer.keyWindowAnchor
    ) {
        self.randomSource = randomSource
        self.nonceLifetime = nonceLifetime
        self.now = now
        self.anchorProvider = anchorProvider
        super.init()
    }

    // MARK: - AppleSignInAuthorizing

    public func authorize() async throws -> AppleSignInCredential {
        guard continuation == nil else { throw AuthError.appleAuthorizationInProgress }
        guard anchorProvider() != nil else {
            // Without a window there is nothing to present from; failing loudly beats a silent
            // no-op that leaves the UI in a spinner.
            throw AuthError.appleAuthorizationFailed
        }

        let nonce: AppleNonce
        do {
            nonce = try AppleNonceGenerator.make(
                source: randomSource,
                now: now(),
                lifetime: nonceLifetime
            )
        } catch {
            throw AuthError.appleAuthorizationFailed
        }

        let attempt = try ledger.begin(nonce: nonce)

        let request = ASAuthorizationAppleIDProvider().createRequest()
        // I-3: email and display name are not identity and are never requested, received or
        // stored. Requesting no scopes also keeps the sheet honest about what is collected.
        request.requestedScopes = []
        request.nonce = nonce.hashedValue

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        activeController = controller

        startTimeout(for: attempt)

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                controller.performRequests()
            }
        } onCancel: {
            // The enclosing Task was cancelled (view dismissed, sign-in superseded). Tearing the
            // sheet down here means no credential can be stored after the caller has moved on.
            let attemptID = attempt.id
            Task { @MainActor [weak self] in
                self?.abortCurrentAttempt(attemptID, with: AuthError.appleCancelled)
            }
        }
    }

    /// Number of attempts that were started and are still unresolved. Test-facing so a superseded
    /// attempt can be observed without exposing the credential.
    var hasPendingAttempt: Bool { ledger.hasPendingAttempt }

    // MARK: - Attempt lifecycle

    private func startTimeout(for attempt: AppleSignInAttempt) {
        timeoutTask?.cancel()
        timeoutTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .seconds(self.nonceLifetime))
            } catch {
                return
            }
            // Only refuse if this is still the live attempt. A completed attempt has already
            // cleared the ledger, so this becomes a no-op rather than a late failure.
            self.abortCurrentAttempt(attempt.id, with: AuthError.appleAttemptExpired)
        }
    }

    /// Ends `attemptID` if it is still the live attempt. An unknown or already-consumed identifier
    /// is ignored, so a cancellation that races a newer attempt cannot destroy it.
    private func abortCurrentAttempt(_ attemptID: UUID, with error: AuthError) {
        guard ledger.pending?.id == attemptID else { return }

        ledger.cancel(attemptID: attemptID)
        timeoutTask?.cancel()
        timeoutTask = nil
        activeController?.cancel()
        activeController = nil

        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(throwing: error)
    }

    private func finish(_ result: Result<AppleSignInCredential, Error>) {
        timeoutTask?.cancel()
        timeoutTask = nil
        activeController = nil

        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    // MARK: - Presentation anchor

    /// Default anchor: the key window of the active foreground scene.
    public static func keyWindowAnchor() -> ASPresentationAnchor? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }

        for scene in scenes {
            if let key = scene.windows.first(where: \.isKeyWindow) { return key }
        }
        return scenes.first?.windows.first
    }
}

/// Apple reports a deliberate dismissal as `ASAuthorizationError.canceled`. Cancellation must not be
/// reported as an authentication failure, so the check is centralized and made domain-aware: a bare
/// integer comparison would also match an unrelated error that happens to use code 1001.
enum AppleAuthorizationCancellation {
    static let domain = "com.apple.AuthenticationServices.AuthorizationError"

    static func isCancellation(_ error: Error) -> Bool {
        if let error = error as? ASAuthorizationError, error.code == .canceled { return true }
        if let error = error as? URLError, error.code == .cancelled { return true }

        let nsError = error as NSError
        return nsError.domain == domain && nsError.code == ASAuthorizationError.Code.canceled.rawValue
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension AppleSignInAuthorizer: ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // `authorize()` refuses to start without an anchor, so this fallback is unreachable in
        // practice and exists only because the delegate method cannot fail.
        anchorProvider() ?? ASPresentationAnchor()
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        // A callback from a controller we no longer own belongs to an abandoned attempt. Dropping
        // it is the whole point of tracking `activeController`.
        guard controller === activeController else { return }
        guard let pending = ledger.pending else {
            finish(.failure(AuthError.appleAttemptExpired))
            return
        }

        do {
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                throw AuthError.appleAuthorizationFailed
            }
            // `credential.user` (the Apple subject) is intentionally never read: the client is not
            // an identity authority, so the subject never enters app memory as a stored value.
            let identityToken = try AppleCredentialValidator.identityToken(from: credential.identityToken)

            // Consuming the attempt here is what makes an expired or superseded nonce unusable.
            let attempt = try ledger.complete(attemptID: pending.id, at: now())

            finish(
                .success(
                    AppleSignInCredential(
                        identityToken: identityToken,
                        rawNonce: attempt.nonce.rawValue,
                        attemptID: attempt.id
                    )
                )
            )
        } catch {
            if ledger.pending?.id == pending.id {
                ledger.cancel(attemptID: pending.id)
            }
            finish(.failure(error))
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        guard controller === activeController, let pending = ledger.pending else { return }

        abortCurrentAttempt(
            pending.id,
            with: AppleAuthorizationCancellation.isCancellation(error)
                ? AuthError.appleCancelled
                : AuthError.appleAuthorizationFailed
        )
    }
}
