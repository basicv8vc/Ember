import Foundation

@MainActor
final class NativeDeviceAdapter {
    let deviceID: UUID
    private let state: LocalDeviceState
    private let client: LocalDeviceClient
    private let workDelay: Duration
    private let clock = ContinuousClock()
    private let heartbeatInterval: Duration = .seconds(10)

    init(configuration: LocalDeviceConfiguration) throws {
        let state = try LocalDeviceState(configuration: configuration)
        let credential = try state.loadOrCreateCredential()
        self.state = state
        self.client = LocalDeviceClient(configuration: configuration, credential: credential)
        self.deviceID = credential.id
        self.workDelay = configuration.workDelay
    }

    func run(report: (String) -> Void) async {
        while !Task.isCancelled {
            do {
                try await runForeground(report: report)
            } catch is CancellationError {
                return
            } catch let error as LocalDeviceError {
                guard !Task.isCancelled else { return }
                report(error.status)
                if !error.canRetry { return }
            } catch let error as URLError {
                guard !Task.isCancelled else { return }
                report("waiting for local runtime (URL error \(error.code.rawValue))")
            } catch {
                guard !Task.isCancelled else { return }
                report(LocalDeviceError.unavailableStorage.status)
                return
            }
            do {
                try await clock.sleep(for: .seconds(1))
            } catch {
                return
            }
        }
    }

    private func runForeground(report: (String) -> Void) async throws {
        try await client.register()
        report("ready device=\(deviceID.uuidString.lowercased())")
        var heartbeatAt = clock.now.advanced(by: heartbeatInterval)
        while !Task.isCancelled {
            if clock.now >= heartbeatAt {
                try await client.register()
                heartbeatAt = clock.now.advanced(by: heartbeatInterval)
            }
            if let pending = try state.loadPending() {
                try await commit(pending, report: report)
                continue
            }
            guard let offer = try await client.claim() else {
                try await clock.sleep(for: .seconds(1))
                continue
            }
            let task = offer.taskId.uuidString.lowercased()
            report("claimed task=\(task) run=\(offer.runId.uuidString.lowercased()) epoch=\(offer.leaseEpoch)")
            guard try await maintainLease(for: offer, report: report) else { continue }
            try Task.checkCancellation()
            let pending = LocalDevicePendingResult(
                taskID: offer.taskId,
                submission: .init(fence: offer.fence, output: NativeTextStats(text: offer.input.text))
            )
            try state.savePending(pending)
            report("result staged task=\(task) epoch=\(offer.leaseEpoch)")
            try await commit(pending, report: report)
        }
    }

    private func maintainLease(
        for offer: LocalDeviceOffer,
        report: (String) -> Void
    ) async throws -> Bool {
        let workAt = clock.now.advanced(by: workDelay)
        var renewAt = clock.now.advanced(by: heartbeatInterval)
        while renewAt <= workAt {
            try await clock.sleep(until: renewAt)
            try await client.register()
            guard let expiration = try await client.renew(offer) else {
                report("lease fenced task=\(offer.taskId.uuidString.lowercased()) epoch=\(offer.leaseEpoch)")
                return false
            }
            report("renewed task=\(offer.taskId.uuidString.lowercased()) epoch=\(offer.leaseEpoch) until=\(expiration)")
            renewAt = renewAt.advanced(by: heartbeatInterval)
        }
        try await clock.sleep(until: workAt)
        return true
    }

    private func commit(_ pending: LocalDevicePendingResult, report: (String) -> Void) async throws {
        let result = try await state.submitPending(pending, using: client.commit)
        let task = pending.taskID.uuidString.lowercased()
        switch result {
        case .committed(let replayed):
            report("committed task=\(task) epoch=\(pending.submission.leaseEpoch) replayed=\(replayed)")
        case .fenced:
            report("result fenced task=\(task) epoch=\(pending.submission.leaseEpoch)")
        }
    }
}
