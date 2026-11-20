import CryptoKit
import Foundation

public enum DeviceSandboxCrypto {
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Manages strictly confined per-task workspaces inside the iOS App Sandbox.
/// Prevents path traversal, symlink escape, active web content output, and uncommitted staging leaks.
public final class DeviceSandboxWorkspace: Sendable {
    public static let allowedOutputMediaTypes: Set<String> = [
        "text/plain",
        "text/markdown",
        "application/json",
        "text/csv",
        "application/pdf",
    ]

    public let rootDirectory: URL
    public let policy: DeviceSandboxPolicy

    public init(rootDirectory: URL? = nil, policy: DeviceSandboxPolicy = .default) {
        if let rootDirectory {
            self.rootDirectory = rootDirectory.standardizedFileURL
        } else {
            let appSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
            self.rootDirectory = appSupport
                .appendingPathComponent("EmberDeviceExecutor", isDirectory: true)
                .standardizedFileURL
        }
        self.policy = policy
    }

    public func taskWorkspaceURL(for taskID: UUID) throws -> URL {
        let dir = workspacesRoot().appendingPathComponent(taskID.uuidString.lowercased(), isDirectory: true)
        try ensureProtectedDirectory(dir)
        return dir.resolvingSymlinksInPath().standardizedFileURL
    }

    public func taskStagingURL(for taskID: UUID) throws -> URL {
        let dir = stagingRoot().appendingPathComponent(taskID.uuidString.lowercased(), isDirectory: true)
        try ensureProtectedDirectory(dir)
        return dir.resolvingSymlinksInPath().standardizedFileURL
    }

    /// Validates filename, media type, path containment, and byte quotas, then atomically writes and
    /// publishes the generated artifact into the task's confined workspace.
    public func publishArtifact(
        taskID: UUID,
        requestedFilename: String,
        mediaType rawMediaType: String,
        data: Data,
        artifactID: UUID = UUID(),
        createdAt: String = DeviceWireDate.format(Date())
    ) throws -> DeviceGeneratedArtifact {
        let normalizedMediaType = B3AttachmentLimits.normalizedMediaType(rawMediaType)
        guard !B3AttachmentLimits.blockedMediaTypes.contains(normalizedMediaType) else {
            throw DeviceExecutorError.blockedMediaType(normalizedMediaType)
        }
        guard Self.allowedOutputMediaTypes.contains(normalizedMediaType) else {
            throw DeviceExecutorError.blockedMediaType(normalizedMediaType)
        }
        guard data.count <= policy.maxGeneratedFileBytes else {
            throw DeviceExecutorError.payloadTooLarge(
                "Generated file '\(requestedFilename)' (\(data.count) bytes) exceeds limit \(policy.maxGeneratedFileBytes)."
            )
        }

        let validatedFilename = try validateSafeRelativeFilename(requestedFilename)
        let workspaceDir = try taskWorkspaceURL(for: taskID)
        let stagingDir = try taskStagingURL(for: taskID)

        let currentWorkspaceBytes = try directoryByteSize(workspaceDir)
        let destinationURL = try resolveConfinedURL(filename: validatedFilename, inside: workspaceDir)
        let existingSize = (try? destinationURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let projectedBytes = currentWorkspaceBytes - existingSize + data.count
        guard projectedBytes <= policy.maxWorkspaceBytes else {
            throw DeviceExecutorError.payloadTooLarge(
                "Task workspace size \(projectedBytes) exceeds quota \(policy.maxWorkspaceBytes)."
            )
        }

        let stagedURL = stagingDir.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: false)
        do {
            try data.write(to: stagedURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.moveItem(at: stagedURL, to: destinationURL)
        } catch let error as DeviceExecutorError {
            try? FileManager.default.removeItem(at: stagedURL)
            throw error
        } catch {
            try? FileManager.default.removeItem(at: stagedURL)
            throw DeviceExecutorError.storageUnavailable("Failed to write artifact '\(validatedFilename)': \(error.localizedDescription)")
        }

        let sha256 = DeviceSandboxCrypto.sha256Hex(data)
        return DeviceGeneratedArtifact(
            artifactID: artifactID,
            taskID: taskID,
            filename: validatedFilename,
            mediaType: normalizedMediaType,
            sizeBytes: data.count,
            sha256: sha256,
            relativePath: "\(taskID.uuidString.lowercased())/\(validatedFilename)",
            createdAt: createdAt
        )
    }

    public func readArtifactData(for artifact: DeviceGeneratedArtifact) throws -> Data {
        let workspaceDir = try taskWorkspaceURL(for: artifact.taskID)
        let validated = try validateSafeRelativeFilename(artifact.filename)
        let fileURL = try resolveConfinedURL(filename: validated, inside: workspaceDir)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw DeviceExecutorError.taskNotFound(artifact.taskID)
        }
        return try Data(contentsOf: fileURL)
    }

    public func artifactFileURL(for artifact: DeviceGeneratedArtifact) throws -> URL {
        let workspaceDir = try taskWorkspaceURL(for: artifact.taskID)
        let validated = try validateSafeRelativeFilename(artifact.filename)
        return try resolveConfinedURL(filename: validated, inside: workspaceDir)
    }

    public func cleanupStaging(for taskID: UUID) {
        let dir = stagingRoot().appendingPathComponent(taskID.uuidString.lowercased(), isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
    }

    public func deleteWorkspace(for taskID: UUID) {
        cleanupStaging(for: taskID)
        let dir = workspacesRoot().appendingPathComponent(taskID.uuidString.lowercased(), isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
    }

    public func validateSafeRelativeFilename(_ rawFilename: String) throws -> String {
        let trimmed = rawFilename.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.contains("/"),
              !trimmed.contains("\\"),
              !trimmed.contains("\0"),
              !trimmed.contains(".."),
              B3AttachmentLimits.isSafeArtifactFilename(trimmed)
        else {
            throw DeviceExecutorError.sandboxPathViolation(rawFilename)
        }
        return trimmed
    }

    private func resolveConfinedURL(filename: String, inside workspaceDir: URL) throws -> URL {
        let canonicalWorkspace = workspaceDir.resolvingSymlinksInPath().standardizedFileURL
        let candidate = canonicalWorkspace.appendingPathComponent(filename, isDirectory: false)
        let canonicalCandidate = candidate.resolvingSymlinksInPath().standardizedFileURL

        let workspacePrefix = canonicalWorkspace.path.hasSuffix("/")
            ? canonicalWorkspace.path
            : canonicalWorkspace.path + "/"
        guard canonicalCandidate.path.hasPrefix(workspacePrefix),
              canonicalCandidate.deletingLastPathComponent().path == canonicalWorkspace.path
        else {
            throw DeviceExecutorError.sandboxPathViolation(filename)
        }
        return canonicalCandidate
    }

    private func workspacesRoot() -> URL {
        rootDirectory.appendingPathComponent("workspaces", isDirectory: true)
    }

    private func stagingRoot() -> URL {
        rootDirectory.appendingPathComponent("staging", isDirectory: true)
    }

    private func ensureProtectedDirectory(_ directory: URL) throws {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = directory
            try mutable.setResourceValues(values)
        } catch {
            throw DeviceExecutorError.storageUnavailable("Unable to prepare sandbox workspace directory: \(error.localizedDescription)")
        }
    }

    private func directoryByteSize(_ directory: URL) throws -> Int {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return 0
        }
        var total = 0
        for item in contents {
            let values = try item.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if values.isRegularFile == true {
                total += values.fileSize ?? 0
            }
        }
        return total
    }
}
