import Foundation

struct ServerSentEventFrame: Equatable, Sendable {
  let event: String
  let id: String?
  let data: String
}

/// Incremental SSE framing. Bytes are retained until a complete line arrives, so a UTF-8
/// scalar split across URLSession chunks is decoded only after all of its bytes are present.
struct ServerSentEventParser {
  private static let maximumEventBytes = 64 * 1024
  private var lineBytes: [UInt8] = []
  private var frameBytes = 0
  private var eventName: String?
  private var eventID: String?
  private var dataLines: [String] = []
  private var hasDataField = false

  mutating func append(_ chunk: Data) throws -> [ServerSentEventFrame] {
    var frames: [ServerSentEventFrame] = []
    for byte in chunk {
      frames.append(contentsOf: try append(byte))
    }
    return frames
  }

  mutating func append(_ byte: UInt8) throws -> [ServerSentEventFrame] {
    frameBytes += 1
    guard frameBytes <= Self.maximumEventBytes else {
      throw TaskAPIRepositoryError.invalidResponse
    }
    guard byte == 0x0a else {
      lineBytes.append(byte)
      guard lineBytes.count <= Self.maximumEventBytes else {
        throw TaskAPIRepositoryError.invalidResponse
      }
      return []
    }

    if lineBytes.last == 0x0d {
      lineBytes.removeLast()
    }
    let completeLine = lineBytes
    lineBytes.removeAll(keepingCapacity: true)

    guard !completeLine.isEmpty else {
      guard hasDataField else {
        resetFrame()
        return []
      }
      let frame = ServerSentEventFrame(
        event: eventName ?? "message",
        id: eventID,
        data: dataLines.joined(separator: "\n")
      )
      resetFrame()
      return [frame]
    }

    // SSE comments are heartbeats. They do not alter frame data or the resume cursor.
    if completeLine.first == 0x3a {
      return []
    }

    guard let line = String(bytes: completeLine, encoding: .utf8) else {
      throw TaskAPIRepositoryError.invalidResponse
    }
    let separator = line.firstIndex(of: ":")
    let field: String
    var value: String
    if let separator {
      field = String(line[..<separator])
      value = String(line[line.index(after: separator)...])
      if value.first == " " {
        value.removeFirst()
      }
    } else {
      field = line
      value = ""
    }

    switch field {
    case "event":
      eventName = value
    case "id":
      // The SSE spec ignores IDs containing NUL. Such a frame will then fail the
      // task-event requirement for an explicit numeric ID.
      if !value.contains("\0") {
        eventID = value
      }
    case "data":
      hasDataField = true
      dataLines.append(value)
    default:
      // retry and extension fields do not carry task state.
      break
    }
    return []
  }

  private mutating func resetFrame() {
    eventName = nil
    eventID = nil
    dataLines.removeAll(keepingCapacity: true)
    hasDataField = false
    frameBytes = 0
  }
}

struct TaskEventStreamValidator {
  private let taskID: UUID
  private(set) var lastConfirmedSequence: Int
  private var lastObservedSequence: Int?

  init(taskID: UUID, lastConfirmedSequence: Int) {
    self.taskID = taskID
    self.lastConfirmedSequence = lastConfirmedSequence
  }

  mutating func consume(_ frame: ServerSentEventFrame) throws -> TaskEventDTO? {
    guard frame.event == "task",
      let rawID = frame.id,
      !rawID.isEmpty,
      rawID.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
      let eventID = Int(rawID)
    else {
      throw TaskAPIRepositoryError.invalidResponse
    }

    let event: TaskEventDTO
    do {
      event = try JSONDecoder().decode(TaskEventDTO.self, from: Data(frame.data.utf8))
    } catch {
      throw TaskAPIRepositoryError.invalidResponse
    }
    guard event.taskID == taskID else {
      throw TaskAPIRepositoryError.taskMismatch
    }
    guard eventID == event.sequence else {
      throw TaskAPIRepositoryError.invalidResponse
    }

    if let lastObservedSequence, event.sequence < lastObservedSequence {
      throw TaskAPIRepositoryError.eventOutOfOrder
    }
    lastObservedSequence = event.sequence

    if event.sequence <= lastConfirmedSequence {
      return nil
    }
    guard TaskEventCursorBounds.contains(event.sequence),
      lastConfirmedSequence < TaskEventCursorBounds.maximum
    else {
      throw TaskAPIRepositoryError.invalidCursor
    }
    let expected = lastConfirmedSequence + 1
    guard event.sequence == expected else {
      throw TaskAPIRepositoryError.eventSequenceGap(expected: expected, received: event.sequence)
    }
    lastConfirmedSequence = event.sequence
    return event
  }
}
