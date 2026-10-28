import type { LogLevel } from './config.js';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface WorkerLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface WorkerLoggerOptions {
  readonly level: LogLevel;
  readonly sink?: (level: LogLevel, line: string) => void;
  readonly now?: () => Date;
}

/**
 * Minimal JSON logger. Only opaque identifiers, counts, status codes and durations may be
 * logged; never Task input, prompts, SQL, connection strings or raw exception text.
 */
export function createWorkerLogger(options: WorkerLoggerOptions): WorkerLogger {
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
    sink(
      level,
      JSON.stringify({
        level,
        time: now().toISOString(),
        service: 'ember-worker',
        message,
        ...context,
      }),
    );
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
