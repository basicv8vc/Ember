import { execFileSync } from 'node:child_process';
import type { ResolvedBenchmarkConfig } from './types.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/i;

/** Use the checked-out code revision, not a placeholder or a potentially stale CI variable. */
export function resolveBenchmarkGitSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (SHA_PATTERN.test(sha)) return sha;
  } catch {
    // The benchmark can also run from a source archive without .git metadata.
  }

  const ciSha = process.env.GITHUB_SHA?.trim();
  return ciSha && SHA_PATTERN.test(ciSha) ? ciSha : 'unknown';
}

/** Never serialize credentials, query tokens, or internal host details to shareable reports. */
export function sanitizeReportConfig(config: ResolvedBenchmarkConfig): ResolvedBenchmarkConfig {
  return {
    ...config,
    databaseUrl: '[REDACTED]',
    apiUrl: config.apiUrl === undefined ? undefined : '[REDACTED]',
  };
}
