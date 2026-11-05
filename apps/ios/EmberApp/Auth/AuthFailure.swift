import Foundation

/// The closed set of failures the L1 authentication foundation can report.
///
/// Every case is payload-free by construction: no Apple assertion, raw nonce, access token,
/// subject, email, server message text or request body is ever carried in an error. That keeps
/// `String(describing:)`, `debugDescription`, crash breadcrumbs and unified logging safe to use
/// on these values without a separate redaction pass.
///
/// The distinction between `unauthenticated` and `keychainUnavailable` is load-bearing
/// (ADR-0004 §5.1 I-8, annex §10.3): a temporarily unreadable Keychain must never be reported as
/// a signed-out consumer, and an invalid credential must never be reported as a transient fault.
public enum AuthError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    // MARK: Apple identity

    /// The person dismissed the Sign in with Apple sheet. Distinct from a failed authorization.
    case appleCancelled
    /// Apple's authorization completed with an error other than cancellation.
    case appleAuthorizationFailed
    /// Apple returned no identity token, or one that is empty/invalid UTF-8.
    case appleCredentialInvalid
    /// A late callback arrived for an attempt that is no longer the current one, or whose
    /// nonce outlived its bounded lifetime. Its credential is discarded, never used.
    case appleAttemptExpired
    /// An authorization attempt was already running when a second one started.
    case appleAuthorizationInProgress

    // MARK: Session HTTP

    /// 400 from a session route. The request was refused before any identity work happened.
    case invalidRequest
    /// 401. The credential is invalid, expired or revoked. Recovery requires a new sign-in
    /// once the bounded refresh path has been exhausted.
    case unauthenticated
    /// 404. `GET /v1/me` answers this only when the projection is not visible; it is never a
    /// prompt to create anything locally.
    case notFound
    /// 429. The per-conversation safety quota is exhausted; retrying cannot help.
    case rateLimited
    /// 503 or another 5xx. Recoverable, but only with backoff.
    case serverUnavailable
    /// A 2xx other than the one status this route freezes, or any unmodelled status.
    case unexpectedStatus(Int)
    /// A malformed, truncated, or contract-violating response body.
    case invalidResponse
    /// A non-HTTP URLSession response.
    case nonHTTPResponse

    // MARK: Transport

    /// No usable network path. The locally stored session stays valid and must not be deleted.
    case offline
    /// The request timed out. For a write the outcome is unknown; it is never replayed here.
    case timedOut
    /// Any other transport failure with no safe interpretation.
    case transportFailure

    // MARK: Local credential storage

    /// Keychain is locked, not yet unlocked once, or otherwise momentarily unavailable.
    /// This is never a sign-out.
    case keychainUnavailable
    /// A stored record exists but cannot be decoded. Treated as unrecoverable for that record,
    /// without silently deleting it.
    case storedSessionCorrupt
    /// There is no local session to act on.
    case sessionMissing

    // MARK: Coordination

    /// A newer sign-in, refresh or logout superseded this operation. Its result must be dropped.
    case superseded
    /// A request carried a non-idempotent method and was answered 401 before execution. It was
    /// deliberately not replayed; the caller may resubmit with the same `client_submission_id`.
    case requestRejectedBeforeExecution
    /// A non-idempotent request failed at the transport layer. The server outcome is unknown and
    /// the request must not be replayed; `client_submission_id` reconciliation belongs to L2.
    case unknownWriteOutcome(clientSubmissionID: String?)
    /// The injected API base URL is not an acceptable secure origin.
    case invalidBaseURL
    /// The caller asked for an authenticated request after that session ended.
    case sessionEnded

    public var description: String {
        switch self {
        case .appleCancelled: "appleCancelled"
        case .appleAuthorizationFailed: "appleAuthorizationFailed"
        case .appleCredentialInvalid: "appleCredentialInvalid"
        case .appleAttemptExpired: "appleAttemptExpired"
        case .appleAuthorizationInProgress: "appleAuthorizationInProgress"
        case .invalidRequest: "invalidRequest"
        case .unauthenticated: "unauthenticated"
        case .notFound: "notFound"
        case .rateLimited: "rateLimited"
        case .serverUnavailable: "serverUnavailable"
        case .unexpectedStatus(let status): "unexpectedStatus(\(status))"
        case .invalidResponse: "invalidResponse"
        case .nonHTTPResponse: "nonHTTPResponse"
        case .offline: "offline"
        case .timedOut: "timedOut"
        case .transportFailure: "transportFailure"
        case .keychainUnavailable: "keychainUnavailable"
        case .storedSessionCorrupt: "storedSessionCorrupt"
        case .sessionMissing: "sessionMissing"
        case .superseded: "superseded"
        case .requestRejectedBeforeExecution: "requestRejectedBeforeExecution"
        case .unknownWriteOutcome: "unknownWriteOutcome"
        case .invalidBaseURL: "invalidBaseURL"
        case .sessionEnded: "sessionEnded"
        }
    }

    public var debugDescription: String { description }

    /// True when the only honest recovery is a fresh Sign in with Apple.
    public var requiresNewSignIn: Bool {
        switch self {
        case .unauthenticated, .sessionMissing, .sessionEnded, .storedSessionCorrupt:
            true
        default:
            false
        }
    }

    /// True when a later attempt on the same device could succeed without new credentials.
    public var isTransient: Bool {
        switch self {
        case .offline, .timedOut, .transportFailure, .serverUnavailable, .keychainUnavailable,
            .rateLimited, .nonHTTPResponse:
            true
        default:
            false
        }
    }

    /// True when the local credential must be kept. Deleting it here would turn a temporary
    /// condition into a sign-out, which annex §10.3 forbids.
    public var preservesLocalSession: Bool {
        switch self {
        case .offline, .timedOut, .transportFailure, .serverUnavailable, .keychainUnavailable,
            .rateLimited, .nonHTTPResponse, .superseded:
            true
        default:
            false
        }
    }
}

/// The truthful outcome of a logout attempt.
///
/// A 401 from `DELETE /v1/auth/session` means the presented token no longer authenticates
/// anything, which is the state logout wanted; a network or 5xx failure means the server may
/// still hold an active session. Callers must show the difference rather than claiming success.
public enum LogoutOutcome: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// 204: the server revoked the presented session.
    case revokedRemotely
    /// 401: the token was already invalid. The server holds no usable session for it.
    case alreadyInvalidated
    /// Local credentials were removed, but the server could not be told.
    case remoteUnconfirmed(AuthError)
    /// The server was told, but the local credential could not be removed.
    case localCleanupFailed(AuthError)

    public var description: String {
        switch self {
        case .revokedRemotely: "revokedRemotely"
        case .alreadyInvalidated: "alreadyInvalidated"
        case .remoteUnconfirmed(let error): "remoteUnconfirmed(\(error))"
        case .localCleanupFailed(let error): "localCleanupFailed(\(error))"
        }
    }

    public var debugDescription: String { description }

    /// True only when no usable credential remains locally and the server is not known to hold one.
    public var isFullySignedOut: Bool {
        switch self {
        case .revokedRemotely, .alreadyInvalidated: true
        case .remoteUnconfirmed, .localCleanupFailed: false
        }
    }
}
