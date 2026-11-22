import SwiftUI

struct ComposerAttachment: Identifiable, Equatable {
    let id: UUID
    let filename: String
    let mediaType: String
    let sizeBytes: Int
    let thumbnailData: Data?

    init(
        id: UUID,
        filename: String,
        mediaType: String,
        sizeBytes: Int,
        thumbnailData: Data? = nil
    ) {
        self.id = id
        self.filename = filename
        self.mediaType = mediaType
        self.sizeBytes = sizeBytes
        self.thumbnailData = thumbnailData
    }
}

/// Display-only state for the conversation surface. The caller owns message truth and ordering.
struct ConversationScreenState {
    var partnerName: String = "Ember"
    var timeline: [ConversationTimelineEntry] = []
    var replyState: ConversationReplyState = .idle
    var suggestedPrompts: [String] = []
    var showsEmptyState = true
    var isLoading = false
    var isSubmitting = false
    var streamingReplyText: String? = nil
    var commandStatus: ConversationCommandStatus = .idle
    var attachments: [ComposerAttachment] = []
    var isUploadingAttachment = false
    var attachmentError: String? = nil
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
    let deliveryNote: String?
    let accessibilityIdentifierOverride: String?

    init(
        id: String,
        author: ConversationMessageAuthor,
        text: String,
        timestamp: Date?,
        deliveryNote: String? = nil,
        accessibilityIdentifierOverride: String? = nil
    ) {
        self.id = id
        self.author = author
        self.text = text
        self.timestamp = timestamp
        self.deliveryNote = deliveryNote
        self.accessibilityIdentifierOverride = accessibilityIdentifierOverride
    }
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
    var onDismissError: (() -> Void)?
    var onTakePhoto: (() -> Void)?
    var onChoosePhoto: (() -> Void)?
    var onPickAttachment: (() -> Void)?
    var onRemoveAttachment: ((UUID) -> Void)?

    init(
        send: @escaping (String) -> Void,
        retry: @escaping () -> Void,
        stopGenerating: @escaping () -> Void,
        selectPrompt: @escaping (String) -> Void,
        onDismissError: (() -> Void)? = nil,
        onTakePhoto: (() -> Void)? = nil,
        onChoosePhoto: (() -> Void)? = nil,
        onPickAttachment: (() -> Void)? = nil,
        onRemoveAttachment: ((UUID) -> Void)? = nil
    ) {
        self.send = send
        self.retry = retry
        self.stopGenerating = stopGenerating
        self.selectPrompt = selectPrompt
        self.onDismissError = onDismissError
        self.onTakePhoto = onTakePhoto
        self.onChoosePhoto = onChoosePhoto
        self.onPickAttachment = onPickAttachment
        self.onRemoveAttachment = onRemoveAttachment
    }
}
