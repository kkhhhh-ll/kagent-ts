/**
 * Structured logger interface for the agent framework.
 *
 * All framework-internal logging goes through this interface so consumers
 * can plug in their own logger (winston, pino, etc.) or silence output
 * entirely for test environments.
 */
export interface Logger {
  /** Debug-level diagnostic messages (verbose, typically disabled in production). */
  debug(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Informational messages about agent lifecycle and progress. */
  info(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Warnings — non-fatal issues the operator should know about. */
  warn(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Errors — fatal or near-fatal issues requiring attention. */
  error(tag: string, message: string, context?: Record<string, unknown>): void;
}

/**
 * Default logger that writes to `console` with the existing `[Tag]` prefix
 * convention. Preserves the exact output format of the pre-logger codebase.
 */
export class ConsoleLogger implements Logger {
  debug(tag: string, message: string, _context?: Record<string, unknown>): void {
    console.debug(`[${tag}] ${message}`);
  }

  info(tag: string, message: string, _context?: Record<string, unknown>): void {
    console.log(`[${tag}] ${message}`);
  }

  warn(tag: string, message: string, _context?: Record<string, unknown>): void {
    console.warn(`[${tag}] ${message}`);
  }

  error(tag: string, message: string, _context?: Record<string, unknown>): void {
    console.error(`[${tag}] ${message}`);
  }
}

/**
 * Logger that discards all messages. Use in tests or when you want to
 * suppress all framework output.
 */
export class SilentLogger implements Logger {
  debug(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  info(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  warn(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  error(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
}
