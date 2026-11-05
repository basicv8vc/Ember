import CryptoKit
import Foundation
import Security

/// A fresh, cryptographically secure Sign in with Apple nonce and its SHA-256 representation.
///
/// Apple's authorization request receives `hashedValue`; the Ember backend receives `rawValue`
/// (ADR-0004 annex §5.2, "nonce hash matches"). Both are assertion material, so neither is ever
/// printed: `description`, `debugDescription` and `Mirror` are redacted.
///
/// `issuedAt` and `lifetime` exist so a late callback can be rejected on a bounded clock rather
/// than trusted because it arrived.
public struct AppleNonce: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable
{
    /// The value sent to the Ember backend, never to Apple.
    public let rawValue: String
    /// Lower-case hex SHA-256 of `rawValue`, sent to Apple.
    public let hashedValue: String
    /// When this nonce was minted.
    public let issuedAt: Date
    /// How long an authorization may take before this nonce is no longer acceptable.
    public let lifetime: TimeInterval

    init(rawValue: String, hashedValue: String, issuedAt: Date, lifetime: TimeInterval) {
        self.rawValue = rawValue
        self.hashedValue = hashedValue
        self.issuedAt = issuedAt
        self.lifetime = lifetime
    }

    /// The instant after which a callback carrying this nonce is refused.
    public var expiresAt: Date {
        issuedAt.addingTimeInterval(lifetime)
    }

    /// Whether this nonce may still be presented to the backend at `date`.
    public func isValid(at date: Date) -> Bool {
        date >= issuedAt && date <= expiresAt
    }

    public var description: String {
        "AppleNonce(raw: <redacted>, hash: <redacted>, lifetime: \(Int(lifetime))s)"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        let children: [(label: String?, value: Any)] = [
            (label: "rawValue", value: "<redacted>"),
            (label: "hashedValue", value: "<redacted>"),
            (label: "issuedAt", value: issuedAt),
            (label: "lifetime", value: lifetime),
        ]
        return Mirror(self, children: children, displayStyle: .struct)
    }
}

/// Injectable source of cryptographically secure random bytes.
///
/// The live implementation uses `SecRandomCopyBytes`; tests inject a deterministic source so
/// nonce uniqueness and hashing can be asserted without reading from the system RNG.
public protocol SecureRandomByteSource: Sendable {
    func randomBytes(count: Int) throws -> Data
}

public enum SecureRandomFailure: Error, Equatable, Sendable {
    case unavailable
    case invalidLength
}

/// `SecRandomCopyBytes`-backed source. This is the only production random source in L1.
public struct SystemSecureRandomByteSource: SecureRandomByteSource {
    public init() {}

    public func randomBytes(count: Int) throws -> Data {
        guard count > 0 else { throw SecureRandomFailure.invalidLength }

        var bytes = [UInt8](repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer -> Int32 in
            guard let base = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, count, base)
        }

        guard status == errSecSuccess else { throw SecureRandomFailure.unavailable }
        return Data(bytes)
    }
}

/// Mints `AppleNonce` values. The raw nonce is 32 CSPRNG bytes rendered as lower-case hex,
/// which is 256 bits of entropy and already restricted to the unreserved charset, so it needs no
/// transport encoding before it is placed in a JSON string.
public enum AppleNonceGenerator {
    /// 32 bytes = 256 bits, matching the session-token entropy requirement in annex §5.1 I-5.
    public static let byteCount = 32
    /// Default bound for one authorization round trip. Apple's sheet is dismissed long before this.
    public static let defaultLifetime: TimeInterval = 300

    public static func make(
        source: SecureRandomByteSource = SystemSecureRandomByteSource(),
        now: Date,
        lifetime: TimeInterval = defaultLifetime
    ) throws -> AppleNonce {
        let bytes = try source.randomBytes(count: byteCount)
        let raw = hexString(bytes)
        return AppleNonce(
            rawValue: raw,
            hashedValue: sha256Hex(raw),
            issuedAt: now,
            lifetime: lifetime
        )
    }

    /// Lower-case hex SHA-256 of the UTF-8 encoding of `value`.
    public static func sha256Hex(_ value: String) -> String {
        hexString(Data(SHA256.hash(data: Data(value.utf8))))
    }

    private static func hexString<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
        let digits: [Character] = Array("0123456789abcdef")
        var output = ""
        output.reserveCapacity((bytes.underestimatedCount) * 2)
        for byte in bytes {
            output.append(digits[Int(byte >> 4)])
            output.append(digits[Int(byte & 0x0F)])
        }
        return output
    }
}
