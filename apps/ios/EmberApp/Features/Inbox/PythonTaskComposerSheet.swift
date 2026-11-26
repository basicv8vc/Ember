import SwiftUI
import UniformTypeIdentifiers

struct PythonTaskComposerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: SessionTaskStore
    let onSubmitted: (UUID) -> Void

    @State private var titleText = ""
    @State private var promptText = ""
    @State private var instructionsText = ""
    @State private var attachedFiles: [StagedUploadReceiptDTO] = []
    @State private var isUploadingFile = false
    @State private var isSubmitting = false
    @State private var isShowingFileImporter = false
    @State private var isEndpointUnavailable = false
    @State private var errorMessage: String?
    @State private var pendingRetryRequest: SubmitPythonTaskRequestDTO?

    private static var allowedFileTypes: [UTType] {
        [.commaSeparatedText, .json, .plainText, .pdf, .data, .item]
    }

    private var trimmedPrompt: String {
        promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canEditInputs: Bool {
        !isSubmitting && !isUploadingFile && pendingRetryRequest == nil
    }

    private var canSubmit: Bool {
        guard !isSubmitting, !isUploadingFile, !isEndpointUnavailable else { return false }
        if pendingRetryRequest != nil { return true }
        return !trimmedPrompt.isEmpty && trimmedPrompt.count <= SubmitPythonTaskRequestDTO.promptMaxChars
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    if store.isMockOnly {
                        MockOnlyBanner()
                    }

                    Text("tasks.python.subtitle", tableName: "Conversation")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if isEndpointUnavailable {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "tasks.python.endpoint_unavailable.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(
                                String(localized: "tasks.python.endpoint_unavailable.message", table: "Conversation")
                            ),
                            tone: .neutral
                        )
                        .accessibilityIdentifier("python-task-endpoint-unavailable")
                    }

                    if pendingRetryRequest != nil {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "tasks.python.unknown_ack.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(
                                String(localized: "tasks.python.unknown_ack.message", table: "Conversation")
                            ),
                            tone: .warning
                        )
                        .accessibilityIdentifier("python-task-unknown-ack")
                    } else if let errorMessage {
                        InlineNotice(
                            title: LocalizedStringKey("tasks.error.title"),
                            message: LocalizedStringKey(errorMessage),
                            tone: .warning
                        )
                        .accessibilityIdentifier("python-task-error")
                    }

                    composerFields
                    attachmentsSection
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background(EmberDesignTokens.surfaceCanvas)
            .navigationTitle(Text("tasks.python.nav_title", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Text("conversation.live.cancel", tableName: "Conversation")
                    }
                    .disabled(isSubmitting)
                    .accessibilityIdentifier("python-task-cancel")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSubmitting {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text(
                                LocalizedStringKey(
                                    pendingRetryRequest != nil
                                        ? "tasks.python.action.retry"
                                        : "tasks.python.action.submit"
                                ),
                                tableName: "Conversation"
                            )
                            .fontWeight(.semibold)
                        }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("python-task-submit")
                }
            }
            .fileImporter(
                isPresented: $isShowingFileImporter,
                allowedContentTypes: Self.allowedFileTypes,
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first {
                        Task { await attachFile(from: url) }
                    }
                case .failure:
                    errorMessage = String(localized: "conversation.composer.attachment_read_failed", table: "Conversation")
                }
            }
        }
    }

    private var composerFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(
                String(localized: "tasks.python.title_placeholder", table: "Conversation"),
                text: $titleText
            )
            .textFieldStyle(.roundedBorder)
            .disabled(!canEditInputs)
            .accessibilityIdentifier("python-task-title-input")

            TextField(
                String(localized: "tasks.python.prompt_placeholder", table: "Conversation"),
                text: $promptText,
                axis: .vertical
            )
            .lineLimit(3...7)
            .textFieldStyle(.roundedBorder)
            .disabled(!canEditInputs)
            .accessibilityIdentifier("python-task-prompt-input")

            TextField(
                String(localized: "tasks.python.instructions_placeholder", table: "Conversation"),
                text: $instructionsText,
                axis: .vertical
            )
            .lineLimit(2...4)
            .textFieldStyle(.roundedBorder)
            .disabled(!canEditInputs)
            .accessibilityIdentifier("python-task-instructions-input")

            HStack {
                Text("\(trimmedPrompt.count) / \(SubmitPythonTaskRequestDTO.promptMaxChars)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(
                        trimmedPrompt.count > SubmitPythonTaskRequestDTO.promptMaxChars
                            ? Color.red
                            : Color.secondary
                    )
                Spacer()
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .emberCardSurface(cornerRadius: EmberDesignTokens.cardCornerRadius)
    }

    private var attachmentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("tasks.python.attachments.title", tableName: "Conversation")
                    .font(.headline)
                Spacer()
                Button {
                    isShowingFileImporter = true
                } label: {
                    if isUploadingFile {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label {
                            Text("tasks.python.attachments.add", tableName: "Conversation")
                        } icon: {
                            Image(systemName: "paperclip")
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                }
                .disabled(!canEditInputs || attachedFiles.count >= B3AttachmentLimits.maxAttachmentsPerMessage)
                .accessibilityIdentifier("python-task-add-file")
            }

            if attachedFiles.isEmpty {
                Text("tasks.python.attachments.empty", tableName: "Conversation")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(attachedFiles) { attachment in
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text")
                            .foregroundStyle(.primary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(attachment.filename)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            attachedFiles.removeAll { $0.uploadID == attachment.uploadID }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .disabled(!canEditInputs)
                        .accessibilityLabel(Text("tasks.python.attachments.remove", tableName: "Conversation"))
                    }
                    .padding(10)
                    .background(EmberDesignTokens.surfaceSubtle, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .emberCardSurface(cornerRadius: EmberDesignTokens.cardCornerRadius)
    }

    private func attachFile(from url: URL) async {
        guard !isUploadingFile, !isSubmitting else { return }
        isUploadingFile = true
        errorMessage = nil
        defer { isUploadingFile = false }

        let didStartScope = url.startAccessingSecurityScopedResource()
        defer {
            if didStartScope {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let resolvedMediaType: String
        if let byExtension = B3AttachmentLimits.mediaType(forFileExtension: url.pathExtension) {
            resolvedMediaType = byExtension
        } else if let resourceValues = try? url.resourceValues(forKeys: [.contentTypeKey]),
                  let mime = resourceValues.contentType?.preferredMIMEType {
            resolvedMediaType = B3AttachmentLimits.normalizedMediaType(mime)
        } else {
            resolvedMediaType = "application/octet-stream"
        }

        guard B3AttachmentLimits.isSafeMediaType(resolvedMediaType) else {
            errorMessage = String(localized: "conversation.composer.attachment_unsupported", table: "Conversation")
            return
        }

        do {
            let data = try Data(contentsOf: url)
            guard !data.isEmpty else {
                errorMessage = String(localized: "conversation.composer.attachment_read_failed", table: "Conversation")
                return
            }
            guard data.count <= SubmitPythonTaskRequestDTO.maxInlineArtifactBytes else {
                errorMessage = String(localized: "tasks.python.error.file_too_large", table: "Conversation")
                return
            }
            let safeName = B3AttachmentLimits.safeUploadFilename(url.lastPathComponent, mediaType: resolvedMediaType)
            let receipt = try await store.uploadTaskAttachment(
                filename: safeName,
                mediaType: resolvedMediaType,
                data: data
            )
            if !attachedFiles.contains(where: { $0.uploadID == receipt.uploadID }) {
                attachedFiles.append(receipt)
            }
        } catch SessionTaskRepositoryError.endpointNotReady {
            isEndpointUnavailable = true
        } catch {
            errorMessage = String(localized: "conversation.composer.attachment_upload_failed", table: "Conversation")
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let request = pendingRetryRequest ?? SubmitPythonTaskRequestDTO(
            title: titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : titleText,
            prompt: trimmedPrompt,
            instructions: instructionsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : instructionsText,
            attachmentIDs: attachedFiles.map(\.uploadID)
        )

        switch await store.submitPythonTask(request) {
        case .submitted(let task, _):
            pendingRetryRequest = nil
            dismiss()
            onSubmitted(task.taskID)
        case .unknownAcknowledgement:
            // Preserve the exact request and clientRequestID so retry is idempotent.
            pendingRetryRequest = request
        case .endpointNotReady:
            pendingRetryRequest = nil
            isEndpointUnavailable = true
        case .failed(let message):
            pendingRetryRequest = nil
            errorMessage = message
        }
    }
}
