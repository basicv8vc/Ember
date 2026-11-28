import Foundation

public enum WebEvidenceLimits {
    public static let schemaVersion = 1
    public static let maxSources = 10
    public static let maxURLCharacters = 2048
    public static let maxTitleCharacters = 200
    public static let maxDomainCharacters = 253
    public static let maxSnippetCharacters = 400
    public static let maxPublishedAtCharacters = 64
    public static let maxSourceIDCharacters = 64
    public static let maxDisplayCountCollapsed = 3
}

public enum WebEvidenceStatus: String, Codable, Equatable, Hashable, Sendable {
    case completed
    case partial
    case failed
}

public struct WebSource: Identifiable, Equatable, Hashable, Sendable {
    public let sourceID: String
    public let index: Int
    public let title: String
    public let url: URL
    public let domain: String
    public let snippet: String?
    public let publishedAt: String?
    public let fetched: Bool

    public var id: String { sourceID }

    public init?(
        sourceID: String,
        index: Int,
        title: String,
        url: URL,
        domain: String,
        snippet: String? = nil,
        publishedAt: String? = nil,
        fetched: Bool
    ) {
        let trimmedID = sourceID.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDomain = domain.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedID.isEmpty,
              trimmedID.count <= WebEvidenceLimits.maxSourceIDCharacters,
              (1...WebEvidenceLimits.maxSources).contains(index),
              !trimmedTitle.isEmpty,
              trimmedTitle.count <= WebEvidenceLimits.maxTitleCharacters,
              !trimmedDomain.isEmpty,
              trimmedDomain.count <= WebEvidenceLimits.maxDomainCharacters,
              url.absoluteString.count <= WebEvidenceLimits.maxURLCharacters,
              let safeURL = EmberInAppBrowserPolicy.webURL(from: url)
        else {
            return nil
        }

        self.sourceID = trimmedID
        self.index = index
        self.title = trimmedTitle
        self.url = safeURL
        self.domain = trimmedDomain
        self.snippet = Self.normalizedOptionalText(snippet, maxLength: WebEvidenceLimits.maxSnippetCharacters)
        self.publishedAt = Self.normalizedOptionalText(publishedAt, maxLength: WebEvidenceLimits.maxPublishedAtCharacters)
        self.fetched = fetched
    }

    public var displayDomain: String {
        let lowercased = domain.lowercased()
        if lowercased.hasPrefix("www."), lowercased.count > 4 {
            return String(lowercased.dropFirst(4))
        }
        return lowercased
    }

    public var formattedPublishedDate: String? {
        guard let publishedAt else { return nil }
        if let parsed = Self.parsePublishedDate(publishedAt) {
            return parsed.formatted(date: .abbreviated, time: .omitted)
        }
        return publishedAt
    }

    private static func normalizedOptionalText(_ raw: String?, maxLength: Int) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxLength else { return nil }
        return trimmed
    }

    private static let dateOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static func parsePublishedDate(_ value: String) -> Date? {
        if let iso = EmberWireDate.parse(value) {
            return iso
        }
        return dateOnlyFormatter.date(from: value)
    }
}

public struct WebEvidence: Equatable, Hashable, Sendable {
    public let schemaVersion: Int
    public let turnID: UUID
    public let status: WebEvidenceStatus
    public let sources: [WebSource]

    public var hasDisplayableSources: Bool {
        !sources.isEmpty
    }

    public init?(
        schemaVersion: Int = WebEvidenceLimits.schemaVersion,
        turnID: UUID,
        status: WebEvidenceStatus,
        sources: [WebSource]
    ) {
        guard schemaVersion == WebEvidenceLimits.schemaVersion else {
            return nil
        }
        let limitedSources = Array(sources.prefix(WebEvidenceLimits.maxSources))
        self.schemaVersion = schemaVersion
        self.turnID = turnID
        self.status = status
        self.sources = limitedSources
    }
}
