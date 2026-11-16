import SwiftUI

struct ConversationComposer: View {
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let isGenerating: Bool
    var note: LocalizedStringKey = "conversation.composer.local_note"
    var attachments: [ComposerAttachment] = []
    var isUploadingAttachment: Bool = false
    var attachmentError: String? = nil
    var onPickAttachment: (() -> Void)? = nil
    var onRemoveAttachment: ((UUID) -> Void)? = nil
    let onSend: (String) -> Void

    private var submission: ConversationComposerSubmission? {
        ConversationInteractionRules.submission(
            for: draft,
            isGenerating: isGenerating || isUploadingAttachment
        )
    }

    private var canSend: Bool {
        submission != nil
    }

    private var canAttachMore: Bool {
        !isGenerating && !isUploadingAttachment && attachments.count < B3AttachmentLimits.maxAttachmentsPerMessage
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !attachments.isEmpty || isUploadingAttachment {
                attachmentChipsRow
            }

            if let attachmentError {
                Text(attachmentError)
                    .font(.caption)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("conversation-attachment-error")
            }

            TextField(
                String(localized: "conversation.composer.placeholder", table: "Conversation"),
                text: $draft,
                axis: .vertical
            )
            .font(.body)
            .lineLimit(1...6)
            .textFieldStyle(.plain)
            .focused(focused)
            .submitLabel(.send)
            .onSubmit(sendIfPossible)
            .accessibilityLabel(Text("conversation.composer.accessibility", tableName: "Conversation"))
            .accessibilityIdentifier("conversation-composer-input")

            HStack(alignment: .center, spacing: 10) {
                if let onPickAttachment {
                    Button(action: onPickAttachment) {
                        Image(systemName: "paperclip")
                            .font(.subheadline.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44)
                            .background(EmberDesignTokens.groupedBackground, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canAttachMore)
                    .opacity(canAttachMore ? 1 : 0.45)
                    .accessibilityLabel(Text("conversation.composer.attach_file", tableName: "Conversation"))
                    .accessibilityIdentifier("conversation-attach-file")
                }

                Text(note, tableName: "Conversation")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: sendIfPossible) {
                    Label {
                        Text("conversation.composer.send", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    } icon: {
                        Image(systemName: "arrow.up")
                            .font(.subheadline.weight(.bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 46)
                    .background(Color.accentColor, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.55)
                .accessibilityHint(Text("conversation.composer.send_hint", tableName: "Conversation"))
                .accessibilityIdentifier("conversation-send")
            }
        }
        .padding(14)
        .frame(maxWidth: 680)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
    }

    private var attachmentChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)

                        Text(attachment.filename)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.middle)

                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file))
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        if let onRemoveAttachment {
                            Button {
                                onRemoveAttachment(attachment.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .disabled(isGenerating || isUploadingAttachment)
                            .accessibilityLabel(Text("conversation.composer.remove_attachment", tableName: "Conversation"))
                            .accessibilityIdentifier("conversation-remove-attachment-\(attachment.id.uuidString.lowercased())")
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(EmberDesignTokens.groupedBackground, in: Capsule())
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("conversation-attachment-chip-\(attachment.filename)")
                }

                if isUploadingAttachment {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("conversation.composer.uploading_attachment", tableName: "Conversation")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(EmberDesignTokens.groupedBackground, in: Capsule())
                    .accessibilityIdentifier("conversation-attachment-uploading")
                }
            }
        }
    }

    private func sendIfPossible() {
        guard let submission else { return }
        draft = submission.draftAfterSubmission
        focused.wrappedValue = submission.composerShouldFocusAfterSubmission
        onSend(submission.message)
    }
}
