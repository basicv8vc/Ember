import SwiftUI

/// A short, mock-only explanation of Ember's Promise → Progress → Outcome experience.
public struct WelcomeOnboardingView: View {
    private let onViewDemo: () -> Void

    public init(onViewDemo: @escaping () -> Void) {
        self.onViewDemo = onViewDemo
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EmberDesignTokens.generousSpacing) {
                HStack(spacing: 10) {
                    Image(systemName: "sparkle")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)

                    Text("onboarding.brand")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("onboarding.title")
                        .font(.largeTitle.weight(.bold))
                        .fixedSize(horizontal: false, vertical: true)

                    Text("onboarding.subtitle")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 12) {
                    OnboardingStepRow(
                        symbol: "tray.and.arrow.down",
                        title: "onboarding.promise_title",
                        message: "onboarding.promise_message"
                    )
                    OnboardingStepRow(
                        symbol: "waveform.path",
                        title: "onboarding.progress_title",
                        message: "onboarding.progress_message"
                    )
                    OnboardingStepRow(
                        symbol: "checkmark.seal",
                        title: "onboarding.outcome_title",
                        message: "onboarding.outcome_message"
                    )
                }

                InlineNotice(
                    title: "onboarding.cloud_title",
                    message: "onboarding.cloud_message",
                    tone: .warning
                )
            }
            .padding(24)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(EmberDesignTokens.groupedBackground.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                MockOnlyBanner()

                Button(action: onViewDemo) {
                    HStack(spacing: 10) {
                        Image(systemName: "play.fill")
                            .accessibilityHidden(true)
                        Text("onboarding.demo_action")
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderedProminent)

                Text("onboarding.signin_note")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .background(.regularMaterial)
            .overlay(alignment: .top) {
                EmberDesignTokens.separator
                    .frame(height: 1)
            }
        }
        .accessibilityIdentifier("mock-onboarding-screen")
    }
}

private struct OnboardingStepRow: View {
    let symbol: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.1), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EmberDesignTokens.cardBackground, in: RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: EmberDesignTokens.cardCornerRadius)
                .strokeBorder(EmberDesignTokens.separator, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Onboarding · English / Light") {
    WelcomeOnboardingView(onViewDemo: {})
        .environment(\.locale, Locale(identifier: "en"))
}

#Preview("Onboarding · 简体中文 / Dark / Large Type") {
    WelcomeOnboardingView(onViewDemo: {})
        .environment(\.locale, Locale(identifier: "zh-Hans"))
        .environment(\.dynamicTypeSize, .accessibility3)
        .preferredColorScheme(.dark)
}

#Preview("Onboarding · Narrow screen") {
    WelcomeOnboardingView(onViewDemo: {})
        .frame(width: 320)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}
