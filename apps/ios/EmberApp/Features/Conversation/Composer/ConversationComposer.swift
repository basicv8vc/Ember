import SwiftUI

/// Preference key reporting the `+` trigger button's bounds so the Hielo-inspired morphing menu
/// can bloom directly out of the `+` circle in screen coordinates using 100% public SwiftUI APIs.
struct ConversationAttachmentButtonAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

enum ConversationComposerMotion {
    static let morphExpand = Animation.spring(response: 0.36, dampingFraction: 0.84)
    static let morphCollapse = Animation.spring(response: 0.30, dampingFraction: 0.86)
    static let pillSpring = Animation.spring(response: 0.24, dampingFraction: 0.84)
}

private enum AttachmentPopoverDragBehavior {
    static let horizontalLimit: CGFloat = 36
    static let upwardLimit: CGFloat = 28
    static let downwardLimit: CGFloat = 80
    static let maxUpwardScale: CGFloat = 1.04
    static let minDownwardScale: CGFloat = 0.90
    static let dismissalTranslation: CGFloat = 60
    static let dismissalPrediction: CGFloat = 110

    static func rubberBandedOffset(for translation: CGSize) -> CGSize {
        CGSize(
            width: rubberBand(translation.width, limit: horizontalLimit),
            height: rubberBand(
                translation.height,
                limit: translation.height < 0 ? upwardLimit : downwardLimit
            )
        )
    }

    static func scale(for offset: CGSize) -> CGFloat {
        if offset.height < 0 {
            let progress = min(abs(offset.height) / upwardLimit, 1)
            return 1 + progress * (maxUpwardScale - 1)
        }
        let progress = min(offset.height / downwardLimit, 1)
        return 1 - progress * (1 - minDownwardScale)
    }

    static func shouldDismiss(translation: CGSize, predictedEndTranslation: CGSize) -> Bool {
        translation.height > dismissalTranslation || predictedEndTranslation.height > dismissalPrediction
    }

    private static func rubberBand(_ value: CGFloat, limit: CGFloat) -> CGFloat {
        let magnitude = abs(value)
        guard magnitude > 0 else { return 0 }
        let resisted = limit * (1 - 1 / (magnitude / limit + 1))
        return value < 0 ? -resisted : resisted
    }
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
    var hidesAttachmentTrigger: Bool = false
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
        hidesAttachmentTrigger: Bool = false,
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
        self.hidesAttachmentTrigger = hidesAttachmentTrigger
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
        VStack(spacing: 7) {
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
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background {
            VStack(spacing: 0) {
                LinearGradient(
                    stops: [
                        .init(color: EmberDesignTokens.groupedBackground.opacity(0), location: 0),
                        .init(color: EmberDesignTokens.groupedBackground.opacity(0.75), location: 0.6),
                        .init(color: EmberDesignTokens.groupedBackground, location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 52)

                EmberDesignTokens.groupedBackground
                    .ignoresSafeArea(edges: .bottom)
            }
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
            isAttachmentMenuPresented.toggle()
        } label: {
            Image(systemName: "plus")
                .font(.title3.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: 42, height: 42)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .emberGlassCircleSurface(interactive: canOpenAttachmentMenu)
        .anchorPreference(key: ConversationAttachmentButtonAnchorKey.self, value: .bounds) { $0 }
        // Hide the underlying glass source while the morphed popover owns this spot.
        .opacity(hidesAttachmentTrigger ? 0 : (canOpenAttachmentMenu ? 1 : 0.45))
        .allowsHitTesting(!hidesAttachmentTrigger)
        .disabled(!canOpenAttachmentMenu)
        .accessibilityLabel(Text("conversation.composer.attach_file", tableName: "Conversation"))
        .accessibilityHint(Text("conversation.composer.attachment_menu.open_hint", tableName: "Conversation"))
        .accessibilityValue(
            canAttachMore
                ? Text(verbatim: "")
                : Text("conversation.composer.attachment_menu.file_limit_reached", tableName: "Conversation")
        )
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
            .padding(.vertical, 9)
            .accessibilityLabel(Text("conversation.composer.accessibility", tableName: "Conversation"))
            .accessibilityIdentifier("conversation-composer-input")

            Button(action: sendIfPossible) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(canSend ? Color.white : Color.secondary)
                    .frame(width: 32, height: 32)
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
        .frame(minHeight: 42)
        .emberGlassRoundedSurface(cornerRadius: 21, interactive: false, tintOpacity: 0.52, elevated: false)
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
            if let thumbnailData = attachment.thumbnailData,
               let uiImage = UIImage(data: thumbnailData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityHidden(true)
            } else {
                Image(systemName: symbolName(for: attachment))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24, height: 24)
                    .background(Color.accentColor.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
            }

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
        .emberGlassRoundedSurface(cornerRadius: 16, interactive: false, tintOpacity: 0.42, elevated: false)
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
        .emberGlassRoundedSurface(cornerRadius: 16, interactive: false, tintOpacity: 0.42, elevated: false)
        .accessibilityIdentifier("conversation-attachment-uploading")
    }

    private func symbolName(for attachment: ComposerAttachment) -> String {
        let mime = attachment.mediaType.lowercased()
        if mime.hasPrefix("image/") {
            return "photo"
        }
        if mime == "application/pdf" {
            return "doc.richtext.fill"
        }
        let ext = URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
        switch ext {
        case "pdf":
            return "doc.richtext.fill"
        case "csv", "tsv", "xlsx", "xls":
            return "tablecells"
        case "md", "markdown":
            return "doc.richtext"
        case "zip":
            return "doc.zipper"
        default:
            return "doc.text"
        }
    }

    private func sendIfPossible() {
        guard let submission else { return }
        if isAttachmentMenuPresented {
            isAttachmentMenuPresented = false
        }
        draft = submission.draftAfterSubmission
        focused.wrappedValue = submission.composerShouldFocusAfterSubmission
        onSend(submission.message)
    }
}

/// Morphs the `+` Liquid Glass circle directly into a sleek Hielo-style floating menu card
/// and back again on tap outside, action selection, or swipe-down drag.
struct ConversationAttachmentPopoverOverlay: View {
    @Binding var isPresented: Bool
    @Binding var isOverlayVisible: Bool

    let sourceRect: CGRect
    let containerSize: CGSize
    let canAttachFile: Bool
    let attachedCount: Int
    let onTakePhoto: (() -> Void)?
    let onChoosePhoto: (() -> Void)?
    let onChooseFile: () -> Void
    let onSelectStarterPrompt: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var measuredMenuSize: CGSize = .zero
    @State private var expansionProgress: CGFloat = 0
    @State private var dragOffset: CGSize = .zero
    @State private var isDismissing = false

    private var menuWidth: CGFloat {
        min(316, max(264, containerSize.width - 28))
    }

    private var destinationRect: CGRect {
        let size = measuredMenuSize == .zero ? CGSize(width: menuWidth, height: 268) : measuredMenuSize
        let x = max(12, min(sourceRect.minX, containerSize.width - size.width - 12))
        let y = max(12, sourceRect.maxY - size.height)
        return CGRect(origin: CGPoint(x: x, y: y), size: size)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if isOverlayVisible {
                Color.black.opacity(0.03 * Double(expansionProgress))
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: dismissPopover)
                    .accessibilityAction(.escape, dismissPopover)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(Text("conversation.composer.attachment_menu.close", tableName: "Conversation"))
                    .accessibilityIdentifier("conversation-attachment-menu-dismiss")

                HieloMorphingCard(
                    progress: expansionProgress,
                    sourceRect: sourceRect,
                    destinationRect: destinationRect,
                    dragOffset: dragOffset,
                    dragScale: AttachmentPopoverDragBehavior.scale(for: dragOffset)
                ) {
                    ConversationComposerAttachmentMenu(
                        canAttachFile: canAttachFile,
                        attachedCount: attachedCount,
                        onTakePhoto: onTakePhoto.map { handler in
                            {
                                dismissPopover()
                                handler()
                            }
                        },
                        onChoosePhoto: onChoosePhoto.map { handler in
                            {
                                dismissPopover()
                                handler()
                            }
                        },
                        onChooseFile: {
                            dismissPopover()
                            onChooseFile()
                        },
                        onSelectStarterPrompt: { starter in
                            dismissPopover()
                            onSelectStarterPrompt(starter)
                        }
                    )
                    .frame(width: menuWidth)
                    .onGeometryChange(for: CGSize.self) { proxy in
                        proxy.size
                    } action: { newSize in
                        guard !isDismissing,
                              newSize.width > 0,
                              newSize.height > 0,
                              newSize.width.isFinite,
                              newSize.height.isFinite,
                              newSize != measuredMenuSize else { return }
                        measuredMenuSize = newSize
                    }
                }
                .opacity(measuredMenuSize == .zero ? 0 : 1)
                .gesture(
                    DragGesture(minimumDistance: 6)
                        .onChanged { value in
                            guard expansionProgress >= 0.95, !isDismissing else { return }
                            dragOffset = AttachmentPopoverDragBehavior.rubberBandedOffset(for: value.translation)
                        }
                        .onEnded { value in
                            guard expansionProgress >= 0.95, !isDismissing else { return }
                            if AttachmentPopoverDragBehavior.shouldDismiss(
                                translation: value.translation,
                                predictedEndTranslation: value.predictedEndTranslation
                            ) {
                                dismissPopover()
                            } else {
                                withAnimation(.spring(response: 0.28, dampingFraction: 0.78)) {
                                    dragOffset = .zero
                                }
                            }
                        }
                )
            }
        }
        .frame(width: containerSize.width, height: containerSize.height, alignment: .topLeading)
        .onChange(of: isPresented, initial: true) { _, presented in
            if presented {
                presentPopover()
            } else if isOverlayVisible && !isDismissing {
                collapsePopover()
            }
        }
        .onChange(of: measuredMenuSize) { _, size in
            guard isPresented, isOverlayVisible, size != .zero, expansionProgress == 0 else { return }
            animateExpansion()
        }
    }

    private func presentPopover() {
        isDismissing = false
        dragOffset = .zero
        expansionProgress = 0
        isOverlayVisible = true
        if measuredMenuSize != .zero {
            animateExpansion()
        }
    }

    private func animateExpansion() {
        if reduceMotion {
            expansionProgress = 1
        } else {
            withAnimation(ConversationComposerMotion.morphExpand) {
                expansionProgress = 1
            }
        }
    }

    private func dismissPopover() {
        if isPresented {
            isPresented = false
        }
        collapsePopover()
    }

    private func collapsePopover() {
        guard isOverlayVisible, !isDismissing else { return }
        isDismissing = true
        if reduceMotion {
            dragOffset = .zero
            expansionProgress = 0
            isOverlayVisible = false
            isDismissing = false
        } else {
            withAnimation(ConversationComposerMotion.morphCollapse) {
                dragOffset = .zero
                expansionProgress = 0
            } completion: {
                isOverlayVisible = false
                isDismissing = false
            }
        }
    }
}

private struct HieloMorphingCard<MenuContent: View>: View {
    let progress: CGFloat
    let sourceRect: CGRect
    let destinationRect: CGRect
    let dragOffset: CGSize
    let dragScale: CGFloat
    @ViewBuilder let menuContent: () -> MenuContent

    private var clampedProgress: CGFloat {
        min(max(progress, 0), 1)
    }

    private var currentRect: CGRect {
        CGRect(
            x: lerp(sourceRect.minX, destinationRect.minX),
            y: lerp(sourceRect.minY, destinationRect.minY),
            width: lerp(sourceRect.width, destinationRect.width),
            height: lerp(sourceRect.height, destinationRect.height)
        )
    }

    private var currentCornerRadius: CGFloat {
        let sourceRadius = min(sourceRect.width, sourceRect.height) / 2
        return lerp(sourceRadius, 30)
    }

    private var sourceOpacity: Double {
        max(0, 1 - Double(clampedProgress) * 4.5)
    }

    private var sourceBlur: CGFloat {
        14 * min(1, clampedProgress * 3)
    }

    private var contentOpacity: Double {
        max(0, (Double(clampedProgress) - 0.14) / 0.86)
    }

    private var contentScale: CGFloat {
        lerp(0.86, 1.0)
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: currentCornerRadius, style: .continuous)
        let rect = currentRect

        ZStack {
            // Fading/blurring `+` source icon as the circle blooms into the menu.
            Image(systemName: "plus")
                .font(.title3.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: sourceRect.width, height: sourceRect.height)
                .scaleEffect(1 + 0.35 * clampedProgress)
                .blur(radius: sourceBlur)
                .opacity(sourceOpacity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

            menuContent()
                .frame(width: destinationRect.width, height: destinationRect.height)
                .scaleEffect(contentScale, anchor: .bottomLeading)
                .opacity(contentOpacity)
                .allowsHitTesting(clampedProgress > 0.5)
        }
        .frame(width: rect.width, height: rect.height)
        .clipShape(shape)
        .emberGlassRoundedSurface(cornerRadius: currentCornerRadius, interactive: true, tintOpacity: 0, elevated: true)
        .scaleEffect(dragScale, anchor: .center)
        .offset(x: rect.minX + dragOffset.width, y: rect.minY + dragOffset.height)
    }

    private func lerp(_ start: CGFloat, _ end: CGFloat) -> CGFloat {
        start + (end - start) * clampedProgress
    }
}

/// Clean Hielo-style glass menu rows containing Ember's photo, file-upload & starter-prompt actions.
struct ConversationComposerAttachmentMenu: View {
    let canAttachFile: Bool
    let attachedCount: Int
    var onTakePhoto: (() -> Void)? = nil
    var onChoosePhoto: (() -> Void)? = nil
    let onChooseFile: () -> Void
    let onSelectStarterPrompt: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let onTakePhoto {
                menuRow(
                    icon: "camera.fill",
                    badgeColor: Color(uiColor: .systemBlue),
                    title: "conversation.composer.attachment_menu.camera_title",
                    trailingBadge: nil,
                    isEnabled: canAttachFile,
                    accessibilityID: "conversation-attachment-menu-camera",
                    action: onTakePhoto
                )
            }

            if let onChoosePhoto {
                menuRow(
                    icon: "photo.on.rectangle.angled",
                    badgeColor: Color(uiColor: .systemGreen),
                    title: "conversation.composer.attachment_menu.photo_title",
                    trailingBadge: nil,
                    isEnabled: canAttachFile,
                    accessibilityID: "conversation-attachment-menu-photo",
                    action: onChoosePhoto
                )
            }

            menuRow(
                icon: "doc.badge.plus",
                badgeColor: .accentColor,
                title: "conversation.composer.attachment_menu.file_title",
                trailingBadge: attachedCount > 0
                    ? "\(attachedCount)/\(B3AttachmentLimits.maxAttachmentsPerMessage)"
                    : String(localized: "conversation.composer.attachment_menu.file_badge", table: "Conversation"),
                isEnabled: canAttachFile,
                accessibilityID: "conversation-attachment-menu-file",
                action: onChooseFile
            )

            Divider()
                .padding(.horizontal, 14)
                .padding(.vertical, 3)

            menuRow(
                icon: "checklist",
                badgeColor: Color(uiColor: .systemIndigo),
                title: "conversation.composer.attachment_menu.notes_title",
                trailingBadge: nil,
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
                trailingBadge: nil,
                isEnabled: true,
                accessibilityID: "conversation-attachment-menu-data"
            ) {
                onSelectStarterPrompt(
                    String(localized: "conversation.composer.attachment_menu.data_prompt", table: "Conversation")
                )
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-attachment-menu")
    }

    private func menuRow(
        icon: String,
        badgeColor: Color,
        title: LocalizedStringKey,
        trailingBadge: String?,
        isEnabled: Bool,
        accessibilityID: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(badgeColor.gradient, in: Circle())
                    .accessibilityHidden(true)

                Text(title, tableName: "Conversation")
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let trailingBadge {
                    Text(trailingBadge)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(ComposerMenuRowButtonStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.42)
        .accessibilityIdentifier(accessibilityID)
    }
}

private struct ComposerMenuRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? Color.primary.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
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
            let glass = interactive ? Glass.regular.interactive() : Glass.regular
            self
                .glassEffect(glass, in: Circle())
                .shadow(color: Color.black.opacity(0.08), radius: 8, x: 0, y: 3)
        } else {
            self
                .background(.ultraThinMaterial, in: Circle())
                .background(EmberDesignTokens.cardBackground.opacity(0.48), in: Circle())
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
        tintOpacity: Double = 0,
        elevated: Bool = false
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            let baseGlass = tintOpacity > 0
                ? Glass.regular.tint(EmberDesignTokens.cardBackground.opacity(tintOpacity))
                : Glass.regular
            let glass = interactive ? baseGlass.interactive() : baseGlass
            self
                .glassEffect(glass, in: shape)
                .shadow(
                    color: Color.black.opacity(elevated ? 0.14 : 0.06),
                    radius: elevated ? 22 : 10,
                    x: 0,
                    y: elevated ? 8 : 3
                )
        } else {
            self
                .background(.ultraThinMaterial, in: shape)
                .background(
                    EmberDesignTokens.cardBackground.opacity(elevated ? 0.78 : 0.56),
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
