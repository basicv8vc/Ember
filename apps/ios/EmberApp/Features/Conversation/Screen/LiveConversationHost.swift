import Foundation
import Observation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The Live host observes real Cloud state; it never runs the local Mock reply generator unless explicitly configured for B3 Mock UI tests.
@MainActor @Observable
final class LiveConversationHostModel {
    enum RootTab: Hashable, Sendable {
        case chat
        case tasks
    }

    private let repository: any LiveConversationServiceProtocol
    private let auth: any LiveAuthControlling
    private let pollingWindow: Duration
    private let taskPollInterval: Duration
    private let monotonicNow: @Sendable () -> ContinuousClock.Instant
    private var pollTask: Task<Void, Never>?
    private var taskObserverTask: Task<Void, Never>?
    private var conversationRefreshTask: Task<Void, Never>?
    private var scheduleArrivalTask: Task<Void, Never>?
    private var currentPollSessionID = UUID()
    private var sessionGeneration: UInt64 = 0

    let taskStore: SessionTaskStore
    let scheduleStore: ProactiveScheduleStore
    let memoryStore: PersonalMemoryStore
    let cloudDeviceMonitor: CloudDeviceAdapterMonitor?
    let isMockMode: Bool
    let environmentBadge: String

    private let cloudBaseURL: URL?
    private let deviceAuthProvider: (any AuthSessionProvider)?
    private let userDefaults: UserDefaults
    private let isDeviceExecutorLaunchOverride: Bool
    private let deviceExecutorTransport: (any CloudDeviceAPITransporting)?
    private let deviceExecutorCredentialStore: (any CloudDeviceCredentialStoring)?
    private let deviceExecutorJournal: CloudDeviceExecutionJournal?
    private let deviceExecutorWorkspace: DeviceSandboxWorkspace?
    private let deviceExecutorClock: (any CloudDeviceClock)?
    private var deviceExecutorPreferenceKey: String?
    private var deviceExecutorLifecycleTask: Task<Void, Never>?

    var selectedTab: RootTab = .chat
    var chatNavigationPath: [UUID] = []
    var tasksNavigationPath: [UUID] = []
    var copiedOutcomeAlert = false

    private(set) var profile: EmberMeDTO?
    private(set) var snapshot: ConversationSnapshot?
    private(set) var isLoading = false
    private(set) var isSubmitting = false
    private(set) var isSigningIn = false
    private(set) var isSigningOut = false
    private(set) var isPollingPaused = false
    private(set) var isViewVisible = false
    private(set) var isSceneActive = true
    private(set) var isDeviceExecutorEnabled = false
    private(set) var deviceExecutorError: String?
    private(set) var command: ConversationCommandStatus = .idle
    private(set) var reply: ConversationReplyState = .idle
    private(set) var status: String?
    private(set) var refreshErrorMessage: String?
    private(set) var requiresSignIn = false
    private(set) var rejectedDraftText: String?
    private(set) var stagedAttachments: [ComposerAttachment] = []
    private(set) var isUploadingAttachment = false
    private(set) var attachmentError: String?

    init(
        repository: any LiveConversationServiceProtocol,
        auth: any LiveAuthControlling,
        taskRepository: (any SessionTaskRepositoryProtocol)? = nil,
        scheduleRepository: (any ProactiveScheduleRepositoryProtocol)? = nil,
        memoryRepository: (any PersonalMemoryRepositoryProtocol)? = nil,
        cloudBaseURL: URL? = nil,
        deviceAuthProvider: (any AuthSessionProvider)? = nil,
        userDefaults: UserDefaults = .standard,
        deviceExecutorTransport: (any CloudDeviceAPITransporting)? = nil,
        deviceExecutorCredentialStore: (any CloudDeviceCredentialStoring)? = nil,
        deviceExecutorJournal: CloudDeviceExecutionJournal? = nil,
        deviceExecutorWorkspace: DeviceSandboxWorkspace? = nil,
        deviceExecutorClock: (any CloudDeviceClock)? = nil,
        isMockMode: Bool = false,
        environmentBadge: String = "LIVE CLOUD",
        pollingWindow: Duration = .seconds(60),
        taskPollInterval: Duration = .seconds(2),
        monotonicNow: @Sendable @escaping () -> ContinuousClock.Instant = { ContinuousClock.now }
    ) {
        self.repository = repository
        self.auth = auth
        self.taskStore = SessionTaskStore(repository: taskRepository)
        self.scheduleStore = ProactiveScheduleStore(repository: scheduleRepository)
        self.memoryStore = PersonalMemoryStore(repository: memoryRepository)
        self.cloudBaseURL = cloudBaseURL
        self.deviceAuthProvider = deviceAuthProvider
        self.userDefaults = userDefaults
        self.deviceExecutorTransport = deviceExecutorTransport
        self.deviceExecutorCredentialStore = deviceExecutorCredentialStore
        self.deviceExecutorJournal = deviceExecutorJournal
        self.deviceExecutorWorkspace = deviceExecutorWorkspace
        self.deviceExecutorClock = deviceExecutorClock
        if !isMockMode, cloudBaseURL != nil, deviceAuthProvider != nil {
            self.cloudDeviceMonitor = CloudDeviceAdapterMonitor()
            self.isDeviceExecutorLaunchOverride =
                ProcessInfo.processInfo.arguments.contains("--ember-enable-device-executor")
        } else {
            self.cloudDeviceMonitor = nil
            self.isDeviceExecutorLaunchOverride = false
        }
        self.deviceExecutorPreferenceKey = nil
        self.isDeviceExecutorEnabled = false
        self.isMockMode = isMockMode
        self.environmentBadge = environmentBadge
        self.pollingWindow = pollingWindow
        self.taskPollInterval = taskPollInterval
        self.monotonicNow = monotonicNow
    }

    func start() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            // Bootstrap identity first: an unresolved outbox lookup may fail offline, but the
            // signed-in user must still see the Live UI and a recovery action, not an empty Mock.
            let bootstrapProfile = try await repository.bootstrap()
            profile = bootstrapProfile
            requiresSignIn = false
            applyStoredDeviceExecutorPreference(for: bootstrapProfile)
            do {
                let recovered = try await repository.recoverAfterRelaunch()
                snapshot = recovered
                status = nil
                refreshErrorMessage = nil
                reply = .idle
                if let rejected = try await repository.rejectedDraft() {
                    rejectedDraftText = rejected.text
                    command = .rejected
                    reply = .failed(message: "The previous message was rejected. Review before sending again.", retryable: false)
                    status = "The rejected message will not be sent automatically."
                }
                if try await repository.activeTurn() != nil {
                    reply = .generating
                    if isViewVisible && isSceneActive {
                        beginPolling()
                    }
                }
                await syncTasksFromCloud(snapshot: recovered)
                await syncCloudDeviceExecutorState()
                await refreshSchedulesAndArmArrival()
            } catch {
                command = .unknownAcknowledgement
                reply = .failed(
                    message: "Cloud history or send reconciliation unavailable. Retry safely.",
                    retryable: true)
                status = "Live Cloud is unavailable; no Mock response will be shown."
            }
        } catch let error as AuthError where error.requiresNewSignIn {
            requiresSignIn = true
            status = "Sign in with Apple to use Live Cloud."
        } catch {
            // A failed bootstrap never causes a switch to the Mock conversation.
            reply = .failed(message: "Cloud connection unavailable. Retry to connect.", retryable: true)
            status = "Cloud conversation is unavailable. Retry when connected."
        }
    }

    func signIn() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            try await auth.signInWithApple()
            let bootstrapProfile = try await repository.bootstrap()
            profile = bootstrapProfile
            let loaded = try await repository.load()
            snapshot = loaded
            requiresSignIn = false
            applyStoredDeviceExecutorPreference(for: bootstrapProfile)
            status = nil
            refreshErrorMessage = nil
            await syncTasksFromCloud(snapshot: loaded)
            await syncCloudDeviceExecutorState()
            await refreshSchedulesAndArmArrival()
        } catch let error as AuthError where error == .appleCancelled {
            status = "Sign-in cancelled."
        } catch {
            status = "Could not sign in to Live Cloud."
        }
    }

    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        defer { isSigningOut = false }

        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false
        currentPollSessionID = UUID()
        if let previousTask {
            _ = await previousTask.value
        }
        await enqueueDeviceExecutorOperation { [weak self] in
            await self?.cloudDeviceMonitor?.stop()
        }

        switch await auth.logout() {
        case .revokedRemotely, .alreadyInvalidated:
            clearLiveState()
            status = String(localized: "conversation.live.signed_out", table: "Conversation")
        case .remoteUnconfirmed:
            clearLiveState()
            status = String(localized: "conversation.live.sign_out_unconfirmed", table: "Conversation")
        case .localCleanupFailed:
            status = String(localized: "conversation.live.sign_out_local_error", table: "Conversation")
        }
    }

    func setDeviceExecutorEnabled(_ enabled: Bool) async {
        isDeviceExecutorEnabled = enabled
        deviceExecutorError = nil
        if let profile, let cloudBaseURL, cloudDeviceMonitor != nil {
            let key = Self.makeDeviceExecutorPreferenceKey(host: cloudBaseURL, consumerID: profile.consumerID)
            deviceExecutorPreferenceKey = key
            userDefaults.set(enabled, forKey: key)
        }
        await syncCloudDeviceExecutorState()
    }

    private func syncCloudDeviceExecutorState() async {
        await enqueueDeviceExecutorOperation { [weak self] in
            await self?.performSyncCloudDeviceExecutorState()
        }
    }

    private func performSyncCloudDeviceExecutorState() async {
        guard let cloudDeviceMonitor else { return }
        guard !isSigningOut,
              isDeviceExecutorEnabled,
              !requiresSignIn,
              let profile,
              let cloudBaseURL,
              let deviceAuthProvider else {
            await cloudDeviceMonitor.stop()
            return
        }
        let targetConsumerID = profile.consumerID
        do {
            let configuration = try CloudDeviceEndpointConfiguration(
                origin: cloudBaseURL,
                accountID: targetConsumerID
            )
            try await cloudDeviceMonitor.connect(
                configuration: configuration,
                authProvider: deviceAuthProvider,
                credentialStore: deviceExecutorCredentialStore ?? KeychainCloudDeviceCredentialStore(),
                transport: deviceExecutorTransport,
                journal: deviceExecutorJournal,
                workspace: deviceExecutorWorkspace,
                clock: deviceExecutorClock ?? SystemCloudDeviceClock(),
                autoStart: false
            )
            guard !isSigningOut,
                  isDeviceExecutorEnabled,
                  !requiresSignIn,
                  self.profile?.consumerID == targetConsumerID else {
                await cloudDeviceMonitor.stop()
                return
            }
            await cloudDeviceMonitor.start()
            guard !isSigningOut,
                  isDeviceExecutorEnabled,
                  !requiresSignIn,
                  self.profile?.consumerID == targetConsumerID else {
                await cloudDeviceMonitor.stop()
                return
            }
            deviceExecutorError = nil
        } catch {
            guard !isSigningOut,
                  isDeviceExecutorEnabled,
                  !requiresSignIn,
                  self.profile?.consumerID == targetConsumerID else {
                await cloudDeviceMonitor.stop()
                return
            }
            deviceExecutorError = String(localized: "device.executor.error.connect_failed", table: "Conversation")
        }
    }

    private func enqueueDeviceExecutorOperation(
        _ operation: @escaping @MainActor () async -> Void
    ) async {
        let previous = deviceExecutorLifecycleTask
        let next = Task { @MainActor in
            _ = await previous?.value
            await operation()
        }
        deviceExecutorLifecycleTask = next
        await next.value
    }

    private func applyStoredDeviceExecutorPreference(for profile: EmberMeDTO) {
        guard cloudDeviceMonitor != nil, let cloudBaseURL else {
            deviceExecutorPreferenceKey = nil
            isDeviceExecutorEnabled = false
            return
        }
        let key = Self.makeDeviceExecutorPreferenceKey(host: cloudBaseURL, consumerID: profile.consumerID)
        deviceExecutorPreferenceKey = key
        isDeviceExecutorEnabled = isDeviceExecutorLaunchOverride || userDefaults.bool(forKey: key)
    }

    private static func makeDeviceExecutorPreferenceKey(host: URL, consumerID: UUID) -> String {
        let hostKey = host.host?.lowercased() ?? "default"
        return "ember.v2.deviceExecutor.enabled.\(hostKey).\(consumerID.uuidString.lowercased())"
    }

    private func clearLiveState() {
        sessionGeneration &+= 1
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        deviceExecutorPreferenceKey = nil
        isDeviceExecutorEnabled = false
        if let monitor = cloudDeviceMonitor {
            Task { @MainActor [weak self] in
                await self?.enqueueDeviceExecutorOperation {
                    await monitor.stop()
                }
            }
        }
        deviceExecutorError = nil
        profile = nil
        snapshot = nil
        requiresSignIn = true
        rejectedDraftText = nil
        stagedAttachments.removeAll()
        isUploadingAttachment = false
        attachmentError = nil
        refreshErrorMessage = nil
        command = .idle
        reply = .idle
        isPollingPaused = false
        selectedTab = .chat
        chatNavigationPath.removeAll()
        tasksNavigationPath.removeAll()
        taskStore.clear()
        scheduleStore.clear()
        memoryStore.clear()
    }

    func removeAttachment(_ attachmentID: UUID) {
        stagedAttachments.removeAll { $0.id == attachmentID }
        attachmentError = nil
    }

    func reportAttachmentPickerFailure() {
        attachmentError = String(localized: "conversation.composer.attachment_read_failed", table: "Conversation")
    }

    func reportCameraUnavailable() {
        attachmentError = String(localized: "conversation.composer.camera_unavailable", table: "Conversation")
    }

    func attachImageData(_ rawData: Data, suggestedFilename: String = "photo.jpg") async {
        guard let image = UIImage(data: rawData) else {
            attachmentError = String(localized: "conversation.composer.attachment_read_failed", table: "Conversation")
            return
        }
        await attachUIImage(image, suggestedFilename: suggestedFilename)
    }

    func attachUIImage(_ image: UIImage, suggestedFilename: String = "photo.jpg") async {
        guard !isUploadingAttachment, !isSubmitting else { return }
        guard stagedAttachments.count < B3AttachmentLimits.maxAttachmentsPerMessage else {
            attachmentError = String(localized: "conversation.composer.attachment_limit", table: "Conversation")
            return
        }

        guard let prepared = Self.encodeUploadImage(image) else {
            attachmentError = String(localized: "conversation.composer.attachment_read_failed", table: "Conversation")
            return
        }

        let startGeneration = sessionGeneration
        isUploadingAttachment = true
        attachmentError = nil
        defer {
            if sessionGeneration == startGeneration {
                isUploadingAttachment = false
            }
        }

        guard prepared.uploadData.count <= B3AttachmentLimits.maxFileBytes else {
            attachmentError = String(localized: "conversation.composer.attachment_too_large", table: "Conversation")
            return
        }

        do {
            let jpegName = Self.jpegFilename(for: suggestedFilename)
            let filename = B3AttachmentLimits.safeUploadFilename(jpegName, mediaType: "image/jpeg")
            let receipt = try await repository.uploadAttachment(
                filename: filename,
                mediaType: "image/jpeg",
                data: prepared.uploadData
            )
            guard sessionGeneration == startGeneration, !Task.isCancelled else { return }
            if !stagedAttachments.contains(where: { $0.id == receipt.uploadID }) {
                stagedAttachments.append(
                    ComposerAttachment(
                        id: receipt.uploadID,
                        filename: receipt.filename,
                        mediaType: receipt.mediaType,
                        sizeBytes: receipt.size,
                        thumbnailData: prepared.thumbnailData
                    )
                )
            }
        } catch {
            guard sessionGeneration == startGeneration else { return }
            attachmentError = String(localized: "conversation.composer.attachment_upload_failed", table: "Conversation")
        }
    }

    func attachFile(from url: URL) async {
        guard !isUploadingAttachment, !isSubmitting else { return }
        guard stagedAttachments.count < B3AttachmentLimits.maxAttachmentsPerMessage else {
            attachmentError = String(localized: "conversation.composer.attachment_limit", table: "Conversation")
            return
        }

        let startGeneration = sessionGeneration
        isUploadingAttachment = true
        attachmentError = nil
        defer {
            if sessionGeneration == startGeneration {
                isUploadingAttachment = false
            }
        }

        let didStartScope = url.startAccessingSecurityScopedResource()
        defer {
            if didStartScope {
                url.stopAccessingSecurityScopedResource()
            }
        }

        var resolvedMediaType: String
        if let byExtension = B3AttachmentLimits.mediaType(forFileExtension: url.pathExtension) {
            resolvedMediaType = byExtension
        } else if let contentType = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType,
                  let preferred = contentType.preferredMIMEType {
            resolvedMediaType = B3AttachmentLimits.normalizedMediaType(preferred)
        } else {
            resolvedMediaType = "application/octet-stream"
        }

        guard B3AttachmentLimits.isSafeMediaType(resolvedMediaType) else {
            attachmentError = String(localized: "conversation.composer.attachment_unsupported", table: "Conversation")
            return
        }

        do {
            if let fileSize = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               fileSize > B3AttachmentLimits.maxFileBytes {
                attachmentError = String(localized: "conversation.composer.attachment_too_large", table: "Conversation")
                return
            }

            var data = try Data(contentsOf: url)
            var rawFilename = url.lastPathComponent
            var thumbnailData: Data?

            let shouldTranscodeToJpeg = resolvedMediaType == "image/heic"
                || resolvedMediaType == "image/heif"
                || (B3AttachmentLimits.isVisionImageMediaType(resolvedMediaType)
                    && resolvedMediaType != "image/gif"
                    && data.count > B3AttachmentLimits.maxVisionImageBytes)

            if shouldTranscodeToJpeg,
               let image = UIImage(data: data),
               let converted = Self.encodeUploadImage(image) {
                data = converted.uploadData
                resolvedMediaType = "image/jpeg"
                rawFilename = Self.jpegFilename(for: rawFilename)
                thumbnailData = converted.thumbnailData
            } else if B3AttachmentLimits.isVisionImageMediaType(resolvedMediaType),
                      let image = UIImage(data: data) {
                thumbnailData = Self.makeThumbnailData(from: image)
            }

            guard data.count <= B3AttachmentLimits.maxFileBytes else {
                attachmentError = String(localized: "conversation.composer.attachment_too_large", table: "Conversation")
                return
            }

            let filename = B3AttachmentLimits.safeUploadFilename(rawFilename, mediaType: resolvedMediaType)
            let receipt = try await repository.uploadAttachment(
                filename: filename,
                mediaType: resolvedMediaType,
                data: data
            )
            guard sessionGeneration == startGeneration, !Task.isCancelled else { return }
            if !stagedAttachments.contains(where: { $0.id == receipt.uploadID }) {
                stagedAttachments.append(
                    ComposerAttachment(
                        id: receipt.uploadID,
                        filename: receipt.filename,
                        mediaType: receipt.mediaType,
                        sizeBytes: receipt.size,
                        thumbnailData: thumbnailData
                    )
                )
            }
        } catch {
            guard sessionGeneration == startGeneration else { return }
            attachmentError = String(localized: "conversation.composer.attachment_upload_failed", table: "Conversation")
        }
    }

    private static func jpegFilename(for rawFilename: String) -> String {
        let baseStem = (rawFilename as NSString).deletingPathExtension
        return baseStem.isEmpty ? "photo.jpg" : "\(baseStem).jpg"
    }

    private static func encodeUploadImage(_ image: UIImage) -> (uploadData: Data, thumbnailData: Data?)? {
        let maxDimension: CGFloat = 2048
        let originalSize = image.size
        guard originalSize.width > 0, originalSize.height > 0 else { return nil }
        let longest = max(originalSize.width, originalSize.height)
        let scale = longest > maxDimension ? (maxDimension / longest) : 1.0
        let targetSize = CGSize(
            width: max(1, (originalSize.width * scale).rounded()),
            height: max(1, (originalSize.height * scale).rounded())
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        var uploadData: Data?
        for quality: CGFloat in [0.82, 0.65, 0.5] {
            guard let candidate = rendered.jpegData(compressionQuality: quality) else { continue }
            uploadData = candidate
            if candidate.count <= B3AttachmentLimits.maxVisionImageBytes {
                break
            }
        }
        guard let uploadData else { return nil }
        let thumbData = makeThumbnailData(from: rendered)
        return (uploadData, thumbData)
    }

    private static func makeThumbnailData(from image: UIImage) -> Data? {
        let maxThumb: CGFloat = 112
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let longest = max(size.width, size.height)
        let scale = min(1.0, maxThumb / longest)
        let targetSize = CGSize(
            width: max(1, (size.width * scale).rounded()),
            height: max(1, (size.height * scale).rounded())
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let thumb = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        return thumb.jpegData(compressionQuality: 0.7)
    }

    func send(_ text: String) async {
        guard !isSubmitting, !isUploadingAttachment else { return }
        let attachmentIDs = stagedAttachments.map(\.id)
        isSubmitting = true
        command = .submitting
        rejectedDraftText = nil
        attachmentError = nil
        defer { isSubmitting = false }
        do {
            _ = try await repository.send(text: text, attachmentIDs: attachmentIDs)
            stagedAttachments.removeAll()
            command = .acknowledged
            reply = .generating
            let loaded = try await repository.load()
            snapshot = loaded
            refreshErrorMessage = nil
            status = isMockMode ? nil : "Message saved to Ember Cloud."
            beginPolling()
            await syncTasksFromCloud(snapshot: loaded)
        } catch let error as LiveB1Failure where error == .unknownAcknowledgement {
            command = .unknownAcknowledgement
            reply = .failed(message: "Send result is unknown. Check receipt before retrying.", retryable: true)
            status = "Your original send ID was saved. Recovery will not duplicate the message."
        } catch let error as LiveB1Failure where error == .staleEpoch || error == .conflict {
            rejectedDraftText = text
            command = .rejected
            reply = .failed(message: "Conversation changed. Review your draft before sending again.", retryable: false)
            status = "The server rejected this submission."
        } catch {
            command = .unknownAcknowledgement
            reply = .failed(message: "Cloud send was interrupted. Reconcile before resubmitting.", retryable: true)
        }
    }

    func retry() async {
        if profile == nil {
            await start()
            return
        }
        do {
            if try await repository.pending() != nil {
                if try await repository.reconcilePending() != nil {
                    command = .acknowledged
                    reply = .generating
                    let loaded = try await repository.load()
                    snapshot = loaded
                    status = nil
                    beginPolling()
                    await syncTasksFromCloud(snapshot: loaded)
                }
            } else {
                let loaded = try await repository.load()
                snapshot = loaded
                if try await repository.activeTurn() != nil {
                    reply = .generating
                    if isViewVisible && isSceneActive {
                        beginPolling()
                    }
                }
                await syncTasksFromCloud(snapshot: loaded)
            }
        } catch {
            reply = .failed(message: "Could not confirm the previous send. Try again later.", retryable: true)
            command = .unknownAcknowledgement
        }
    }

    func stop() async {
        guard !isSubmitting else { return }
        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false
        currentPollSessionID = UUID()
        if let previousTask {
            _ = await previousTask.value
        }

        do {
            let result = try await repository.cancelActiveTurn()
            if result?.status == .cancelled {
                reply = .idle
                status = "Turn cancelled on Ember Cloud."
            } else {
                status = "Cancellation requested; checking server state."
                beginPolling()
            }
            let loaded = try await repository.load()
            snapshot = loaded
            await syncTasksFromCloud(snapshot: loaded)
        } catch {
            status = "Cancellation unconfirmed; server state will be checked."
            beginPolling()
        }
    }

    func refreshTasks() async {
        guard !requiresSignIn, taskStore.hasRepository else { return }
        await taskStore.syncReferences(from: snapshot)
    }

    func handleTabSelection(_ tab: RootTab) async {
        switch tab {
        case .chat:
            if canPerformBackgroundRefresh {
                await refreshConversationAndTasks()
            } else {
                await refreshTasks()
            }
        case .tasks:
            await refreshTasks()
        }
    }

    func refreshConversationAndTasks() async {
        if let inFlight = conversationRefreshTask {
            _ = await inFlight.value
        }
        if profile == nil,
           !requiresSignIn,
           !isLoading,
           !isSubmitting,
           !isSigningIn,
           !isSigningOut,
           command != .unknownAcknowledgement,
           rejectedDraftText == nil {
            await start()
            return
        }
        guard canPerformBackgroundRefresh else {
            await refreshTasks()
            return
        }
        let expectedGeneration = sessionGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            await performControlledConversationRefresh(expectedGeneration: expectedGeneration)
        }
        conversationRefreshTask = task
        _ = await task.value
        if sessionGeneration == expectedGeneration {
            conversationRefreshTask = nil
        }
    }

    private var canPerformBackgroundRefresh: Bool {
        !isLoading && !isSigningIn && canArmScheduleArrival
    }

    private var canArmScheduleArrival: Bool {
        profile != nil
            && !requiresSignIn
            && !isSubmitting
            && !isSigningOut
            && pollTask == nil
            && !isPollingPaused
            && reply != .generating
            && command != .unknownAcknowledgement
            && rejectedDraftText == nil
    }

    private func scheduleForegroundRefresh() {
        guard conversationRefreshTask == nil, canPerformBackgroundRefresh else { return }
        let expectedGeneration = sessionGeneration
        conversationRefreshTask = Task { [weak self] in
            guard let self else { return }
            await performControlledConversationRefresh(expectedGeneration: expectedGeneration)
            if sessionGeneration == expectedGeneration {
                conversationRefreshTask = nil
            }
        }
    }

    private func performControlledConversationRefresh(
        expectedGeneration: UInt64,
        rearmSchedules: Bool = true
    ) async {
        guard sessionGeneration == expectedGeneration, canPerformBackgroundRefresh else { return }
        do {
            let loaded = try await repository.load()
            guard sessionGeneration == expectedGeneration,
                  !Task.isCancelled,
                  canPerformBackgroundRefresh
            else { return }
            snapshot = loaded
            refreshErrorMessage = nil
            if command == .idle, case .failed(_, retryable: true) = reply {
                reply = .idle
            }
            await syncTasksFromCloud(snapshot: loaded)
            if rearmSchedules {
                await refreshSchedulesAndArmArrival()
            }
        } catch is CancellationError {
            return
        } catch {
            guard sessionGeneration == expectedGeneration else { return }
            refreshErrorMessage = String(localized: "conversation.live.refresh_unavailable", table: "Conversation")
            await syncTasksFromCloud(snapshot: snapshot)
        }
    }

    func handleSchedulesSheetDismissed() async {
        if canPerformBackgroundRefresh {
            await refreshConversationAndTasks()
        } else {
            await refreshSchedulesAndArmArrival()
        }
    }

    private func refreshSchedulesAndArmArrival() async {
        guard !requiresSignIn, !isMockMode, scheduleStore.hasRepository else { return }
        await scheduleStore.refresh()
        armScheduleArrivalRefreshIfNeeded()
    }

    private func armScheduleArrivalRefreshIfNeeded(allowImmediatePastDue: Bool = true) {
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        guard isViewVisible,
              isSceneActive,
              !isMockMode,
              scheduleStore.hasRepository,
              canArmScheduleArrival else { return }

        let now = Date()
        let initialDelaySeconds: TimeInterval
        if scheduleStore.hasInFlightRun {
            initialDelaySeconds = 2.0
        } else if let nextFire = scheduleStore.nextActiveFireDate {
            if nextFire <= now && !allowImmediatePastDue {
                return
            }
            let delta = nextFire.timeIntervalSince(now) + 2.0
            guard delta <= 300 else { return }
            initialDelaySeconds = max(1.0, delta)
        } else {
            return
        }

        let expectedGeneration = sessionGeneration
        scheduleArrivalTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(initialDelaySeconds))
            } catch {
                return
            }
            guard let self else { return }
            for attempt in 0..<4 {
                guard !Task.isCancelled,
                      self.sessionGeneration == expectedGeneration,
                      self.isViewVisible,
                      self.isSceneActive,
                      self.canPerformBackgroundRefresh else { return }

                await self.scheduleStore.refresh()
                await self.performControlledConversationRefresh(
                    expectedGeneration: expectedGeneration,
                    rearmSchedules: false
                )

                guard !Task.isCancelled,
                      self.sessionGeneration == expectedGeneration,
                      self.isViewVisible,
                      self.isSceneActive,
                      self.canPerformBackgroundRefresh else { return }

                let stillExpectingArrival =
                    self.scheduleStore.hasInFlightRun
                    || (self.scheduleStore.nextActiveFireDate.map { $0 <= Date() } ?? false)
                guard stillExpectingArrival, attempt < 3 else { break }

                do {
                    try await Task.sleep(for: .seconds(2.5))
                } catch {
                    return
                }
            }
            if self.sessionGeneration == expectedGeneration {
                self.scheduleArrivalTask = nil
                self.armScheduleArrivalRefreshIfNeeded(allowImmediatePastDue: false)
            }
        }
    }

    func openTaskFromChat(_ taskID: UUID) {
        selectedTab = .chat
        if chatNavigationPath.last != taskID {
            chatNavigationPath.append(taskID)
        }
    }

    func openTaskFromInbox(_ taskID: UUID) {
        selectedTab = .tasks
        if tasksNavigationPath.last != taskID {
            tasksNavigationPath.append(taskID)
        }
    }

    func resumePolling() {
        guard !requiresSignIn else { return }
        guard reply == .generating || isPollingPaused else { return }
        isPollingPaused = false
        status = String(localized: "conversation.live.checking_status", table: "Conversation")
        beginPolling()
    }

    func handleViewAppeared() {
        isViewVisible = true
        guard isSceneActive && !requiresSignIn else { return }
        if (reply == .generating || isPollingPaused) && pollTask == nil {
            isPollingPaused = false
            beginPolling()
        } else if canPerformBackgroundRefresh {
            scheduleForegroundRefresh()
        }
    }

    func handleViewDisappeared() {
        isViewVisible = false
        suspendForDisappearance()
    }

    func handleSceneActive() {
        isSceneActive = true
        guard isViewVisible && !requiresSignIn else { return }
        if (reply == .generating || isPollingPaused) && pollTask == nil {
            isPollingPaused = false
            beginPolling()
        } else if canPerformBackgroundRefresh {
            scheduleForegroundRefresh()
        }
    }

    func handleSceneInactive() {
        isSceneActive = false
        suspendForDisappearance()
    }

    func handleScenePhase(_ phase: ScenePhase) {
        if let cloudDeviceMonitor {
            Task { @MainActor [weak self] in
                await self?.enqueueDeviceExecutorOperation { [weak self] in
                    guard let self else { return }
                    guard !self.isSigningOut, !self.requiresSignIn, self.isDeviceExecutorEnabled else {
                        await cloudDeviceMonitor.stop()
                        return
                    }
                    await cloudDeviceMonitor.handleScenePhase(phase)
                }
            }
        }
        switch phase {
        case .active:
            handleSceneActive()
        case .inactive, .background:
            handleSceneInactive()
        @unknown default:
            break
        }
    }

    func suspendForDisappearance() {
        // Disappearance or inactive state stops only observation. It must not cancel the durable server Turn.
        pollTask?.cancel()
        pollTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
    }

    var screen: ConversationScreenState {
        let id = profile?.conversation.conversationID
        let timeline: [ConversationTimelineEntry] = (snapshot?.messages ?? []).map { message in
            let stableID = "conversation-message-\(message.id.rawValue.uuidString.lowercased())"
            switch message.kind {
            case .user(let text):
                return .message(ConversationMessagePresentation(
                    id: stableID,
                    author: .user,
                    text: text,
                    timestamp: message.createdAt
                ))
            case .ember(let text):
                return .message(ConversationMessagePresentation(
                    id: stableID,
                    author: .ember,
                    text: text,
                    timestamp: message.createdAt
                ))
            case .activity(let activity):
                return .activity(ConversationActivityPresentation(
                    id: stableID,
                    title: "Cloud activity",
                    detail: activity.text,
                    timestamp: message.createdAt
                ))
            case .taskReference(let ref):
                return makeTaskReferenceEntry(stableID: stableID, taskID: ref.taskID)
            case .commitmentReference(let ref):
                return .activity(ConversationActivityPresentation(
                    id: stableID,
                    title: "Commitment reference",
                    detail: ref.commitmentID.uuidString,
                    timestamp: message.createdAt
                ))
            case .outcomeReference(let outcome):
                return makeOutcomeReferenceEntry(stableID: stableID, outcome: outcome)
            }
        }
        return ConversationScreenState(
            partnerName: profile?.agent.displayName ?? "Ember Cloud",
            timeline: timeline,
            replyState: reply,
            suggestedPrompts: [],
            showsEmptyState: timeline.isEmpty && id != nil,
            isLoading: isLoading,
            isSubmitting: isSubmitting,
            commandStatus: command,
            attachments: stagedAttachments,
            isUploadingAttachment: isUploadingAttachment,
            attachmentError: attachmentError
        )
    }

    private func makeTaskReferenceEntry(stableID: String, taskID: UUID) -> ConversationTimelineEntry {
        if let task = taskStore.tasksByID[taskID] {
            let presentation = TaskPresentationState(
                taskStatus: task.status,
                connectionPhase: taskStore.detailErrorByTaskID[taskID] != nil ? .disconnected : .connected,
                commandInFlight: taskStore.cancellingTaskIDs.contains(taskID) ? .cancellingTask : nil,
                capability: taskStore.isMock(task) ? .mockOnly : .real
            )
            let cancelResponse = taskStore.cancelResponseByTaskID[taskID]
            let generatedArtifactCount = (taskStore.artifactsByTaskID[taskID] ?? [])
                .filter { $0.createdBy == .run }
                .count
            let progressDetail = Self.taskCardProgressDetail(
                task: task,
                latestEvent: taskStore.eventsByTaskID[taskID]?.last,
                result: taskStore.resultsByTaskID[taskID]
            )
            return .inlineCard(id: stableID, accessibilityLabel: task.displayTitle) {
                TaskActivityCard(
                    title: task.displayTitle,
                    taskID: task.taskID,
                    status: task.status,
                    updatedAt: task.updatedAt,
                    presentation: presentation,
                    cancelResponse: cancelResponse,
                    progressDetail: progressDetail,
                    artifactCount: generatedArtifactCount,
                    onOpenDetail: { [weak self] in
                        self?.openTaskFromChat(taskID)
                    }
                )
            }
        }

        let title = String(localized: "conversation.task.unavailable", table: "Conversation")
        let isLoadingTask = taskStore.isLoadingList || taskStore.loadingDetailTaskIDs.contains(taskID)
        let isMissing = taskStore.missingTaskIDs.contains(taskID)
        let isMock = isMockMode || taskStore.isMockOnly
        return .inlineCard(id: stableID, accessibilityLabel: title) {
            SessionTaskPendingReferenceCard(
                taskID: taskID,
                isLoading: isLoadingTask,
                isMissing: isMissing,
                isMockOnly: isMock,
                onOpenDetail: { [weak self] in
                    self?.openTaskFromChat(taskID)
                }
            )
        }
    }

    static func taskCardProgressDetail(
        task: SessionTaskDTO,
        latestEvent: SessionTaskEventDTO?,
        result: SessionTaskResultDTO?
    ) -> String? {
        if task.status == .completed,
           let summary = result?.result?.summaryText.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty {
            return summary
        }

        if let latestEvent {
            let facts = ActivityEventRow.facts(for: latestEvent.asTaskEventDTO())
            let localizedTitle = Bundle.main.localizedString(
                forKey: facts.titleKey,
                value: nil,
                table: "ConversationCards"
            )
            if let errorCode = facts.errorCode {
                return "\(localizedTitle) (\(errorCode.rawValue))"
            }
            return localizedTitle
        }

        return nil
    }

    private func makeOutcomeReferenceEntry(stableID: String, outcome: OutcomeReference) -> ConversationTimelineEntry {
        let taskID: UUID? = switch outcome {
        case .taskResult(let id): id
        case .artifact(_, let taskID): taskID
        case .commitmentOutcome: nil
        }

        let task = taskID.flatMap { taskStore.tasksByID[$0] }
        let result = taskID.flatMap { taskStore.resultsByTaskID[$0] }
        let title = task?.displayTitle ?? String(localized: "card.result", table: "ConversationCards")

        let summaryText: String?
        let readableContent: String?
        if let result, result.resultState == .available, let payload = result.result {
            if let detail = payload.detailText, OutcomeCard.hasReadableContent(detail) {
                summaryText = payload.summaryText
                readableContent = detail
            } else {
                summaryText = nil
                readableContent = payload.summaryText
            }
        } else {
            summaryText = nil
            readableContent = nil
        }

        let isSimulated = taskStore.isMock(task, result: result) || isMockMode
        let generatedArtifacts = taskID.flatMap { taskStore.artifactsByTaskID[$0] }?.filter { $0.createdBy == .run } ?? []
        return .inlineCard(id: stableID, accessibilityLabel: title) {
            VStack(alignment: .leading, spacing: 8) {
                OutcomeCard(
                    title: title,
                    summary: summaryText,
                    readableContent: readableContent,
                    isMockOnly: isSimulated,
                    onCopy: readableContent.map { content in
                        { [weak self] in
                            UIPasteboard.general.string = content
                            self?.copiedOutcomeAlert = true
                        }
                    }
                )

                if let taskID, !generatedArtifacts.isEmpty {
                    Button { [weak self] in
                        self?.openTaskFromChat(taskID)
                    } label: {
                        Label {
                            Text("tasks.artifacts.open_files_count \(generatedArtifacts.count)", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "doc.badge.arrow.up")
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("outcome-open-artifacts-\(taskID.uuidString.lowercased())")
                }
            }
        }
    }

    private func syncTasksFromCloud(snapshot: ConversationSnapshot?) async {
        guard taskStore.hasRepository else { return }
        await taskStore.syncReferences(from: snapshot)
        beginTaskObservationIfNeeded()
    }

    private func beginTaskObservationIfNeeded() {
        guard !isMockMode,
              isViewVisible,
              isSceneActive,
              !requiresSignIn,
              pollTask == nil,
              !isPollingPaused,
              command != .unknownAcknowledgement,
              rejectedDraftText == nil,
              taskStore.hasObservableInProgressTask(in: snapshot)
        else {
            taskObserverTask?.cancel()
            taskObserverTask = nil
            return
        }
        guard taskObserverTask == nil else { return }

        let expectedGeneration = sessionGeneration
        let startTime = monotonicNow()
        taskObserverTask = Task { [weak self] in
            defer {
                if let self, self.sessionGeneration == expectedGeneration {
                    self.taskObserverTask = nil
                }
            }
            while let self,
                  !Task.isCancelled,
                  self.sessionGeneration == expectedGeneration,
                  self.isViewVisible,
                  self.isSceneActive,
                  !self.requiresSignIn,
                  self.pollTask == nil,
                  !self.isPollingPaused,
                  self.monotonicNow() - startTime < self.pollingWindow,
                  self.taskStore.hasObservableInProgressTask(in: self.snapshot) {
                do {
                    try await Task.sleep(for: self.taskPollInterval)
                } catch {
                    return
                }
                guard !Task.isCancelled,
                      self.sessionGeneration == expectedGeneration,
                      self.isViewVisible,
                      self.isSceneActive,
                      !self.requiresSignIn,
                      self.pollTask == nil,
                      !self.isPollingPaused
                else { return }

                let previouslyInProgress = Set(
                    self.taskStore.tasksByID.values
                        .filter { !$0.status.isTerminal && $0.status != .waitingApproval }
                        .map(\.taskID)
                )
                let previouslyUnresolved = SessionTaskStore.referencedIDs(in: self.snapshot).taskIDs.filter {
                    self.taskStore.tasksByID[$0] == nil
                }
                let trackedIDs = previouslyInProgress.union(previouslyUnresolved)

                await self.taskStore.syncReferences(from: self.snapshot)
                guard !Task.isCancelled, self.sessionGeneration == expectedGeneration else { return }

                let shouldRefreshConversation = trackedIDs.contains { taskID in
                    guard let updated = self.taskStore.tasksByID[taskID] else { return false }
                    return updated.status.isTerminal || updated.status == .waitingApproval
                }
                if shouldRefreshConversation, self.canPerformBackgroundRefresh {
                    await self.performControlledConversationRefresh(expectedGeneration: expectedGeneration)
                }
            }
        }
    }

    private func beginPolling() {
        guard isViewVisible && isSceneActive && !requiresSignIn else { return }
        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false

        let sessionID = UUID()
        currentPollSessionID = sessionID
        let startTime = monotonicNow()

        pollTask = Task { [weak self] in
            if let previousTask {
                _ = await previousTask.value
            }
            guard let self, currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
            while !Task.isCancelled && !requiresSignIn {
                if monotonicNow() - startTime >= pollingWindow {
                    guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                    pollTask = nil
                    isPollingPaused = true
                    status = String(localized: "conversation.live.waiting_for_cloud", table: "Conversation")
                    return
                }

                do {
                        guard let turn = try await repository.pollActiveTurn() else {
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        reply = .idle
                        pollTask = nil
                        isPollingPaused = false
                        await refreshSchedulesAndArmArrival()
                        return
                    }
                    guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                    switch turn.status {
                    case .running:
                        reply = .generating
                        if monotonicNow() - startTime >= pollingWindow {
                            pollTask = nil
                            isPollingPaused = true
                            status = String(localized: "conversation.live.waiting_for_cloud", table: "Conversation")
                            return
                        }
                    case .completed:
                        let loaded = try await repository.load()
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        snapshot = loaded
                        reply = .idle
                        status = isMockMode ? nil : "Completed by Ember Cloud."
                        pollTask = nil
                        isPollingPaused = false
                        await syncTasksFromCloud(snapshot: loaded)
                        await refreshSchedulesAndArmArrival()
                        return
                    case .failed:
                        let loaded = try await repository.load()
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        snapshot = loaded
                        reply = .failed(message: "Cloud turn failed.", retryable: false)
                        pollTask = nil
                        isPollingPaused = false
                        await syncTasksFromCloud(snapshot: loaded)
                        await refreshSchedulesAndArmArrival()
                        return
                    case .cancelled:
                        let loaded = try await repository.load()
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        snapshot = loaded
                        reply = .idle
                        status = "Turn cancelled."
                        pollTask = nil
                        isPollingPaused = false
                        await syncTasksFromCloud(snapshot: loaded)
                        await refreshSchedulesAndArmArrival()
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                    reply = .failed(message: "Cloud connection lost. Resume polling when online.", retryable: true)
                    pollTask = nil
                    isPollingPaused = false
                    return
                }
            }
        }
    }
}

private struct SessionTaskPendingReferenceCard: View {
    let taskID: UUID
    let isLoading: Bool
    let isMissing: Bool
    let isMockOnly: Bool
    let onOpenDetail: () -> Void

    var body: some View {
        Button(action: onOpenDetail) {
            ConversationCardSurface {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: isMissing ? "questionmark.circle" : "clock.arrow.circlepath")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 7) {
                            Text(
                                isLoading
                                    ? String(localized: "conversation.task.loading", table: "Conversation")
                                    : String(localized: "conversation.task.unavailable", table: "Conversation")
                            )
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)

                            if isMockOnly {
                                ConversationMockTag()
                            }
                        }

                        Text(taskID.uuidString.lowercased())
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("task-reference-unavailable-\(taskID.uuidString.lowercased())")
    }
}

/// Reuses ConversationScreen, TaskInboxView, TaskActivityCard, OutcomeCard, and DesignSystem
/// in a Chat + Tasks dual-tab shell behind Live authentication (and in `--ember-mock-chat-tasks`).
struct LiveConversationHost: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: LiveConversationHostModel
    @State private var draft = ""
    @State private var isConfirmingSignOut = false
    @State private var isShowingMemorySheet = false
    @State private var isShowingSchedulesSheet = false
    @State private var isShowingFileImporter = false
    @State private var isShowingPhotoPicker = false
    @State private var isShowingCamera = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []

    #if DEBUG
    private let debugUseV2Staging: Binding<Bool>?
    #endif

    private static var allowedAttachmentTypes: [UTType] {
        [.item]
    }

    #if DEBUG
    init(model: LiveConversationHostModel, debugUseV2Staging: Binding<Bool>? = nil) {
        _model = State(initialValue: model)
        self.debugUseV2Staging = debugUseV2Staging
    }
    #else
    init(model: LiveConversationHostModel) {
        _model = State(initialValue: model)
    }
    #endif

    var body: some View {
        Group {
            if model.requiresSignIn {
                signInView
            } else {
                TabView(selection: $model.selectedTab) {
                    chatTab
                        .tabItem {
                            Label(
                                String(localized: "tab.chat", table: "Conversation"),
                                systemImage: "bubble.left.and.bubble.right"
                            )
                        }
                        .tag(LiveConversationHostModel.RootTab.chat)

                    tasksTab
                        .tabItem {
                            Label(
                                String(localized: "tab.tasks", table: "Conversation"),
                                systemImage: "checklist"
                            )
                        }
                        .badge(model.taskStore.needsInterventionCount)
                        .tag(LiveConversationHostModel.RootTab.tasks)
                }
            }
        }
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .alert(
            Text("conversation.live.sign_out_confirm_title", tableName: "Conversation"),
            isPresented: $isConfirmingSignOut
        ) {
            Button(role: .cancel) {} label: {
                Text("conversation.live.cancel", tableName: "Conversation")
            }
            Button(role: .destructive) {
                Task {
                    await model.signOut()
                    if model.requiresSignIn { draft = "" }
                }
            } label: {
                Text("conversation.live.sign_out", tableName: "Conversation")
            }
        } message: {
            Text("conversation.live.sign_out_confirm_message", tableName: "Conversation")
        }
        .alert(
            Text("tasks.detail.copied_title", tableName: "Conversation"),
            isPresented: $model.copiedOutcomeAlert
        ) {
            Button(role: .cancel) {} label: {
                Text("tasks.detail.ok", tableName: "Conversation")
            }
        }
        .task { await model.start() }
        .onAppear {
            model.handleScenePhase(scenePhase)
            model.handleViewAppeared()
        }
        .onDisappear { model.handleViewDisappeared() }
        .onChange(of: model.rejectedDraftText) { _, rejected in
            // Do not overwrite user edits. Only an explicit Send may create a fresh ID.
            if let rejected, draft.isEmpty { draft = rejected }
        }
        .onChange(of: model.selectedTab) { _, newTab in
            Task { await model.handleTabSelection(newTab) }
        }
        .onChange(of: scenePhase) { _, newPhase in
            model.handleScenePhase(newPhase)
        }
    }

    private var signInView: some View {
        VStack(spacing: 16) {
            Text(model.environmentBadge)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(EmberDesignTokens.cardBackground, in: Capsule())
                .accessibilityIdentifier("live-sign-in-environment-badge")
            Text("Ember Cloud").font(.title2.bold())
            Text("Sign in to sync your conversation securely.")
                .foregroundStyle(.secondary)
            AppleSignInControl(isEnabled: !model.isSigningIn) {
                Task { await model.signIn() }
            }
            .frame(height: 50)
            .frame(maxWidth: 360)
            .accessibilityIdentifier("live-conversation-sign-in")
            if let status = model.status {
                Text(status).font(.footnote).foregroundStyle(.secondary)
            }
            #if DEBUG
            if let debugUseV2Staging,
               (ProcessInfo.processInfo.environment["EMBER_CLOUD_BASE_URL"] ?? "").isEmpty {
                Toggle("V2 Staging (Internal QA)", isOn: debugUseV2Staging)
                    .toggleStyle(.switch)
                    .font(.caption)
                    .frame(maxWidth: 260)
                    .padding(.top, 8)
                    .accessibilityIdentifier("debug-v2-staging-toggle")
            }
            #endif
        }
        .padding()
    }

    private var chatTab: some View {
        NavigationStack(path: $model.chatNavigationPath) {
            VStack(spacing: 0) {
                if model.isMockMode {
                    HStack(spacing: 12) {
                        MockOnlyBanner()
                        if model.scheduleStore.hasRepository {
                            Button {
                                isShowingSchedulesSheet = true
                            } label: {
                                Label {
                                    Text("schedules.nav_title", tableName: "Conversation")
                                } icon: {
                                    Image(systemName: "calendar.badge.clock")
                                }
                                .font(.caption.weight(.semibold))
                            }
                            .accessibilityIdentifier("live-conversation-open-schedules")
                        }
                        if model.memoryStore.hasRepository {
                            Button {
                                isShowingMemorySheet = true
                            } label: {
                                Label {
                                    Text("memory.nav_title", tableName: "Conversation")
                                } icon: {
                                    Image(systemName: "brain.head.profile")
                                }
                                .font(.caption.weight(.semibold))
                            }
                            .accessibilityIdentifier("live-conversation-open-memory")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .background(EmberDesignTokens.groupedBackground)
                } else {
                    HStack(spacing: 12) {
                        Text(model.environmentBadge)
                            .font(.caption.weight(.semibold))
                            .accessibilityIdentifier("live-cloud-mode")
                        Spacer()
                        if model.scheduleStore.hasRepository {
                            Button {
                                isShowingSchedulesSheet = true
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "calendar.badge.clock")
                                    Text("schedules.nav_title", tableName: "Conversation")
                                    if model.scheduleStore.activeCount > 0 {
                                        Text("(\(model.scheduleStore.activeCount))")
                                            .monospacedDigit()
                                    }
                                }
                                .font(.caption.weight(.semibold))
                            }
                            .disabled(model.isSigningOut || model.isLoading)
                            .accessibilityIdentifier("live-conversation-open-schedules")
                        }
                        if model.memoryStore.hasRepository {
                            Button {
                                isShowingMemorySheet = true
                            } label: {
                                Label {
                                    Text("memory.nav_title", tableName: "Conversation")
                                } icon: {
                                    Image(systemName: "brain.head.profile")
                                }
                                .font(.caption.weight(.semibold))
                            }
                            .disabled(model.isSigningOut || model.isLoading)
                            .accessibilityIdentifier("live-conversation-open-memory")
                        }
                        Button {
                            isConfirmingSignOut = true
                        } label: {
                            Text("conversation.live.sign_out", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(model.isSigningOut || model.isSubmitting || model.isLoading)
                        .accessibilityIdentifier("live-conversation-sign-out")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                }

                if let status = model.status {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.top, 2)
                        .accessibilityIdentifier("live-conversation-status")
                }

                if let refreshError = model.refreshErrorMessage {
                    HStack(alignment: .center, spacing: 10) {
                        Image(systemName: "wifi.slash")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color(uiColor: .systemOrange))
                            .accessibilityHidden(true)
                        Text(refreshError)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            Task { await model.refreshConversationAndTasks() }
                        } label: {
                            Text("conversation.live.refresh_retry", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("live-conversation-refresh-retry")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(uiColor: .systemOrange).opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("live-conversation-refresh-error")
                }

                if model.isPollingPaused {
                    Button {
                        model.resumePolling()
                    } label: {
                        Label(
                            String(localized: "conversation.live.check_again", table: "Conversation"),
                            systemImage: "arrow.clockwise"
                        )
                        .font(.caption.weight(.semibold))
                    }
                    .accessibilityIdentifier("live-conversation-resume-polling")
                    .padding(.vertical, 4)
                }

                ConversationScreen(
                    state: model.screen,
                    draft: $draft,
                    actions: ConversationScreenActions(
                        send: { text in
                            draft = ""
                            Task { await model.send(text) }
                        },
                        retry: { Task { await model.retry() } },
                        stopGenerating: { Task { await model.stop() } },
                        selectPrompt: { draft = $0 },
                        onTakePhoto: {
                            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                                isShowingCamera = true
                            } else {
                                model.reportCameraUnavailable()
                            }
                        },
                        onChoosePhoto: { isShowingPhotoPicker = true },
                        onPickAttachment: { isShowingFileImporter = true },
                        onRemoveAttachment: { model.removeAttachment($0) }
                    ),
                    composerNote: model.isMockMode
                        ? "conversation.composer.local_note"
                        : "conversation.composer.cloud_note",
                    showsSubmissionAcknowledgement: model.isMockMode,
                    replyPreparingText: model.isMockMode
                        ? "conversation.reply.preparing"
                        : "conversation.reply.waiting_for_cloud",
                    replyStopText: model.isMockMode
                        ? "conversation.reply.stop"
                        : "conversation.reply.cancel_cloud_turn",
                    emberMessageAuthorText: model.isMockMode
                        ? "conversation.message.ember_mock"
                        : "conversation.message.ember_cloud",
                    onRefresh: {
                        await model.refreshConversationAndTasks()
                    }
                )
            }
            .photosPicker(
                isPresented: $isShowingPhotoPicker,
                selection: $selectedPhotoItems,
                maxSelectionCount: max(1, B3AttachmentLimits.maxAttachmentsPerMessage - model.stagedAttachments.count),
                matching: .images
            )
            .onChange(of: selectedPhotoItems) { _, items in
                guard !items.isEmpty else { return }
                let picked = items
                selectedPhotoItems = []
                Task {
                    for (index, item) in picked.enumerated() {
                        if model.stagedAttachments.count >= B3AttachmentLimits.maxAttachmentsPerMessage {
                            break
                        }
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            await model.attachImageData(data, suggestedFilename: "photo_\(index + 1).jpg")
                        } else {
                            model.reportAttachmentPickerFailure()
                        }
                    }
                }
            }
            .fullScreenCover(isPresented: $isShowingCamera) {
                CameraCaptureSheet(
                    onCapture: { image in
                        isShowingCamera = false
                        Task {
                            await model.attachUIImage(image, suggestedFilename: "camera_photo.jpg")
                        }
                    },
                    onCancel: {
                        isShowingCamera = false
                    }
                )
                .ignoresSafeArea()
            }
            .fileImporter(
                isPresented: $isShowingFileImporter,
                allowedContentTypes: Self.allowedAttachmentTypes,
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first {
                        Task { await model.attachFile(from: url) }
                    }
                case .failure:
                    model.reportAttachmentPickerFailure()
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: UUID.self) { taskID in
                TaskDetailView(taskID: taskID, store: model.taskStore)
                    .toolbar(.hidden, for: .tabBar)
            }
            .sheet(isPresented: $isShowingMemorySheet) {
                PersonalMemorySheetView(store: model.memoryStore)
            }
            .sheet(isPresented: $isShowingSchedulesSheet) {
                ProactiveSchedulesSheetView(
                    store: model.scheduleStore,
                    onOpenChat: { isShowingSchedulesSheet = false }
                )
            }
            .onChange(of: isShowingSchedulesSheet) { _, isShowing in
                if !isShowing {
                    Task { await model.handleSchedulesSheetDismissed() }
                }
            }
        }
    }

    private var tasksTab: some View {
        NavigationStack(path: $model.tasksNavigationPath) {
            TaskInboxView(
                store: model.taskStore,
                scheduleStore: model.scheduleStore,
                deviceMonitor: model.cloudDeviceMonitor,
                isDeviceExecutorEnabled: model.isDeviceExecutorEnabled,
                deviceExecutorError: model.deviceExecutorError,
                onSetDeviceExecutorEnabled: { enabled in
                    Task { await model.setDeviceExecutorEnabled(enabled) }
                },
                onOpenChat: {
                    model.selectedTab = .chat
                },
                onOpenTask: { taskID in
                    model.openTaskFromInbox(taskID)
                }
            )
            .navigationDestination(for: UUID.self) { taskID in
                TaskDetailView(taskID: taskID, store: model.taskStore)
                    .toolbar(.hidden, for: .tabBar)
            }
        }
    }
}

private struct CameraCaptureSheet: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            } else {
                onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
