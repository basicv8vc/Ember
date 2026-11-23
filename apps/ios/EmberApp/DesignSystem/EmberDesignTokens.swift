import SwiftUI

enum EmberDesignTokens {
    static let cardCornerRadius: CGFloat = 20
    static let noticeCornerRadius: CGFloat = 16
    static let compactSpacing: CGFloat = 8
    static let standardSpacing: CGFloat = 16
    static let generousSpacing: CGFloat = 24

    static let groupedBackground = Color(uiColor: .systemGroupedBackground)
    static let cardBackground = Color(uiColor: .secondarySystemGroupedBackground)
    static let separator = Color.primary.opacity(0.1)

    static let minTapTarget: CGFloat = 44

    // Visual V1: neutral, adaptive Chat-only surfaces. Deliberately scoped so existing
    // Tasks, Memory and Schedules retain their behavior until their focused visual pass.
    static let chatCanvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.067, green: 0.067, blue: 0.067, alpha: 1)
            : UIColor(red: 0.980, green: 0.980, blue: 0.980, alpha: 1)
    })

    static let chatPaper = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.125, green: 0.125, blue: 0.125, alpha: 1)
            : .white
    })

    static let chatAgentBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.161, green: 0.161, blue: 0.161, alpha: 1)
            : UIColor(red: 0.953, green: 0.953, blue: 0.953, alpha: 1)
    })

    static let chatUserBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.220, green: 0.220, blue: 0.220, alpha: 1)
            : UIColor(red: 0.914, green: 0.914, blue: 0.914, alpha: 1)
    })

    static let chatHairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.270, green: 0.270, blue: 0.270, alpha: 1)
            : UIColor(red: 0.885, green: 0.885, blue: 0.885, alpha: 1)
    })

    static let chatActionFill = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.96, green: 0.96, blue: 0.96, alpha: 1)
            : UIColor(red: 0.09, green: 0.09, blue: 0.09, alpha: 1)
    })

    static let chatActionForeground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .black : .white
    })

    static let chatBrandInk = Color.primary


    static let emberMarkTint = Color(
        uiColor: UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark
                ? UIColor(red: 0.91, green: 0.53, blue: 0.29, alpha: 1.0)
                : UIColor(red: 0.78, green: 0.39, blue: 0.16, alpha: 1.0)
        }
    )

    static let emberSoftSurface = Color(
        uiColor: UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark
                ? UIColor(red: 0.91, green: 0.53, blue: 0.29, alpha: 0.16)
                : UIColor(red: 0.78, green: 0.39, blue: 0.16, alpha: 0.10)
        }
    )

    static let mockPillForeground = Color(
        uiColor: UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark
                ? UIColor(red: 0.99, green: 0.73, blue: 0.45, alpha: 1.0)
                : UIColor(red: 0.60, green: 0.24, blue: 0.04, alpha: 1.0)
        }
    )
}

extension TaskStatus {
    var designSystemLabel: LocalizedStringKey {
        switch self {
        case .queued: "status.queued"
        case .running: "status.running"
        case .waitingApproval: "status.waiting_approval"
        case .retryableFailed: "status.retryable_failed"
        case .completed: "status.completed"
        case .failed: "status.failed"
        case .cancelled: "status.cancelled"
        }
    }

    var designSystemSymbol: String {
        switch self {
        case .queued: "clock"
        case .running: "gearshape.2"
        case .waitingApproval: "hand.raised"
        case .retryableFailed: "arrow.clockwise"
        case .completed: "checkmark.circle"
        case .failed: "xmark.circle"
        case .cancelled: "minus.circle"
        }
    }

    var designSystemColor: Color {
        switch self {
        case .queued: Color(uiColor: .systemBlue)
        case .running: Color(uiColor: .systemIndigo)
        case .waitingApproval: Color(uiColor: .systemOrange)
        case .retryableFailed: Color(uiColor: .systemBrown)
        case .completed: Color(uiColor: .systemGreen)
        case .failed: Color(uiColor: .systemRed)
        case .cancelled: Color(uiColor: .secondaryLabel)
        }
    }
}

extension TaskEventPhase {
    var designSystemLabel: LocalizedStringKey {
        switch self {
        case .accepted: "activity.accepted"
        case .leased: "activity.leased"
        case .started: "activity.started"
        case .progress: "activity.progress"
        case .waitingApproval: "activity.waiting_approval"
        case .approvalGranted: "activity.approval_granted"
        case .approvalDenied: "activity.approval_denied"
        case .retryScheduled: "activity.retry_scheduled"
        case .completed: "activity.completed"
        case .failed: "activity.failed"
        case .cancelled: "activity.cancelled"
        }
    }

    var designSystemSymbol: String {
        switch self {
        case .accepted: "tray.and.arrow.down"
        case .leased: "person.crop.circle.badge.checkmark"
        case .started: "play.circle"
        case .progress: "text.alignleft"
        case .waitingApproval: "hand.raised"
        case .approvalGranted: "checkmark.seal"
        case .approvalDenied: "xmark.seal"
        case .retryScheduled: "arrow.clockwise.circle"
        case .completed: "checkmark.circle"
        case .failed: "xmark.circle"
        case .cancelled: "minus.circle"
        }
    }

    var designSystemColor: Color {
        switch self {
        case .accepted, .leased: Color(uiColor: .systemBlue)
        case .started, .progress: Color(uiColor: .systemIndigo)
        case .waitingApproval: Color(uiColor: .systemOrange)
        case .approvalGranted, .completed: Color(uiColor: .systemGreen)
        case .approvalDenied, .failed: Color(uiColor: .systemRed)
        case .retryScheduled: Color(uiColor: .systemBrown)
        case .cancelled: Color(uiColor: .secondaryLabel)
        }
    }
}
