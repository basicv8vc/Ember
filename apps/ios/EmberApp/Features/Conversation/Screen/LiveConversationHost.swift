import Foundation
import Observation
import SwiftUI

/// The Live host observes real Cloud state; it never runs the local Mock reply generator.
@MainActor @Observable
final class LiveConversationHostModel {
    private let repository: LiveConversationRepository
    private let auth: LiveAuthSessionCoordinator
    private var pollTask: Task<Void, Never>?

    private(set) var profile: EmberMeDTO?
    private(set) var snapshot: ConversationSnapshot?
    private(set) var isLoading = false
    private(set) var isSubmitting = false
    private(set) var isSigningIn = false
    private(set) var isSigningOut = false
    private(set) var command: ConversationCommandStatus = .idle
    private(set) var reply: ConversationReplyState = .idle
    private(set) var status: String?
    private(set) var requiresSignIn = false
    private(set) var rejectedDraftText: String?

    init(repository: LiveConversationRepository, auth: LiveAuthSessionCoordinator) {
        self.repository = repository
        self.auth = auth
    }

    func start() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            // Bootstrap identity first: an unresolved outbox lookup may fail offline, but the
            // signed-in user must still see the Live UI and a recovery action, not an empty Mock.
            profile = try await repository.bootstrap()
            requiresSignIn = false
            do {
                snapshot = try await repository.recoverAfterRelaunch()
                status = nil
                reply = .idle
                if let rejected = try await repository.rejectedDraft() {
                    rejectedDraftText = rejected.text
                    command = .rejected
                    reply = .failed(message: "The previous message was rejected. Review before sending again.", retryable: false)
                    status = "The rejected message will not be sent automatically."
                }
                if try await repository.activeTurn() != nil { beginPolling() }
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
            profile = try await repository.bootstrap()
            snapshot = try await repository.load()
            requiresSignIn = false
            status = nil
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

        pollTask?.cancel()
        pollTask = nil

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

    private func clearLiveState() {
        profile = nil
        snapshot = nil
        requiresSignIn = true
        rejectedDraftText = nil
        command = .idle
        reply = .idle
    }

    func send(_ text: String) async {
        guard !isSubmitting else { return }
        isSubmitting = true
        command = .submitting
        rejectedDraftText = nil
        defer { isSubmitting = false }
        do {
            _ = try await repository.send(text: text)
            command = .acknowledged
            reply = .generating
            snapshot = try await repository.load()
            status = "Message saved to Ember Cloud."
            beginPolling()
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
                    snapshot = try await repository.load()
                    status = nil
                    beginPolling()
                }
            } else {
                snapshot = try await repository.load()
                if try await repository.activeTurn() != nil { beginPolling() }
            }
        } catch {
            reply = .failed(message: "Could not confirm the previous send. Try again later.", retryable: true)
            command = .unknownAcknowledgement
        }
    }

    func stop() async {
        guard !isSubmitting else { return }
        do {
            let result = try await repository.cancelActiveTurn()
            if result?.status == .cancelled {
                reply = .idle
                status = "Turn cancelled on Ember Cloud."
                pollTask?.cancel()
                pollTask = nil
            } else {
                status = "Cancellation requested; checking server state."
                beginPolling()
            }
            snapshot = try await repository.load()
        } catch {
            status = "Cancellation unconfirmed; server state will be checked."
            beginPolling()
        }
    }

    func suspendForDisappearance() {
        // Disappearance stops only observation. It must not cancel the durable server Turn.
        pollTask?.cancel()
        pollTask = nil
    }

    var screen: ConversationScreenState {
        let id = profile?.conversation.conversationID
        let timeline: [ConversationTimelineEntry] = (snapshot?.messages ?? []).map { message in
            let stableID = "conversation-message-\(message.id.rawValue.uuidString.lowercased())"
            switch message.kind {
            case .user(let text):
                return .message(ConversationMessagePresentation(id: stableID,
                    author: .user, text: text, timestamp: message.createdAt))
            case .ember(let text):
                return .message(ConversationMessagePresentation(id: stableID,
                    author: .ember, text: text, timestamp: message.createdAt))
            case .activity(let activity):
                return .activity(ConversationActivityPresentation(id: stableID,
                    title: "Cloud activity", detail: activity.text, timestamp: message.createdAt))
            case .taskReference(let ref):
                return .activity(ConversationActivityPresentation(id: stableID,
                    title: "Task reference", detail: ref.taskID.uuidString, timestamp: message.createdAt))
            case .commitmentReference(let ref):
                return .activity(ConversationActivityPresentation(id: stableID,
                    title: "Commitment reference", detail: ref.commitmentID.uuidString, timestamp: message.createdAt))
            case .outcomeReference:
                return .activity(ConversationActivityPresentation(id: stableID,
                    title: "Linked result", detail: "Available from Ember Cloud", timestamp: message.createdAt))
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
            commandStatus: command)
    }

    private func beginPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    guard let turn = try await repository.pollActiveTurn() else {
                        reply = .idle
                        return
                    }
                    switch turn.status {
                    case .running: reply = .generating
                    case .completed:
                        snapshot = try await repository.load()
                        reply = .idle
                        status = "Completed by Ember Cloud."
                        return
                    case .failed:
                        snapshot = try await repository.load()
                        reply = .failed(message: "Cloud turn failed.", retryable: false)
                        return
                    case .cancelled:
                        snapshot = try await repository.load()
                        reply = .idle
                        status = "Turn cancelled."
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    reply = .failed(message: "Cloud connection lost. Resume polling when online.", retryable: true)
                    return
                }
            }
        }
    }
}

/// Reuses the existing ConversationScreen. The default App Root never instantiates this view.
struct LiveConversationHost: View {
    @State private var model: LiveConversationHostModel
    @State private var draft = ""
    @State private var isConfirmingSignOut = false

    init(model: LiveConversationHostModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        Group {
            if model.requiresSignIn {
                VStack(spacing: 16) {
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
                }
                .padding()
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Text("LIVE CLOUD")
                            .font(.caption.weight(.semibold))
                            .accessibilityIdentifier("live-cloud-mode")
                        Spacer()
                        Button {
                            isConfirmingSignOut = true
                        } label: {
                            Text("conversation.live.sign_out", tableName: "Conversation")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(model.isSigningOut || model.isSubmitting || model.isLoading)
                        .accessibilityIdentifier("live-conversation-sign-out")
                    }
                    if let status = model.status {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("live-conversation-status")
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
                            selectPrompt: { draft = $0 }),
                        composerNote: "conversation.composer.cloud_note",
                        showsSubmissionAcknowledgement: false,
                        replyPreparingText: "conversation.reply.waiting_for_cloud",
                        replyStopText: "conversation.reply.cancel_cloud_turn",
                        emberMessageAuthorText: "conversation.message.ember_cloud")
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
        .task { await model.start() }
        .onChange(of: model.rejectedDraftText) { _, rejected in
            // Do not overwrite user edits. Only an explicit Send may create a fresh ID.
            if let rejected, draft.isEmpty { draft = rejected }
        }
        .onDisappear { model.suspendForDisappearance() }
    }
}
