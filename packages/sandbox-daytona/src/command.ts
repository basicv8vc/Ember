import { InvalidArgumentError } from '@ember/domain';
import { DAYTONA_SANDBOX_LIMITS } from './limits.js';

/**
 * POSIX single-quote escaping.
 *
 * Daytona's process API takes a shell string (`executeCommand` / `executeSessionCommand` run it
 * through zsh, bash or sh), while the Ember `SandboxProvider` contract takes an argv array.
 * Rendering argv into a shell string is only safe if every token is quoted so the shell cannot
 * interpret it. Single quotes suppress expansion, substitution, globbing, separators and
 * redirection; the only character that needs escaping is the single quote itself, which is
 * closed, escaped and reopened (`'\''`).
 */
export function quotePosixToken(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/** Renders a validated argv as a shell command string. */
export function renderCommand(argv: readonly string[]): string {
  return argv.map(quotePosixToken).join(' ');
}

export interface ArgvPolicy {
  readonly allowedPrograms: readonly string[];
}

function reject(path: string, code: string): never {
  throw new InvalidArgumentError([{ path, code }]);
}

/**
 * Validates and normalises an argv before it can become a shell command.
 *
 * Rules, all enforced before any vendor call:
 * - non-empty array, bounded cardinality, bounded token length and total length;
 * - no NUL and no C0 control characters except tab/newline (which are legitimate inside a
 *   quoted argument, but carriage return is rejected because it makes the rendered command
 *   ambiguous in an audit trail);
 * - `argv[0]` must resolve to an allowlisted program name.
 */
export function validateArgv(argv: readonly string[], policy: ArgvPolicy): readonly string[] {
  if (argv.length === 0) {
    reject('argv', 'too_small');
  }

  if (argv.length > DAYTONA_SANDBOX_LIMITS.maxArgvLength) {
    reject('argv', 'too_big');
  }

  let totalChars = 0;

  for (const [index, token] of argv.entries()) {
    if (typeof token !== 'string') {
      reject('argv', 'invalid_type');
    }

    if (token.length === 0 && index === 0) {
      reject('argv', 'too_small');
    }

    if (token.length > DAYTONA_SANDBOX_LIMITS.maxArgChars) {
      reject('argv', 'too_big');
    }

    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(token)) {
      reject('argv', 'invalid_character');
    }

    totalChars += token.length;
  }

  if (totalChars > DAYTONA_SANDBOX_LIMITS.maxCommandChars) {
    reject('argv', 'too_big');
  }

  const program = argv[0] ?? '';
  const segments = program.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (program.includes('/')) {
    // Absolute paths are tolerated, but only when normalised: `..` and empty segments would
    // let a caller address a different binary than the one the allowlist approved.
    if (!program.startsWith('/') || segments.some((segment, i) => i > 0 && segment === '')) {
      reject('argv', 'invalid_program_path');
    }

    if (segments.includes('..') || segments.includes('.')) {
      reject('argv', 'invalid_program_path');
    }
  }

  if (!policy.allowedPrograms.includes(basename)) {
    reject('argv', 'program_not_allowed');
  }

  return Object.freeze([...argv]);
}

/** Builds a unique, shell-safe session id for one exec. */
export function sessionIdFor(sandboxId: string, sequence: number): string {
  const safe = sandboxId.replaceAll(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `ember-${safe}-${sequence}`;
}
