import Foundation

/// A durable, non-secret marker meaning: *the credential in the store may already be unusable — do not
/// present it.*
///
/// ## Two situations, one invariant
///
/// 1. **A refresh is in flight.** `POST /v1/auth/session/refresh` rotates the token server-side. From
///    the moment the request may have reached the server until the replacement is persisted, the stored
///    token is in an unknown state: it is valid only if the server never processed the rotation.
/// 2. **A rotation succeeded but could not be persisted.** The stored token is definitely dead.
///
/// A force-quit, a jetsam kill or a crash in either window leaves a token on disk that the server may
/// already have rotated away. Presenting it is not merely useless: the backend treats a rotated-away
/// token as evidence of theft. `findActiveSession` and `rotateSession` both answer it by revoking **every**
/// session for that consumer, so one unlucky window signs the person out of every device they own.
/// There is no safe probe either — `GET /v1/me` goes through the same reuse check — so the only correct
/// behaviour is to never present the token again.
///
/// ## Why it cannot live in the Keychain
///
/// The Keychain is the component that is failing in situation 2, so a marker stored there would fail for
/// the same reason. It has to live outside.
///
/// ## Why this is not "authentication state in UserDefaults"
///
/// It is a single bit plus a format version. It carries no access token, no session id, no consumer id,
/// no Apple assertion and no nonce; it cannot be replayed, it identifies nobody, and it says nothing
/// about the person using the device. ADR-0004 annex §5.1 I-8 forbids the credential itself from leaving
/// the Keychain — a boolean about the *validity* of a file we already own does not move it.
///
/// ## Durability is the whole point
///
/// The marker is worthless if it can be lost in the same crash that loses the response. `FileSessionRecoveryFence`
/// therefore flushes the payload to the platter, flushes the directory entry that names it, and reads it
/// back before `arm()` returns — and `LiveAuthSessionCoordinator` refuses to send a rotation at all if
/// `arm()` throws. The alternative (a `UserDefaults` write) is only coherent once the preferences daemon
/// has been reached, which this type cannot prove, so it is not used to make a crash-recovery claim.
public protocol SessionRecoveryFence: Sendable {
    /// Whether the credential in the store must be treated as unusable.
    var isArmed: Bool { get }

    /// Records that the stored credential must not be presented, and returns only once that record is
    /// durable.
    ///
    /// - Throws: `AuthError.recoveryFenceUnavailable` when the marker could not be persisted. Callers
    ///   must treat that as a refusal to proceed, never as a warning.
    func arm() throws

    /// Records that the store holds either nothing, or a credential that is trustworthy again.
    func clear()
}

/// Production fence: one small file in Application Support, written durably.
public struct FileSessionRecoveryFence: SessionRecoveryFence {
    /// App-specific directory, created on first use.
    public static let directoryName = "EmberAuth"
    /// Stable name. Changing it silently disarms every installed build, so it is part of the format.
    public static let fileName = "rotation-in-flight"

    /// Payload is a version only. Nothing about the session, the consumer or the device goes in it.
    private static let payload = Data(#"{"version":1}"#.utf8)

    private let directory: URL?

    /// - Parameter directory: `nil` uses `Application Support/EmberAuth`. Tests pass a temporary
    ///   directory so they never touch the simulator's real Application Support.
    public init(directory: URL? = nil) {
        self.directory = directory
    }

    public var isArmed: Bool {
        guard let url = try? markerURL() else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    public func arm() throws {
        do {
            let url = try markerURL()
            let container = url.deletingLastPathComponent()

            try FileManager.default.createDirectory(
                at: container,
                withIntermediateDirectories: true
            )
            // The marker is transient state, not user data. Excluding the directory keeps a restored
            // backup on another device from carrying a verdict about a session that never migrated.
            try? excludeFromBackup(container)

            // `.atomic` writes a sibling file and renames it, so a crash cannot leave a half-written
            // marker that reads as "not armed".
            try Self.payload.write(to: url, options: .atomic)

            // Flush the bytes, then the directory entry that makes the file reachable, then prove it
            // by reading the marker back. Only after all three does this return.
            try flush(url)
            try flush(container)

            guard try Data(contentsOf: url) == Self.payload else {
                throw AuthError.recoveryFenceUnavailable
            }
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.recoveryFenceUnavailable
        }
    }

    public func clear() {
        guard let url = try? markerURL() else { return }
        try? FileManager.default.removeItem(at: url)
        try? flush(url.deletingLastPathComponent())
    }

    // MARK: - Private

    private func markerURL() throws -> URL {
        let base: URL
        if let directory {
            base = directory
        } else {
            guard
                let support = FileManager.default.urls(
                    for: .applicationSupportDirectory,
                    in: .userDomainMask
                ).first
            else {
                throw AuthError.recoveryFenceUnavailable
            }
            base = support.appendingPathComponent(Self.directoryName, isDirectory: true)
        }
        return base.appendingPathComponent(Self.fileName, isDirectory: false)
    }

    /// `fsync` on a file or a directory. A directory handles the rename that published the file.
    private func flush(_ url: URL) throws {
        let descriptor = open(url.path, O_RDONLY)
        guard descriptor >= 0 else { throw AuthError.recoveryFenceUnavailable }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw AuthError.recoveryFenceUnavailable }
    }

    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try mutable.setResourceValues(values)
    }
}

/// Deterministic fence for tests and previews. A lock rather than an actor, so assertions can read the
/// state without `await`.
public final class InMemorySessionRecoveryFence: SessionRecoveryFence, @unchecked Sendable {
    private let lock = NSLock()
    private var armed: Bool
    private var armFailure: AuthError?
    private var armCalls = 0
    private var clearCalls = 0

    public init(armed: Bool = false) {
        self.armed = armed
    }

    public var isArmed: Bool { lock.withLock { armed } }
    public var armCallCount: Int { lock.withLock { armCalls } }
    public var clearCallCount: Int { lock.withLock { clearCalls } }

    /// Makes `arm()` fail, so a test can assert that the coordinator refuses to rotate rather than
    /// sending a request it cannot record.
    public func setArmFailure(_ error: AuthError?) {
        lock.withLock { armFailure = error }
    }

    public func arm() throws {
        let failure = lock.withLock { () -> AuthError? in
            armCalls += 1
            return armFailure
        }
        if let failure { throw failure }
        lock.withLock { armed = true }
    }

    public func clear() {
        lock.withLock {
            armed = false
            clearCalls += 1
        }
    }
}
