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

    /// Inserts a quick starter prompt into an existing composer draft without overwriting user text.
    static func insertingStarterPrompt(_ starter: String, into currentDraft: String) -> String {
        let trimmedStarter = starter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedStarter.isEmpty else { return currentDraft }
        let trimmedDraft = currentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedDraft.isEmpty {
            return trimmedStarter
        }
        if trimmedDraft.contains(trimmedStarter) {
            return currentDraft
        }
        return "\(currentDraft.trimmingCharacters(in: .newlines))\n\n\(trimmedStarter)"
    }

    static func stopAction(for replyState: ConversationReplyState) -> ConversationReplyAction? {
        replyState == .generating ? .stopMockReply : nil
    }

    static func retryAction(for replyState: ConversationReplyState) -> ConversationReplyAction? {
        guard case .failed(_, retryable: true) = replyState else { return nil }
        return .retryMockReply
    }
}
