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
