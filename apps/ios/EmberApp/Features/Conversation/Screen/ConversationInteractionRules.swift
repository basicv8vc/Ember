import Foundation

struct ConversationComposerSubmission: Equatable {
    let message: String
    let draftAfterSubmission: String
    let composerShouldFocusAfterSubmission: Bool
}

enum ConversationPromptSelection: Equatable {
    case populateDraft(String)
}

enum ConversationReplyAction: Equatable {
    case stopMockReply
    case retryMockReply
}

enum ConversationInteractionRules {
    static func submission(for draft: String, isGenerating: Bool) -> ConversationComposerSubmission? {
        guard !isGenerating,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

        return ConversationComposerSubmission(
            message: draft,
            draftAfterSubmission: "",
            composerShouldFocusAfterSubmission: false
        )
    }

    static func promptSelection(_ prompt: String) -> ConversationPromptSelection {
        .populateDraft(prompt)
    }

    static func stopAction(for replyState: ConversationReplyState) -> ConversationReplyAction? {
        replyState == .generating ? .stopMockReply : nil
    }

    static func retryAction(for replyState: ConversationReplyState) -> ConversationReplyAction? {
        guard case .failed(_, retryable: true) = replyState else { return nil }
        return .retryMockReply
    }
}
