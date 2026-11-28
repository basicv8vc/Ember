import Darwin
import Foundation
import SafariServices
import SwiftUI

struct EmberWebSourceLink: Identifiable, Equatable {
    let url: URL
    let displayHost: String

    var id: String { url.absoluteString }
}

enum EmberOpenURLDisposition: Equatable, Sendable {
    case openInAppBrowser(URL)
    case systemAction
    case discard
}

enum EmberInAppBrowserPolicy {
    private static let blockedLocalHostnames: Set<String> = [
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
    ]
    private static let allowedExternalSchemes: Set<String> = [
        "mailto",
        "tel",
    ]

    /// Routes public HTTP(S) URLs to the in-app Safari sheet, permits safe external utility schemes
    /// (`mailto:`, `tel:`), and discards unsafe HTTP(S) or script/file URLs so the system never
    /// launches them outside the app.
    static func disposition(for url: URL) -> EmberOpenURLDisposition {
        if let webURL = webURL(from: url) {
            return .openInAppBrowser(webURL)
        }
        if let scheme = url.scheme?.lowercased(),
           allowedExternalSchemes.contains(scheme)
        {
            return .systemAction
        }
        return .discard
    }

    /// Only public HTTP(S) URLs without embedded credentials or private/local hosts are safe
    /// to open in `SFSafariViewController`.
    static func webURL(from url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.user == nil,
              url.password == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
              components.user == nil,
              components.password == nil,
              let rawHost = url.host,
              isPublicWebHost(rawHost)
        else {
            return nil
        }
        return url
    }

    static func displayHost(for url: URL) -> String {
        guard let host = url.host, !host.isEmpty else {
            return url.absoluteString
        }
        let lowercased = host.lowercased()
        if lowercased.hasPrefix("www."), lowercased.count > 4 {
            return String(lowercased.dropFirst(4))
        }
        return lowercased
    }

    private static func isPublicWebHost(_ rawHost: String) -> Bool {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while host.hasSuffix(".") {
            host.removeLast()
        }
        guard !host.isEmpty,
              !host.contains(".."),
              host.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              host.rangeOfCharacter(from: .controlCharacters) == nil
        else {
            return false
        }

        let unbracketed = if host.hasPrefix("["), host.hasSuffix("]") {
            String(host.dropFirst().dropLast())
        } else {
            host
        }

        if let ipv4 = parseIPv4(unbracketed) {
            return isPublicIPv4(ipv4)
        }
        if let ipv6 = parseIPv6(unbracketed) {
            return isPublicIPv6(ipv6)
        }

        if blockedLocalHostnames.contains(host) ||
            host.hasSuffix(".localhost") ||
            host.hasSuffix(".local") ||
            host.hasSuffix(".internal")
        {
            return false
        }

        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2,
              labels.allSatisfy({ !$0.isEmpty }),
              let tld = labels.last,
              tld.contains(where: { $0.isLetter })
        else {
            return false
        }
        return true
    }

    private static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        var addr = in_addr()
        guard host.withCString({ inet_pton(AF_INET, $0, &addr) }) == 1 else {
            return nil
        }
        let value = UInt32(bigEndian: addr.s_addr)
        return (
            UInt8((value >> 24) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF)
        )
    }

    private static func isPublicIPv4(_ octets: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (b0, b1, b2, _) = octets
        if b0 == 0 || b0 == 10 || b0 == 127 { return false }
        if b0 == 100, (64...127).contains(b1) { return false }
        if b0 == 169, b1 == 254 { return false }
        if b0 == 172, (16...31).contains(b1) { return false }
        if b0 == 192, b1 == 168 { return false }
        if b0 == 192, b1 == 0, b2 == 0 { return false }
        if b0 == 198, b1 == 18 || b1 == 19 { return false }
        if b0 >= 224 { return false }
        return true
    }

    private static func parseIPv6(_ host: String) -> [UInt8]? {
        let cleanHost = host.split(separator: "%", maxSplits: 1).first.map(String.init) ?? host
        var addr = in6_addr()
        guard cleanHost.withCString({ inet_pton(AF_INET6, $0, &addr) }) == 1 else {
            return nil
        }
        return withUnsafeBytes(of: addr) { Array($0) }
    }

    private static func isPublicIPv6(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 16 else { return false }
        if bytes.allSatisfy({ $0 == 0 }) { return false } // ::
        if bytes.prefix(15).allSatisfy({ $0 == 0 }), bytes[15] == 1 { return false } // ::1
        if (bytes[0] & 0xFE) == 0xFC { return false } // fc00::/7 unique local
        if bytes[0] == 0xFE, (bytes[1] & 0xC0) == 0x80 { return false } // fe80::/10 link-local
        if bytes[0] == 0xFF { return false } // ff00::/8 multicast
        // ::ffff:a.b.c.d IPv4-mapped
        if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 0xFF, bytes[11] == 0xFF {
            return isPublicIPv4((bytes[12], bytes[13], bytes[14], bytes[15]))
        }
        return true
    }
}

enum EmberLinkDetector {
    private static let detectorLock = NSLock()
    private static let detector: NSDataDetector? = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
    )

    private static func mayContainWebURL(_ text: String) -> Bool {
        text.contains("http://") || text.contains("https://") || text.contains("www.")
    }

    private static func normalizedWebURL(from match: NSTextCheckingResult, in text: NSString) -> URL? {
        guard let url = match.url else { return nil }
        let matchedSubstring = text.substring(with: match.range)
        if matchedSubstring.lowercased().hasPrefix("www."),
           let httpsURL = URL(string: "https://\(matchedSubstring)") {
            return EmberInAppBrowserPolicy.webURL(from: httpsURL)
        }
        return EmberInAppBrowserPolicy.webURL(from: url)
    }

    private static func matches(in text: String) -> [(NSRange, URL)] {
        guard mayContainWebURL(text), let detector else { return [] }
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        detectorLock.lock()
        let rawMatches = detector.matches(in: text, options: [], range: fullRange)
        detectorLock.unlock()

        return rawMatches.compactMap { match in
            guard let url = normalizedWebURL(from: match, in: nsText) else { return nil }
            return (match.range, url)
        }
    }

    /// Linkifies bare HTTP(S) / `www.` URLs in plain text, returning `nil` when no web URLs are present.
    static func linkifiedPlainText(for rawText: String) -> AttributedString? {
        let detected = matches(in: rawText)
        guard !detected.isEmpty else { return nil }

        var attributed = AttributedString(rawText)
        for (nsRange, url) in detected {
            guard let stringRange = Range(nsRange, in: rawText),
                  let attrRange = Range(stringRange, in: attributed)
            else {
                continue
            }
            attributed[attrRange].link = url
            attributed[attrRange].underlineStyle = .single
        }
        return attributed
    }

    /// Enhances a Markdown-parsed `AttributedString` by underlining existing Markdown links
    /// and linkifying any bare HTTP(S) / `www.` URLs that are not already linked.
    static func enhanceLinks(in attributed: inout AttributedString) {
        for run in attributed.runs where run.link != nil {
            attributed[run.range].underlineStyle = .single
        }

        let plainText = String(attributed.characters)
        let detected = matches(in: plainText)
        guard !detected.isEmpty else { return }

        for (nsRange, url) in detected {
            guard let stringRange = Range(nsRange, in: plainText),
                  let attrRange = Range(stringRange, in: attributed)
            else {
                continue
            }
            let alreadyLinked = attributed[attrRange].runs.contains { $0.link != nil }
            if !alreadyLinked {
                attributed[attrRange].link = url
                attributed[attrRange].underlineStyle = .single
            }
        }
    }

    /// Extracts unique HTTP(S) source links from Markdown or plain text for display as source pills.
    static func extractWebLinks(from rawText: String, limit: Int = 6) -> [EmberWebSourceLink] {
        guard limit > 0, mayContainWebURL(rawText) else { return [] }

        var seen: Set<String> = []
        var results: [EmberWebSourceLink] = []

        let detected = matches(in: rawText)
        for (_, url) in detected {
            let key = url.absoluteString
            guard seen.insert(key).inserted else { continue }
            results.append(
                EmberWebSourceLink(
                    url: url,
                    displayHost: EmberInAppBrowserPolicy.displayHost(for: url)
                )
            )
            if results.count >= limit {
                break
            }
        }
        return results
    }
}

private struct IdentifiableBrowserURL: Identifiable {
    let id = UUID()
    let url: URL
}

private struct EmberInAppBrowserSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        configuration.barCollapsingEnabled = true

        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.preferredControlTintColor = .label
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

private struct EmberInAppBrowserModifier: ViewModifier {
    @State private var presentedURL: IdentifiableBrowserURL?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                switch EmberInAppBrowserPolicy.disposition(for: url) {
                case .openInAppBrowser(let webURL):
                    presentedURL = IdentifiableBrowserURL(url: webURL)
                    return .handled
                case .systemAction:
                    return .systemAction
                case .discard:
                    return .discarded
                }
            })
            .sheet(item: $presentedURL) { item in
                EmberInAppBrowserSheet(url: item.url)
                    .ignoresSafeArea()
            }
    }
}

extension View {
    func emberInAppBrowser() -> some View {
        modifier(EmberInAppBrowserModifier())
    }
}
