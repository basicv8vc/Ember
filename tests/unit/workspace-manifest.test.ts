import { describe, expect, it } from 'vitest';
import {
  canonicalWorkspaceManifest,
  diffWorkspaceManifests,
  mergeWorkspaceManifests,
  normalizeWorkspaceManifest,
  normalizeWorkspacePath,
  workspacePathCollisionKey,
} from '@ember/domain';

/**
 * Pure manifest rules (no database, no filesystem).
 *
 * These are the cheapest tests in P0B-06 and they guard the decisions that a database test
 * cannot express as precisely: which paths are representable and when an automatic merge is
 * allowed at all.
 */

const A = {
  path: 'a.txt',
  artifactId: '11111111-1111-4111-8111-111111111111',
  sha256: 'a'.repeat(64),
  size: 1,
};
const B = {
  path: 'b.txt',
  artifactId: '22222222-2222-4222-8222-222222222222',
  sha256: 'b'.repeat(64),
  size: 2,
};
const A2 = { ...A, sha256: 'c'.repeat(64), size: 3 };

function manifest(...files: (typeof A)[]) {
  return { files };
}

describe('P0B06 workspace manifest paths', () => {
  it('accepts normalized POSIX relative paths', () => {
    expect(normalizeWorkspacePath('notes/2026/plan.md')).toBe('notes/2026/plan.md');
    expect(normalizeWorkspacePath('a.txt')).toBe('a.txt');
  });

  it('rejects absolute, traversing and ambiguous paths', () => {
    for (const unsafe of [
      '/etc/passwd',
      '../escape',
      'a/../../b',
      './relative',
      'a//b',
      'a/',
      '',
      'a\\b',
      'C:/windows',
      'a:b',
      'trailing ',
      'dir./file',
      'control\u0001char',
    ]) {
      expect(() => normalizeWorkspacePath(unsafe)).toThrow();
    }
  });

  it('rejects a non-NFC path instead of silently rewriting it', () => {
    // "é" as e + combining acute: valid Unicode, ambiguous as a file identity.
    expect(() => normalizeWorkspacePath('cafe\u0301.txt')).toThrow();
  });

  it('rejects duplicate and case-colliding entries', () => {
    expect(() => normalizeWorkspaceManifest(manifest(A, A))).toThrow();
    expect(() => normalizeWorkspaceManifest(manifest(A, { ...B, path: 'A.TXT' }))).toThrow();
    expect(workspacePathCollisionKey('A.TXT')).toBe(workspacePathCollisionKey('a.txt'));
  });

  it('sorts entries deterministically and freezes the result', () => {
    const normalized = normalizeWorkspaceManifest(manifest(B, A));

    expect(normalized.files.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.files)).toBe(true);
  });

  it('rejects malformed artifact references', () => {
    expect(() => normalizeWorkspaceManifest(manifest({ ...A, artifactId: 'nope' }))).toThrow();
    expect(() => normalizeWorkspaceManifest(manifest({ ...A, sha256: 'short' }))).toThrow();
    expect(() => normalizeWorkspaceManifest(manifest({ ...A, size: -1 }))).toThrow();
  });
});

describe('P0B06 deterministic workspace merge', () => {
  it('detects added, updated and removed entries against a base', () => {
    const changes = diffWorkspaceManifests(manifest(A, B), manifest(A2));

    expect(changes.changed.map((entry) => entry.path)).toEqual(['a.txt']);
    expect(changes.removed).toEqual(['b.txt']);
  });

  it('merges disjoint additive changes deterministically', () => {
    const base = manifest(A);
    const current = manifest(A, B);
    const candidate = manifest(A, { ...B, path: 'c.txt' });
    const merged = mergeWorkspaceManifests(base, current, candidate);

    expect(merged.status).toBe('merged');

    if (merged.status === 'merged') {
      expect(merged.manifest.files.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      expect(merged.mergedPaths).toEqual(['c.txt']);
    }
  });

  it('reports overlapping paths as a conflict', () => {
    const base = manifest(A);
    const current = manifest(A2);
    const candidate = manifest({ ...A, sha256: 'd'.repeat(64) });
    const merged = mergeWorkspaceManifests(base, current, candidate);

    expect(merged).toMatchObject({ status: 'conflict', reason: 'overlapping_paths' });
  });

  it('refuses to merge any destructive change', () => {
    const base = manifest(A, B);
    const deletedOnCurrent = mergeWorkspaceManifests(base, manifest(A), manifest(A));

    expect(deletedOnCurrent).toMatchObject({
      status: 'conflict',
      reason: 'destructive_change',
      conflictPaths: ['b.txt'],
    });

    const deletedOnCandidate = mergeWorkspaceManifests(base, manifest(A, B), manifest(A));

    expect(deletedOnCandidate).toMatchObject({ status: 'conflict', reason: 'destructive_change' });
  });

  it('produces a canonical digest input independent of entry order', () => {
    expect(canonicalWorkspaceManifest(manifest(B, A))).toBe(
      canonicalWorkspaceManifest(manifest(A, B)),
    );
  });
});
