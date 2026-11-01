import Foundation

/// Matches the current API's decimal cursor grammar and JavaScript safe integer boundary.
enum TaskEventCursorBounds {
  static let maximum = 999_999_999_999_999

  static func contains(_ sequence: Int) -> Bool {
    (0...maximum).contains(sequence)
  }
}
