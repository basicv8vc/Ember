import Foundation
import Observation
import os
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct TurnLatencyMetrics: Equatable, Sendable {
    let mode: String
    let ttftMs: Int?
    let e2eMs: Int
    let deltaCount: Int
}

struct PendingRejectedDraft: Equatable, Sendable {
    let id: UUID
    let text: String
}

/// The Live host observes real Cloud state; it never runs the local Mock reply generator unless explicitly configured for B3 Mock UI tests.
@MainActor @Observable
final class LiveConversationHostModel {
    private static let latencyLogger = Logger(subsystem: "com.basicv8vc.ember", category: "ChatLatency")

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
    private var streamTask: Task<Void, Never>?
    private var taskObserverTask: Task<Void, Never>?
    private var conversationRefreshTask: Task<Void, Never>?
    private var scheduleArrivalTask: Task<Void, Never>?
    private var currentPollSessionID = UUID()
    private var currentStreamSessionID = UUID()
    private var sessionGeneration: UInt64 = 0
    private var isStarting = false
    private var startupReadinessTask: Task<Void, Never>?
    private var pendingDiscardTask: Task<Void, Never>?

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
    private(set) var isStopping = false
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
    private(set) var signInErrorMessage: String?
    private(set) var refreshErrorMessage: String?
    private(set) var requiresSignIn = false
    private(set) var rejectedDraftText: String?
    private(set) var pendingRejectedDraftRestoration: PendingRejectedDraft?
    private(set) var pendingOutgoingText: String?
    private(set) var streamingReplyText: String?
    private(set) var lastTurnMetrics: TurnLatencyMetrics?
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
        initialStagedAttachments: [ComposerAttachment] = [],
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
        self.stagedAttachments = isMockMode ? initialStagedAttachments : []
        self.environmentBadge = environmentBadge
        self.pollingWindow = pollingWindow
        self.taskPollInterval = taskPollInterval
        self.monotonicNow = monotonicNow
    }

    func start() async {
        guard !isStarting else { return }
        isStarting = true
        isLoading = true
        let expectedGeneration = sessionGeneration
        defer {
            isLoading = false
            isStarting = false
        }

        var recoveredSnapshot: ConversationSnapshot?
        let readinessTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                // Bootstrap identity first: an unresolved outbox lookup may fail offline, but the
                // signed-in user must still see the Live UI and a recovery action, not an empty Mock.
                let bootstrapProfile = try await self.repository.bootstrap()
                guard self.sessionGeneration == expectedGeneration, !Task.isCancelled else { return }
                self.profile = bootstrapProfile
                self.requiresSignIn = false
                self.signInErrorMessage = nil
                self.applyStoredDeviceExecutorPreference(for: bootstrapProfile)
                do {
                    let recovered = try await self.repository.recoverAfterRelaunch()
                    guard self.sessionGeneration == expectedGeneration, !Task.isCancelled else { return }
                    recoveredSnapshot = recovered
                    self.snapshot = recovered
                    let persistedPending = (try? await self.repository.pending())?.text
                    if !self.isSubmitting || persistedPending != nil {
                        self.pendingOutgoingText = persistedPending
                    }
                    if !self.isSubmitting {
                        self.streamingReplyText = nil
                        self.status = nil
                        self.refreshErrorMessage = nil
                        self.reply = .idle
                        if let rejected = try await self.repository.rejectedDraft() {
                            self.applyRejectedSubmission(draftText: rejected.text, reason: .previousDraft)
                        }
                    }
                    if try await self.repository.activeTurn() != nil {
                        self.reply = .generating
                        if self.isViewVisible && self.isSceneActive {
                            self.beginPolling()
                        }
                    }
                } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
                    guard self.sessionGeneration == expectedGeneration else { return }
                    self.applyAuthFailure(error)
                } catch let error as LiveB1Failure where error == .unavailable {
                    guard self.sessionGeneration == expectedGeneration else { return }
                    let persistedPending = (try? await self.repository.pending())?.text
                    self.pendingOutgoingText = persistedPending
                    if persistedPending != nil {
                        self.applyServiceUnavailable()
                    } else {
                        self.command = .unknownAcknowledgement
                        self.reply = .failed(
                            message: LiveConversationCopy.loadUnavailableMessage,
                            retryable: true
                        )
                        self.status = LiveConversationCopy.loadUnavailableStatus
                    }
                } catch {
                    guard self.sessionGeneration == expectedGeneration else { return }
                    let persistedPending = (try? await self.repository.pending())?.text
                    self.pendingOutgoingText = persistedPending
                    self.command = .unknownAcknowledgement
                    if persistedPending != nil {
                        self.reply = .failed(
                            message: LiveConversationCopy.sendUnknownAckMessage,
                            retryable: true
                        )
                        self.status = LiveConversationCopy.sendUnknownAckStatus
                    } else {
                        self.reply = .failed(
                            message: LiveConversationCopy.loadUnavailableMessage,
                            retryable: true
                        )
                        self.status = LiveConversationCopy.loadUnavailableStatus
                    }
                }
            } catch let error as AuthError where error == .accessDenied {
                guard self.sessionGeneration == expectedGeneration else { return }
                self.requiresSignIn = true
                let message = LiveConversationCopy.signInNotAllowlisted
                self.signInErrorMessage = message
                self.status = message
            } catch let error as AuthError where error.requiresNewSignIn {
                guard self.sessionGeneration == expectedGeneration else { return }
                self.requiresSignIn = true
                self.signInErrorMessage = nil
                self.status = LiveConversationCopy.signInPrompt
            } catch {
                guard self.sessionGeneration == expectedGeneration else { return }
                // A failed bootstrap never causes a switch to the Mock conversation.
                self.reply = .failed(message: LiveConversationCopy.connectionUnavailable, retryable: true)
                self.status = nil
            }
        }
        startupReadinessTask = readinessTask
        await readinessTask.value
        if sessionGeneration == expectedGeneration {
            startupReadinessTask = nil
        }
        isLoading = false

        guard sessionGeneration == expectedGeneration,
              !Task.isCancelled,
              let recovered = recoveredSnapshot else { return }

        async let tasksWork: Void = syncTasksFromCloud(snapshot: recovered)
        async let deviceWork: Void = syncCloudDeviceExecutorState()
        async let capabilitiesWork: Void = refreshSchedulesAndMemoryCapabilities()
        _ = await (tasksWork, deviceWork, capabilitiesWork)
    }

    func signIn() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        status = nil
        signInErrorMessage = nil
        defer { isSigningIn = false }
        do {
            try await auth.signInWithApple()
            let bootstrapProfile = try await repository.bootstrap()
            profile = bootstrapProfile
            let loaded = try await repository.load()
            snapshot = loaded
            pendingOutgoingText = nil
            streamingReplyText = nil
            requiresSignIn = false
            signInErrorMessage = nil
            applyStoredDeviceExecutorPreference(for: bootstrapProfile)
            status = nil
            refreshErrorMessage = nil
            async let tasksWork: Void = syncTasksFromCloud(snapshot: loaded)
            async let deviceWork: Void = syncCloudDeviceExecutorState()
            async let capabilitiesWork: Void = refreshSchedulesAndMemoryCapabilities()
            _ = await (tasksWork, deviceWork, capabilitiesWork)
        } catch let error as AuthError where error == .appleCancelled {
            signInErrorMessage = nil
            status = LiveConversationCopy.signInCancelled
        } catch let error as AuthError where error == .accessDenied || error == .unexpectedStatus(403) {
            let message = LiveConversationCopy.signInNotAllowlisted
            signInErrorMessage = message
            status = message
        } catch let error as AuthError {
            let message = LiveAuthEntryModel.message(for: error)
            signInErrorMessage = message
            status = message
        } catch {
            let message = LiveConversationCopy.signInFailed
            signInErrorMessage = message
            status = message
        }
    }

    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        defer { isSigningOut = false }

        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        let previousStreamTask = streamTask
        previousStreamTask?.cancel()
        streamTask = nil
        streamingReplyText = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false
        currentPollSessionID = UUID()
        currentStreamSessionID = UUID()
        if let previousTask {
            _ = await previousTask.value
        }
        if let previousStreamTask {
            _ = await previousStreamTask.value
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
        startupReadinessTask?.cancel()
        startupReadinessTask = nil
        pendingDiscardTask?.cancel()
        pendingDiscardTask = nil
        currentPollSessionID = UUID()
        currentStreamSessionID = UUID()
        pollTask?.cancel()
        pollTask = nil
        streamTask?.cancel()
        streamTask = nil
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
        signInErrorMessage = nil
        rejectedDraftText = nil
        pendingRejectedDraftRestoration = nil
        pendingOutgoingText = nil
        streamingReplyText = nil
        lastTurnMetrics = nil
        stagedAttachments.removeAll()
        isUploadingAttachment = false
        attachmentError = nil
        refreshErrorMessage = nil
        command = .idle
        reply = .idle
        isStopping = false
        isPollingPaused = false
        selectedTab = .chat
        chatNavigationPath.removeAll()
        tasksNavigationPath.removeAll()
        taskStore.clear()
        scheduleStore.clear()
        memoryStore.clear()
        ConversationCardFormatting.clearCaches()
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
        let trimmedOutgoing = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sendStart = monotonicNow()
        let startGeneration = sessionGeneration
        isSubmitting = true
        command = .submitting
        rejectedDraftText = nil
        pendingRejectedDraftRestoration = nil
        pendingOutgoingText = trimmedOutgoing.isEmpty ? nil : trimmedOutgoing
        streamingReplyText = nil
        attachmentError = nil
        status = nil
        defer { isSubmitting = false }

        if let pendingDiscardTask {
            await pendingDiscardTask.value
            guard sessionGeneration == startGeneration, !Task.isCancelled else { return }
        }

        if let startupReadinessTask {
            await startupReadinessTask.value
            guard sessionGeneration == startGeneration, !Task.isCancelled else { return }
            if requiresSignIn {
                pendingOutgoingText = nil
                command = .idle
                return
            }
            if command == .unknownAcknowledgement || reply == .generating {
                // Startup recovered an unresolved prior send or an active turn; restore the
                // newly composed text so the user never loses it.
                if !trimmedOutgoing.isEmpty {
                    rejectedDraftText = text
                    pendingRejectedDraftRestoration = PendingRejectedDraft(id: UUID(), text: text)
                }
                pendingOutgoingText = (try? await repository.pending())?.text
                return
            }
            if profile == nil {
                if !trimmedOutgoing.isEmpty {
                    rejectedDraftText = text
                    pendingRejectedDraftRestoration = PendingRejectedDraft(id: UUID(), text: text)
                }
                pendingOutgoingText = nil
                command = .idle
                return
            }
        }

        do {
            let sendSession = try await repository.sendStreaming(text: text, attachmentIDs: attachmentIDs)
            if profile == nil, let hydrated = try? await repository.bootstrap() {
                profile = hydrated
                requiresSignIn = false
                applyStoredDeviceExecutorPreference(for: hydrated)
            }
            stagedAttachments.removeAll()
            pendingOutgoingText = nil
            refreshErrorMessage = nil
            command = .acknowledged
            reply = .generating
            status = isMockMode ? nil : LiveConversationCopy.messageAccepted
            if let eventStream = sendSession.events {
                appendAcceptedUserMessageIfNeeded(from: sendSession.receipt)
                beginStreamingObservation(eventStream, receipt: sendSession.receipt, startedAt: sendStart)
            } else {
                let loaded = try await repository.load()
                snapshot = loaded
                beginPolling(startedAt: sendStart)
                await syncTasksFromCloud(snapshot: loaded)
            }
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            applyAuthFailure(error)
        } catch let error as LiveB1Failure where error == .unavailable {
            applyServiceUnavailable()
        } catch let error as LiveB1Failure where error == .unknownAcknowledgement {
            applyUnknownAcknowledgement()
        } catch let error as LiveB1Failure where error == .staleEpoch || error == .conflict {
            applyRejectedSubmission(draftText: text, reason: .conflict)
        } catch let error as LiveB1Failure where error == .rejected {
            applyRejectedSubmission(
                draftText: trimmedOutgoing.isEmpty ? nil : text,
                reason: .rejected
            )
        } catch {
            applyUnknownAcknowledgement()
        }
    }

    func dismissReplyError() {
        switch reply {
        case .failed(_, retryable: false):
            reply = .idle
            if command == .rejected {
                command = .idle
                status = nil
            }
        case .failed(_, retryable: true):
            let draftToRestore = pendingOutgoingText
            if let draftToRestore, !draftToRestore.isEmpty {
                rejectedDraftText = draftToRestore
                pendingRejectedDraftRestoration = PendingRejectedDraft(id: UUID(), text: draftToRestore)
            }
            pendingOutgoingText = nil
            reply = .idle
            if command == .unknownAcknowledgement {
                command = .idle
            }
            status = nil
            if draftToRestore != nil {
                pendingDiscardTask?.cancel()
                let expectedGeneration = sessionGeneration
                pendingDiscardTask = Task { [weak self] in
                    guard let self, self.sessionGeneration == expectedGeneration else { return }
                    try? await self.repository.discardPending()
                }
            }
        default:
            break
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
                    pendingOutgoingText = nil
                    refreshErrorMessage = nil
                    status = nil
                    beginPolling()
                    await syncTasksFromCloud(snapshot: loaded)
                }
            } else {
                let loaded = try await repository.load()
                snapshot = loaded
                pendingOutgoingText = nil
                refreshErrorMessage = nil
                if let rejected = try await repository.rejectedDraft() {
                    applyRejectedSubmission(draftText: rejected.text, reason: .previousDraft)
                } else if try await repository.activeTurn() != nil {
                    command = .acknowledged
                    reply = .generating
                    status = nil
                    if isViewVisible && isSceneActive {
                        beginPolling()
                    }
                } else {
                    command = .idle
                    reply = .idle
                    status = nil
                }
                await syncTasksFromCloud(snapshot: loaded)
            }
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            applyAuthFailure(error)
        } catch let error as LiveB1Failure where error == .staleEpoch || error == .conflict {
            let storedDraft = (try? await repository.rejectedDraft())?.text
            applyRejectedSubmission(draftText: storedDraft ?? pendingOutgoingText, reason: .conflict)
        } catch let error as LiveB1Failure where error == .rejected {
            applyRejectedSubmission(draftText: pendingOutgoingText, reason: .rejected)
        } catch let error as LiveB1Failure where error == .unavailable {
            if pendingOutgoingText != nil {
                applyServiceUnavailable()
            } else if command == .acknowledged {
                reply = .failed(
                    message: LiveConversationCopy.replyInterruptedMessage,
                    retryable: true
                )
                status = LiveConversationCopy.replyInterruptedStatus
            } else {
                command = .unknownAcknowledgement
                reply = .failed(
                    message: LiveConversationCopy.retrySyncUnavailable,
                    retryable: true
                )
                status = nil
            }
        } catch {
            if pendingOutgoingText != nil {
                command = .unknownAcknowledgement
                reply = .failed(
                    message: LiveConversationCopy.retryUnknownAckMessage,
                    retryable: true
                )
                status = LiveConversationCopy.sendUnknownAckStatus
            } else if command == .acknowledged {
                reply = .failed(
                    message: LiveConversationCopy.replyInterruptedMessage,
                    retryable: true
                )
                status = LiveConversationCopy.replyInterruptedStatus
            } else {
                command = .unknownAcknowledgement
                reply = .failed(
                    message: LiveConversationCopy.retrySyncUnavailable,
                    retryable: true
                )
                status = nil
            }
        }
    }

    func triggerStop() {
        guard !isSubmitting, !isStopping, reply == .generating else { return }
        isStopping = true
        Task { await performStop() }
    }

    func stop() async {
        guard !isSubmitting, !isStopping else { return }
        isStopping = true
        await performStop()
    }

    private func performStop() async {
        let stopGeneration = sessionGeneration
        defer {
            if sessionGeneration == stopGeneration {
                isStopping = false
            }
        }
        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        let previousStreamTask = streamTask
        previousStreamTask?.cancel()
        streamTask = nil
        streamingReplyText = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false
        currentPollSessionID = UUID()
        currentStreamSessionID = UUID()
        if let previousTask {
            _ = await previousTask.value
        }
        if let previousStreamTask {
            _ = await previousStreamTask.value
        }

        let cancelResult: LiveB1Turn?
        do {
            cancelResult = try await repository.cancelActiveTurn()
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            applyAuthFailure(error)
            return
        } catch {
            status = LiveConversationCopy.cancelStatusUnknown
            beginPolling()
            return
        }

        switch cancelResult?.status {
        case .cancelled:
            reply = .idle
            status = LiveConversationCopy.turnCancelled
        case .completed:
            reply = .idle
            status = nil
        case .failed:
            reply = .failed(message: LiveConversationCopy.turnFailed, retryable: false)
            status = nil
        case .running:
            status = LiveConversationCopy.cancelRequested
            beginPolling()
        case nil:
            reply = .idle
            status = nil
        }

        do {
            let loaded = try await repository.load()
            snapshot = loaded
            refreshErrorMessage = nil
            await syncTasksFromCloud(snapshot: loaded)
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            applyAuthFailure(error)
        } catch {
            refreshErrorMessage = LiveConversationCopy.refreshUnavailable
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
            if profile == nil,
               !requiresSignIn,
               !isLoading,
               !isSigningIn,
               !isSigningOut,
               command != .unknownAcknowledgement,
               rejectedDraftText == nil {
                await start()
            } else {
                await refreshTasks()
            }
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
            && streamTask == nil
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
        } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
            guard sessionGeneration == expectedGeneration else { return }
            applyAuthFailure(error)
        } catch {
            guard sessionGeneration == expectedGeneration else { return }
            refreshErrorMessage = LiveConversationCopy.refreshUnavailable
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

    private func refreshSchedulesAndMemoryCapabilities() async {
        guard !requiresSignIn, !isMockMode else { return }
        async let schedulesWork: Void = refreshSchedulesAndArmArrival()
        async let memoryWork: Void = refreshMemoryAvailabilityIfNeeded()
        _ = await (schedulesWork, memoryWork)
    }

    private func refreshMemoryAvailabilityIfNeeded() async {
        guard !requiresSignIn, !isMockMode, memoryStore.hasRepository else { return }
        await memoryStore.refresh()
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
        if (reply == .generating || isPollingPaused) && pollTask == nil && streamTask == nil {
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
        if (reply == .generating || isPollingPaused) && pollTask == nil && streamTask == nil {
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
        streamTask?.cancel()
        streamTask = nil
        streamingReplyText = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
    }

    var screen: ConversationScreenState {
        let id = profile?.conversation.conversationID
        var timeline: [ConversationTimelineEntry] = (snapshot?.messages ?? []).map { message in
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
                    title: String(localized: "conversation.activity.cloud", table: "Conversation"),
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
        if let pendingOutgoingText, !pendingOutgoingText.isEmpty {
            let note = String(
                localized: isSubmitting
                    ? "conversation.message.sending_note"
                    : "conversation.message.pending_ack_note",
                table: "Conversation"
            )
            timeline.append(
                .message(ConversationMessagePresentation(
                    id: "conversation-message-user-pending",
                    author: .user,
                    text: pendingOutgoingText,
                    timestamp: nil,
                    deliveryNote: note,
                    accessibilityIdentifierOverride: "conversation-message-user-pending"
                ))
            )
        }
        if reply == .generating, let streamingReplyText, !streamingReplyText.isEmpty {
            timeline.append(
                .message(ConversationMessagePresentation(
                    id: "conversation-streaming-reply",
                    author: .ember,
                    text: streamingReplyText,
                    timestamp: nil,
                    accessibilityIdentifierOverride: "conversation-streaming-reply",
                    isStreaming: true
                ))
            )
        }
        let emptyPrompts: [ConversationStarterPrompt] = if !isLoading, id != nil, timeline.isEmpty {
            buildEmptyStatePrompts()
        } else {
            []
        }
        let emptyState: ConversationEmptyStateConfiguration? = if !isLoading, id != nil, timeline.isEmpty {
            ConversationEmptyStateConfiguration(
                title: String(localized: "conversation.empty.headline", table: "Conversation"),
                subtitle: emptyStateSubtitle(),
                capabilityNote: emptyStateCapabilityNote(),
                prompts: emptyPrompts
            )
        } else {
            nil
        }
        return ConversationScreenState(
            partnerName: profile?.agent.displayName ?? "Ember Cloud",
            headerSubtitle: headerStatusForSubtitle,
            headerSubtitleAccessibilityIdentifier: headerStatusForSubtitle != nil ? "live-conversation-status" : nil,
            environmentPill: environmentPill,
            timeline: timeline,
            replyState: reply,
            suggestedPrompts: emptyPrompts.map(\.prompt),
            emptyState: emptyState,
            showsEmptyState: timeline.isEmpty && id != nil,
            isLoading: isLoading,
            isSubmitting: isSubmitting,
            isStopping: isStopping,
            streamingReplyText: streamingReplyText,
            commandStatus: command,
            attachments: stagedAttachments,
            isUploadingAttachment: isUploadingAttachment,
            attachmentError: attachmentError
        )
    }

    var supportsMemoryCapability: Bool {
        guard memoryStore.hasRepository else { return false }
        return isMockMode || memoryStore.endpointAvailability == .available
    }

    var supportsScheduleCapability: Bool {
        guard scheduleStore.hasRepository else { return false }
        return isMockMode || scheduleStore.endpointAvailability == .available
    }

    var headerStatusForSubtitle: String? {
        guard let status, Self.isShortHeaderStatus(status) else { return nil }
        return status
    }

    var bannerStatus: String? {
        guard let status, !Self.isShortHeaderStatus(status) else { return nil }
        return status
    }

    var environmentPill: ConversationEnvironmentPill {
        if isMockMode {
            return ConversationEnvironmentPill(
                title: "MOCK ONLY",
                tone: .mock,
                accessibilityIdentifier: "mock-only-banner",
                accessibilityLabel: String(localized: "conversation.header.mock_accessibility", table: "Conversation")
            )
        }
        let tone: ConversationEnvironmentPill.Tone = switch environmentBadge {
        case "V2 STAGING":
            .staging
        case "CUSTOM CLOUD":
            .custom
        default:
            .cloud
        }
        return ConversationEnvironmentPill(
            title: environmentBadge,
            tone: tone,
            accessibilityIdentifier: "live-cloud-mode",
            accessibilityLabel: String(
                format: String(localized: "conversation.header.env_accessibility_format", table: "Conversation"),
                environmentBadge
            )
        )
    }

    private static func isShortHeaderStatus(_ value: String) -> Bool {
        value == LiveConversationCopy.messageAccepted
            || value == LiveConversationCopy.checkingStatus
            || value == LiveConversationCopy.turnCancelled
    }

    private func buildEmptyStatePrompts() -> [ConversationStarterPrompt] {
        var prompts: [ConversationStarterPrompt] = []
        if supportsMemoryCapability {
            prompts.append(
                ConversationStarterPrompt(
                    id: "memory",
                    iconName: "brain.head.profile",
                    title: String(localized: "conversation.prompt.card.memory_title", table: "Conversation"),
                    prompt: String(localized: "conversation.live.prompt.memory", table: "Conversation")
                )
            )
        }
        if supportsScheduleCapability {
            prompts.append(
                ConversationStarterPrompt(
                    id: "brief",
                    iconName: "sun.horizon",
                    title: String(localized: "conversation.prompt.card.brief_title", table: "Conversation"),
                    prompt: String(localized: "conversation.live.prompt.brief", table: "Conversation")
                )
            )
        }
        prompts.append(
            ConversationStarterPrompt(
                id: "notes",
                iconName: "checklist",
                title: String(localized: "conversation.prompt.card.notes_title", table: "Conversation"),
                prompt: String(localized: "conversation.empty.prompt.notes_action", table: "Conversation")
            )
        )
        if prompts.count < 3 {
            prompts.append(
                ConversationStarterPrompt(
                    id: "priorities",
                    iconName: "calendar.day.timeline.left",
                    title: String(localized: "conversation.prompt.card.priorities_title", table: "Conversation"),
                    prompt: String(localized: "conversation.empty.prompt.priorities", table: "Conversation")
                )
            )
        }
        if prompts.count < 3 {
            prompts.append(
                ConversationStarterPrompt(
                    id: "analyze_file",
                    iconName: "doc.text.magnifyingglass",
                    title: String(localized: "conversation.prompt.card.file_title", table: "Conversation"),
                    prompt: String(localized: "conversation.empty.prompt.analyze_file", table: "Conversation")
                )
            )
        }
        return Array(prompts.prefix(3))
    }

    private func emptyStateSubtitle() -> String {
        switch (supportsMemoryCapability, supportsScheduleCapability) {
        case (true, true):
            String(localized: "conversation.empty.subtitle.full", table: "Conversation")
        case (true, false):
            String(localized: "conversation.empty.subtitle.memory_only", table: "Conversation")
        case (false, true):
            String(localized: "conversation.empty.subtitle.schedules_only", table: "Conversation")
        case (false, false):
            String(localized: "conversation.empty.subtitle.core", table: "Conversation")
        }
    }

    private func emptyStateCapabilityNote() -> String? {
        guard !isMockMode else { return nil }
        switch (memoryStore.isEndpointUnavailable, scheduleStore.isEndpointUnavailable) {
        case (true, true):
            return String(localized: "conversation.empty.capability.memory_and_schedules_unavailable", table: "Conversation")
        case (true, false):
            return String(localized: "conversation.empty.capability.memory_unavailable", table: "Conversation")
        case (false, true):
            return String(localized: "conversation.empty.capability.schedules_unavailable", table: "Conversation")
        case (false, false):
            return nil
        }
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
              streamTask == nil,
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
                      self.streamTask == nil,
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

    private func appendAcceptedUserMessageIfNeeded(from receipt: LiveB1Receipt) {
        let convID = ConversationID(rawValue: receipt.conversationID)
        let messageID = MessageID(rawValue: receipt.messageID)
        let userMessage = ConversationMessage(
            id: messageID,
            conversationID: convID,
            sequence: receipt.sequence,
            createdAt: receipt.createdAt,
            kind: .user(text: receipt.text)
        )
        if let current = snapshot {
            if !current.messages.contains(where: { $0.id == messageID || $0.sequence == receipt.sequence }) {
                var messages = current.messages
                messages.append(userMessage)
                messages.sort { $0.sequence < $1.sequence }
                snapshot = ConversationSnapshot(
                    conversation: current.conversation,
                    messages: messages,
                    assistantTurns: current.assistantTurns
                )
            }
        } else {
            snapshot = ConversationSnapshot(
                conversation: Conversation(id: convID, createdAt: receipt.createdAt, updatedAt: receipt.createdAt),
                messages: [userMessage],
                assistantTurns: []
            )
        }
    }

    private func beginStreamingObservation(
        _ stream: AsyncThrowingStream<LiveV2StreamEvent, Error>,
        receipt: LiveB1Receipt,
        startedAt: ContinuousClock.Instant
    ) {
        let previousStreamTask = streamTask
        previousStreamTask?.cancel()
        streamTask = nil
        let previousPollTask = pollTask
        previousPollTask?.cancel()
        pollTask = nil
        taskObserverTask?.cancel()
        taskObserverTask = nil
        conversationRefreshTask?.cancel()
        conversationRefreshTask = nil
        scheduleArrivalTask?.cancel()
        scheduleArrivalTask = nil
        isPollingPaused = false
        currentPollSessionID = UUID()

        let streamSessionID = UUID()
        currentStreamSessionID = streamSessionID
        let expectedGeneration = sessionGeneration

        streamTask = Task { [weak self] in
            if let previousStreamTask { _ = await previousStreamTask.value }
            if let previousPollTask { _ = await previousPollTask.value }
            guard let self,
                  self.sessionGeneration == expectedGeneration,
                  self.currentStreamSessionID == streamSessionID,
                  !Task.isCancelled,
                  !self.requiresSignIn else { return }

            var firstDeltaAt: ContinuousClock.Instant?
            var deltaCount = 0
            var committedTurn: LiveB1Turn?
            var handedOff = false
            var streamInterrupted = false

            do {
                for try await event in stream {
                    guard self.sessionGeneration == expectedGeneration,
                          self.currentStreamSessionID == streamSessionID,
                          !Task.isCancelled,
                          !self.requiresSignIn else { return }

                    switch event {
                    case .delta(_, let chunk):
                        if !chunk.isEmpty {
                            deltaCount += 1
                            if firstDeltaAt == nil {
                                firstDeltaAt = self.monotonicNow()
                            }
                            self.streamingReplyText = (self.streamingReplyText ?? "") + chunk
                        }
                    case .committed(let turn, _, _):
                        committedTurn = turn
                    case .handedOff:
                        handedOff = true
                    }
                    if committedTurn != nil || handedOff {
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // Post-acceptance stream interruption falls back to durable B1 polling/reconciliation.
                streamInterrupted = true
            }

            guard self.sessionGeneration == expectedGeneration,
                  self.currentStreamSessionID == streamSessionID,
                  !Task.isCancelled,
                  !self.requiresSignIn else { return }

            self.streamTask = nil

            if let turn = committedTurn {
                await self.repository.finishTurnFromStream(turn)
                let e2eMs = Self.elapsedMilliseconds(from: startedAt, to: self.monotonicNow())
                let ttftMs = firstDeltaAt.map { Self.elapsedMilliseconds(from: startedAt, to: $0) }
                self.lastTurnMetrics = TurnLatencyMetrics(
                    mode: "sse",
                    ttftMs: ttftMs,
                    e2eMs: e2eMs,
                    deltaCount: deltaCount
                )
                Self.latencyLogger.info(
                    "turn_completed mode=sse ttft_ms=\(ttftMs ?? -1, privacy: .public) e2e_ms=\(e2eMs, privacy: .public) deltas=\(deltaCount, privacy: .public)"
                )
                self.streamingReplyText = nil
                do {
                    let loaded = try await self.repository.load()
                    guard self.sessionGeneration == expectedGeneration,
                          self.currentStreamSessionID == streamSessionID,
                          !Task.isCancelled,
                          !self.requiresSignIn else { return }
                    self.snapshot = loaded
                    await self.syncTasksFromCloud(snapshot: loaded)
                } catch is CancellationError {
                    return
                } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
                    self.applyAuthFailure(error)
                    return
                } catch {
                    self.refreshErrorMessage = LiveConversationCopy.refreshUnavailable
                }

                switch turn.status {
                case .completed:
                    self.reply = .idle
                    self.status = nil
                case .failed:
                    self.reply = .failed(message: LiveConversationCopy.turnFailed, retryable: false)
                    self.status = nil
                case .cancelled:
                    self.reply = .idle
                    self.status = LiveConversationCopy.turnCancelled
                case .running:
                    self.reply = .generating
                    self.beginPolling(startedAt: startedAt)
                    return
                }
                await self.refreshSchedulesAndArmArrival()
                return
            }

            self.streamingReplyText = nil
            if streamInterrupted && !self.isMockMode {
                self.status = LiveConversationCopy.streamInterruptedChecking
            }
            self.beginPolling(startedAt: startedAt)
        }
    }

    private static func elapsedMilliseconds(
        from start: ContinuousClock.Instant,
        to end: ContinuousClock.Instant
    ) -> Int {
        let components = start.duration(to: end).components
        let ms = Int(components.seconds) * 1000 + Int(components.attoseconds / 1_000_000_000_000_000)
        return max(0, ms)
    }

    private func beginPolling(startedAt: ContinuousClock.Instant? = nil) {
        guard isViewVisible && isSceneActive && !requiresSignIn else { return }
        let previousTask = pollTask
        previousTask?.cancel()
        pollTask = nil
        streamTask?.cancel()
        streamTask = nil
        streamingReplyText = nil
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
        let turnStartTime = startedAt ?? startTime

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
                    status = LiveConversationCopy.waitingForCloud
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
                            status = LiveConversationCopy.waitingForCloud
                            return
                        }
                    case .completed:
                        let loaded = try await repository.load()
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        let e2eMs = Self.elapsedMilliseconds(from: turnStartTime, to: monotonicNow())
                        lastTurnMetrics = TurnLatencyMetrics(
                            mode: "poll",
                            ttftMs: nil,
                            e2eMs: e2eMs,
                            deltaCount: 0
                        )
                        Self.latencyLogger.info("turn_completed mode=poll e2e_ms=\(e2eMs, privacy: .public)")
                        snapshot = loaded
                        reply = .idle
                        status = nil
                        pollTask = nil
                        isPollingPaused = false
                        await syncTasksFromCloud(snapshot: loaded)
                        await refreshSchedulesAndArmArrival()
                        return
                    case .failed:
                        let loaded = try await repository.load()
                        guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                        snapshot = loaded
                        reply = .failed(message: LiveConversationCopy.turnFailed, retryable: false)
                        status = nil
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
                        status = LiveConversationCopy.turnCancelled
                        pollTask = nil
                        isPollingPaused = false
                        await syncTasksFromCloud(snapshot: loaded)
                        await refreshSchedulesAndArmArrival()
                        return
                    }
                } catch is CancellationError {
                    return
                } catch let error as AuthError where error.requiresNewSignIn || error == .accessDenied {
                    guard currentPollSessionID == sessionID, !Task.isCancelled else { return }
                    applyAuthFailure(error)
                    pollTask = nil
                    return
                } catch {
                    guard currentPollSessionID == sessionID, !Task.isCancelled, !requiresSignIn else { return }
                    reply = .failed(
                        message: LiveConversationCopy.replyInterruptedMessage,
                        retryable: true
                    )
                    status = LiveConversationCopy.replyInterruptedStatus
                    pollTask = nil
                    isPollingPaused = false
                    return
                }
            }
        }
    }

    private enum RejectionReason {
        case conflict
        case rejected
        case previousDraft
    }

    private func applyAuthFailure(_ error: AuthError) {
        clearLiveState()
        let message = error == .accessDenied
            ? LiveConversationCopy.signInNotAllowlisted
            : LiveAuthEntryModel.message(for: error)
        signInErrorMessage = message
        status = message
    }

    private func applyUnknownAcknowledgement() {
        command = .unknownAcknowledgement
        reply = .failed(
            message: LiveConversationCopy.sendUnknownAckMessage,
            retryable: true
        )
        status = LiveConversationCopy.sendUnknownAckStatus
    }

    private func applyServiceUnavailable() {
        command = .unknownAcknowledgement
        reply = .failed(
            message: LiveConversationCopy.sendServiceUnavailableMessage,
            retryable: true
        )
        status = LiveConversationCopy.sendServiceUnavailableStatus
    }

    func consumePendingRejectedDraftRestoration(id: UUID) {
        if pendingRejectedDraftRestoration?.id == id {
            pendingRejectedDraftRestoration = nil
        }
    }

    private func applyRejectedSubmission(draftText: String?, reason: RejectionReason) {
        if let draftText {
            rejectedDraftText = draftText
            pendingRejectedDraftRestoration = PendingRejectedDraft(id: UUID(), text: draftText)
        }
        pendingOutgoingText = nil
        command = .rejected
        let message: String = switch reason {
        case .conflict: LiveConversationCopy.sendConflictMessage
        case .rejected: LiveConversationCopy.sendRejectedMessage
        case .previousDraft: LiveConversationCopy.previousRejectedMessage
        }
        reply = .failed(message: message, retryable: false)
        status = LiveConversationCopy.sendRejectedStatus
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
    @State private var isShowingSidebar = false
    @State private var isConfirmingSignOut = false
    @State private var isShowingMemorySheet = false
    @State private var isShowingSchedulesSheet = false
    @State private var isShowingFileImporter = false
    @State private var isShowingPhotoPicker = false
    @State private var isShowingCamera = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []

    private static var allowedAttachmentTypes: [UTType] {
        [.item]
    }

    init(model: LiveConversationHostModel) {
        _model = State(initialValue: model)
    }

    // Only surface task counts actually known from the existing repository.
    // Never imply that a failed/unavailable task list is live.
    private var workSummary: ConversationWorkSummary? {
        let store = model.taskStore
        guard store.hasRepository,
              !store.listEndpointUnavailable,
              store.listErrorMessage == nil else { return nil }
        return ConversationWorkSummary(
            needsAttentionCount: store.needsInterventionCount,
            activeCount: store.inProgressCount
        )
    }

    var body: some View {
        Group {
            if model.requiresSignIn {
                signInView
            } else {
                EmberSidebarContainer(
                    isShowingSidebar: $isShowingSidebar,
                    canSwipeOpenFromEdge: canSwipeOpenSidebarFromEdge,
                    selectedTab: model.selectedTab,
                    needsInterventionCount: model.taskStore.needsInterventionCount,
                    hasMemoryRepository: model.memoryStore.hasRepository,
                    memoryUnavailable: model.memoryStore.isEndpointUnavailable,
                    hasSchedulesRepository: model.scheduleStore.hasRepository,
                    schedulesUnavailable: model.scheduleStore.isEndpointUnavailable,
                    isMockMode: model.isMockMode,
                    environmentBadge: model.environmentBadge,
                    canSignOut: !model.isSigningOut && !model.isSubmitting && !model.isLoading,
                    onOpenChat: {
                        model.selectedTab = .chat
                    },
                    onOpenTasks: {
                        model.selectedTab = .tasks
                    },
                    onOpenMemory: {
                        isShowingMemorySheet = true
                    },
                    onOpenSchedules: {
                        isShowingSchedulesSheet = true
                    },
                    onSignOut: {
                        isConfirmingSignOut = true
                    }
                ) {
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
        }
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .sheet(isPresented: $isShowingMemorySheet) {
            PersonalMemorySheetView(store: model.memoryStore)
        }
        .sheet(isPresented: $isShowingSchedulesSheet) {
            ProactiveSchedulesSheetView(
                store: model.scheduleStore,
                onOpenChat: {
                    isShowingSchedulesSheet = false
                    model.selectedTab = .chat
                }
            )
        }
        .onChange(of: isShowingSchedulesSheet) { _, isShowing in
            if !isShowing {
                Task { await model.handleSchedulesSheetDismissed() }
            }
        }
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
        .onChange(of: model.selectedTab) { _, newTab in
            Task { await model.handleTabSelection(newTab) }
        }
        .onChange(of: scenePhase) { _, newPhase in
            model.handleScenePhase(newPhase)
        }
        .onChange(of: model.requiresSignIn) { _, needsSignIn in
            if needsSignIn { isShowingSidebar = false }
        }
    }

    private var canSwipeOpenSidebarFromEdge: Bool {
        guard !model.requiresSignIn,
              !isShowingMemorySheet,
              !isShowingSchedulesSheet,
              !isConfirmingSignOut,
              !isShowingFileImporter,
              !isShowingPhotoPicker,
              !isShowingCamera
        else {
            return false
        }
        switch model.selectedTab {
        case .chat:
            return model.chatNavigationPath.isEmpty
        case .tasks:
            return model.tasksNavigationPath.isEmpty
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
            Text("conversation.live.sign_in_subtitle", tableName: "Conversation")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            AppleSignInControl(isEnabled: !model.isSigningIn) {
                Task { await model.signIn() }
            }
            .frame(height: 50)
            .frame(maxWidth: 360)
            .accessibilityIdentifier("live-conversation-sign-in")
            if model.isSigningIn {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("conversation.live.signing_in", tableName: "Conversation")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("live-conversation-signing-in")
            } else if let signInError = model.signInErrorMessage {
                InlineNotice(
                    title: LocalizedStringKey(
                        String(localized: "conversation.live.sign_in_error_title", table: "Conversation")
                    ),
                    message: LocalizedStringKey(signInError),
                    tone: .error
                )
                .frame(maxWidth: 360)
                .accessibilityIdentifier("live-conversation-sign-in-error")
            } else if let status = model.status {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding()
    }

    private var chatTab: some View {
        NavigationStack(path: $model.chatNavigationPath) {
            LiveChatDraftHost(
                state: model.screen,
                pendingRejectedDraft: model.pendingRejectedDraftRestoration,
                requiresSignIn: model.requiresSignIn,
                isMockMode: model.isMockMode,
                workSummary: workSummary,
                onOpenTasks: { model.selectedTab = .tasks },
                onConsumeRejectedDraft: { model.consumePendingRejectedDraftRestoration(id: $0) },
                onSend: { text in Task { await model.send(text) } },
                onRetry: { Task { await model.retry() } },
                onStopGenerating: { model.triggerStop() },
                onDismissError: { model.dismissReplyError() },
                onTakePhoto: {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        isShowingCamera = true
                    } else {
                        model.reportCameraUnavailable()
                    }
                },
                onChoosePhoto: { isShowingPhotoPicker = true },
                onPickAttachment: { isShowingFileImporter = true },
                onRemoveAttachment: { model.removeAttachment($0) },
                onRefresh: {
                    await model.refreshConversationAndTasks()
                },
                headerMenu: {
                    chatHeaderMenu
                },
                topNotices: {
                    chatTopNotices
                }
            )
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
        }
    }

    private var chatHeaderMenu: some View {
        Menu {
            Button {
                Task { @MainActor in
                    await Task.yield()
                    isShowingSidebar = true
                }
            } label: {
                Label {
                    Text(String(localized: "sidebar.open", table: "Conversation"))
                } icon: {
                    Image(systemName: "sidebar.leading")
                }
            }
            .accessibilityIdentifier("live-conversation-open-sidebar")

            Divider()

            if model.scheduleStore.hasRepository {
                Button {
                    isShowingSchedulesSheet = true
                } label: {
                    Label {
                        Text(schedulesMenuTitle)
                    } icon: {
                        Image(systemName: "calendar.badge.clock")
                    }
                }
                .disabled(model.isSigningOut || model.isLoading)
                .accessibilityIdentifier("live-conversation-open-schedules")
            }

            if model.memoryStore.hasRepository {
                Button {
                    isShowingMemorySheet = true
                } label: {
                    Label {
                        Text(memoryMenuTitle)
                    } icon: {
                        Image(systemName: "brain.head.profile")
                    }
                }
                .disabled(model.isSigningOut || model.isLoading)
                .accessibilityIdentifier("live-conversation-open-memory")
            }

            Divider()

            Label {
                Text(environmentMenuDescription)
            } icon: {
                Image(systemName: model.isMockMode ? "testtube.2" : "cloud")
            }

            if !model.isMockMode {
                Divider()

                Button(role: .destructive) {
                    isConfirmingSignOut = true
                } label: {
                    Label {
                        Text("conversation.live.sign_out", tableName: "Conversation")
                    } icon: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                    }
                }
                .disabled(model.isSigningOut || model.isSubmitting || model.isLoading)
                .accessibilityIdentifier("live-conversation-sign-out")
            }
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)

                if model.scheduleStore.hasInFlightRun {
                    Circle()
                        .fill(EmberDesignTokens.chatBrandInk)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -1)
                        .accessibilityHidden(true)
                }
            }
            .frame(minWidth: EmberDesignTokens.minTapTarget, minHeight: EmberDesignTokens.minTapTarget)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("conversation.header.menu.label", tableName: "Conversation"))
        .accessibilityValue(
            model.scheduleStore.hasInFlightRun
                ? Text("conversation.header.menu.schedule_running", tableName: "Conversation")
                : Text(verbatim: "")
        )
        .accessibilityIdentifier("live-conversation-menu")
    }

    @ViewBuilder
    private var chatTopNotices: some View {
        if model.bannerStatus != nil || model.isPollingPaused {
            let noticeMessage = model.bannerStatus ?? LiveConversationCopy.waitingForCloud
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "info.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color(uiColor: .systemOrange))
                        .accessibilityHidden(true)

                    Text(noticeMessage)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("live-conversation-status")

                    if model.isPollingPaused {
                        resumePollingButton
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "info.circle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color(uiColor: .systemOrange))
                            .padding(.top, 2)
                            .accessibilityHidden(true)

                        Text(noticeMessage)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("live-conversation-status")
                    }

                    if model.isPollingPaused {
                        resumePollingButton
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(uiColor: .systemOrange).opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }

        if let refreshError = model.refreshErrorMessage {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    refreshErrorContent(refreshError)
                    refreshRetryButton
                }

                VStack(alignment: .leading, spacing: 8) {
                    refreshErrorContent(refreshError)
                    refreshRetryButton
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(uiColor: .systemOrange).opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("live-conversation-refresh-error")
        }
    }

    private func refreshErrorContent(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "wifi.slash")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: .systemOrange))
                .padding(.top, 2)
                .accessibilityHidden(true)
            Text(message)
                .font(.caption)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var refreshRetryButton: some View {
        Button {
            Task { await model.refreshConversationAndTasks() }
        } label: {
            Text(String(localized: "conversation.live.refresh_retry", table: "Conversation"))
                .font(.caption.weight(.semibold))
                .frame(minWidth: EmberDesignTokens.minTapTarget, minHeight: EmberDesignTokens.minTapTarget)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityIdentifier("live-conversation-refresh-retry")
    }

    private var resumePollingButton: some View {
        Button {
            model.resumePolling()
        } label: {
            Label(
                String(localized: "conversation.live.check_again", table: "Conversation"),
                systemImage: "arrow.clockwise"
            )
            .font(.caption.weight(.semibold))
            .frame(minWidth: EmberDesignTokens.minTapTarget, minHeight: EmberDesignTokens.minTapTarget)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityIdentifier("live-conversation-resume-polling")
    }

    private var schedulesMenuTitle: String {
        let base = String(localized: "schedules.nav_title", table: "Conversation")
        if model.scheduleStore.isEndpointUnavailable {
            return String(
                format: String(localized: "conversation.menu.unavailable_format", table: "Conversation"),
                base
            )
        }
        if model.scheduleStore.activeCount > 0 {
            return "\(base) (\(model.scheduleStore.activeCount))"
        }
        return base
    }

    private var memoryMenuTitle: String {
        let base = String(localized: "memory.nav_title", table: "Conversation")
        if model.memoryStore.isEndpointUnavailable {
            return String(
                format: String(localized: "conversation.menu.unavailable_format", table: "Conversation"),
                base
            )
        }
        if !model.memoryStore.items.isEmpty {
            return "\(base) (\(model.memoryStore.items.count))"
        }
        return base
    }

    private var environmentMenuDescription: String {
        if model.isMockMode {
            return String(localized: "conversation.menu.env.mock", table: "Conversation")
        }
        switch (model.memoryStore.isEndpointUnavailable, model.scheduleStore.isEndpointUnavailable) {
        case (true, true):
            return String(
                format: String(localized: "conversation.menu.env.core_only_format", table: "Conversation"),
                model.environmentBadge
            )
        case (true, false):
            return String(
                format: String(localized: "conversation.menu.env.memory_unavailable_format", table: "Conversation"),
                model.environmentBadge
            )
        case (false, true):
            return String(
                format: String(localized: "conversation.menu.env.schedules_unavailable_format", table: "Conversation"),
                model.environmentBadge
            )
        case (false, false):
            if model.supportsMemoryCapability && model.supportsScheduleCapability {
                return String(
                    format: String(localized: "conversation.menu.env.full_format", table: "Conversation"),
                    model.environmentBadge
                )
            }
            return model.environmentBadge
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
                onOpenNavigationDirectory: {
                    Task { @MainActor in
                        await Task.yield()
                        isShowingSidebar = true
                    }
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

struct LiveChatDraftHost<HeaderMenu: View, TopNotices: View>: View {
    let state: ConversationScreenState
    let pendingRejectedDraft: PendingRejectedDraft?
    let requiresSignIn: Bool
    let isMockMode: Bool
    let workSummary: ConversationWorkSummary?
    let onOpenTasks: (() -> Void)?
    let onConsumeRejectedDraft: (UUID) -> Void
    let onSend: (String) -> Void
    let onRetry: () -> Void
    let onStopGenerating: () -> Void
    let onDismissError: () -> Void
    let onTakePhoto: () -> Void
    let onChoosePhoto: () -> Void
    let onPickAttachment: () -> Void
    let onRemoveAttachment: (UUID) -> Void
    let onRefresh: () async -> Void
    let headerMenu: HeaderMenu
    let topNotices: TopNotices

    @State private var draft = ""

    init(
        state: ConversationScreenState,
        pendingRejectedDraft: PendingRejectedDraft?,
        requiresSignIn: Bool,
        isMockMode: Bool,
        workSummary: ConversationWorkSummary? = nil,
        onOpenTasks: (() -> Void)? = nil,
        onConsumeRejectedDraft: @escaping (UUID) -> Void,
        onSend: @escaping (String) -> Void,
        onRetry: @escaping () -> Void,
        onStopGenerating: @escaping () -> Void,
        onDismissError: @escaping () -> Void,
        onTakePhoto: @escaping () -> Void,
        onChoosePhoto: @escaping () -> Void,
        onPickAttachment: @escaping () -> Void,
        onRemoveAttachment: @escaping (UUID) -> Void,
        onRefresh: @escaping () async -> Void,
        @ViewBuilder headerMenu: () -> HeaderMenu,
        @ViewBuilder topNotices: () -> TopNotices
    ) {
        self.state = state
        self.pendingRejectedDraft = pendingRejectedDraft
        self.requiresSignIn = requiresSignIn
        self.isMockMode = isMockMode
        self.workSummary = workSummary
        self.onOpenTasks = onOpenTasks
        self.onConsumeRejectedDraft = onConsumeRejectedDraft
        self.onSend = onSend
        self.onRetry = onRetry
        self.onStopGenerating = onStopGenerating
        self.onDismissError = onDismissError
        self.onTakePhoto = onTakePhoto
        self.onChoosePhoto = onChoosePhoto
        self.onPickAttachment = onPickAttachment
        self.onRemoveAttachment = onRemoveAttachment
        self.onRefresh = onRefresh
        self.headerMenu = headerMenu()
        self.topNotices = topNotices()
    }

    var body: some View {
        ConversationScreen(
            state: state,
            draft: $draft,
            actions: ConversationScreenActions(
                send: { text in
                    draft = ""
                    onSend(text)
                },
                retry: onRetry,
                stopGenerating: onStopGenerating,
                selectPrompt: { draft = $0 },
                onDismissError: onDismissError,
                onTakePhoto: onTakePhoto,
                onChoosePhoto: onChoosePhoto,
                onPickAttachment: onPickAttachment,
                onRemoveAttachment: onRemoveAttachment
            ),
            composerNote: isMockMode
                ? "conversation.composer.local_note"
                : "conversation.composer.cloud_note",
            showsSubmissionAcknowledgement: isMockMode,
            replyPreparingText: isMockMode
                ? "conversation.reply.preparing"
                : "conversation.reply.waiting_for_cloud",
            replyStopText: isMockMode
                ? "conversation.reply.stop"
                : "conversation.reply.cancel_cloud_turn",
            emberMessageAuthorText: isMockMode
                ? "conversation.message.ember_mock"
                : "conversation.message.ember_cloud",
            onRefresh: onRefresh,
            workSummary: workSummary,
            onOpenTasks: onOpenTasks,
            headerMenu: { headerMenu },
            topNotices: { topNotices }
        )
        .onChange(of: pendingRejectedDraft, initial: true) { _, pending in
            guard let pending else { return }
            // Do not overwrite user edits. Only an explicit Send may create a fresh ID.
            draft = Self.applyPendingRejectedDraft(currentDraft: draft, pending: pending)
            onConsumeRejectedDraft(pending.id)
        }
        .onChange(of: requiresSignIn, initial: true) { _, needsSignIn in
            if needsSignIn { draft = "" }
        }
    }

    static func applyPendingRejectedDraft(
        currentDraft: String,
        pending: PendingRejectedDraft
    ) -> String {
        currentDraft.isEmpty ? pending.text : currentDraft
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
