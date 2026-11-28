import SwiftUI

enum ConversationWebSourcesPresentation {
    static func visibleSources(from sources: [WebSource], isExpanded: Bool) -> [WebSource] {
        guard !isExpanded else { return sources }
        return Array(sources.prefix(WebEvidenceLimits.maxDisplayCountCollapsed))
    }

    static func shouldShowExpandToggle(totalCount: Int) -> Bool {
        totalCount > WebEvidenceLimits.maxDisplayCountCollapsed
    }

    static func statusText(fetched: Bool) -> String {
        String(
            localized: fetched
                ? "conversation.web_sources.status.fetched"
                : "conversation.web_sources.status.searched",
            table: "Conversation"
        )
    }

    static func rowAccessibilityLabel(for source: WebSource) -> String {
        var parts = [
            source.title,
            source.displayDomain,
            statusText(fetched: source.fetched),
        ]
        if let date = source.formattedPublishedDate {
            parts.append(date)
        }
        return parts.joined(separator: ", ")
    }

    static func domainInitial(for domain: String) -> String? {
        let lowercased = domain.lowercased()
        let stripped = if lowercased.hasPrefix("www."), lowercased.count > 4 {
            String(lowercased.dropFirst(4))
        } else {
            lowercased
        }
        guard let first = stripped.first, first.isLetter || first.isNumber else {
            return nil
        }
        return String(first).uppercased()
    }
}

/// Renders verified structured web evidence beneath the corresponding assistant response.
struct ConversationWebSourcesCard: View {
    let evidence: WebEvidence
    var onOpenURL: ((URL) -> Void)?

    @Environment(\.openURL) private var openURL
    @State private var isExpanded = false

    var body: some View {
        if evidence.hasDisplayableSources {
            let sources = evidence.sources
            let displayed = ConversationWebSourcesPresentation.visibleSources(
                from: sources,
                isExpanded: isExpanded
            )
            let canExpand = ConversationWebSourcesPresentation.shouldShowExpandToggle(totalCount: sources.count)

            VStack(alignment: .leading, spacing: 0) {
                headerRow(totalCount: sources.count)

                Divider()
                    .overlay(EmberDesignTokens.chatHairline)

                ForEach(Array(displayed.enumerated()), id: \.element.id) { offset, source in
                    if offset > 0 {
                        Divider()
                            .overlay(EmberDesignTokens.chatHairline)
                            .padding(.leading, 50)
                    }
                    sourceRow(source)
                }

                if canExpand {
                    Divider()
                        .overlay(EmberDesignTokens.chatHairline)
                    expandToggle(totalCount: sources.count)
                }
            }
            .frame(maxWidth: 680, alignment: .leading)
            .background(
                EmberDesignTokens.chatPaper,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversation-web-sources-card")
        }
    }

    private func headerRow(totalCount: Int) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "globe")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            Text("conversation.web_sources.header \(totalCount)", tableName: "Conversation")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            if evidence.status == .partial {
                Text("conversation.web_sources.partial", tableName: "Conversation")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(EmberDesignTokens.surfaceSubtle, in: Capsule())
                    .overlay {
                        Capsule()
                            .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
                    }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func sourceRow(_ source: WebSource) -> some View {
        Button {
            guard let safeURL = EmberInAppBrowserPolicy.webURL(from: source.url) else { return }
            if let onOpenURL {
                onOpenURL(safeURL)
            } else {
                openURL(safeURL)
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                domainMonogram(for: source.displayDomain)

                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: source.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    metadataLine(for: source)

                    if let snippet = source.snippet {
                        Text(verbatim: snippet)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "arrow.up.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: EmberDesignTokens.minTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: ConversationWebSourcesPresentation.rowAccessibilityLabel(for: source)))
        .accessibilityHint(Text("conversation.web_sources.open_hint", tableName: "Conversation"))
        .accessibilityAddTraits(.isLink)
        .accessibilityIdentifier("conversation-web-source-row-\(source.index)")
    }

    private func domainMonogram(for domain: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(EmberDesignTokens.surfaceSubtle)
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
                }

            if let initial = ConversationWebSourcesPresentation.domainInitial(for: domain) {
                Text(verbatim: initial)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "globe")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 26, height: 26)
        .padding(.top, 1)
        .accessibilityHidden(true)
    }

    private func metadataLine(for source: WebSource) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: source.displayDomain)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)

            statusBadge(fetched: source.fetched)

            if let date = source.formattedPublishedDate {
                Text(verbatim: "·")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)

                Text(verbatim: date)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func statusBadge(fetched: Bool) -> some View {
        HStack(spacing: 3) {
            Image(systemName: fetched ? "checkmark" : "magnifyingglass")
                .font(.system(size: 9, weight: .semibold))
                .accessibilityHidden(true)
            Text(
                fetched
                    ? "conversation.web_sources.status.fetched"
                    : "conversation.web_sources.status.searched",
                tableName: "Conversation"
            )
            .font(.caption2.weight(.medium))
        }
        .foregroundStyle(fetched ? .primary : .secondary)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            fetched ? EmberDesignTokens.surfaceSubtle : Color.clear,
            in: Capsule()
        )
        .overlay {
            Capsule()
                .strokeBorder(EmberDesignTokens.chatHairline, lineWidth: 1)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private func expandToggle(totalCount: Int) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                if isExpanded {
                    Text("conversation.web_sources.show_less", tableName: "Conversation")
                } else {
                    Text("conversation.web_sources.show_all \(totalCount)", tableName: "Conversation")
                }
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: EmberDesignTokens.minTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("conversation-web-sources-toggle")
    }
}
