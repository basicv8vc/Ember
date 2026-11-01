import Foundation
import Observation

struct TaskComposePendingRequest: Equatable {
    let content: String
    let idempotencyKey: String
}

struct TaskComposeSubmissionAttempt: Equatable {
    let request: TaskComposePendingRequest
    let simulateUnknownReceipt: Bool
}

enum TaskComposeSubmissionFailure: Equatable {
    case idempotencyConflict
    case repositoryUnavailable
    case rejected

    var message: String {
        switch self {
        case .idempotencyConflict:
            "提交失败：这段内容与先前的提交冲突。笔记已保留且可编辑；检查后重新提交。"
        case .repositoryUnavailable:
            "本机模拟暂不可用。笔记已保留且可编辑，请稍后重试。"
        case .rejected:
            "提交失败。笔记已保留且可编辑；修改后重新提交。"
        }
    }
}

enum TaskComposeSubmissionState: Equatable {
    case idle
    case submitting(TaskComposePendingRequest)
    case unknownAcknowledgement(TaskComposePendingRequest)
    case definiteFailure(TaskComposeSubmissionFailure)
    case accepted(TaskReceiptDTO)
}

private enum TaskComposeErrorDisposition {
    case unknownAcknowledgement
    case definiteFailure(TaskComposeSubmissionFailure)
}

@MainActor
@Observable
final class TaskComposeSubmissionModel {
    var draft = ""
    private(set) var state: TaskComposeSubmissionState = .idle

    @ObservationIgnored
    private let makeIdempotencyKey: () -> String

    init(makeIdempotencyKey: @escaping () -> String = { UUID().uuidString }) {
        self.makeIdempotencyKey = makeIdempotencyKey
    }

    var isSubmitting: Bool {
        if case .submitting = state { return true }
        return false
    }

    var isAwaitingReceipt: Bool {
        if case .unknownAcknowledgement = state { return true }
        return false
    }

    var hasDefiniteFailure: Bool {
        if case .definiteFailure = state { return true }
        return false
    }

    var submitButtonTitle: String {
        switch state {
        case .idle:
            "提交模拟任务"
        case .submitting:
            "正在提交"
        case .unknownAcknowledgement:
            "用相同内容和键重试"
        case .definiteFailure:
            "重新提交"
        case .accepted:
            "提交另一项模拟任务"
        }
    }

    var canEditDraft: Bool {
        switch state {
        case .submitting, .unknownAcknowledgement:
            false
        case .idle, .definiteFailure, .accepted:
            true
        }
    }

    var statusMessage: String? {
        switch state {
        case .unknownAcknowledgement:
            "尚未确认：回执未能确认请求结果。草稿与幂等键已保留；重试将使用相同内容和键。"
        case let .definiteFailure(failure):
            failure.message
        case .idle, .submitting, .accepted:
            nil
        }
    }

    func beginSubmission(simulateUnknownReceipt: Bool) -> TaskComposeSubmissionAttempt? {
        switch state {
        case .submitting:
            return nil

        case let .unknownAcknowledgement(request):
            // An ambiguous ACK can only retry the frozen request, with its original key.
            draft = request.content
            state = .submitting(request)
            return TaskComposeSubmissionAttempt(request: request, simulateUnknownReceipt: false)

        case .idle, .definiteFailure, .accepted:
            guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let request = TaskComposePendingRequest(content: draft, idempotencyKey: makeIdempotencyKey())
            state = .submitting(request)
            return TaskComposeSubmissionAttempt(
                request: request,
                simulateUnknownReceipt: simulateUnknownReceipt
            )
        }
    }

    func finishSubmission(
        _ attempt: TaskComposeSubmissionAttempt,
        in session: TaskJourneySession,
        onReceipt: (TaskReceiptDTO) -> Void
    ) async {
        guard case let .submitting(request) = state, request == attempt.request else { return }

        do {
            let receipt = try await session.createNoteTask(
                note: request.content,
                idempotencyKey: request.idempotencyKey,
                simulateUnknownReceipt: attempt.simulateUnknownReceipt
            )
            state = .accepted(receipt)
            draft = ""
            onReceipt(receipt)
        } catch TaskJourneyDemoError.receiptUnknown {
            draft = request.content
            state = .unknownAcknowledgement(request)
        } catch {
            // Do not surface localizedDescription: repository errors can contain request data.
            draft = request.content
            switch Self.classify(error) {
            case .unknownAcknowledgement:
                state = .unknownAcknowledgement(request)
            case let .definiteFailure(failure):
                state = .definiteFailure(failure)
            }
        }
    }

    private static func classify(_ error: any Error) -> TaskComposeErrorDisposition {
        if let demoError = error as? TaskJourneyDemoError {
            switch demoError {
            case .repositoryUnavailable:
                return .definiteFailure(.repositoryUnavailable)
            case .receiptUnknown:
                return .unknownAcknowledgement
            }
        }

        if let repositoryError = error as? FakeTaskRepositoryError {
            switch repositoryError {
            case .idempotencyConflict:
                return .definiteFailure(.idempotencyConflict)
            case .receiptFixtureMissing, .requestEncodingFailed:
                return .definiteFailure(.repositoryUnavailable)
            case .taskNotFound:
                return .unknownAcknowledgement
            }
        }

        if let repositoryError = error as? TaskAPIRepositoryError {
            switch repositoryError {
            case .mockEndpointRequired, .invalidRequest, .invalidIdempotencyKey, .invalidCursor:
                // These are local/preflight failures that occur before a create request is sent.
                return .definiteFailure(.repositoryUnavailable)
            case .idempotencyConflict:
                return .definiteFailure(.idempotencyConflict)
            case .badRequest, .unauthenticated, .forbidden, .notFound, .conflict, .rateLimited:
                // A typed 4xx response is an explicit server rejection.
                return .definiteFailure(.rejected)
            case let .unexpectedStatus(status) where (400..<500).contains(status) && status != 408:
                return .definiteFailure(.rejected)
            default:
                // Transport errors, 5xx, invalid receipts, and unknown repository failures
                // do not establish whether the create was accepted.
                return .unknownAcknowledgement
            }
        }

        return .unknownAcknowledgement
    }
}
