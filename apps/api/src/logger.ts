import type { LogLevel } from './env.js';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Test seam; defaults to stdout/stderr JSON lines. */
  readonly sink?: (level: LogLevel, line: string) => void;
  readonly now?: () => Date;
}

/**
 * Minimal structured JSON logger. Callers must only pass opaque identifiers and
 * metadata — never tokens, request bodies, or database credentials.
 */
export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const sink =
    options.sink ??
    ((level: LogLevel, line: string): void => {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    });
  const threshold = LEVEL_SEVERITY[options.level];

  const write = (level: LogLevel, message: string, context: Record<string, unknown> = {}): void => {
    if (LEVEL_SEVERITY[level] < threshold) {
      return;
    }
    sink(level, JSON.stringify({ level, time: now().toISOString(), message, ...context }));
  };

  return {
    debug: (message, context) => {
      write('debug', message, context);
    },
    info: (message, context) => {
      write('info', message, context);
    },
    warn: (message, context) => {
      write('warn', message, context);
    },
    error: (message, context) => {
      write('error', message, context);
    },
  };
}
