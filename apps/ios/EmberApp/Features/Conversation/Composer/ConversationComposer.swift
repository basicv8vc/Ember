import SwiftUI

/// Preference key reporting the `+` trigger button's bounds so the floating attachment menu
/// can anchor directly above it in full-screen coordinates without clipping or private APIs.
struct ConversationAttachmentButtonAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

enum ConversationComposerMotion {
    static let menuSpring = Animation.spring(response: 0.30, dampingFraction: 0.80)
    static let pillSpring = Animation.spring(response: 0.24, dampingFraction: 0.84)
}

struct ConversationComposer: View {
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let isGenerating: Bool
    var note: LocalizedStringKey = "conversation.composer.local_note"
    var attachments: [ComposerAttachment] = []
    var isUploadingAttachment: Bool = false
    var attachmentError: String? = nil
    @Binding var isAttachmentMenuPresented: Bool
    var onPickAttachment: (() -> Void)? = nil
    var onRemoveAttachment: ((UUID) -> Void)? = nil
    let onSend: (String) -> Void

    init(
        draft: Binding<String>,
        focused: FocusState<Bool>.Binding,
        isGenerating: Bool,
        note: LocalizedStringKey = "conversation.composer.local_note",
        attachments: [ComposerAttachment] = [],
        isUploadingAttachment: Bool = false,
        attachmentError: String? = nil,
        isAttachmentMenuPresented: Binding<Bool> = .constant(false),
        onPickAttachment: (() -> Void)? = nil,
        onRemoveAttachment: ((UUID) -> Void)? = nil,
        onSend: @escaping (String) -> Void
    ) {
        _draft = draft
        self.focused = focused
        self.isGenerating = isGenerating
        self.note = note
        self.attachments = attachments
        self.isUploadingAttachment = isUploadingAttachment
        self.attachmentError = attachmentError
        _isAttachmentMenuPresented = isAttachmentMenuPresented
        self.onPickAttachment = onPickAttachment
        self.onRemoveAttachment = onRemoveAttachment
        self.onSend = onSend
    }

    private var submission: ConversationComposerSubmission? {
        ConversationInteractionRules.submission(
            for: draft,
            isGenerating: isGenerating || isUploadingAttachment
        )
    }

    private var canSend: Bool {
        submission != nil
    }

    private var canOpenAttachmentMenu: Bool {
        !isGenerating && !isUploadingAttachment
    }

    private var canAttachMore: Bool {
        canOpenAttachmentMenu && attachments.count < B3AttachmentLimits.maxAttachmentsPerMessage
    }

    var body: some View {
        VStack(spacing: 8) {
            if let attachmentError {
                attachmentErrorBanner(attachmentError)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if !attachments.isEmpty || isUploadingAttachment {
                attachmentChipsRow
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            floatingComposerBar

            Text(note, tableName: "Conversation")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 640)
                .padding(.horizontal, 8)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background {
            LinearGradient(
                stops: [
                    .init(color: EmberDesignTokens.groupedBackground.opacity(0), location: 0),
                    .init(color: EmberDesignTokens.groupedBackground.opacity(0.72), location: 0.25),
                    .init(color: EmberDesignTokens.groupedBackground.opacity(0.96), location: 0.58),
                    .init(color: EmberDesignTokens.groupedBackground, location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        }
        .animation(ConversationComposerMotion.pillSpring, value: attachments.count)
        .animation(ConversationComposerMotion.pillSpring, value: isUploadingAttachment)
        .animation(ConversationComposerMotion.pillSpring, value: attachmentError)
        .sensoryFeedback(.selection, trigger: isAttachmentMenuPresented)
    }

    private var floatingComposerBar: some View {
        EmberGlassGroup(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                if onPickAttachment != nil {
                    attachmentTriggerButton
                }

                composerInputPill
            }
            .frame(maxWidth: 680)
        }
    }

    private var attachmentTriggerButton: some View {
        Button {
            withAnimation(ConversationComposerMotion.menuSpring) {
                isAttachmentMenuPresented.toggle()
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(isAttachmentMenuPresented ? Color.accentColor : Color.primary)
                .rotationEffect(.degrees(isAttachmentMenuPresented ? 45 : 0))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .emberGlassCircleSurface(interactive: canOpenAttachmentMenu)
        .anchorPreference(key: ConversationAttachmentButtonAnchorKey.self, value: .bounds) { $0 }
        .disabled(!canOpenAttachmentMenu)
        .opacity(canOpenAttachmentMenu ? 1 : 0.45)
        .accessibilityLabel(
            Text(
                isAttachmentMenuPresented
                    ? "conversation.composer.attachment_menu.close"
                    : "conversation.composer.attach_file",
                tableName: "Conversation"
            )
        )
        .accessibilityHint(Text("conversation.composer.attachment_menu.open_hint", tableName: "Conversation"))
        .accessibilityValue(canAttachMore ? Text(verbatim: "") : Text("conversation.composer.attachment_menu.file_limit_reached", tableName: "Conversation"))
        .accessibilityIdentifier("conversation-attach-file")
    }

    private var composerInputPill: some View {
        HStack(alignment: .bottom, spacing: 8) {
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
            .padding(.leading, 16)
            .padding(.vertical, 10)
            .accessibilityLabel(Text("conversation.composer.accessibility", tableName: "Conversation"))
            .accessibilityIdentifier("conversation-composer-input")

            Button(action: sendIfPossible) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(canSend ? Color.white : Color.secondary)
                    .frame(width: 34, height: 34)
                    .background(
                        canSend ? Color.accentColor : Color.primary.opacity(0.08),
                        in: Circle()
                    )
                    .scaleEffect(canSend ? 1.0 : 0.94)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .padding(.trailing, 5)
            .padding(.bottom, 5)
            .animation(ConversationComposerMotion.pillSpring, value: canSend)
            .accessibilityLabel(Text("conversation.composer.send", tableName: "Conversation"))
            .accessibilityHint(Text("conversation.composer.send_hint", tableName: "Conversation"))
            .accessibilityIdentifier("conversation-send")
        }
        .frame(minHeight: 44)
        .emberGlassRoundedSurface(cornerRadius: 22, interactive: false, elevated: false)
    }

    private func attachmentErrorBanner(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: .systemRed))
                .accessibilityHidden(true)

            Text(message)
                .font(.caption)
                .foregroundStyle(Color(uiColor: .systemRed))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 680, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.red.opacity(0.22), lineWidth: 0.75)
        }
        .accessibilityIdentifier("conversation-attachment-error")
    }

    private var attachmentChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    attachmentChip(attachment)
                }

                if isUploadingAttachment {
                    uploadingAttachmentChip
                }
            }
            .padding(.horizontal, 2)
        }
        .frame(maxWidth: 680, alignment: .leading)
    }

    private func attachmentChip(_ attachment: ComposerAttachment) -> some View {
        HStack(spacing: 7) {
            Image(systemName: symbolName(for: attachment))
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 24, height: 24)
                .background(Color.accentColor.opacity(0.12), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.filename)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 160, alignment: .leading)

            if let onRemoveAttachment {
                Button {
                    onRemoveAttachment(attachment.id)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isGenerating || isUploadingAttachment)
                .accessibilityLabel(Text("conversation.composer.remove_attachment", tableName: "Conversation"))
                .accessibilityIdentifier("conversation-remove-attachment-\(attachment.id.uuidString.lowercased())")
            }
        }
        .padding(.leading, 7)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .emberGlassRoundedSurface(cornerRadius: 16, interactive: false, elevated: false)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-attachment-chip-\(attachment.filename)")
    }

    private var uploadingAttachmentChip: some View {
        HStack(spacing: 7) {
            ProgressView()
                .controlSize(.small)
            Text("conversation.composer.uploading_attachment", tableName: "Conversation")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .emberGlassRoundedSurface(cornerRadius: 16, interactive: false, elevated: false)
        .accessibilityIdentifier("conversation-attachment-uploading")
    }

    private func symbolName(for attachment: ComposerAttachment) -> String {
        let ext = URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
        switch ext {
        case "csv", "tsv":
            return "tablecells"
        case "md", "markdown":
            return "doc.richtext"
        default:
            return "doc.text"
        }
    }

    private func sendIfPossible() {
        guard let submission else { return }
        if isAttachmentMenuPresented {
            withAnimation(ConversationComposerMotion.menuSpring) {
                isAttachmentMenuPresented = false
            }
        }
        draft = submission.draftAfterSubmission
        focused.wrappedValue = submission.composerShouldFocusAfterSubmission
        onSend(submission.message)
    }
}

/// Floating glass action menu anchored above the composer's `+` button.
struct ConversationComposerAttachmentMenu: View {
    let canAttachFile: Bool
    let attachedCount: Int
    let onChooseFile: () -> Void
    let onSelectStarterPrompt: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            menuRow(
                icon: "doc.badge.plus",
                badgeColor: .accentColor,
                title: "conversation.composer.attachment_menu.file_title",
                subtitle: canAttachFile
                    ? LocalizedStringKey("conversation.composer.attachment_menu.file_subtitle")
                    : LocalizedStringKey("conversation.composer.attachment_menu.file_limit_reached"),
                trailingText: attachedCount > 0 ? "\(attachedCount)/\(B3AttachmentLimits.maxAttachmentsPerMessage)" : nil,
                isEnabled: canAttachFile,
                accessibilityID: "conversation-attachment-menu-file",
                action: onChooseFile
            )

            Divider()
                .padding(.leading, 56)

            menuRow(
                icon: "checklist",
                badgeColor: Color(uiColor: .systemIndigo),
                title: "conversation.composer.attachment_menu.notes_title",
                subtitle: "conversation.composer.attachment_menu.notes_subtitle",
                isEnabled: true,
                accessibilityID: "conversation-attachment-menu-notes"
            ) {
                onSelectStarterPrompt(
                    String(localized: "conversation.composer.attachment_menu.notes_prompt", table: "Conversation")
                )
            }

            menuRow(
                icon: "tablecells",
                badgeColor: Color(uiColor: .systemTeal),
                title: "conversation.composer.attachment_menu.data_title",
                subtitle: "conversation.composer.attachment_menu.data_subtitle",
                isEnabled: true,
                accessibilityID: "conversation-attachment-menu-data"
            ) {
                onSelectStarterPrompt(
                    String(localized: "conversation.composer.attachment_menu.data_prompt", table: "Conversation")
                )
            }
        }
        .padding(8)
        .emberGlassRoundedSurface(cornerRadius: 24, interactive: true, elevated: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-attachment-menu")
    }

    private func menuRow(
        icon: String,
        badgeColor: Color,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey,
        trailingText: String? = nil,
        isEnabled: Bool,
        accessibilityID: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(badgeColor.gradient, in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title, tableName: "Conversation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(subtitle, tableName: "Conversation")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let trailingText {
                    Text(trailingText)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(ComposerMenuRowButtonStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityIdentifier(accessibilityID)
    }
}

private struct ComposerMenuRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? Color.primary.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1.0)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct EmberGlassGroup<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content()
            }
        } else {
            content()
        }
    }
}

private extension View {
    @ViewBuilder
    func emberGlassCircleSurface(interactive: Bool = true) -> some View {
        if #available(iOS 26.0, *) {
            let baseGlass = Glass.regular.tint(EmberDesignTokens.cardBackground.opacity(0.45))
            let glass = interactive ? baseGlass.interactive() : baseGlass
            self
                .glassEffect(glass, in: Circle())
                .shadow(color: Color.black.opacity(0.08), radius: 8, x: 0, y: 3)
        } else {
            self
                .background(.ultraThinMaterial, in: Circle())
                .background(EmberDesignTokens.cardBackground.opacity(0.55), in: Circle())
                .overlay {
                    Circle().strokeBorder(Color.primary.opacity(0.11), lineWidth: 0.75)
                }
                .shadow(color: Color.black.opacity(0.09), radius: 8, x: 0, y: 3)
        }
    }

    @ViewBuilder
    func emberGlassRoundedSurface(
        cornerRadius: CGFloat,
        interactive: Bool = false,
        elevated: Bool = false
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            let baseGlass = Glass.regular.tint(
                EmberDesignTokens.cardBackground.opacity(elevated ? 0.58 : 0.48)
            )
            let glass = interactive ? baseGlass.interactive() : baseGlass
            self
                .glassEffect(glass, in: shape)
                .shadow(
                    color: Color.black.opacity(elevated ? 0.14 : 0.06),
                    radius: elevated ? 20 : 10,
                    x: 0,
                    y: elevated ? 8 : 3
                )
        } else {
            self
                .background(.ultraThinMaterial, in: shape)
                .background(
                    EmberDesignTokens.cardBackground.opacity(elevated ? 0.78 : 0.58),
                    in: shape
                )
                .overlay {
                    shape.strokeBorder(Color.primary.opacity(elevated ? 0.14 : 0.10), lineWidth: 0.75)
                }
                .shadow(
                    color: Color.black.opacity(elevated ? 0.16 : 0.08),
                    radius: elevated ? 18 : 10,
                    x: 0,
                    y: elevated ? 8 : 3
                )
        }
    }
}
