import Foundation

/// The concurrency-safe owner of the live Ember session.
///
/// One actor owns the in-memory credential, the Keychain write path and the refresh single-flight.
/// UI, repositories and the future Live Conversation repository all talk to this boundary instead of
/// holding a token, so there is exactly one place that can rotate, revoke or delete a credential.
///
/// ## How the race windows are closed
///
/// Every `await` in this file is a network call or a UI presentation — never credential storage. The
/// store protocol is synchronous (`EmberSessionStore`), so each credential mutation runs as one
/// uninterrupted actor step: *validate generation → write → commit*. Nothing can interleave inside that
/// step, so these interleavings cannot happen:
///
/// - a logout landing between "Keychain written" and "session installed" by a sign-in;
/// - a stale refresh deleting the credential a newer sign-in just stored;
/// - a rotation committing onto a session that was replaced while its network call was in flight.
///
/// The awaits that remain are each followed by a re-validation before any mutation, which is what makes
/// the surviving interleavings deterministic and testable:
///
/// - `signInWithApple()` bumps `signInSequence` before presenting the sheet and re-checks it after both
///   awaits. A completion that lost the race throws `superseded` and mutates nothing.
/// - `settle()` re-checks `generation` after the rotation returns and before touching the store.
/// - Revocation is keyed to the token that actually failed (`revokeLocally(ifCurrent:)`), so a delayed
///   401 for a token that has since been replaced cannot sign out the newer session.
///
/// Other invariants:
///
/// - **One rotation per generation.** Concurrent callers share a single in-flight refresh task. A
///   rotated token is never used to start a second refresh, because reuse is a server-side security
///   event that can revoke every session for the consumer (annex §5.3).
/// - **Transient failure is not sign-out.** Only an explicit 401 for the current token revokes local
///   state. Offline, timeout, 5xx and a locked Keychain leave the stored session untouched.
/// - **Revocation is terminal for this generation.** After a 401 the in-memory record is dropped, so a
///   retry path finds nothing to refresh and cannot start a request storm.
/// - **A credential that is not durable is not adopted.** When a rotation succeeds server-side but the
///   replacement cannot be written, the session ends instead of continuing from memory: a token that
///   exists only in the process would leave the *rotated-away* token on disk, and the next launch would
///   present it — which the backend answers by revoking every session for the consumer.
/// - **A rotation is fenced before it is sent.** `POST /v1/auth/session/refresh` can commit on the server
///   and then vanish — a timeout, a dropped connection, a process kill. The stored token is then
///   unusable but still on disk. The `SessionRecoveryFence` is made durable *before* the request exists
///   and is cleared only once a replacement is persisted or the failure proves the token untouched, so
///   the next launch destroys the credential instead of replaying it. If the fence cannot be persisted,
///   the rotation is not attempted at all.
public actor LiveAuthSessionCoordinator: AuthSessionProvider {
    public struct Dependencies: Sendable {
        public let api: EmberSessionAPI
        public let transport: EmberAuthenticatedTransport
        public let store: EmberSessionStore
        public let appleSignIn: AppleSignInAuthorizing
        /// Durable marker that the stored credential must not be presented. See `SessionRecoveryFence`.
        public let fence: SessionRecoveryFence
        /// Injected clock. Every expiry decision reads it, so tests are not wall-clock dependent.
        public let now: @Sendable () -> Date
        /// How early a token is rotated before it expires, so a request cannot start with a
        /// credential that dies in flight.
        public let refreshLeeway: TimeInterval
        /// Cleanup that must be installed *before* any logout can execute.
        ///
        /// `registerSignOutCleanup` needs an `await` on this actor, so a caller that starts the view
        /// first and registers afterwards leaves a window in which a logout would skip the hook. A
        /// composition that owns a durable outbox therefore passes its cleanup here instead, and the
        /// hooks exist from the instant the coordinator does. Registration order is a security
        /// property, so it is not left to scheduling.
        public let signOutCleanupHooks: [@Sendable () async -> Void]

        public init(
            api: EmberSessionAPI,
            transport: EmberAuthenticatedTransport,
            store: EmberSessionStore,
            appleSignIn: AppleSignInAuthorizing,
            fence: SessionRecoveryFence = FileSessionRecoveryFence(),
            signOutCleanupHooks: [@Sendable () async -> Void] = [],
            now: @escaping @Sendable () -> Date = { Date() },
            refreshLeeway: TimeInterval = 60
        ) {
            self.api = api
            self.transport = transport
            self.store = store
            self.appleSignIn = appleSignIn
            self.fence = fence
            self.signOutCleanupHooks = signOutCleanupHooks
            self.now = now
            self.refreshLeeway = refreshLeeway
        }
    }

    /// One refresh that has been started and not yet settled.
    ///
    /// `token` is the credential this rotation is allowed to revoke if the server rejects it. `task` is
    /// the network call. `settlement` is the single actor-isolated operation that turns the response
    /// into the new credential; every caller awaits that same task's value, so one rotation produces
    /// one store write.
    private final class RefreshOperation {
        let generation: UInt64
        let token: EmberAccessToken
        let task: Task<EmberSessionResponseDTO, Error>
        var settlement: Task<EmberSessionRecord, Error>?

        init(
            generation: UInt64,
            token: EmberAccessToken,
            task: Task<EmberSessionResponseDTO, Error>
        ) {
            self.generation = generation
            self.token = token
            self.task = task
        }
    }

    private let api: EmberSessionAPI
    private let transport: EmberAuthenticatedTransport
    private let store: EmberSessionStore
    private let appleSignIn: AppleSignInAuthorizing
    private let fence: SessionRecoveryFence
    private let now: @Sendable () -> Date
    private let refreshLeeway: TimeInterval

    private var record: EmberSessionRecord?
    private var didAttemptRestore = false

    /// Bumped whenever the credential identity changes. Guards every stale completion.
    private var generation: UInt64 = 0
    /// Bumped when a sign-in starts, so its completion cannot land on a newer session.
    private var signInSequence: UInt64 = 0

    private var refresh: RefreshOperation?
    /// A token the server minted but this device refused to keep. Revoked once, on the way out.
    private var orphanedToken: EmberAccessToken?
    private var isLoggingOut = false
    private var cleanupHooks: [@Sendable () async -> Void]

    public init(dependencies: Dependencies) {
        self.api = dependencies.api
        self.transport = dependencies.transport
        self.store = dependencies.store
        self.appleSignIn = dependencies.appleSignIn
        self.fence = dependencies.fence
        // Installed at construction, not by a later `await`: see `signOutCleanupHooks`.
        self.cleanupHooks = dependencies.signOutCleanupHooks
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
                try restoreRecordIfNeeded()
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

        // From here to the end of this method there is no suspension: a logout either completed before
        // this point — in which case the guard rejects the credential — or starts entirely after the
        // commit. There is no window in which a signed-out device can end up authenticated.
        guard attempt == signInSequence, !isLoggingOut else { throw AuthError.superseded }

        let newRecord = makeRecord(from: dto)

        do {
            try store.save(newRecord)
        } catch {
            // The server minted a session this device cannot keep. Best-effort revoke it once so a
            // dangling session is not left behind; the storage failure is what gets reported. No local
            // state was changed, so this await cannot resurrect anything.
            try? await api.logout(accessToken: newRecord.accessToken)
            throw AuthError.keychainUnavailable
        }

        record = newRecord
        generation &+= 1
        refresh = nil
        didAttemptRestore = true
        // The store now holds a credential the server just minted, so any earlier "do not trust what is
        // stored" verdict is obsolete. Leaving it armed would make the next launch delete this session.
        fence.clear()
        return newRecord
    }

    // MARK: - Restore

    /// Cold-start restore: load, bound-refresh when needed, then read the authoritative projection.
    ///
    /// Returns what the server says about the consumer, Agent and main Conversation. It never invents
    /// an id, and it never converts a transient failure into a signed-out state.
    public func restoreSession() async throws -> EmberMeDTO {
        try restoreRecordIfNeeded()

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
        try restoreRecordIfNeeded()

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

        // Preparing the request awaited a possible rotation. If the session ended in the meantime, the
        // request is refused here rather than being sent with a token the device already gave up.
        guard !isLoggingOut, record?.accessToken == session.accessToken else {
            throw AuthError.sessionEnded
        }

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
                // Keyed to the token that was rejected, so a logout or a newer sign-in that happened
                // during the replay is not signed out by this older failure.
                revokeLocally(ifCurrent: refreshed.accessToken)
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
    /// Local state is cleared first and synchronously, before any network call: from that instant no
    /// new request can be authorized with the departing token, an in-flight rotation fails its
    /// generation check, and a crash mid-logout leaves no credential behind. The remote call is then
    /// attempted exactly once, and the outcome distinguishes "server confirmed", "token already
    /// invalid" and "we could not reach the server".
    @discardableResult
    public func logout() async -> LogoutOutcome {
        // Load once so a logout after a cold start still revokes the stored session remotely.
        if !didAttemptRestore {
            try? restoreRecordIfNeeded()
        }

        signInSequence &+= 1
        let departing = record

        record = nil
        isLoggingOut = true
        generation &+= 1
        // In-flight refreshes now fail their generation check and cannot resurrect this session.
        refresh = nil
        didAttemptRestore = true

        var localError: AuthError?
        do {
            try store.delete()
            // Nothing of the departing session is left to present, so no fence is needed.
            fence.clear()
        } catch {
            localError = (error as? AuthError) ?? .keychainUnavailable
            // The departing token is dead the moment the server processes this logout. If its item could
            // not be removed, fence the store so the next launch cannot present it.
            try? fence.arm()
        }

        var remoteError: AuthError?
        if let departing {
            do {
                try await api.logout(accessToken: departing.accessToken)
            } catch {
                remoteError = (error as? AuthError) ?? .transportFailure
            }
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
    /// Synchronous, so concurrent cold-start callers cannot each install the record and bump the
    /// generation twice. A failed load does not count as an attempt: a locked Keychain becomes readable
    /// after the next unlock, and the coordinator must notice that without a relaunch.
    private func restoreRecordIfNeeded() throws {
        guard !didAttemptRestore else { return }

        // A previous launch rotated the token, could not persist the replacement, and could not remove
        // what was left behind. Whatever the store still holds is the token the server already rotated
        // away, so it is destroyed without ever being loaded: presenting it would be `reuse_detected`,
        // and the backend answers that by revoking every session for the consumer.
        //
        // Only when the removal is confirmed does this launch settle as signed out. If the removal
        // fails, the fence stays armed and the state stays `unavailable` (via the thrown error) — a
        // store we could not clean is not evidence of a signed-out consumer.
        if fence.isArmed {
            do {
                try store.delete()
            } catch let error as AuthError {
                throw error
            } catch {
                throw AuthError.keychainUnavailable
            }

            fence.clear()
            didAttemptRestore = true
            return
        }

        let stored: EmberSessionRecord?
        do {
            stored = try store.load()
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.keychainUnavailable
        }

        didAttemptRestore = true
        if let stored {
            record = stored
            generation &+= 1
        }
    }

    private func validSessionForRequest() async throws -> EmberSessionRecord {
        try restoreRecordIfNeeded()

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
            // The marker is made durable *before* the request exists. From this instant the stored token
            // must be assumed unusable by the next launch, because the server may rotate it and neither
            // this process nor the response may survive to say so. If the marker cannot be persisted the
            // rotation is not attempted at all: sending one without it would recreate exactly the window
            // this fence closes.
            do {
                try fence.arm()
            } catch {
                throw (error as? AuthError) ?? .recoveryFenceUnavailable
            }

            let api = self.api
            let token = current.accessToken
            let operationGeneration = expectedGeneration

            // The task owns the network call only. The Keychain write and the commit happen in
            // `settle`, inside the actor, with no await between them. Creating it immediately after
            // arming keeps the window between "recorded" and "sent" as small as the language allows.
            let task = Task<EmberSessionResponseDTO, Error> {
                try await api.refreshSession(accessToken: token)
            }

            operation = RefreshOperation(
                generation: operationGeneration,
                token: token,
                task: task
            )
            refresh = operation
        }

        // Claiming the settlement is a synchronous compare-and-set on the actor: no suspension can
        // occur between reading `settlement` and assigning it, so exactly one caller owns the commit
        // and every other caller awaits that same result.
        if let settlement = operation.settlement {
            return try await settledResult(of: settlement)
        }

        let settlement = Task<EmberSessionRecord, Error> {
            try await self.settle(operation, expectedGeneration: expectedGeneration)
        }
        operation.settlement = settlement
        return try await settledResult(of: settlement)
    }

    /// Awaits one settlement and drains any credential it orphaned.
    ///
    /// Every waiter goes through this, but the token is consumed on first read, so a rotation shared by
    /// N callers still produces exactly one revoke.
    private func settledResult(
        of settlement: Task<EmberSessionRecord, Error>
    ) async throws -> EmberSessionRecord {
        do {
            let settled = try await settlement.value
            await revokeOrphanedTokenIfNeeded()
            return settled
        } catch {
            await revokeOrphanedTokenIfNeeded()
            throw error
        }
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

            // Ownership check, mirroring the one the success path performs after its own await. A
            // rotation can be outstanding long enough for a logout or a newer sign-in to replace this
            // session, and a failure that arrives afterwards describes a credential nobody is using any
            // more. Acting on it would clear a fence a *different* rotation armed and end the session
            // that replaced this one — including deleting its Keychain item.
            let stillOwnsTheSession = generation == expectedGeneration && !isLoggingOut
            if refresh === operation { refresh = nil }

            guard stillOwnsTheSession else {
                // The failure belongs to a superseded rotation. Reporting the original cause would tell
                // the caller its session is gone while a newer one is live, so the cause is dropped
                // along with the operation.
                throw AuthError.superseded
            }

            if authError == .unauthenticated {
                // Past the guard above, this rotation still owns the session, so a 401 is evidence about
                // the token actually in use. `revokeLocally(ifCurrent:)` keeps its own token check as a
                // second line: revocation is always keyed to the credential that failed.
                revokeLocally(ifCurrent: operation.token)
                throw authError
            }

            if authError.credentialUnaffectedByRefresh {
                // The server declined before rotating, or the request never left the device. The stored
                // credential is exactly what it was, so the fence's warning is no longer true and the
                // session survives.
                fence.clear()
                throw authError
            }

            // The outcome is unknown: the rotation may have committed, so the token on disk may already
            // be dead. Replaying it is what `reuse_detected` punishes by revoking every session for the
            // consumer, so the session ends here and the credential is destroyed without being
            // presented again. The cause is deliberately not forwarded: a caller that treated
            // `.timedOut` as "your session was kept" would be told a lie.
            endSessionAfterUnusableCredential(orphanedToken: nil)
            throw AuthError.rotationOutcomeUnknown
        }

        // The rotation may have taken long enough for a logout or a newer sign-in to replace this
        // session. The new token is then discarded and *nothing* is written: there is deliberately no
        // cleanup delete here, because the credential now in the store belongs to somebody else.
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
            try store.replace(rotated)
        } catch {
            storageError = (error as? AuthError) ?? .keychainUnavailable
        }

        if let storageError {
            // The server has already rotated `operation.token` away. The replacement exists only in this
            // process, and adopting it would be the defect this branch closes: the Keychain would keep
            // the dead token, and a force-quit followed by a cold start would present it. The backend
            // treats that as reuse and revokes every session for the consumer.
            //
            // So the session ends, atomically with the generation check above: no suspension has
            // occurred since it, so this is still one uninterrupted actor step.
            endSessionAfterUnusableCredential(orphanedToken: rotated.accessToken)
            throw storageError
        }

        // No suspension since the guard above, so the credential cannot have changed underneath this
        // commit. The single write is the one the state now reflects, so memory and storage agree again
        // and any fence left by an earlier failure is no longer true.
        record = rotated
        generation &+= 1
        if refresh === operation { refresh = nil }
        fence.clear()
        return rotated
    }

    /// Ends the session because the credential on disk can no longer be trusted.
    ///
    /// Two situations reach here: a rotation the server accepted but this device could not persist, and
    /// a rotation whose outcome is unknown. They are the same state — the stored token may already be
    /// rotated away — so they get the same treatment.
    ///
    /// Called only with no pending suspension, so it runs as one uninterrupted actor step. Three things
    /// happen, in this order, and the order is the point:
    ///
    /// 1. The fence is armed **first**, and its failure is tolerated only because the caller already
    ///    armed it before the request. Everything after this can fail, and a crash between here and the
    ///    delete would otherwise leave an unmarked stale credential on disk.
    /// 2. Local state is dropped. From this instant no request of any kind — read, write, refresh or
    ///    logout — can be sent with the suspect token.
    /// 3. The stale item is deleted, which makes the next launch clean rather than merely fenced. The
    ///    fence is cleared only if that delete is confirmed.
    ///
    /// - Parameter orphanedToken: a replacement token the server minted but this device refused to keep,
    ///   handed back on a best-effort basis. `nil` when the outcome was never received.
    private func endSessionAfterUnusableCredential(orphanedToken token: EmberAccessToken?) {
        try? fence.arm()

        record = nil
        generation &+= 1
        refresh = nil
        didAttemptRestore = true

        if (try? store.delete()) != nil {
            fence.clear()
        }

        // The outcome cannot change local state, so it is not awaited before the settlement returns.
        orphanedToken = token
    }

    /// Consumes `orphanedToken`, if a previous settlement left one, and revokes it exactly once.
    private func revokeOrphanedTokenIfNeeded() async {
        guard let token = orphanedToken else { return }
        orphanedToken = nil

        // Best effort by design: if the server is unreachable the session simply expires by TTL. A
        // retry loop here would be a request storm for a credential nobody holds.
        try? await api.logout(accessToken: token)
    }

    // MARK: - Profile

    private func fetchProfile(using session: EmberSessionRecord) async throws -> EmberMeDTO {
        do {
            return try await api.bootstrap(accessToken: session.accessToken)
        } catch let error as AuthError where error == .unauthenticated {
            // A locally valid-looking token can still be expired or revoked server-side. One rotation
            // and one retry is the contract's bounded recovery (annex §10.3); a second 401 ends the
            // session instead of looping.
            let refreshed = try await performRefresh(expectedGeneration: generation)

            do {
                return try await api.bootstrap(accessToken: refreshed.accessToken)
            } catch let retryError as AuthError where retryError == .unauthenticated {
                revokeLocally(ifCurrent: refreshed.accessToken)
                throw AuthError.unauthenticated
            }
        }
    }

    // MARK: - Revocation

    /// Drops the local credential when the server rejects **the token that is still current**.
    ///
    /// The guard is the point: a 401 is only evidence about the credential that produced it. If a
    /// logout has already cleared the session, or a newer sign-in has replaced the token, this is a
    /// no-op — a stale failure must never sign out a newer session.
    ///
    /// Reachability is deliberately narrow: only an explicit 401 calls it. Offline, timeout, 5xx and a
    /// locked Keychain never do, so a temporary condition cannot become a sign-out.
    private func revokeLocally(ifCurrent token: EmberAccessToken) {
        guard record?.accessToken == token else { return }

        record = nil
        generation &+= 1
        refresh = nil
        didAttemptRestore = true

        // A failed delete is not a security hole — the token is already invalid server-side — but it
        // must not change the reported state, so the error is dropped on purpose. The fence is what
        // keeps the next launch from presenting a token the server has already rejected.
        if (try? store.delete()) != nil {
            fence.clear()
        } else {
            try? fence.arm()
        }
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
