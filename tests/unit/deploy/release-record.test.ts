/**
 * Release bookkeeping for deploy.sh / rollback.sh --previous.
 *
 * The contract under test: deploy.sh records the deployed tag and keeps the tag it
 * replaced in release.previous, so `rollback.sh --previous` always has a target without
 * manual bookkeeping; a rollback rotates the record the same way. The rotation logic
 * lives in lib.sh (`record_release_tag` / `read_previous_release`) and is exercised here
 * against a scratch EMBER_RELEASE_DIR — no Docker, no /etc/ember, nothing shared.
 *
 * Persistence failures must be fatal: a deploy or rollback that cannot write the record
 * must not report success. The failure-path tests pin that.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPTS_DIR = `${REPO_ROOT}infra/staging/scripts`;
const LIB_SH = `${SCRIPTS_DIR}/lib.sh`;
const DEPLOY_SH = `${SCRIPTS_DIR}/deploy.sh`;
const ROLLBACK_SH = `${SCRIPTS_DIR}/rollback.sh`;

interface BashResult {
  status: number;
  stdout: string;
  stderr: string;
}

function bash(script: string, env: Record<string, string> = {}): BashResult {
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function scratchReleaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'ember-release-record-'));
}

function record(tag: string, dir: string): BashResult {
  return bash(`source "${LIB_SH}"; record_release_tag "${tag}"`, { EMBER_RELEASE_DIR: dir });
}

function readPrevious(dir: string): BashResult {
  return bash(`source "${LIB_SH}"; read_previous_release`, { EMBER_RELEASE_DIR: dir });
}

function recordedTag(dir: string, name: 'release' | 'release.previous'): string | undefined {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
}

describe('release record bookkeeping', () => {
  it('records the first release with no previous target', () => {
    const dir = scratchReleaseDir();

    expect(record('git-aaaa', dir).status).toBe(0);
    expect(recordedTag(dir, 'release')).toBe('git-aaaa');
    expect(recordedTag(dir, 'release.previous')).toBeUndefined();

    const previous = readPrevious(dir);
    expect(previous.status).toBe(1);
    expect(previous.stderr).toContain('no previous release recorded');
  });

  it('rotates the outgoing release into release.previous on every deploy', () => {
    const dir = scratchReleaseDir();

    expect(record('git-aaaa', dir).status).toBe(0);
    expect(record('git-bbbb', dir).status).toBe(0);
    expect(recordedTag(dir, 'release')).toBe('git-bbbb');
    expect(recordedTag(dir, 'release.previous')).toBe('git-aaaa');

    expect(record('git-cccc', dir).status).toBe(0);
    expect(recordedTag(dir, 'release')).toBe('git-cccc');
    expect(recordedTag(dir, 'release.previous')).toBe('git-bbbb');
  });

  it('keeps the previous release when the same tag is redeployed', () => {
    // Rebuilding the current release must not destroy the rollback target.
    const dir = scratchReleaseDir();

    record('git-aaaa', dir);
    record('git-bbbb', dir);
    record('git-bbbb', dir);

    expect(recordedTag(dir, 'release')).toBe('git-bbbb');
    expect(recordedTag(dir, 'release.previous')).toBe('git-aaaa');
  });

  it('resolves --previous to the release before the last deploy', () => {
    const dir = scratchReleaseDir();

    record('git-aaaa', dir);
    record('git-bbbb', dir);

    const previous = readPrevious(dir);
    expect(previous.status).toBe(0);
    expect(previous.stdout.trim()).toBe('git-aaaa');
  });

  it('deploys and rollbacks share the same rotation through lib.sh', () => {
    // A rollback must rotate the record too, so the bookkeeping always matches what runs
    // and the next deploy's `--previous` target is the release that was actually current.
    const dir = scratchReleaseDir();

    record('git-aaaa', dir); // deploy v1
    record('git-bbbb', dir); // deploy v2
    record('git-aaaa', dir); // rollback --previous -> v1

    expect(recordedTag(dir, 'release')).toBe('git-aaaa');
    expect(recordedTag(dir, 'release.previous')).toBe('git-bbbb');
  });

  it('refuses to report success when the record directory cannot be created', () => {
    // A path under a non-directory can never exist — deterministic even when the suite
    // runs as root. The old implementation logged a warning and returned 0 here.
    const result = record('git-aaaa', '/dev/null/ember-release-record');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot be created');
  });

  it.skipIf((process.getuid?.() ?? 0) === 0)(
    'fails loudly and leaves the record intact when the directory is not writable',
    () => {
      // Consistency: a failed update must not touch what is already recorded.
      const dir = scratchReleaseDir();
      expect(record('git-aaaa', dir).status).toBe(0);

      chmodSync(dir, 0o500);
      try {
        const result = record('git-bbbb', dir);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('not writable');
        expect(recordedTag(dir, 'release')).toBe('git-aaaa');
        expect(recordedTag(dir, 'release.previous')).toBeUndefined();
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('rejects an empty release tag', () => {
    const dir = scratchReleaseDir();

    const result = bash(`source "${LIB_SH}"; record_release_tag ""`, {
      EMBER_RELEASE_DIR: dir,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('empty release tag');
  });
});

describe('deploy.sh and rollback.sh wiring', () => {
  it('deploy.sh records the release through record_release_tag', () => {
    expect(readFileSync(DEPLOY_SH, 'utf8')).toContain('record_release_tag "$RELEASE_TAG"');
  });

  it('rollback.sh resolves and rotates the record through the shared helpers', () => {
    const script = readFileSync(ROLLBACK_SH, 'utf8');
    expect(script).toContain('TARGET="$(read_previous_release)"');
    expect(script).toContain('record_release_tag "$TARGET"');
    // The previous tag is never read straight off disk anymore: no hardcoded /etc path.
    expect(script).not.toMatch(/tr -d .*release\.previous/);
  });

  it('rollback.sh --previous fails fast when no previous release was recorded', () => {
    // Must die on the bookkeeping, before any Docker check: the message is the proof.
    const dir = scratchReleaseDir();

    const result = bash(`"${ROLLBACK_SH}" --previous`, { EMBER_RELEASE_DIR: dir });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no previous release recorded');
    expect(result.stderr).not.toContain('docker');
  });

  it('rollback.sh refuses to run without an explicit target', () => {
    const dir = scratchReleaseDir();

    const result = bash(`"${ROLLBACK_SH}"`, { EMBER_RELEASE_DIR: dir });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('specify --to=<tag> or --previous');
    expect(result.stderr).not.toContain('docker');
  });
});
