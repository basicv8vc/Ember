import Foundation

struct TaskRecoverySnapshot: Equatable, Sendable {
  let task: TaskDTO
  let events: [TaskEventDTO]
  let lastConfirmedSequence: Int
  let presentationState: TaskPresentationState
}

/// Internal coordinator for the independent server, connection, command, and capability
/// dimensions. Features continue to depend on the frozen TaskRepositoryProtocol only.
actor TaskStateCoordinator {
  private let repository: MockTaskAPIRepository
  private let resumeIndexStore: TaskResumeIndexStore?
  private var taskStatus: TaskStatus?
  private var connectionPhase: ConnectionPhase = .idle
  private var commandInFlight: TaskCommandInFlight?
  private let capability: TaskExecutionCapability = .mockOnly
  private var resumeTaskID: UUID?
  private var lastConfirmedSequence: Int

  init(
    repository: MockTaskAPIRepository,
    resumeIndexStore: TaskResumeIndexStore? = nil,
    initialIndex: TaskResumeIndex? = nil
  ) {
    self.repository = repository
    self.resumeIndexStore = resumeIndexStore
    let resumeIndex = initialIndex ?? resumeIndexStore?.load()
    self.resumeTaskID = resumeIndex?.taskID
    self.lastConfirmedSequence = resumeIndex?.lastConfirmedSequence ?? 0
  }

  func presentationState() -> TaskPresentationState {
    TaskPresentationState(
      taskStatus: taskStatus,
      connectionPhase: connectionPhase,
      commandInFlight: commandInFlight,
      capability: capability
    )
  }

  func createTask(
    _ request: CreateTaskRequestDTO,
    idempotencyKey: String
  ) async throws -> TaskReceiptDTO {
    commandInFlight = .creatingTask
    defer { commandInFlight = nil }
    return try await repository.createTask(request, idempotencyKey: idempotencyKey)
  }

  /// Reconcile server truth after launch, reconnect, or any uncertain stream ending.
  /// Snapshot status is authoritative; events advance only the confirmed cursor.
  func recover(taskID: UUID) async throws -> TaskRecoverySnapshot {
    prepareResumeCursor(for: taskID)
    connectionPhase = .connecting
    do {
      return try await reconcile(taskID: taskID, alreadyObserved: [])
    } catch {
      connectionPhase = .disconnected
      throw error
    }
  }

  /// Consume one SSE connection. If it ends or fails, fetch the authoritative snapshot
  /// and page all events after the last validated cursor before reporting connected again.
  func consumeAndRecover(taskID: UUID) async throws -> TaskRecoverySnapshot {
    prepareResumeCursor(for: taskID)
    connectionPhase = .connecting
    var observed: [TaskEventDTO] = []
    do {
      for try await event in repository.streamTaskEvents(
        taskID: taskID, after: lastConfirmedSequence)
      {
        observed.append(event)
        lastConfirmedSequence = event.sequence
        persistResumeIndex(taskID: taskID)
      }
    } catch {
      // Keep the last server status. The cursor has advanced only for validated events.
      connectionPhase = .disconnected
    }

    do {
      return try await reconcile(taskID: taskID, alreadyObserved: observed)
    } catch {
      connectionPhase = .disconnected
      throw error
    }
  }

  /// A 202 cancel response records an in-flight command and its server-reported status;
  /// it never turns a running task into cancelled locally.
  func cancel(taskID: UUID) async throws -> TaskCancelDTO {
    prepareResumeCursor(for: taskID)
    commandInFlight = .cancellingTask
    defer { commandInFlight = nil }
    do {
      let response = try await repository.cancelTask(id: taskID)
      taskStatus = response.status
      return response
    } catch {
      throw error
    }
  }

  private func reconcile(
    taskID: UUID,
    alreadyObserved: [TaskEventDTO]
  ) async throws -> TaskRecoverySnapshot {
    connectionPhase = .connecting
    var newlyConfirmed = alreadyObserved
    let snapshot = try await repository.fetchTask(id: taskID)
    taskStatus = snapshot.status

    while true {
      let page = try await repository.fetchEvents(taskID: taskID, after: lastConfirmedSequence)
      guard page.events.count <= 100 else {
        throw TaskAPIRepositoryError.invalidResponse
      }
      if page.events.isEmpty {
        break
      }

      let oldCursor = lastConfirmedSequence
      for event in page.events {
        // fetchEvents validates task association, order, and contiguous sequence
        // before returning. Commit only these complete DTOs.
        lastConfirmedSequence = event.sequence
        newlyConfirmed.append(event)
      }
      guard lastConfirmedSequence > oldCursor else {
        throw TaskAPIRepositoryError.noCursorProgress
      }
      persistResumeIndex(taskID: taskID)
      if page.events.count < 100 {
        break
      }
    }

    connectionPhase = .connected
    return TaskRecoverySnapshot(
      task: snapshot,
      events: newlyConfirmed,
      lastConfirmedSequence: lastConfirmedSequence,
      presentationState: currentPresentationState()
    )
  }

  private func persistResumeIndex(taskID: UUID) {
    guard let resumeIndexStore,
      let index = try? TaskResumeIndex(
        taskID: taskID,
        lastConfirmedSequence: lastConfirmedSequence
      )
    else {
      return
    }
    // Losing this non-sensitive convenience index must not falsify server state.
    try? resumeIndexStore.save(index)
  }

  private func prepareResumeCursor(for taskID: UUID) {
    guard resumeTaskID != taskID else { return }
    resumeTaskID = taskID
    lastConfirmedSequence = 0
    taskStatus = nil
  }

  private func currentPresentationState() -> TaskPresentationState {
    TaskPresentationState(
      taskStatus: taskStatus,
      connectionPhase: connectionPhase,
      commandInFlight: commandInFlight,
      capability: capability
    )
  }
}
