import { createTenantHash, redactSecrets, sanitizeContext } from './privacy.js';
import type { LogLevel } from './types.js';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface TelemetryLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface TelemetryLoggerOptions {
  readonly level: LogLevel;
  readonly service?: string;
  readonly sink?: (level: LogLevel, line: string) => void;
  readonly now?: () => Date;
}

/**
 * OpenTelemetry-style structured JSON logger with automatic sensitive data redaction.
 * Ensures tokens, raw prompts, secrets, and database credentials are fully scrubbed.
 */
export function createTelemetryLogger(options: TelemetryLoggerOptions): TelemetryLogger {
  const now = options.now ?? (() => new Date());
  const service = options.service ?? 'ember';
  const sink =
    options.sink ??
    ((level: LogLevel, line: string): void => {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    });
  const threshold = LEVEL_SEVERITY[options.level];

  const write = (
    level: LogLevel,
    rawMessage: string,
    rawContext: Record<string, unknown> = {},
  ): void => {
    if (LEVEL_SEVERITY[level] < threshold) {
      return;
    }

    const message = redactSecrets(rawMessage);
    const sanitized = sanitizeContext(rawContext);

    // Normalize trace_id and span_id if passed as camelCase
    const trace_id = sanitized.traceId ?? sanitized.trace_id;
    const span_id = sanitized.spanId ?? sanitized.span_id;
    delete sanitized.traceId;
    delete sanitized.spanId;

    // Convert tenantId to tenant_hash if not already done
    if (typeof sanitized.tenantId === 'string' && !sanitized.tenant_hash) {
      sanitized.tenant_hash = createTenantHash(sanitized.tenantId);
      delete sanitized.tenantId;
    }

    const record = {
      level,
      time: now().toISOString(),
      service,
      message,
      ...(trace_id ? { trace_id } : {}),
      ...(span_id ? { span_id } : {}),
      ...sanitized,
    };

    sink(level, JSON.stringify(record));
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}
