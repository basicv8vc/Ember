import Foundation

/// Centralized user-facing copy for Live conversation delivery, recovery, cancellation, and auth states.
/// All strings resolve from `Conversation.xcstrings` and follow the model:
/// what happened -> what is known -> what the user can safely do next.
enum LiveConversationCopy {
    static var messageAccepted: String {
        String(localized: "conversation.live.message_accepted", table: "Conversation")
    }

    static var sendUnknownAckMessage: String {
        String(localized: "conversation.live.send_unknown_ack_message", table: "Conversation")
    }

    static var sendUnknownAckStatus: String {
        String(localized: "conversation.live.send_unknown_ack_status", table: "Conversation")
    }

    static var retryUnknownAckMessage: String {
        String(localized: "conversation.live.retry_unknown_ack_message", table: "Conversation")
    }

    static var sendConflictMessage: String {
        String(localized: "conversation.live.send_conflict_message", table: "Conversation")
    }

    static var sendRejectedMessage: String {
        String(localized: "conversation.live.send_rejected", table: "Conversation")
    }

    static var sendRejectedStatus: String {
        String(localized: "conversation.live.send_rejected_status", table: "Conversation")
    }

    static var previousRejectedMessage: String {
        String(localized: "conversation.live.previous_rejected_message", table: "Conversation")
    }

    static var streamInterruptedChecking: String {
        String(localized: "conversation.live.stream_interrupted_checking", table: "Conversation")
    }

    static var replyInterruptedMessage: String {
        String(localized: "conversation.live.reply_interrupted_message", table: "Conversation")
    }

    static var replyInterruptedStatus: String {
        String(localized: "conversation.live.reply_interrupted_status", table: "Conversation")
    }

    static var loadUnavailableMessage: String {
        String(localized: "conversation.live.load_unavailable_message", table: "Conversation")
    }

    static var loadUnavailableStatus: String {
        String(localized: "conversation.live.load_unavailable_status", table: "Conversation")
    }

    static var connectionUnavailable: String {
        String(localized: "conversation.live.connection_unavailable", table: "Conversation")
    }

    static var retrySyncUnavailable: String {
        String(localized: "conversation.live.retry_sync_unavailable", table: "Conversation")
    }

    static var refreshUnavailable: String {
        String(localized: "conversation.live.refresh_unavailable", table: "Conversation")
    }

    static var waitingForCloud: String {
        String(localized: "conversation.live.waiting_for_cloud", table: "Conversation")
    }

    static var checkingStatus: String {
        String(localized: "conversation.live.checking_status", table: "Conversation")
    }

    static var turnFailed: String {
        String(localized: "conversation.live.turn_failed", table: "Conversation")
    }

    static var turnCancelled: String {
        String(localized: "conversation.live.turn_cancelled", table: "Conversation")
    }

    static var cancelRequested: String {
        String(localized: "conversation.live.cancel_requested", table: "Conversation")
    }

    static var cancelStatusUnknown: String {
        String(localized: "conversation.live.cancel_status_unknown", table: "Conversation")
    }

    static var signInPrompt: String {
        String(localized: "conversation.live.sign_in_prompt", table: "Conversation")
    }

    static var signInCancelled: String {
        String(localized: "conversation.live.sign_in_cancelled", table: "Conversation")
    }

    static var signInNotAllowlisted: String {
        String(localized: "conversation.live.sign_in_not_allowlisted", table: "Conversation")
    }

    static var signInFailed: String {
        String(localized: "conversation.live.sign_in_failed", table: "Conversation")
    }
}
