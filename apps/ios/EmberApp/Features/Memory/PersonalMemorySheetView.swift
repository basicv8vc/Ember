import SwiftUI

struct PersonalMemorySheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: PersonalMemoryStore

    @State private var isShowingAddSheet = false
    @State private var addDraftContent = ""
    @State private var addSelectedKind: PersonalMemoryKind = .preference
    @State private var editingItem: PersonalMemoryItemDTO?
    @State private var editDraftContent = ""
    @State private var editSelectedKind: PersonalMemoryKind = .preference
    @State private var pendingDeleteItem: PersonalMemoryItemDTO?

    private var subtitleKey: LocalizedStringKey {
        if store.isEndpointUnavailable {
            return LocalizedStringKey(
                String(localized: "memory.subtitle.unavailable", table: "Conversation")
            )
        }
        if store.isMockOnly {
            return LocalizedStringKey(
                String(localized: "memory.subtitle.mock", table: "Conversation")
            )
        }
        return LocalizedStringKey(
            String(localized: "memory.subtitle", table: "Conversation")
        )
    }

    private var canOpenAddSheet: Bool {
        !store.isEndpointUnavailable && !store.isAtCapacity
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    if store.isMockOnly {
                        MockOnlyBanner()
                    }

                    Text(subtitleKey)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if store.isEndpointUnavailable {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "memory.endpoint_unavailable.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(
                                String(localized: "memory.endpoint_unavailable.message", table: "Conversation")
                            ),
                            tone: .neutral
                        )
                        .accessibilityIdentifier("memory-endpoint-unavailable")
                    } else {
                        if let error = store.errorMessage, !store.items.isEmpty {
                            MemoryErrorBanner(message: error, identifier: "memory-error-notice")
                        }

                        if store.isAtCapacity && store.errorMessage == nil {
                            InlineNotice(
                                title: LocalizedStringKey(
                                    String(localized: "memory.error.limit_reached", table: "Conversation")
                                ),
                                tone: .neutral
                            )
                            .accessibilityIdentifier("memory-capacity-notice")
                        }

                        primaryContent
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(EmberDesignTokens.surfaceCanvas)
            .navigationTitle(Text("memory.nav_title", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await store.refresh()
            }
            .task {
                await store.refresh()
            }
            .toolbar {
                if !store.isEndpointUnavailable {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            openAddSheet()
                        } label: {
                            Label {
                                Text("memory.add.short", tableName: "Conversation")
                                    .font(.subheadline.weight(.semibold))
                            } icon: {
                                Image(systemName: "plus")
                            }
                        }
                        .disabled(!canOpenAddSheet)
                        .accessibilityLabel(Text("memory.add.action", tableName: "Conversation"))
                        .accessibilityIdentifier("memory-add-button")
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Text("tasks.detail.close", tableName: "Conversation")
                    }
                    .accessibilityIdentifier("memory-sheet-close")
                }
            }
            .alert(
                Text("memory.delete.confirm_title", tableName: "Conversation"),
                isPresented: Binding(
                    get: { pendingDeleteItem != nil },
                    set: { if !$0 { pendingDeleteItem = nil } }
                )
            ) {
                Button(role: .cancel) {
                    pendingDeleteItem = nil
                } label: {
                    Text("conversation.live.cancel", tableName: "Conversation")
                }
                Button(role: .destructive) {
                    if let target = pendingDeleteItem {
                        pendingDeleteItem = nil
                        Task { await store.delete(id: target.memoryID) }
                    }
                } label: {
                    Text("memory.delete.action", tableName: "Conversation")
                }
            } message: {
                Text("memory.delete.confirm_message", tableName: "Conversation")
            }
            .sheet(isPresented: $isShowingAddSheet) {
                addMemorySheet
            }
            .sheet(item: $editingItem) { item in
                editMemorySheet(for: item)
            }
        }
    }

    @ViewBuilder
    private var primaryContent: some View {
        if store.isLoading && store.items.isEmpty {
            LoadingPlaceholder(title: "placeholder.loading")
                .accessibilityIdentifier("memory-loading")
        } else if let error = store.errorMessage, store.items.isEmpty {
            ErrorPlaceholder(
                title: LocalizedStringKey(
                    String(localized: "memory.error.title", table: "Conversation")
                ),
                message: LocalizedStringKey(error),
                retryTitle: LocalizedStringKey("placeholder.retry")
            ) {
                Task { await store.refresh() }
            }
            .accessibilityIdentifier("memory-error-placeholder")
        } else if store.items.isEmpty {
            VStack(spacing: EmberDesignTokens.standardSpacing) {
                EmptyPlaceholder(
                    title: LocalizedStringKey(
                        String(localized: "memory.empty.title", table: "Conversation")
                    ),
                    message: LocalizedStringKey(
                        String(localized: "memory.empty.message", table: "Conversation")
                    ),
                    systemImage: "brain.head.profile"
                )
                .accessibilityIdentifier("memory-empty")

                Button {
                    openAddSheet()
                } label: {
                    Label {
                        Text("memory.add.action", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    } icon: {
                        Image(systemName: "plus")
                    }
                    .foregroundStyle(EmberDesignTokens.primaryActionForeground)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(EmberDesignTokens.primaryActionFill)
                .disabled(!canOpenAddSheet)
                .accessibilityIdentifier("memory-empty-add-button")
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("memory.saved.section_title", tableName: "Conversation")
                        .font(.headline)
                    Spacer()
                    Text("\(store.items.count) / \(store.limits.maxItems)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("memory-count-badge")
                }

                ForEach(store.items) { item in
                    memoryRow(item)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("memory-saved-section")
        }
    }

    private func openAddSheet() {
        store.clearError()
        isShowingAddSheet = true
    }

    private func memoryRow(_ item: PersonalMemoryItemDTO) -> some View {
        let isDeleting = store.deletingIDs.contains(item.memoryID)
        let isUpdating = store.updatingIDs.contains(item.memoryID)
        let idSuffix = item.memoryID.uuidString.lowercased()

        return VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) {
                    kindBadge(for: item.kind)
                    Spacer(minLength: 8)
                    rowActionButtons(
                        for: item,
                        idSuffix: idSuffix,
                        isDeleting: isDeleting,
                        isUpdating: isUpdating
                    )
                }

                VStack(alignment: .leading, spacing: 6) {
                    kindBadge(for: item.kind)
                    HStack(spacing: 4) {
                        Spacer(minLength: 0)
                        rowActionButtons(
                            for: item,
                            idSuffix: idSuffix,
                            isDeleting: isDeleting,
                            isUpdating: isUpdating
                        )
                    }
                }
            }

            Text(item.content)
                .font(.body)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            HStack(spacing: 6) {
                Image(systemName: Self.sourceSymbol(for: item.provenance.source))
                    .accessibilityHidden(true)
                Text(String(localized: Self.sourceLabelKey(for: item.provenance.source), table: "Conversation"))
                if let date = ConversationCardFormatting.date(from: item.updatedAt) {
                    Text("·")
                    Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .emberCardSurface(cornerRadius: 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-item-\(idSuffix)")
    }

    private func kindBadge(for kind: PersonalMemoryKind) -> some View {
        Text(
            kind == .preference
                ? "memory.kind.preference"
                : "memory.kind.fact",
            tableName: "Conversation"
        )
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.primary)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(EmberDesignTokens.surfaceSubtle, in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(EmberDesignTokens.surfaceHairline, lineWidth: 1)
        }
    }

    private func rowActionButtons(
        for item: PersonalMemoryItemDTO,
        idSuffix: String,
        isDeleting: Bool,
        isUpdating: Bool
    ) -> some View {
        HStack(spacing: 2) {
            Button {
                store.clearError()
                editSelectedKind = item.kind
                editDraftContent = item.content
                editingItem = item
            } label: {
                Group {
                    if isUpdating {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "pencil")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .disabled(isDeleting || isUpdating)
            .accessibilityLabel(Text("memory.edit.action", tableName: "Conversation"))
            .accessibilityIdentifier("memory-edit-\(idSuffix)")

            Button(role: .destructive) {
                pendingDeleteItem = item
            } label: {
                Group {
                    if isDeleting {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "trash")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color(uiColor: .systemRed))
            .disabled(isDeleting || isUpdating)
            .accessibilityLabel(Text("memory.delete.action", tableName: "Conversation"))
            .accessibilityIdentifier("memory-delete-\(idSuffix)")
        }
    }

    private var addMemorySheet: some View {
        let trimmed = addDraftContent.trimmingCharacters(in: .whitespacesAndNewlines)
        let canCommit = !trimmed.isEmpty
            && trimmed.count <= store.limits.maxContentChars
            && !store.isSaving
            && !store.isAtCapacity
            && !store.isEndpointUnavailable

        return MemoryEditorSheet(
            navigationTitleKey: "memory.add.action",
            selectedKind: $addSelectedKind,
            draftContent: $addDraftContent,
            maxContentChars: store.limits.maxContentChars,
            isCommitting: store.isSaving,
            canCommit: canCommit,
            errorMessage: store.errorMessage,
            errorIdentifier: "memory-add-error-notice",
            inputIdentifier: "memory-composer-input",
            saveIdentifier: "memory-composer-save",
            helperMessage: LocalizedStringKey(
                String(localized: "memory.add.helper", table: "Conversation")
            ),
            onCancel: {
                store.clearError()
                isShowingAddSheet = false
            },
            onSave: {
                let kind = addSelectedKind
                let content = trimmed
                Task {
                    if await store.save(kind: kind, content: content) {
                        addDraftContent = ""
                        isShowingAddSheet = false
                    }
                }
            }
        )
        .onDisappear {
            if !store.isSaving {
                store.clearError()
            }
        }
    }

    private func editMemorySheet(for item: PersonalMemoryItemDTO) -> some View {
        let trimmed = editDraftContent.trimmingCharacters(in: .whitespacesAndNewlines)
        let isUpdating = store.updatingIDs.contains(item.memoryID)
        let canCommit = !trimmed.isEmpty
            && trimmed.count <= store.limits.maxContentChars
            && !isUpdating
            && (trimmed != item.content || editSelectedKind != item.kind)
        let sourceText = String(
            localized: Self.sourceLabelKey(for: item.provenance.source),
            table: "Conversation"
        )

        return MemoryEditorSheet(
            navigationTitleKey: "memory.edit.title",
            selectedKind: $editSelectedKind,
            draftContent: $editDraftContent,
            maxContentChars: store.limits.maxContentChars,
            isCommitting: isUpdating,
            canCommit: canCommit,
            errorMessage: store.errorMessage,
            errorIdentifier: "memory-edit-error-notice",
            inputIdentifier: "memory-edit-input",
            saveIdentifier: "memory-edit-save",
            helperMessage: LocalizedStringKey(
                String(localized: "memory.edit.source_prefix \(sourceText)", table: "Conversation")
            ),
            onCancel: {
                store.clearError()
                editingItem = nil
            },
            onSave: {
                let nextKind = editSelectedKind
                let nextContent = trimmed
                Task {
                    let updated = await store.update(
                        id: item.memoryID,
                        kind: nextKind,
                        content: nextContent
                    )
                    if updated || !store.items.contains(where: { $0.memoryID == item.memoryID }) {
                        editingItem = nil
                    }
                }
            }
        )
        .onDisappear {
            if store.items.contains(where: { $0.memoryID == item.memoryID }) {
                store.clearError()
            }
        }
    }

    static func sourceLabelKey(for source: PersonalMemorySource) -> String.LocalizationValue {
        source == .explicitUserRequest ? "memory.source.chat" : "memory.source.settings"
    }

    static func sourceSymbol(for source: PersonalMemorySource) -> String {
        source == .explicitUserRequest ? "bubble.left" : "square.and.pencil"
    }

    /// Human-readable subtitle lines rendered on a memory row (never includes raw internal `key`).
    static func visibleMetadataSummary(for item: PersonalMemoryItemDTO) -> String {
        String(localized: sourceLabelKey(for: item.provenance.source), table: "Conversation")
    }
}

private struct MemoryEditorSheet: View {
    let navigationTitleKey: String.LocalizationValue
    @Binding var selectedKind: PersonalMemoryKind
    @Binding var draftContent: String
    let maxContentChars: Int
    let isCommitting: Bool
    let canCommit: Bool
    let errorMessage: String?
    let errorIdentifier: String
    let inputIdentifier: String
    let saveIdentifier: String
    let helperMessage: LocalizedStringKey
    let onCancel: () -> Void
    let onSave: () -> Void

    @FocusState private var isInputFocused: Bool

    private var trimmedCount: Int {
        draftContent.trimmingCharacters(in: .whitespacesAndNewlines).count
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    Picker(
                        String(localized: "memory.kind.label", table: "Conversation"),
                        selection: $selectedKind
                    ) {
                        Text("memory.kind.preference", tableName: "Conversation")
                            .tag(PersonalMemoryKind.preference)
                        Text("memory.kind.fact", tableName: "Conversation")
                            .tag(PersonalMemoryKind.fact)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("memory-kind-picker")

                    TextField(
                        String(localized: "memory.composer.placeholder", table: "Conversation"),
                        text: $draftContent,
                        axis: .vertical
                    )
                    .lineLimit(3...6)
                    .textFieldStyle(.roundedBorder)
                    .focused($isInputFocused)
                    .accessibilityIdentifier(inputIdentifier)

                    HStack {
                        Text("\(trimmedCount) / \(maxContentChars)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(
                                trimmedCount > maxContentChars ? Color.red : Color.secondary
                            )
                        Spacer()
                    }

                    Text(helperMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let errorMessage {
                        MemoryErrorBanner(message: errorMessage, identifier: errorIdentifier)
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(EmberDesignTokens.surfaceCanvas)
            .navigationTitle(Text(String(localized: navigationTitleKey, table: "Conversation")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onCancel) {
                        Text("conversation.live.cancel", tableName: "Conversation")
                    }
                    .accessibilityIdentifier("memory-editor-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: onSave) {
                        if isCommitting {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("memory.composer.save", tableName: "Conversation")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!canCommit)
                    .accessibilityIdentifier(saveIdentifier)
                }
            }
            .onAppear {
                isInputFocused = true
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct MemoryErrorBanner: View {
    let message: String
    let identifier: String

    var body: some View {
        InlineNotice(
            title: LocalizedStringKey(
                String(localized: "memory.error.title", table: "Conversation")
            ),
            message: LocalizedStringKey(message),
            tone: .warning
        )
        .accessibilityIdentifier(identifier)
    }
}
