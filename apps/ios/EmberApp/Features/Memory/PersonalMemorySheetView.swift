import SwiftUI

struct PersonalMemorySheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: PersonalMemoryStore

    @State private var draftContent = ""
    @State private var selectedKind: PersonalMemoryKind = .preference
    @State private var pendingDeleteItem: PersonalMemoryItemDTO?

    private var trimmedDraft: String {
        draftContent.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !trimmedDraft.isEmpty
            && trimmedDraft.count <= store.limits.maxContentChars
            && !store.isSaving
            && !store.isAtCapacity
            && !store.isEndpointUnavailable
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EmberDesignTokens.standardSpacing) {
                    if store.isMockOnly {
                        MockOnlyBanner()
                    }

                    Text("memory.subtitle", tableName: "Conversation")
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
                        composerCard
                    }

                    if let error = store.errorMessage {
                        InlineNotice(
                            title: LocalizedStringKey(
                                String(localized: "memory.error.title", table: "Conversation")
                            ),
                            message: LocalizedStringKey(error),
                            tone: .warning
                        )
                        .accessibilityIdentifier("memory-error-notice")
                    }

                    if store.isLoading && store.items.isEmpty {
                        LoadingPlaceholder(title: "placeholder.loading")
                            .accessibilityIdentifier("memory-loading")
                    } else if store.items.isEmpty && !store.isEndpointUnavailable {
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
                    } else if !store.items.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text("memory.saved.section_title", tableName: "Conversation")
                                    .font(.headline)
                                Spacer()
                                Text("\(store.items.count) / \(store.limits.maxItems)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }

                            ForEach(store.items) { item in
                                memoryRow(item)
                            }
                        }
                    }
                }
                .padding(EmberDesignTokens.standardSpacing)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background(EmberDesignTokens.groupedBackground)
            .navigationTitle(Text("memory.nav_title", tableName: "Conversation"))
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await store.refresh()
            }
            .task {
                await store.refresh()
            }
            .toolbar {
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
        }
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
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
            .lineLimit(2...5)
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("memory-composer-input")

            HStack {
                Text("\(trimmedDraft.count) / \(store.limits.maxContentChars)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(
                        trimmedDraft.count > store.limits.maxContentChars ? Color.red : Color.secondary
                    )
                Spacer()
                Button {
                    let contentToSave = trimmedDraft
                    Task {
                        if await store.save(kind: selectedKind, content: contentToSave) {
                            draftContent = ""
                        }
                    }
                } label: {
                    if store.isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("memory.composer.save", tableName: "Conversation")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSave)
                .accessibilityIdentifier("memory-composer-save")
            }
        }
        .padding(EmberDesignTokens.standardSpacing)
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
        )
    }

    private func memoryRow(_ item: PersonalMemoryItemDTO) -> some View {
        let isDeleting = store.deletingIDs.contains(item.memoryID)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text(
                    item.kind == .preference
                        ? "memory.kind.preference"
                        : "memory.kind.fact",
                    tableName: "Conversation"
                )
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.12), in: Capsule())

                if let key = item.key {
                    Text(key)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Button(role: .destructive) {
                    pendingDeleteItem = item
                } label: {
                    if isDeleting {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "trash")
                            .font(.caption.weight(.semibold))
                    }
                }
                .disabled(isDeleting)
                .accessibilityLabel(Text("memory.delete.action", tableName: "Conversation"))
                .accessibilityIdentifier("memory-delete-\(item.memoryID.uuidString.lowercased())")
            }

            Text(item.content)
                .font(.body)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            HStack(spacing: 6) {
                Text(
                    item.provenance.source == .explicitUserRequest
                        ? "memory.source.chat"
                        : "memory.source.settings",
                    tableName: "Conversation"
                )
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
        .background(
            EmberDesignTokens.cardBackground,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory-item-\(item.memoryID.uuidString.lowercased())")
    }
}
