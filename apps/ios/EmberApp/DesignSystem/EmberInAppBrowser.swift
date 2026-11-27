import Foundation
import OSLog
import SwiftUI
import UIKit
import WebKit

struct EmberWebSourceLink: Identifiable, Equatable {
    let url: URL
    let displayHost: String

    var id: String { url.absoluteString }
}

enum EmberInAppBrowserPolicy {
    /// Only HTTP(S) URLs with a non-empty host are safe to open in the embedded browser.
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

    /// Extracts unique public HTTP(S) source links from Markdown or plain text in appearance order.
    static func extractWebLinks(from rawText: String, limit: Int = 6) -> [EmberWebSourceLink] {
        guard limit > 0, mayContainWebURL(rawText) else { return [] }
        var seen: Set<String> = []
        var result: [EmberWebSourceLink] = []

        for (_, url) in matches(in: rawText) {
            let key = url.absoluteString
            guard seen.insert(key).inserted else { continue }
            result.append(
                EmberWebSourceLink(
                    url: url,
                    displayHost: EmberInAppBrowserPolicy.displayHost(for: url)
                )
            )
            if result.count >= limit {
                break
            }
        }
        return result
    }
}

private struct IdentifiableBrowserURL: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
private final class EmberEmbeddedBrowserModel: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView

    @Published var currentURL: URL
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var isLoading = true
    @Published var estimatedProgress: Double = 0.1
    @Published var isReaderModeEnabled = false

    private let initialURL: URL
    private var hasStartedInitialLoad = false
    private var observations: [NSKeyValueObservation] = []

    /// Ensures legacy desktop-only pages (like paulgraham.com with no viewport meta)
    /// scale cleanly to mobile width without breaking responsive sites that already define a viewport.
    private static let mobileViewportFallbackScriptSource = """
    (function() {
      if (!document.querySelector('meta[name="viewport"]')) {
        var meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
        if (document.head) { document.head.appendChild(meta); }
        var style = document.createElement('style');
        style.id = 'ember-mobile-fallback-style';
        style.textContent = 'html, body { max-width: 100% !important; overflow-x: hidden !important; -webkit-text-size-adjust: 100%; } body { padding: 12px 16px 88px 16px !important; box-sizing: border-box !important; font-family: -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 16px !important; line-height: 1.65 !important; } table, tr, td, img, pre, code { max-width: 100% !important; width: auto !important; height: auto !important; box-sizing: border-box !important; } td { display: block !important; }';
        if (document.head) { document.head.appendChild(style); }
      }
    })();
    """

    private static let readerModeToggleScriptSource = """
    (function(enable) {
      var existing = document.getElementById('ember-reader-overlay');
      if (!enable) {
        if (existing) { existing.remove(); }
        document.documentElement.style.overflow = '';
        return;
      }
      if (existing) { return; }
      var root = document.querySelector('article, main, [role="main"]') || document.body;
      var title = (document.querySelector('h1') && document.querySelector('h1').innerText) || document.title || '';
      var blocks = [];
      var nodes = root.querySelectorAll('h1, h2, h3, p, li, blockquote, pre');
      for (var i = 0; i < nodes.length; i++) {
        var text = (nodes[i].innerText || '').trim();
        if (text.length < 2) continue;
        if (nodes[i].tagName === 'H1' && text === title.trim()) continue;
        blocks.push({ tag: nodes[i].tagName.toLowerCase(), text: text });
      }
      if (blocks.length === 0) {
        var raw = (root.innerText || '').split(/\\n{2,}/).map(function(s) { return s.trim(); }).filter(Boolean);
        blocks = raw.map(function(t) { return { tag: 'p', text: t }; });
      }
      var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      var overlay = document.createElement('div');
      overlay.id = 'ember-reader-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:24px 20px 104px 20px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:' + (isDark ? '#111111' : '#ffffff') + ';color:' + (isDark ? '#f2f2f2' : '#161616') + ';';
      var container = document.createElement('div');
      container.style.cssText = 'max-width:640px;margin:0 auto;';
      if (title.trim()) {
        var h = document.createElement('h1');
        h.textContent = title.trim();
        h.style.cssText = 'font-size:24px;line-height:1.3;font-weight:700;margin:0 0 18px 0;';
        container.appendChild(h);
      }
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        var el = document.createElement(b.tag === 'li' ? 'p' : b.tag);
        el.textContent = b.tag === 'li' ? '• ' + b.text : b.text;
        if (b.tag === 'h2' || b.tag === 'h3') {
          el.style.cssText = 'font-size:19px;line-height:1.35;font-weight:600;margin:22px 0 10px 0;';
        } else if (b.tag === 'pre') {
          el.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;overflow-x:auto;padding:12px;border-radius:10px;background:' + (isDark ? '#1e1e1e' : '#f4f4f6') + ';margin:14px 0;';
        } else if (b.tag === 'blockquote') {
          el.style.cssText = 'font-size:16px;line-height:1.65;margin:14px 0;padding-left:14px;border-left:3px solid ' + (isDark ? '#444' : '#d4d4d8') + ';opacity:0.9;';
        } else {
          el.style.cssText = 'font-size:17px;line-height:1.72;margin:0 0 14px 0;';
        }
        container.appendChild(el);
      }
      overlay.appendChild(container);
      document.documentElement.style.overflow = 'hidden';
      document.body.appendChild(overlay);
    })
    """

    init(initialURL: URL) {
        self.initialURL = initialURL
        self.currentURL = initialURL
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        let viewportScript = WKUserScript(
            source: Self.mobileViewportFallbackScriptSource,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(viewportScript)

        // Initialize WKWebView with a real mobile-sized frame rather than `.zero` so WebKit's
        // WebPageProxy never computes an initial 0px / 980px desktop layout during sheet presentation.
        let screenSize = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen.bounds.size }
            .first ?? CGSize(width: 393, height: 852)
        let initialFrame = CGRect(
            x: 0,
            y: 0,
            width: screenSize.width,
            height: max(screenSize.height * 0.68, 400)
        )

        let webView = WKWebView(frame: initialFrame, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView = webView
        super.init()

        webView.navigationDelegate = self
        observations = [
            webView.observe(\.url, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    if let url = view.url {
                        self?.currentURL = url
                    }
                }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    self?.canGoBack = view.canGoBack
                }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    self?.canGoForward = view.canGoForward
                }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    self?.isLoading = view.isLoading
                }
            },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    self?.estimatedProgress = view.estimatedProgress
                }
            },
            webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.correctShrunkenZoomIfNeeded(reason: "contentSize") }
            },
        ]
    }

    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Ember", category: "InAppBrowser")

    /// WKWebView 先以 980px 布局空白文档（最小缩放约 0.41）。在 sheet 尺寸变化时，
    /// 这个小于 1 的缩放可能留到已按 device-width 排版的页面上，表现为内容比视口窄、挤在左侧。
    func correctShrunkenZoomIfNeeded(reason: String) {
        let sv = webView.scrollView
        let viewportWidth = webView.bounds.width
        let contentWidth = sv.contentSize.width
        let zoom = sv.zoomScale
        guard viewportWidth >= 200, contentWidth > 0, zoom > 0 else { return }
        if sv.isZooming || sv.isZoomBouncing { return }
        if let p = sv.pinchGestureRecognizer, p.state == .began || p.state == .changed { return }
        guard contentWidth < viewportWidth - 2 else { return }
        let fit = min(viewportWidth / (contentWidth / zoom), max(sv.maximumZoomScale, 1))
        guard fit > zoom + 0.01 else { return }
        Self.logger.notice("Restoring shrunken zoom (\(reason, privacy: .public)): zoom=\(Double(zoom), privacy: .public) min=\(Double(sv.minimumZoomScale), privacy: .public) content=\(Double(contentWidth), privacy: .public) viewport=\(Double(viewportWidth), privacy: .public) -> \(Double(fit), privacy: .public)")
        sv.setZoomScale(fit, animated: false)
    }

    func startInitialLoadIfNeeded() {
        guard !hasStartedInitialLoad else { return }
        hasStartedInitialLoad = true
        webView.load(URLRequest(url: initialURL))
    }

    func notifyViewportResized() {
        guard hasStartedInitialLoad else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'));", completionHandler: nil)
    }

    func goBack() {
        isReaderModeEnabled = false
        webView.goBack()
    }

    func goForward() {
        isReaderModeEnabled = false
        webView.goForward()
    }

    func toggleReaderMode() {
        isReaderModeEnabled.toggle()
        applyReaderModeState()
    }

    private func applyReaderModeState() {
        let js = "\(Self.readerModeToggleScriptSource)(\(isReaderModeEnabled ? "true" : "false"));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Task { @MainActor [weak self] in self?.correctShrunkenZoomIfNeeded(reason: "commit") }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if self.isReaderModeEnabled {
                self.applyReaderModeState()
            }
            self.correctShrunkenZoomIfNeeded(reason: "finish")
            try? await Task.sleep(nanoseconds: 600_000_000)
            self.correctShrunkenZoomIfNeeded(reason: "finish+600ms")
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            Task { @MainActor in decisionHandler(.cancel, preferences) }
            return
        }

        if let safeWebURL = EmberInAppBrowserPolicy.webURL(from: url) {
            if navigationAction.targetFrame == nil {
                Task { @MainActor in
                    preferences.preferredContentMode = .mobile
                    webView.load(URLRequest(url: safeWebURL))
                    decisionHandler(.cancel, preferences)
                }
                return
            }
            Task { @MainActor in
                preferences.preferredContentMode = .mobile
                decisionHandler(.allow, preferences)
            }
            return
        }

        if navigationAction.navigationType == .linkActivated {
            Task { @MainActor in
                UIApplication.shared.open(url)
                decisionHandler(.cancel, preferences)
            }
            return
        }

        Task { @MainActor in decisionHandler(.cancel, preferences) }
    }
}

private final class EmberEmbeddedWebViewController: UIViewController {
    let model: EmberEmbeddedBrowserModel
    private var lastReportedSize: CGSize = .zero

    init(model: EmberEmbeddedBrowserModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let webView = model.webView
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        view.layoutIfNeeded()
        lastReportedSize = view.bounds.size
        model.startInitialLoadIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        guard size.width >= 200, size.height >= 200 else { return }

        if lastReportedSize != .zero, abs(size.width - lastReportedSize.width) > 1 || abs(size.height - lastReportedSize.height) > 1 {
            lastReportedSize = size
            model.notifyViewportResized()
        } else if lastReportedSize == .zero {
            lastReportedSize = size
        }
        model.correctShrunkenZoomIfNeeded(reason: "layout")
    }
}

private struct EmberEmbeddedWebViewContainer: UIViewControllerRepresentable {
    let model: EmberEmbeddedBrowserModel

    func makeUIViewController(context: Context) -> EmberEmbeddedWebViewController {
        EmberEmbeddedWebViewController(model: model)
    }

    func updateUIViewController(_ uiViewController: EmberEmbeddedWebViewController, context: Context) {}
}

private struct EmberEmbeddedBrowserSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: EmberEmbeddedBrowserModel
    let onAskAboutPage: ((URL) -> Void)?

    init(url: URL, onAskAboutPage: ((URL) -> Void)?) {
        _model = StateObject(wrappedValue: EmberEmbeddedBrowserModel(initialURL: url))
        self.onAskAboutPage = onAskAboutPage
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
                .overlay(alignment: .bottomLeading) {
                    ZStack(alignment: .leading) {
                        Rectangle()
                            .fill(EmberDesignTokens.chatHairline)
                            .frame(height: 1)

                        if model.isLoading {
                            GeometryReader { proxy in
                                Rectangle()
                                    .fill(EmberDesignTokens.chatBrandInk)
                                    .frame(width: max(proxy.size.width * max(0.08, model.estimatedProgress), 24), height: 2)
                                    .animation(.easeOut(duration: 0.2), value: model.estimatedProgress)
                            }
                            .frame(height: 2)
                        }
                    }
                }

            ZStack(alignment: .bottom) {
                EmberEmbeddedWebViewContainer(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if let onAskAboutPage {
                    Button {
                        onAskAboutPage(model.currentURL)
                        dismiss()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "sparkles")
                                .font(.caption.weight(.semibold))
                            Text("问 Ember 当前页面")
                                .font(.subheadline.weight(.semibold))
                        }
                        .foregroundStyle(EmberDesignTokens.chatActionForeground)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(EmberDesignTokens.chatActionFill, in: Capsule())
                        .shadow(color: Color.black.opacity(0.16), radius: 10, x: 0, y: 4)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 16)
                    .accessibilityIdentifier("embedded-browser-ask-ember")
                }
            }
        }
        .background(EmberDesignTokens.chatPaper)
    }

    private var headerBar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                Button {
                    model.goBack()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.callout.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .disabled(!model.canGoBack)
                .foregroundStyle(model.canGoBack ? .primary : .tertiary)
                .accessibilityLabel("后退")

                Button {
                    model.goForward()
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.callout.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .disabled(!model.canGoForward)
                .foregroundStyle(model.canGoForward ? .primary : .tertiary)
                .accessibilityLabel("前进")
            }

            HStack(spacing: 5) {
                Image(systemName: model.currentURL.scheme?.lowercased() == "https" ? "lock.fill" : "globe")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                Text(EmberInAppBrowserPolicy.displayHost(for: model.currentURL))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 4) {
                Button {
                    model.toggleReaderMode()
                } label: {
                    Image(systemName: model.isReaderModeEnabled ? "doc.plaintext.fill" : "doc.plaintext")
                        .font(.callout.weight(.medium))
                        .frame(width: 32, height: 32)
                        .background(
                            model.isReaderModeEnabled ? EmberDesignTokens.surfaceSubtle : Color.clear,
                            in: Circle()
                        )
                }
                .foregroundStyle(.primary)
                .accessibilityLabel(model.isReaderModeEnabled ? "退出阅读模式" : "阅读模式")
                .accessibilityIdentifier("embedded-browser-reader-toggle")

                Button {
                    UIApplication.shared.open(model.currentURL)
                } label: {
                    Image(systemName: "safari")
                        .font(.callout.weight(.medium))
                        .frame(width: 32, height: 32)
                }
                .foregroundStyle(.primary)
                .accessibilityLabel("在 Safari 中打开")

                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.callout.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .foregroundStyle(.primary)
                .accessibilityLabel("关闭")
                .accessibilityIdentifier("embedded-browser-close")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(EmberDesignTokens.chatPaper)
    }
}

private struct EmberInAppBrowserModifier: ViewModifier {
    let onAskAboutPage: ((URL) -> Void)?
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
                EmberEmbeddedBrowserSheet(url: item.url, onAskAboutPage: onAskAboutPage)
                    .presentationDetents([.fraction(0.68), .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(24)
                    .presentationContentInteraction(.scrolls)
            }
    }
}

extension View {
    func emberInAppBrowser(onAskAboutPage: ((URL) -> Void)? = nil) -> some View {
        modifier(EmberInAppBrowserModifier(onAskAboutPage: onAskAboutPage))
    }
}
