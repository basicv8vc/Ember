import Foundation
import SafariServices
import SwiftUI

enum EmberInAppBrowserPolicy {
    /// Only HTTP(S) URLs with a non-empty host are safe to open in `SFSafariViewController`.
    static func webURL(from url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host,
              !host.isEmpty
        else {
            return nil
        }
        return url
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
                guard let webURL = EmberInAppBrowserPolicy.webURL(from: url) else {
                    return .systemAction
                }
                presentedURL = IdentifiableBrowserURL(url: webURL)
                return .handled
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
