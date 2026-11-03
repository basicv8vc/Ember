import Foundation

/// An Ember consumer session returned by the approved B1 session contract.
///
/// The access token is intentionally non-Codable and is never persisted by this type.
/// A production provider must store it in Keychain with the B1-required accessibility class.
public struct AuthSession: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let sessionID: UUID
    public let consumerID: UUID
    public let accessToken: String
    public let expiresAt: Date

    public init?(
        sessionID: UUID,
        consumerID: UUID,
        accessToken: String,
        expiresAt: Date
    ) {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        self.sessionID = sessionID
        self.consumerID = consumerID
        self.accessToken = accessToken
        self.expiresAt = expiresAt
    }

    public var description: String {
        "AuthSession(sessionID: \(sessionID), consumerID: \(consumerID), accessToken: <redacted>, expiresAt: \(expiresAt))"
    }

    public var debugDescription: String {
        description
    }
}

/// The current state of the consumer session boundary.
///
/// unavailable is distinct from unauthenticated: it means the provider cannot currently
/// determine session state and must not be treated as an instruction to sign the user out.
public enum AuthSessionState: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case authenticated(AuthSession)
    case unauthenticated
    case unavailable

    public var description: String {
        switch self {
        case .authenticated:
            "authenticated(<redacted>)"
        case .unauthenticated:
            "unauthenticated"
        case .unavailable:
            "unavailable"
        }
    }

    public var debugDescription: String {
        description
    }
}

/// Supplies the currently installed Ember consumer session to the application.
///
/// This interface does not implement Apple sign-in, session minting/refresh/logout, Keychain
/// storage, or any provider assertion handling. Those are separate B1 implementation slices.
public protocol AuthSessionProvider: Sendable {
    func currentSession() async -> AuthSessionState
}

/// In-memory auth provider for previews and tests only. It performs no network or disk I/O.
public actor MockAuthSessionProvider: AuthSessionProvider {
    private var state: AuthSessionState

    public init(initialState: AuthSessionState = .unauthenticated) {
        self.state = initialState
    }

    public func currentSession() async -> AuthSessionState {
        state
    }

    public func setState(_ newState: AuthSessionState) {
        state = newState
    }
}
