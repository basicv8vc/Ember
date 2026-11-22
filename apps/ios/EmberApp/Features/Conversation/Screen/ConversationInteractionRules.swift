import CoreGraphics
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

enum ConversationComposerTrailingAction: Equatable, Sendable {
    case send(isEnabled: Bool)
    case submitting
    case stop(isEnabled: Bool)
}

enum ConversationAttachmentPopoverLayout {
    static let preferredWidth: CGFloat = 272
    static let horizontalMargin: CGFloat = 14
    static let verticalMargin: CGFloat = 12
    static let bottomMargin: CGFloat = 8
    static let fallbackHeight: CGFloat = 268

    static func menuWidth(for containerWidth: CGFloat) -> CGFloat {
        max(0, min(preferredWidth, containerWidth - horizontalMargin * 2))
    }

    static func maxMenuHeight(for containerHeight: CGFloat) -> CGFloat {
        max(0, containerHeight - verticalMargin - bottomMargin)
    }

    static func destinationRect(
        sourceRect: CGRect,
        measuredMenuSize: CGSize,
        containerSize: CGSize
    ) -> CGRect {
        let width = menuWidth(for: containerSize.width)
        let rawHeight = measuredMenuSize == .zero ? fallbackHeight : measuredMenuSize.height
        let height = min(rawHeight, maxMenuHeight(for: containerSize.height))
        let maxX = max(horizontalMargin, containerSize.width - width - horizontalMargin)
        let x = min(max(horizontalMargin, sourceRect.minX), maxX)
        let maxY = max(verticalMargin, containerSize.height - bottomMargin - height)
        let y = min(max(verticalMargin, sourceRect.maxY - height), maxY)
        return CGRect(x: x, y: y, width: width, height: height)
    }
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

    static func trailingAction(
        for draft: String,
        replyState: ConversationReplyState,
        isSubmitting: Bool,
        isStopping: Bool = false,
        isLoading: Bool = false,
        isUploadingAttachment: Bool = false
    ) -> ConversationComposerTrailingAction {
        if isLoading {
            return .send(isEnabled: false)
        }
        if isStopping {
            return .stop(isEnabled: false)
        }
        if isSubmitting {
            return .submitting
        }
        if replyState == .generating {
            return .stop(isEnabled: true)
        }
        let canSend = submission(for: draft, isGenerating: isUploadingAttachment) != nil
        return .send(isEnabled: canSend)
    }

    static func shouldShowComposerNote(timelineIsEmpty: Bool, isLoading: Bool) -> Bool {
        timelineIsEmpty && !isLoading
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
