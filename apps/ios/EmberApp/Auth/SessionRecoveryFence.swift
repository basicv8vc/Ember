import Foundation

/// A durable, non-secret marker meaning: *whatever credential is in the store right now must not be
/// presented to the server.*
///
/// ## The situation it exists for
///
/// A refresh rotates the token server-side, and then the Keychain refuses the write of the replacement.
/// The old token is now dead, but it is still the only thing on disk. If the process dies at that point
/// — a force-quit, a jetsam kill, a crash — the next launch loads that dead token and presents it. The
/// B1 backend treats a rotated-away token as evidence of theft: `reuse_detected` revokes **every**
/// session for that consumer. One failed Keychain write would therefore sign the person out of every
/// device they own.
///
/// Deleting the stale item at the moment of failure is the first line of defence
/// (`LiveAuthSessionCoordinator.settle`). This fence is the second line, for the case where the delete
/// fails too.
///
/// ## Why it cannot live in the Keychain
///
/// The Keychain is the component that is failing in precisely the scenario the fence guards, so a marker
/// stored there would fail for the same reason. It has to live outside.
///
/// ## Why this is not "authentication state in UserDefaults"
///
/// It is a single bit. It carries no access token, no session id, no consumer id, no Apple assertion and
/// no nonce; it cannot be replayed, it identifies nobody, and it says nothing about the person using the
/// device. ADR-0004 annex §5.1 I-8 forbids the credential itself from leaving the Keychain — that
/// prohibition is not weakened by remembering one boolean about the *validity* of a file we already own.
public protocol SessionRecoveryFence: Sendable {
    /// Whether the stored credential must be treated as untrusted.
    var isArmed: Bool { get }

    /// Records that the stored credential must not be presented on the next launch.
    func arm()

    /// Records that the store is known to hold either nothing, or a credential that is trustworthy.
    func clear()
}

/// Production fence, backed by `UserDefaults`.
public struct UserDefaultsSessionRecoveryFence: SessionRecoveryFence {
    /// Stable, app-namespaced key. Changing it silently disarms every installed build, so it must be
    /// treated as part of the persisted format.
    public static let key = "com.basicv8vc.ember.auth.rotation-unpersisted"

    private let suiteName: String?

    /// - Parameter suiteName: `nil` uses the app's standard defaults. Tests pass a unique suite so they
    ///   never observe each other's fenced state.
    public init(suiteName: String? = nil) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults {
        if let suiteName, let scoped = UserDefaults(suiteName: suiteName) { return scoped }
        return .standard
    }

    public var isArmed: Bool {
        defaults.bool(forKey: Self.key)
    }

    public func arm() {
        defaults.set(true, forKey: Self.key)
    }

    public func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}

/// Deterministic fence for tests and previews. A lock rather than an actor, so assertions can read the
/// state without `await`.
public final class InMemorySessionRecoveryFence: SessionRecoveryFence, @unchecked Sendable {
    private let lock = NSLock()
    private var armed: Bool
    private var armCalls = 0
    private var clearCalls = 0

    public init(armed: Bool = false) {
        self.armed = armed
    }

    public var isArmed: Bool { lock.withLock { armed } }
    public var armCallCount: Int { lock.withLock { armCalls } }
    public var clearCallCount: Int { lock.withLock { clearCalls } }

    public func arm() {
        lock.withLock {
            armed = true
            armCalls += 1
        }
    }

    public func clear() {
        lock.withLock {
            armed = false
            clearCalls += 1
        }
    }
}
