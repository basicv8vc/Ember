import SwiftUI

/// Display-only state for the conversation surface. The caller owns message truth and ordering.
struct ConversationScreenState {
    var partnerName: String = "Ember"
    var timeline: [ConversationTimelineEntry] = []
    var replyState: ConversationReplyState = .idle
    var suggestedPrompts: [String] = []
}

enum ConversationReplyState: Equatable {
    case idle
    case generating
    case failed(message: String, retryable: Bool)
}

enum ConversationMessageAuthor: Equatable {
    case user
    case ember
}

struct ConversationMessagePresentation {
    let id: String
    let author: ConversationMessageAuthor
    let text: String
    let timestamp: Date?
}

struct ConversationActivityPresentation {
    let id: String
    let title: String
    let detail: String?
    let timestamp: Date?
}

/// A typed SwiftUI timeline slot for Agent C's inline cards, erased only at the view boundary.
struct ConversationInlineContent: Identifiable {
    let id: String
    let accessibilityLabel: String
    let content: AnyView

    init<Content: View>(
        id: String,
        accessibilityLabel: String,
        @ViewBuilder content: () -> Content
    ) {
        self.id = id
        self.accessibilityLabel = accessibilityLabel
        self.content = AnyView(content())
    }
}

enum ConversationTimelineEntry: Identifiable {
    case message(ConversationMessagePresentation)
    case activity(ConversationActivityPresentation)
    case inlineContent(ConversationInlineContent)

    var id: String {
        switch self {
        case .message(let message): message.id
        case .activity(let activity): activity.id
        case .inlineContent(let content): content.id
        }
    }

    static func inlineCard<Content: View>(
        id: String,
        accessibilityLabel: String,
        @ViewBuilder content: () -> Content
    ) -> Self {
        .inlineContent(
            ConversationInlineContent(
                id: id,
                accessibilityLabel: accessibilityLabel,
                content: content
            )
        )
    }
}

struct ConversationScreenActions {
    var send: (String) -> Void
    var retry: () -> Void
    var stopGenerating: () -> Void
    var selectPrompt: (String) -> Void

    init(
        send: @escaping (String) -> Void,
        retry: @escaping () -> Void,
        stopGenerating: @escaping () -> Void,
        selectPrompt: @escaping (String) -> Void
    ) {
        self.send = send
        self.retry = retry
        self.stopGenerating = stopGenerating
        self.selectPrompt = selectPrompt
    }
}
