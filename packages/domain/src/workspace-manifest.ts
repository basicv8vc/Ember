import { InvalidArgumentError } from './errors.js';

/**
 * Workspace manifest rules (P0B-06 / B06-D2).
 *
 * A manifest entry is a *logical* workspace file: a POSIX-style relative path plus a
 * tenant-owned Artifact reference and the digest/size the Artifact is expected to have. It
 * deliberately has no host path, no absolute root, no inode and no storage key, so the same
 * manifest can be interpreted by a future sandbox on another machine.
 *
 * This module is pure: no filesystem, database, clock or crypto. It decides which paths are
 * representable and how two changesets may be merged deterministically.
 */

export interface WorkspaceFileEntry {
  /** Normalized POSIX-style relative path; never absolute and never a host path. */
  readonly path: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
}

export interface WorkspaceManifestValue {
  readonly files: readonly WorkspaceFileEntry[];
}

export const MAX_WORKSPACE_PATH_LENGTH = 255;
export const MAX_WORKSPACE_FILES = 2_000;
export const MAX_WORKSPACE_FILE_SIZE = 104_857_600;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Characters that are either unrepresentable or ambiguous across platforms. */
const FORBIDDEN_PATH_CHARACTERS = /[\\<>:"|?*]/;

function fail(path: string, code: string): never {
  throw new InvalidArgumentError([{ path, code }]);
}

/**
 * Validate and return one logical workspace path.
 *
 * Rejected on purpose:
 * - empty, absolute (`/etc/passwd`), drive-relative or UNC style names;
 * - `.`/`..` traversal segments and empty segments (`a//b`, trailing `/`);
 * - backslashes and Windows-reserved characters, which are separator or glob aliases;
 * - control characters and non-NFC Unicode, which different filesystems may normalize
 *   differently (a silent overwrite is exactly the failure this contract forbids).
 */
export function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string') {
    fail('path', 'not_a_string');
  }

  if (value.length === 0) {
    fail('path', 'empty');
  }

  if (value.length > MAX_WORKSPACE_PATH_LENGTH) {
    fail('path', 'too_long');
  }

  // Reject before normalization: a path that only becomes valid after Unicode folding is
  // ambiguous across platforms and must be refused rather than silently rewritten.
  if (value.normalize('NFC') !== value) {
    fail('path', 'not_nfc');
  }

  if (value.startsWith('/') || value.startsWith('./')) {
    fail('path', 'absolute_or_dot_prefixed');
  }

  if (FORBIDDEN_PATH_CHARACTERS.test(value)) {
    fail('path', 'forbidden_character');
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x20 || codePoint === 0x7f) {
      fail('path', 'control_character');
    }
  }

  const segments = value.split('/');

  for (const segment of segments) {
    if (segment.length === 0) {
      fail('path', 'empty_segment');
    }
    if (segment === '.' || segment === '..') {
      fail('path', 'traversal_segment');
    }
    if (segment.trim() !== segment || segment.endsWith('.')) {
      // Trailing dots and surrounding whitespace are stripped by some filesystems.
      fail('path', 'ambiguous_segment');
    }
  }

  return value;
}

/**
 * Case/width-insensitive collision key.
 *
 * Two paths that collide here could resolve to one physical file on a case-insensitive or
 * normalization-insensitive filesystem, so the manifest rejects them instead of letting one
 * entry overwrite the other.
 */
export function workspacePathCollisionKey(path: string): string {
  return path.normalize('NFKC').toLowerCase();
}

function toManifestEntry(value: unknown, index: number): WorkspaceFileEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`files[${index}]`, 'not_an_object');
  }

  const entry = value as Record<string, unknown>;
  const path = normalizeWorkspacePath(entry['path']);
  const artifactId = entry['artifactId'];
  const sha256 = entry['sha256'];
  const size = entry['size'];

  if (typeof artifactId !== 'string' || !UUID_PATTERN.test(artifactId)) {
    fail(`files[${index}].artifactId`, 'invalid_id');
  }

  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    fail(`files[${index}].sha256`, 'invalid_digest');
  }

  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    fail(`files[${index}].size`, 'invalid_size');
  }

  if (size > MAX_WORKSPACE_FILE_SIZE) {
    fail(`files[${index}].size`, 'too_large');
  }

  return Object.freeze({ path, artifactId, sha256, size });
}

/**
 * Validate a manifest and return a deterministic, path-sorted copy.
 *
 * Duplicate normalized paths and cross-platform collision keys are rejected: silently
 * keeping one of two conflicting entries would be a last-write-wins decision.
 */
export function normalizeWorkspaceManifest(value: unknown): WorkspaceManifestValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('manifest', 'not_an_object');
  }

  const files = (value as Record<string, unknown>)['files'];

  if (!Array.isArray(files)) {
    fail('manifest.files', 'not_an_array');
  }

  if (files.length > MAX_WORKSPACE_FILES) {
    fail('manifest.files', 'too_many_entries');
  }

  const entries = files.map((entry, index) => toManifestEntry(entry, index));
  const seen = new Set<string>();
  const collisionSeen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.path)) {
      fail('manifest.files', 'duplicate_path');
    }
    seen.add(entry.path);

    const collisionKey = workspacePathCollisionKey(entry.path);

    if (collisionSeen.has(collisionKey)) {
      fail('manifest.files', 'ambiguous_path_collision');
    }
    collisionSeen.add(collisionKey);
  }

  return Object.freeze({
    files: Object.freeze([...entries].sort((left, right) => (left.path < right.path ? -1 : 1))),
  });
}

/** Compare two entries by the fields that define file content identity. */
export function sameWorkspaceEntry(left: WorkspaceFileEntry, right: WorkspaceFileEntry): boolean {
  return (
    left.path === right.path &&
    left.artifactId === right.artifactId &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

export interface WorkspaceChangeSet {
  /** Paths whose entry differs from the base (added or content-updated). */
  readonly changed: readonly WorkspaceFileEntry[];
  /** Paths present in the base but absent from the branch. */
  readonly removed: readonly string[];
}

export function diffWorkspaceManifests(
  base: WorkspaceManifestValue,
  branch: WorkspaceManifestValue,
): WorkspaceChangeSet {
  const baseByPath = new Map(base.files.map((entry) => [entry.path, entry]));
  const branchByPath = new Map(branch.files.map((entry) => [entry.path, entry]));
  const changed: WorkspaceFileEntry[] = [];

  for (const entry of branch.files) {
    const previous = baseByPath.get(entry.path);

    if (previous === undefined || !sameWorkspaceEntry(previous, entry)) {
      changed.push(entry);
    }
  }

  const removed: string[] = [];

  for (const path of baseByPath.keys()) {
    if (!branchByPath.has(path)) {
      removed.push(path);
    }
  }

  return Object.freeze({
    changed: Object.freeze(changed.sort((left, right) => (left.path < right.path ? -1 : 1))),
    removed: Object.freeze(removed.sort()),
  });
}

export type WorkspaceMergeOutcome =
  | {
      readonly status: 'merged';
      readonly manifest: WorkspaceManifestValue;
      readonly mergedPaths: readonly string[];
    }
  | {
      readonly status: 'conflict';
      readonly reason: 'overlapping_paths' | 'destructive_change';
      readonly conflictPaths: readonly string[];
    };

/**
 * Deterministically merge a candidate branch onto the current workspace.
 *
 * The merge is allowed only when all of the following hold:
 * - both sides share the declared base (the caller has already verified it exists);
 * - neither side deleted a path (deletion, rename and permission-like removal are all high
 *   risk and stay manual);
 * - the two change sets touch a disjoint set of paths;
 * - every changed entry is a plain add or content update.
 *
 * Anything else is reported as a conflict with the paths that need a human decision. The
 * function never returns "keep whichever value arrived last".
 */
export function mergeWorkspaceManifests(
  base: WorkspaceManifestValue,
  current: WorkspaceManifestValue,
  candidate: WorkspaceManifestValue,
): WorkspaceMergeOutcome {
  const currentChanges = diffWorkspaceManifests(base, current);
  const candidateChanges = diffWorkspaceManifests(base, candidate);

  const destructive = [...currentChanges.removed, ...candidateChanges.removed];

  if (destructive.length > 0) {
    return Object.freeze({
      status: 'conflict' as const,
      reason: 'destructive_change' as const,
      conflictPaths: Object.freeze([...new Set(destructive)].sort()),
    });
  }

  const currentPaths = new Set(currentChanges.changed.map((entry) => entry.path));
  const overlapping = candidateChanges.changed
    .map((entry) => entry.path)
    .filter((path) => currentPaths.has(path));

  if (overlapping.length > 0) {
    return Object.freeze({
      status: 'conflict' as const,
      reason: 'overlapping_paths' as const,
      conflictPaths: Object.freeze([...new Set(overlapping)].sort()),
    });
  }

  const merged = new Map(current.files.map((entry) => [entry.path, entry]));

  for (const entry of candidateChanges.changed) {
    merged.set(entry.path, entry);
  }

  return Object.freeze({
    status: 'merged' as const,
    manifest: Object.freeze({
      files: Object.freeze(
        [...merged.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
      ),
    }),
    mergedPaths: Object.freeze(candidateChanges.changed.map((entry) => entry.path)),
  });
}

/**
 * Canonical digest input for a manifest.
 *
 * Hashing itself belongs to the infrastructure adapter (it needs a crypto module); both the
 * database and TypeScript must hash exactly this string, so the canonical form is defined
 * once here.
 */
export function canonicalWorkspaceManifest(manifest: WorkspaceManifestValue): string {
  return JSON.stringify(
    normalizeWorkspaceManifest(manifest).files.map((entry) => [
      entry.path,
      entry.artifactId,
      entry.sha256,
      entry.size,
    ]),
  );
}
