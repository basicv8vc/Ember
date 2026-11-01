import Foundation

/// The only task data this local resume store accepts: a task identifier and last validated
/// event cursor. It has no field capable of carrying a prompt, note, result, or credential.
public struct TaskResumeIndex: Codable, Equatable, Sendable {
  public let taskID: UUID
  public let lastConfirmedSequence: Int

  public init(taskID: UUID, lastConfirmedSequence: Int) throws {
    guard TaskEventCursorBounds.contains(lastConfirmedSequence) else {
      throw TaskResumeIndexStoreError.invalidSequence
    }
    self.taskID = taskID
    self.lastConfirmedSequence = lastConfirmedSequence
  }
}

public enum TaskResumeIndexStoreError: Error, Equatable {
  case invalidSequence
  case encodingFailed
}

/// Stores one minimal, same-installation resume pointer. It does not make a claim about
/// restoring task history after app deletion, reinstall, device migration, or backup restore.
public final class TaskResumeIndexStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private let storageKey: String

  public init(defaults: UserDefaults = .standard, storageKey: String = "ember.task.resume-index.v1")
  {
    self.defaults = defaults
    self.storageKey = storageKey
  }

  public func save(_ index: TaskResumeIndex) throws {
    guard TaskEventCursorBounds.contains(index.lastConfirmedSequence) else {
      throw TaskResumeIndexStoreError.invalidSequence
    }
    do {
      defaults.set(try JSONEncoder().encode(index), forKey: storageKey)
    } catch {
      throw TaskResumeIndexStoreError.encodingFailed
    }
  }

  public func load() -> TaskResumeIndex? {
    guard let data = defaults.data(forKey: storageKey),
      let index = try? JSONDecoder().decode(TaskResumeIndex.self, from: data),
      TaskEventCursorBounds.contains(index.lastConfirmedSequence)
    else {
      return nil
    }
    return index
  }

  public func clear() {
    defaults.removeObject(forKey: storageKey)
  }
}
