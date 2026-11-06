import Foundation

/// The result of one successful Sign in with Apple authorization.
///
/// `identityToken` is an Apple JWT and `rawNonce` is the nonce whose SHA-256 Apple signed. Both are
/// private assertion contents: they are sent to the Ember backend exactly once for
/// `POST /v1/auth/session` and are never logged, persisted, or described.
public struct AppleSignInCredential: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible, CustomReflectable
{
    public let identityToken: String
    public let rawNonce: String
    /// The attempt this credential belongs to. Callers use it to reject a completion that
    /// arrives after a newer attempt started.
    public let attemptID: UUID

    public init(identityToken: String, rawNonce: String, attemptID: UUID) {
        self.identityToken = identityToken
        self.rawNonce = rawNonce
        self.attemptID = attemptID
    }

    public var description: String {
        "AppleSignInCredential(<redacted>, attempt: \(attemptID.uuidString))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        let children: [(label: String?, value: Any)] = [
            (label: "identityToken", value: "<redacted>"),
            (label: "rawNonce", value: "<redacted>"),
            (label: "attemptID", value: attemptID),
        ]
        return Mirror(self, children: children, displayStyle: .struct)
    }
}

/// Anything that can produce an Apple credential: the live `ASAuthorizationController` adapter,
/// or a deterministic test double. The Ember backend — not this app — owns Apple JWT trust policy,
/// so no implementation inspects the token's claims.
///
/// The requirement is main-actor isolated because native authorization presents UI. That is a
/// property of the capability, not an implementation detail: a fake that must be callable from an
/// arbitrary executor would not be modelling the same thing.
public protocol AppleSignInAuthorizing: Sendable {
    /// Starts a native authorization and returns its credential.
    ///
    /// Throws `AuthError.appleCancelled` when the person dismisses the sheet, and
    /// `AuthError.appleAttemptExpired` when a late or stale callback is refused.
    @MainActor func authorize() async throws -> AppleSignInCredential
}

/// One in-flight authorization attempt, identified so a stale completion can be refused.
public struct AppleSignInAttempt: Equatable, Sendable {
    public let id: UUID
    public let nonce: AppleNonce

    init(id: UUID, nonce: AppleNonce) {
        self.id = id
        self.nonce = nonce
    }
}

/// The bounded lifetime bookkeeping for a single authorization attempt.
///
/// This is deliberately a value type with no Apple, UI or clock dependency, so the invariants the
/// live adapter relies on — one attempt at a time, no reuse of an attempt, no acceptance of an
/// expired or superseded callback — are deterministic in unit tests. The live authorizer holds one
/// of these; tests drive it directly.
public struct AppleSignInAttemptLedger: Sendable {
    public private(set) var pending: AppleSignInAttempt?

    public init() {}

    /// Starts an attempt. Refuses to start a second concurrent attempt, because two live
    /// `ASAuthorizationController`s would make "which callback is current" unanswerable.
    public mutating func begin(nonce: AppleNonce, id: UUID = UUID()) throws -> AppleSignInAttempt {
        guard pending == nil else { throw AuthError.appleAuthorizationInProgress }
        let attempt = AppleSignInAttempt(id: id, nonce: nonce)
        pending = attempt
        return attempt
    }

    /// Consumes the pending attempt if `attemptID` is the current one and its nonce is still live.
    ///
    /// A completion for anything else is refused and clears nothing: an old attempt must never be
    /// able to end a newer one. `AuthError.appleAttemptExpired` covers both the stale and the
    /// out-of-window case, because the caller's action is identical — discard the credential.
    public mutating func complete(attemptID: UUID, at date: Date) throws -> AppleSignInAttempt {
        guard let attempt = pending, attempt.id == attemptID else {
            throw AuthError.appleAttemptExpired
        }
        pending = nil

        guard attempt.nonce.isValid(at: date) else { throw AuthError.appleAttemptExpired }
        return attempt
    }

    /// Abandons `attemptID`. Unknown or already-consumed identifiers are ignored, so a
    /// cancellation that races a completion cannot corrupt the ledger.
    public mutating func cancel(attemptID: UUID) {
        guard pending?.id == attemptID else { return }
        pending = nil
    }

    public var hasPendingAttempt: Bool {
        pending != nil
    }
}

/// Validates the credential material Apple hands back, before anything is sent to the backend.
///
/// Apple can complete successfully with `identityToken == nil`; that is an authentication failure,
/// not an empty session. The token must be non-empty UTF-8 without surrounding whitespace, because
/// a `Data` that does not decode cleanly cannot be a JWT the server can verify.
enum AppleCredentialValidator {
    static func identityToken(from data: Data?) throws -> String {
        guard let data, !data.isEmpty else { throw AuthError.appleCredentialInvalid }
        guard let token = String(data: data, encoding: .utf8) else {
            throw AuthError.appleCredentialInvalid
        }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw AuthError.appleCredentialInvalid }
        return trimmed
    }
}
