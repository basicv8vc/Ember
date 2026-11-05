import Foundation

/// The concurrency-safe owner of the live Ember session.
///
/// One actor owns the in-memory credential, the Keychain write path and the refresh single-flight.
/// UI, repositories and the future Live Conversation repository all talk to this boundary instead of
/// holding a token, so there is exactly one place that can rotate, revoke or delete a credential.
///
/// Invariants it enforces:
///
/// - **One rotation per generation.** Concurrent callers share a single in-flight refresh task. A
///   rotated token is never used to start a second refresh, because reuse is a server-side security
///   event that can revoke every session for the consumer (annex §5.3).
/// - **Stale completions are dropped.** Every mutation is fenced by a generation counter and a
///   sign-in sequence number, so a callback from an abandoned attempt cannot overwrite newer state.
/// - **Transient failure is not sign-out.** Only an explicit 401 revokes local state. Offline,
///   timeout, 5xx and a locked Keychain leave the stored session untouched.
/// - **Revocation is terminal for this generation.** After a 401 the in-memory record is dropped,
///   so a retry path finds nothing to refresh and cannot start a request storm.
public actor LiveAuthSessionCoordinator: AuthSessionProvider {
    public struct Dependencies: Sendable {
        public let api: EmberSessionAPI
        public let transport: EmberAuthenticatedTransport
        public let store: EmberSessionStore
        public let appleSignIn: AppleSignInAuthorizing
        /// Injected clock. Every expiry decision reads it, so tests are not wall-clock dependent.
        public let now: @Sendable () -> Date
        /// How early a token is rotated before it expires, so a request cannot start with a
        /// credential that dies in flight.
        public let refreshLeeway: TimeInterval

        public init(
            api: EmberSessionAPI,
            transport: EmberAuthenticatedTransport,
            store: EmberSessionStore,
            appleSignIn: AppleSignInAuthorizing,
            now: @escaping @Sendable () -> Date = { Date() },
            refreshLeeway: TimeInterval = 60
        ) {
            self.api = api
            self.transport = transport
            self.store = store
            self.appleSignIn = appleSignIn
            self.now = now
            self.refreshLeeway = refreshLeeway
        }
    }

    /// One refresh that has been started and not yet settled.
    ///
    /// `task` is the network call. `settlement` is the single actor-isolated operation that turns its
    /// response into the new credential: it performs the one Keychain write, the generation checks and
    /// the commit, and every caller awaits that same task's value. Without it, two waiters resuming
    /// around the store write could both believe they own the rotation.
    private final class RefreshOperation {
        let generation: UInt64
        let task: Task<EmberSessionResponseDTO, Error>
        var settlement: Task<EmberSessionRecord, Error>?

        init(generation: UInt64, task: Task<EmberSessionResponseDTO, Error>) {
            self.generation = generation
            self.task = task
        }
    }

    private let api: EmberSessionAPI
    private let transport: EmberAuthenticatedTransport
    private let store: EmberSessionStore
    private let appleSignIn: AppleSignInAuthorizing
    private let now: @Sendable () -> Date
    private let refreshLeeway: TimeInterval

    private var record: EmberSessionRecord?
    private var didAttemptRestore = false

    /// Bumped whenever the credential identity changes. Guards every stale completion.
    private var generation: UInt64 = 0
    /// Bumped when a sign-in starts, so its completion cannot land on a newer session.
    private var signInSequence: UInt64 = 0

    private var refresh: RefreshOperation?
    /// The in-flight Keychain read, shared so N concurrent cold-start callers produce one load and one
    /// generation bump.
    private var restoreTask: Task<EmberSessionRecord?, Error>?
    private var isLoggingOut = false
    private var cleanupHooks: [@Sendable () async -> Void] = []

    public init(dependencies: Dependencies) {
        self.api = dependencies.api
        self.transport = dependencies.transport
        self.store = dependencies.store
        self.appleSignIn = dependencies.appleSignIn
        self.now = dependencies.now
        self.refreshLeeway = dependencies.refreshLeeway
    }

    // MARK: - AuthSessionProvider

    /// The current session as the existing provider contract describes it.
    ///
    /// `unavailable` is returned when a credential exists but cannot currently be validated — an
    /// expired record that has not been refreshed yet, or a Keychain that cannot be read. It is never
    /// `unauthenticated`: that would tell the app to forget a credential it may still hold.
    public func currentSession() async -> AuthSessionState {
        if !didAttemptRestore {
            do {
                try await restoreRecordIfNeeded()
            } catch {
                return .unavailable
            }
        }

        guard let record else { return .unauthenticated }
        guard !record.isExpired(at: now()) else { return .unavailable }
        guard let session = AuthSession(accessToken: record.accessToken.rawValue) else {
            return .unavailable
        }
        return .authenticated(session)
    }

    // MARK: - Sign in

    /// Exchanges a Sign in with Apple credential for an Ember session and stores it.
    ///
    /// The returned record is the only credential this app will use. Nothing is returned unless the
    /// token was persisted, because a session that exists only in memory would silently disappear on
    /// the next launch.
    @discardableResult
    public func signInWithApple() async throws -> EmberSessionRecord {
        guard !isLoggingOut else { throw AuthError.sessionEnded }

        signInSequence &+= 1
        let attempt = signInSequence

        // Presents the native sheet and returns the assertion. Cancellation surfaces as
        // `appleCancelled` and leaves the stored session exactly as it was.
        let credential = try await appleSignIn.authorize()

        try Task.checkCancellation()
        guard attempt == signInSequence, !isLoggingOut else { throw AuthError.superseded }

        let dto = try await api.createSession(
            identityToken: credential.identityToken,
            nonce: credential.rawNonce
        )

        try Task.checkCancellation()
        // A newer sign-in or a logout started while the exchange was in flight. This credential
        // must not become the session.
        guard attempt == signInSequence, !isLoggingOut else { throw AuthError.superseded }

        let newRecord = makeRecord(from: dto)

        do {
            try await store.save(newRecord)
        } catch {
            // The server minted a session this device cannot keep. Best-effort revoke it once so a
            // dangling session is not left behind; the storage failure is what gets reported.
            try? await api.logout(accessToken: newRecord.accessToken)
            throw AuthError.keychainUnavailable
        }

        record = newRecord
        generation &+= 1
        refresh = nil
        didAttemptRestore = true
        return newRecord
    }

    // MARK: - Restore

    /// Cold-start restore: load, bound-refresh when needed, then read the authoritative projection.
    ///
    /// Returns what the server says about the consumer, Agent and main Conversation. It never invents
    /// an id, and it never converts a transient failure into a signed-out state.
    public func restoreSession() async throws -> EmberMeDTO {
        try await restoreRecordIfNeeded()

        guard let current = record else { throw AuthError.sessionMissing }

        let usable: EmberSessionRecord
        if current.isExpired(at: now())
            || current.needsRefresh(at: now(), leeway: refreshLeeway)
        {
            // One bounded rotation, then the profile read. If the rotation is impossible because the
            // network is down, the stored record stays and the error says so.
            usable = try await performRefresh(expectedGeneration: generation)
        } else {
            usable = current
        }

        return try await fetchProfile(using: usable)
    }

    // MARK: - Refresh

    /// Rotates the session when it is close to expiry, otherwise returns the current record.
    ///
    /// Concurrent callers await the same in-flight rotation, so a token cannot be rotated twice.
    public func refreshSessionIfNeeded() async throws -> EmberSessionRecord {
        try await restoreRecordIfNeeded()

        guard let current = record else { throw AuthError.sessionMissing }
        guard !isLoggingOut else { throw AuthError.sessionEnded }

        guard current.needsRefresh(at: now(), leeway: refreshLeeway) else { return current }
        return try await performRefresh(expectedGeneration: generation)
    }

    // MARK: - Authenticated transport

    /// Sends one authenticated request through the shared authorization boundary.
    ///
    /// - Reads recover from a 401 with a single shared rotation and a single replay.
    /// - Writes are never replayed: a 401 is reported as `requestRejectedBeforeExecution` and an
    ///   unknown transport outcome as `unknownWriteOutcome`, so the caller keeps its
    ///   `client_submission_id` for the contract-defined reconciliation instead of a blind retry.
    public func authorizedRequest(_ request: EmberAuthenticatedRequest) async throws -> EmberAPIResponse {
        guard !isLoggingOut else { throw AuthError.sessionEnded }

        let session = try await validSessionForRequest()
        let urlRequest = try transport.makeRequest(request, accessToken: session.accessToken)

        let response: EmberAPIResponse
        do {
            response = try await transport.send(urlRequest)
        } catch {
            let authError = (error as? AuthError) ?? .transportFailure

            switch request.idempotency {
            case .idempotentRead:
                guard authError.isTransient else { throw authError }
                // Exactly one replay of a read. Never more, and never a replay of a write.
                return try await transport.send(urlRequest)
            case .nonIdempotent(let submissionID):
                throw AuthError.unknownWriteOutcome(clientSubmissionID: submissionID)
            }
        }

        guard response.statusCode == 401 else { return response }
        return try await recoverFromUnauthorized(request: request)
    }

    private func recoverFromUnauthorized(
        request: EmberAuthenticatedRequest
    ) async throws -> EmberAPIResponse {
        switch request.idempotency {
        case .idempotentRead:
            // One rotation, one replay. A second 401 means the session is gone: revoke and report.
            let refreshed = try await performRefresh(expectedGeneration: generation)
            let retry = try transport.makeRequest(request, accessToken: refreshed.accessToken)
            let second = try await transport.send(retry)

            guard second.statusCode != 401 else {
                await revokeLocally()
                throw AuthError.unauthenticated
            }
            return second

        case .nonIdempotent:
            // The request was refused before any handler ran, so the outcome is known: nothing was
            // written. Refresh for the next attempt, but do not resend this one.
            do {
                _ = try await performRefresh(expectedGeneration: generation)
            } catch let error as AuthError where error == .unauthenticated {
                throw AuthError.unauthenticated
            } catch {
                // A failed rotation does not change the fact that the write was not executed.
            }
            throw AuthError.requestRejectedBeforeExecution
        }
    }

    // MARK: - Logout

    /// Ends the session truthfully.
    ///
    /// Order matters: local state is dropped first so no new request can be authorized with the
    /// departing token while the server call is in flight; the remote call is attempted exactly once;
    /// and local credentials are removed regardless of the remote answer. The outcome distinguishes
    /// "server confirmed", "token already invalid" and "we could not reach the server".
    @discardableResult
    public func logout() async -> LogoutOutcome {
        // Load once so a logout after a cold start still revokes the stored session remotely.
        if !didAttemptRestore {
            try? await restoreRecordIfNeeded()
        }

        signInSequence &+= 1
        let departing = record

        record = nil
        isLoggingOut = true
        generation &+= 1
        // In-flight refreshes now fail their generation check and cannot resurrect this session.
        refresh = nil
        didAttemptRestore = true

        var remoteError: AuthError?
        if let departing {
            do {
                try await api.logout(accessToken: departing.accessToken)
            } catch {
                remoteError = (error as? AuthError) ?? .transportFailure
            }
        }

        var localError: AuthError?
        do {
            try await store.delete()
        } catch {
            localError = (error as? AuthError) ?? .keychainUnavailable
        }

        // Narrow hook for the L4 outbox: it runs only after credentials are gone, and it is not the
        // outbox implementation itself.
        for hook in cleanupHooks {
            await hook()
        }

        isLoggingOut = false

        if let localError { return .localCleanupFailed(localError) }
        guard departing != nil else { return .alreadyInvalidated }
        guard let remoteError else { return .revokedRemotely }

        // A 401 here means the token no longer authenticates anything, which is the state logout
        // wanted. Reporting it as a failure would push the caller into an unnecessary retry.
        return remoteError == .unauthenticated ? .alreadyInvalidated : .remoteUnconfirmed(remoteError)
    }

    /// Registers a cleanup action to run after credentials are removed. Used later for the protected
    /// pending-send outbox; L1 deliberately does not implement one.
    public func registerSignOutCleanup(_ hook: @escaping @Sendable () async -> Void) {
        cleanupHooks.append(hook)
    }

    // MARK: - Restore plumbing

    /// Loads the stored record at most once per successful attempt.
    ///
    /// A failed load does not count as an attempt: a locked Keychain becomes readable after the next
    /// unlock, and the coordinator must be able to notice that without a relaunch.
    private func restoreRecordIfNeeded() async throws {
        guard !didAttemptRestore else { return }

        let task: Task<EmberSessionRecord?, Error>
        if let existing = restoreTask {
            task = existing
        } else {
            let store = self.store
            task = Task { try await store.load() }
            restoreTask = task
        }

        do {
            let stored = try await task.value
            // Another caller may have committed this same load while this one was suspended. Only the
            // first resumption may install the record and bump the generation, otherwise a generation
            // captured moments earlier would be invalidated by a duplicate load.
            guard !didAttemptRestore else { return }

            didAttemptRestore = true
            restoreTask = nil
            if let stored {
                record = stored
                generation &+= 1
            }
        } catch let error as AuthError {
            // A failed read is not an attempt: a locked Keychain must be retryable in this launch.
            restoreTask = nil
            throw error
        } catch {
            restoreTask = nil
            throw AuthError.keychainUnavailable
        }
    }

    private func validSessionForRequest() async throws -> EmberSessionRecord {
        try await restoreRecordIfNeeded()

        guard record != nil else { throw AuthError.sessionMissing }
        guard !isLoggingOut else { throw AuthError.sessionEnded }

        return try await refreshSessionIfNeeded()
    }

    // MARK: - Refresh plumbing

    private func performRefresh(expectedGeneration: UInt64) async throws -> EmberSessionRecord {
        guard let current = record else { throw AuthError.sessionMissing }
        guard !isLoggingOut else { throw AuthError.sessionEnded }

        let operation: RefreshOperation
        if let existing = refresh, existing.generation == expectedGeneration {
            // Single-flight: this caller joins the rotation already in progress for this generation.
            operation = existing
        } else {
            let api = self.api
            let token = current.accessToken
            let operationGeneration = expectedGeneration

            // The task owns the network call only. The Keychain write happens in `settle`, inside the
            // actor, so it can be fenced against a logout that lands mid-flight.
            let task = Task<EmberSessionResponseDTO, Error> {
                try await api.refreshSession(accessToken: token)
            }

            operation = RefreshOperation(generation: operationGeneration, task: task)
            refresh = operation
        }

        // Claiming the settlement is a synchronous compare-and-set on the actor: no suspension can
        // occur between reading `settlement` and assigning it, so exactly one caller owns the commit
        // and every other caller awaits that same result.
        if let settlement = operation.settlement {
            return try await settlement.value
        }

        let settlement = Task<EmberSessionRecord, Error> {
            try await self.settle(operation, expectedGeneration: expectedGeneration)
        }
        operation.settlement = settlement
        return try await settlement.value
    }

    private func settle(
        _ operation: RefreshOperation,
        expectedGeneration: UInt64
    ) async throws -> EmberSessionRecord {
        let dto: EmberSessionResponseDTO
        do {
            dto = try await operation.task.value
        } catch {
            let authError = (error as? AuthError) ?? .transportFailure
            if refresh === operation { refresh = nil }
            if authError == .unauthenticated {
                // Reuse of a rotated token revokes every session for the consumer, so local state
                // must follow immediately. Nothing here retries.
                await revokeLocally()
            }
            throw authError
        }

        guard generation == expectedGeneration, !isLoggingOut else {
            if refresh === operation { refresh = nil }
            throw AuthError.superseded
        }

        let rotated = EmberSessionRecord(
            sessionID: dto.sessionID,
            consumerID: dto.consumerID,
            accessToken: dto.accessToken,
            expiresAt: dto.expiresAt,
            storedAt: now()
        )

        var storageError: AuthError?
        do {
            try await store.replace(rotated)
        } catch {
            storageError = (error as? AuthError) ?? .keychainUnavailable
        }

        // A logout or a newer sign-in may have run while the store write was suspended. A rotated
        // token must never leave a live credential behind after the consumer signed out, so the
        // write is undone before the result is discarded.
        guard generation == expectedGeneration, !isLoggingOut else {
            try? await store.delete()
            if refresh === operation { refresh = nil }
            throw AuthError.superseded
        }

        record = rotated
        generation &+= 1
        if refresh === operation { refresh = nil }

        if let storageError {
            // The token is live but not durable. Reporting the failure is the honest option: the
            // caller can warn that the session will not survive a relaunch.
            throw storageError
        }
        return rotated
    }

    // MARK: - Profile

    private func fetchProfile(using session: EmberSessionRecord) async throws -> EmberMeDTO {
        do {
            return try await api.bootstrap(accessToken: session.accessToken)
        } catch let error as AuthError where error == .unauthenticated {
            // A locally valid-looking token can still be expired or revoked server-side. One
            // rotation and one retry is the contract's bounded recovery (annex §10.3); a second 401
            // ends the session instead of looping.
            let refreshed = try await performRefresh(expectedGeneration: generation)

            do {
                return try await api.bootstrap(accessToken: refreshed.accessToken)
            } catch let retryError as AuthError where retryError == .unauthenticated {
                await revokeLocally()
                throw AuthError.unauthenticated
            }
        }
    }

    // MARK: - Revocation

    /// Drops the local credential after the server has definitively rejected it.
    ///
    /// Deliberately narrow: it is only reachable from an explicit 401. Offline, timeout, 5xx and a
    /// locked Keychain never call it, so a temporary condition cannot become a sign-out.
    private func revokeLocally() async {
        record = nil
        generation &+= 1
        refresh = nil
        didAttemptRestore = true

        // A failed delete is not a security hole — the token is already invalid server-side — but it
        // must not change the reported state, so the error is dropped on purpose.
        try? await store.delete()
    }

    // MARK: - Helpers

    private func makeRecord(from dto: EmberSessionResponseDTO) -> EmberSessionRecord {
        EmberSessionRecord(
            sessionID: dto.sessionID,
            consumerID: dto.consumerID,
            accessToken: dto.accessToken,
            expiresAt: dto.expiresAt,
            storedAt: now()
        )
    }
}
