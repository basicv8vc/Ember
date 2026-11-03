import Foundation

/// An in-memory view of the currently available Ember session credential.
///
/// This value is deliberately not Codable and has no persistence behavior. The provider
/// implementation owns any future secure-storage policy; this interface makes no assumptions
/// about Keychain, refresh, sign-in providers, or credential lifetime.
public struct AuthSession: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let accessToken: String

    public init?(accessToken: String) {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        self.accessToken = accessToken
    }

    public var description: String {
        "AuthSession(accessToken: <redacted>)"
    }

    public var debugDescription: String {
        description
    }

    public var customMirror: Mirror {
        Mirror(self, children: [(label: "accessToken", value: "<redacted>")], displayStyle: .struct)
    }
}

/// The provider's current knowledge of authentication state.
///
/// unavailable is distinct from unauthenticated: callers must not interpret a temporary
/// provider failure as a sign-out.
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

/// Minimal, provider-neutral read interface for the current Ember session.
///
/// Login, refresh, logout, credential persistence and provider-specific assertions are
/// intentionally outside this contract.
public protocol AuthSessionProvider: Sendable {
    func currentSession() async -> AuthSessionState
}

/// Deterministic in-memory provider for previews and unit tests. No network or disk I/O.
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
