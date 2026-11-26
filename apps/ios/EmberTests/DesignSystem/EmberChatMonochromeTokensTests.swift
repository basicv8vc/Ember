import SwiftUI
import UIKit
import XCTest
@testable import Ember

@MainActor
final class EmberChatMonochromeTokensTests: XCTestCase {
    func testMessageAndActionContrastInLightAndDarkMode() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let foreground = UIColor.label.resolvedColor(with: traits)
            let user = resolved(EmberDesignTokens.chatUserBubble, traits: traits)
            let agent = resolved(EmberDesignTokens.chatAgentBubble, traits: traits)
            let action = resolved(EmberDesignTokens.chatActionFill, traits: traits)
            let actionText = resolved(EmberDesignTokens.chatActionForeground, traits: traits)

            XCTAssertGreaterThanOrEqual(
                contrastRatio(foreground, user), 4.5,
                "User text contrast must remain readable in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(foreground, agent), 4.5,
                "Ember text contrast must remain readable in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(actionText, action), 4.5,
                "Send icon must remain readable in \(style)"
            )
            XCTAssertGreaterThan(
                abs(relativeLuminance(user) - relativeLuminance(agent)), 0.01,
                "User and Ember turns need subtly different surfaces"
            )
        }
    }

    func testCanvasAdaptsToSystemAppearance() {
        let light = resolved(
            EmberDesignTokens.chatCanvas,
            traits: UITraitCollection(userInterfaceStyle: .light)
        )
        let dark = resolved(
            EmberDesignTokens.chatCanvas,
            traits: UITraitCollection(userInterfaceStyle: .dark)
        )
        XCTAssertGreaterThan(relativeLuminance(light), 0.9)
        XCTAssertLessThan(relativeLuminance(dark), 0.02)
    }

    func testSharedVisualV1SurfaceHierarchyAndContrast() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let foreground = UIColor.label.resolvedColor(with: traits)
            let paper = resolved(EmberDesignTokens.surfacePaper, traits: traits)
            let subtle = resolved(EmberDesignTokens.surfaceSubtle, traits: traits)
            let hairline = resolved(EmberDesignTokens.surfaceHairline, traits: traits)
            let actionFill = resolved(EmberDesignTokens.primaryActionFill, traits: traits)
            let actionForeground = resolved(EmberDesignTokens.primaryActionForeground, traits: traits)

            XCTAssertGreaterThanOrEqual(
                contrastRatio(foreground, paper), 4.5,
                "Card body text contrast must remain readable on surfacePaper in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(foreground, subtle), 4.5,
                "Nested well text contrast must remain readable on surfaceSubtle in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(actionForeground, actionFill), 4.5,
                "Primary monochrome CTA contrast must remain readable in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(paper, subtle), 1.1,
                "Nested wells must remain visually distinct from paper cards in \(style)"
            )
            XCTAssertGreaterThanOrEqual(
                contrastRatio(paper, hairline), 1.25,
                "Card hairlines must remain visible against paper cards in \(style)"
            )
        }
    }

    private func resolved(_ color: Color, traits: UITraitCollection) -> UIColor {
        UIColor(color).resolvedColor(with: traits)
    }

    private func contrastRatio(_ a: UIColor, _ b: UIColor) -> Double {
        let values = [relativeLuminance(a), relativeLuminance(b)].sorted()
        return (values[1] + 0.05) / (values[0] + 0.05)
    }

    private func relativeLuminance(_ color: UIColor) -> Double {
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(color.getRed(&r, green: &g, blue: &b, alpha: &alpha))
        func linear(_ value: CGFloat) -> Double {
            let value = Double(value)
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
}
