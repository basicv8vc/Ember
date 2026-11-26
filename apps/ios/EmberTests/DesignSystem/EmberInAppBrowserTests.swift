import Foundation
import SwiftUI
import XCTest
@testable import Ember

final class EmberInAppBrowserTests: XCTestCase {
    func testPolicyAcceptsHTTPAndHTTPSWithHost() {
        let httpsURL = URL(string: "https://example.com/path?q=1")!
        let httpURL = URL(string: "http://docs.example.org")!

        XCTAssertEqual(EmberInAppBrowserPolicy.webURL(from: httpsURL), httpsURL)
        XCTAssertEqual(EmberInAppBrowserPolicy.webURL(from: httpURL), httpURL)
    }

    func testPolicyRejectsNonWebSchemesAndEmptyHosts() {
        let rejected = [
            "mailto:hello@example.com",
            "tel:+15551234567",
            "javascript:alert(1)",
            "file:///tmp/test.html",
            "https://",
        ]

        for raw in rejected {
            let url = URL(string: raw)!
            XCTAssertNil(EmberInAppBrowserPolicy.webURL(from: url), "Expected \(raw) to be rejected")
        }
    }

    func testLinkDetectorFastPathReturnsNilWhenNoURLPresent() {
        XCTAssertNil(EmberLinkDetector.linkifiedPlainText(for: "帮我总结一下今天的待办事项"))
        XCTAssertNil(EmberLinkDetector.linkifiedPlainText(for: "Hello Ember, how are you?"))
    }

    func testLinkDetectorLinkifiesBareURLsAndUpgradesWWW() {
        let linked = EmberLinkDetector.linkifiedPlainText(for: "Check https://openai.com and www.apple.com please")
        XCTAssertNotNil(linked)
        let urls = linked!.runs.compactMap(\.link)
        XCTAssertEqual(urls, [
            URL(string: "https://openai.com")!,
            URL(string: "https://www.apple.com")!,
        ])
    }

    func testEnhanceLinksPreservesMarkdownLinksAndAddsBareURLs() {
        let raw = "Read [Ember Docs](https://ember.example.com) or visit https://example.org directly."
        let parsed = ConversationCardFormatting.attributedMarkdown(for: raw, useCache: false)
        XCTAssertNotNil(parsed)

        let linkedRuns = parsed!.runs.filter { $0.link != nil }
        XCTAssertEqual(linkedRuns.map(\.link), [
            URL(string: "https://ember.example.com")!,
            URL(string: "https://example.org")!,
        ])
        XCTAssertTrue(linkedRuns.allSatisfy { $0.underlineStyle == .single })
    }
}
