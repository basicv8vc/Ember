import SwiftUI

@MainActor
enum AppCompositionRoot {
    static func makeRootView() -> some View {
        FoundationLaunchView()
    }
}
