import { InvalidStateTransitionError } from '@ember/domain';
import { describe, expect, it } from 'vitest';
import { runCli, type CliOutputStreams } from '../../apps/cli/src/sandbox-smoke/cli.js';
import {
  SmokeHarnessError,
  formatSanitizedError,
  sanitizeString,
  serializeSafeJson,
} from '../../apps/cli/src/sandbox-smoke/sanitize.js';
import { SmokeReportSchema } from '../../apps/cli/src/sandbox-smoke/types.js';

function createBufferedStreams(): CliOutputStreams & { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  return {
    writeStdout: (t: string) => {
      stdout += t;
    },
    writeStderr: (t: string) => {
      stderr += t;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe('SandboxSmoke CLI', () => {
  it('runs successfully with default options and outputs summary and JSON', async () => {
    const streams = createBufferedStreams();
    const code = await runCli([], streams);

    expect(code).toBe(0);
    expect(streams.stderr).toBe('');
    expect(streams.stdout).toContain('Ember Sandbox Smoke Harness (Local Fake Simulation)');
    expect(streams.stdout).toContain('Status:                PASS');
    expect(streams.stdout).toContain('--- Machine-Readable JSON Report ---');
    expect(streams.stdout).toContain('"provider": "fake"');
    expect(streams.stdout).toContain('"realIsolationStatus": "NOT_MEASURED"');
  });

  it('outputs only raw JSON when --json flag is supplied', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--json'], streams);

    expect(code).toBe(0);
    expect(streams.stderr).toBe('');
    expect(streams.stdout).not.toContain('Ember Sandbox Smoke Harness');

    const parsed = SmokeReportSchema.parse(JSON.parse(streams.stdout));
    expect(parsed.provider).toBe('fake');
    expect(parsed.status).toBe('PASS');
  });

  it('outputs only human summary when --format=summary is supplied', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--format=summary'], streams);

    expect(code).toBe(0);
    expect(streams.stderr).toBe('');
    expect(streams.stdout).toContain('Ember Sandbox Smoke Harness');
    expect(streams.stdout).not.toContain('--- Machine-Readable JSON Report ---');
  });

  it('rejects --provider cloudflare with non-zero exit and no network calls', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--provider', 'cloudflare'], streams);

    expect(code).toBe(1);
    expect(streams.stderr).toContain('Provider "cloudflare" is NOT_MEASURED');
    expect(streams.stderr).toContain('Zero network calls or implicit fallbacks were executed');
    expect(streams.stdout).toBe('');
  });

  it('rejects other candidate cloud providers (e2b, daytona, boat) with non-zero exit', async () => {
    for (const vendor of ['e2b', 'daytona', 'boat']) {
      const streams = createBufferedStreams();
      const code = await runCli([`--provider=${vendor}`], streams);

      expect(code).toBe(1);
      expect(streams.stderr).toContain(`Provider "${vendor}" is NOT_MEASURED`);
      expect(streams.stdout).toBe('');
    }
  });

  it('rejects unknown provider with non-zero exit', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--provider', 'docker-local'], streams);

    expect(code).toBe(1);
    expect(streams.stderr).toContain('Unknown provider "docker-local"');
    expect(streams.stdout).toBe('');
  });

  it('rejects unknown command-line flag with non-zero exit', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--unrecognized-option'], streams);

    expect(code).toBe(1);
    expect(streams.stderr).toContain('Unrecognized argument "--unrecognized-option"');
    expect(streams.stdout).toBe('');
  });

  it('rejects illegal timeout arguments with non-zero exit', async () => {
    for (const badTimeout of ['-50', '0', '9999999', 'invalid', '100abc', '100.5']) {
      const streams = createBufferedStreams();
      const code = await runCli(['--timeout-ms', badTimeout], streams);

      expect(code).toBe(1);
      expect(streams.stderr).toContain('Invalid timeout value');
      expect(streams.stdout).toBe('');
    }

    for (const badTimeout of ['--timeout-ms=100abc', '--timeout=100.5']) {
      const streams = createBufferedStreams();
      const code = await runCli([badTimeout], streams);

      expect(code).toBe(1);
      expect(streams.stderr).toContain('Invalid timeout value');
      expect(streams.stdout).toBe('');
    }
  });

  it('prints help message and exits 0 when --help or -h is passed', async () => {
    const streams = createBufferedStreams();
    const code = await runCli(['--help'], streams);

    expect(code).toBe(0);
    expect(streams.stdout).toContain('Usage:');
    expect(streams.stdout).toContain('pnpm sandbox:smoke:local');
    expect(streams.stderr).toBe('');
  });

  it('sanitizes tokens, URLs with passwords, and secret keys in strings and errors', () => {
    const rawWithBearer =
      'Failed to connect: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret';
    expect(sanitizeString(rawWithBearer)).toBe('Failed to connect: Bearer [REDACTED]');

    const rawWithDbUri =
      'Error connecting to postgres://admin:super_secret_pw@db.internal:5432/ember';
    expect(sanitizeString(rawWithDbUri)).toBe(
      'Error connecting to postgres://admin:[REDACTED]@db.internal:5432/ember',
    );

    const rawWithApiKey = 'Configuration error: api_key="secret-api-key-value" is invalid';
    expect(sanitizeString(rawWithApiKey)).toBe(
      'Configuration error: api_key="[REDACTED]" is invalid',
    );

    const error = new Error('Database at postgresql://user:mypassword@db:5432/app connection lost');
    // Raw arbitrary error messages are converted to safe codes
    expect(formatSanitizedError(error)).toBe('Provider operation failed [ERR_PROVIDER_EXECUTION]');
    // Direct string scrubber redacts known credential patterns
    expect(sanitizeString(error.message)).toBe(
      'Database at postgresql://user:[REDACTED]@db:5432/app connection lost',
    );

    const serialized = serializeSafeJson({
      bearer: 'Bearer some-auth-token',
      url: 'https://user:password123@api.vendor.com/v1',
    });
    expect(serialized).toContain('Bearer [REDACTED]');
    expect(serialized).toContain('https://user:[REDACTED]@api.vendor.com/v1');
    expect(serialized).not.toContain('password123');
  });

  it('Class 1 Spoofing: strictly maps message spoofing attempts to fixed safe provider error', () => {
    const spoofedMessages = [
      'CRITICAL_SECRET_KEY_12345 [ERR_PHASE_TIMEOUT]',
      'LEAKED_JWT_PAYLOAD [ERR_OPERATION_ABORTED]',
      'INTERNAL_VPC_SUBNET [ERR_EXEC_FAILED]',
      'HASH_COLLISION_LEAK [DIGEST_MISMATCH]',
      'INVALID_BILLING_LEAK [ERR_INVALID_USAGE]',
      'DomainError: Fake domain error containing SENSITIVE_TOKEN [INVALID_STATE_TRANSITION]',
      'CRITICAL_LEAKED_SECRET timed out after 5000ms [ERR_PHASE_TIMEOUT]',
    ];

    for (const msg of spoofedMessages) {
      const err = new Error(msg);
      // Even with context, message spoofing fails to masquerade as an internal error
      const formattedWithContext = formatSanitizedError(err, 'create');
      expect(formattedWithContext).toBe(
        'Provider operation failed during create [ERR_PROVIDER_EXECUTION]',
      );
      expect(formattedWithContext).not.toContain(msg);

      // Without context
      const formattedWithoutContext = formatSanitizedError(err);
      expect(formattedWithoutContext).toBe('Provider operation failed [ERR_PROVIDER_EXECUTION]');
      expect(formattedWithoutContext).not.toContain(msg);
    }
  });

  it('Class 2 Spoofing: strictly rejects arbitrary error.code and duck-typed error properties', () => {
    const errorWithPolicyDenied = new Error('Sensitive cloud policy denial error body');
    Object.assign(errorWithPolicyDenied, { code: 'POLICY_DENIED' });

    const errorWithTimeoutCode = new Error('Sensitive timeout stack trace');
    Object.assign(errorWithTimeoutCode, { code: 'ERR_PHASE_TIMEOUT' });

    const errorWithCustomCode = new Error('Sensitive custom error text');
    Object.assign(errorWithCustomCode, { code: 'CUSTOM_EXPLOIT_CODE_999' });

    const plainObjectSpoof = {
      code: 'POLICY_DENIED',
      message: 'INJECTED_POLICY_FAILURE_SECRET',
    };

    const duckTypedHarnessSpoof = {
      name: 'SmokeHarnessError',
      code: 'ERR_PHASE_TIMEOUT',
      message: 'DUCK_TYPED_SECRET_LEAK [ERR_PHASE_TIMEOUT]',
    };

    const duckTypedDomainSpoof = {
      name: 'DomainError',
      code: 'INVALID_STATE_TRANSITION',
      publicMessage: 'DUCK_DOMAIN_SECRET_LEAK',
    };

    const candidates = [
      errorWithPolicyDenied,
      errorWithTimeoutCode,
      errorWithCustomCode,
      plainObjectSpoof,
      duckTypedHarnessSpoof,
      duckTypedDomainSpoof,
    ];

    for (const candidate of candidates) {
      const formatted = formatSanitizedError(candidate, 'exec');
      expect(formatted).toBe('Provider operation failed during exec [ERR_PROVIDER_EXECUTION]');
      expect(formatted).not.toContain('POLICY_DENIED');
      expect(formatted).not.toContain('CUSTOM_EXPLOIT_CODE_999');
      expect(formatted).not.toContain('Sensitive');
      expect(formatted).not.toContain('INJECTED');
      expect(formatted).not.toContain('DUCK');
    }
  });

  it('Trusted Errors: generates safe public message strictly from error code and rejects forged messages', () => {
    const timeoutErr = new SmokeHarnessError('ERR_PHASE_TIMEOUT', {
      phase: 'exec',
      timeoutMs: 5000,
    });
    expect(formatSanitizedError(timeoutErr)).toBe(
      'Phase "exec" timed out after 5000ms [ERR_PHASE_TIMEOUT]',
    );

    // Overwriting .message on genuine SmokeHarnessError has zero effect (formatSanitizedError maps from code)
    const forgedMessageHarnessErr = new SmokeHarnessError('ERR_EXEC_FAILED', {
      exitCode: 1,
    });
    Object.assign(forgedMessageHarnessErr, {
      message: 'Execution failed with Bearer secret-token-xyz [ERR_EXEC_FAILED]',
    });
    expect(formatSanitizedError(forgedMessageHarnessErr)).toBe(
      'Command exited with non-zero exit code: 1 [ERR_EXEC_FAILED]',
    );
    expect(formatSanitizedError(forgedMessageHarnessErr)).not.toContain('secret-token-xyz');

    // Passing an unrecognized or sensitive phase name falls back to safe generic "Phase"
    const maliciousPhaseErr = new SmokeHarnessError('ERR_PHASE_TIMEOUT', {
      phase: 'MALICIOUS_SECRET_CUSTOMER_DOCUMENT_999',
      timeoutMs: 5000,
    });
    expect(formatSanitizedError(maliciousPhaseErr)).toBe(
      'Phase timed out after 5000ms [ERR_PHASE_TIMEOUT]',
    );
    expect(formatSanitizedError(maliciousPhaseErr)).not.toContain(
      'MALICIOUS_SECRET_CUSTOMER_DOCUMENT_999',
    );

    const domainErr = new InvalidStateTransitionError('task', 'submitted', 'completed');
    expect(formatSanitizedError(domainErr)).toBe(
      'DomainError: The requested state transition is not allowed [INVALID_STATE_TRANSITION]',
    );
  });
});
