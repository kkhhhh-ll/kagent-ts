/**
 * Structured logger interface for the agent framework.
 *
 * All framework-internal logging goes through this interface so consumers
 * can plug in their own logger (winston, pino, etc.) or silence output
 * entirely for test environments.
 */

/** Log levels in ascending order of severity. */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  /** Debug-level diagnostic messages (verbose, typically disabled in production). */
  debug(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Informational messages about agent lifecycle and progress. */
  info(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Warnings — non-fatal issues the operator should know about. */
  warn(tag: string, message: string, context?: Record<string, unknown>): void;

  /** Errors — fatal or near-fatal issues requiring attention. */
  error(tag: string, message: string, context?: Record<string, unknown>): void;

  /**
   * Create a child logger with pre-bound context.
   *
   * Every log call on the child automatically merges the bound context
   * with any per-call context (per-call keys take precedence over bound keys).
   *
   * Typical usage:
   * ```ts
   * const reqLogger = logger.child({ requestId: "abc-123" });
   * reqLogger.info("HTTP", "Request started");                // context includes requestId
   * reqLogger.error("HTTP", "Request failed", { status: 500 }); // merged: { requestId, status }
   * ```
   */
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Characters we strip / escape from tag and message to prevent log injection. */
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/g;

/** Replace control characters with their `\xNN` escape so they can't forge log lines. */
function sanitize(s: string): string {
  return s.replace(CONTROL_RE, (ch) =>
    `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * Safe JSON serializer that handles:
 * - `Error` objects (non-enumerable `.message` / `.stack` / `.name`)
 * - `BigInt` values (which `JSON.stringify` rejects)
 * - Circular references (returns `"[Circular]"` instead of losing all data)
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(value, (_key, val) => {
      // BigInt must be handled FIRST — typeof "bigint" is not "object".
      if (typeof val === "bigint") {
        return `BigInt(${val.toString()})`;
      }

      // Null / non-object pass through unchanged.
      if (val === null || typeof val !== "object") {
        return val;
      }

      // --- circular-reference guard (applies to Errors AND plain objects) ---
      if (seen.has(val)) return "[Circular]";
      seen.add(val);

      // --- Error → extract non-enumerable properties ---
      if (val instanceof Error) {
        const serialized: Record<string, unknown> = {
          name: val.name,
          message: val.message,
        };
        if (val.stack) serialized.stack = val.stack;
        // Let the replacer re-enter for `cause` so circular guards fire.
        if (val.cause !== undefined) serialized.cause = val.cause;
        return serialized;
      }

      return val;
    });
  } catch {
    // Last-resort fallback (should be unreachable with the WeakSet guard).
    return String(value);
  }
}

/**
 * Serialize a context record for log output. Returns an empty string when
 * the record is empty so callers can append unconditionally without adding
 * trailing whitespace.
 */
function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return "";
  return " " + safeStringify(context);
}

// ---------------------------------------------------------------------------
// ConsoleLogger
// ---------------------------------------------------------------------------

/**
 * Default logger that writes to `console` with the `[Tag]` prefix convention.
 *
 * @example
 * ```ts
 * // Default: outputs everything (DEBUG and above).
 * const logger = new ConsoleLogger();
 *
 * // Production: only warnings and errors.
 * const logger = new ConsoleLogger({ minLevel: LogLevel.WARN });
 *
 * // Fully disabled at runtime.
 * const logger = new ConsoleLogger({ enabled: false });
 *
 * // Per-request child with bound context.
 * const reqLog = logger.child({ requestId: "abc-123" });
 * reqLog.info("HTTP", "ok"); // → [HTTP] ok {"requestId":"abc-123"}
 * ```
 */
export class ConsoleLogger implements Logger {
  private minLevel: LogLevel;
  private enabled: boolean;
  private bindings: Record<string, unknown>;

  constructor(opts?: {
    minLevel?: LogLevel;
    /** When `false`, all output is suppressed (independent of `minLevel`). */
    enabled?: boolean;
    bindings?: Record<string, unknown>;
  }) {
    this.minLevel = opts?.minLevel ?? LogLevel.DEBUG;
    this.enabled = opts?.enabled ?? true;
    this.bindings = opts?.bindings ?? {};
  }

  debug(tag: string, message: string, context?: Record<string, unknown>): void {
    if (!this._shouldLog(LogLevel.DEBUG)) return;
    console.debug(
      `[${sanitize(tag)}] ${sanitize(message)}${formatContext(this._merge(context))}`,
    );
  }

  info(tag: string, message: string, context?: Record<string, unknown>): void {
    if (!this._shouldLog(LogLevel.INFO)) return;
    console.log(
      `[${sanitize(tag)}] ${sanitize(message)}${formatContext(this._merge(context))}`,
    );
  }

  warn(tag: string, message: string, context?: Record<string, unknown>): void {
    if (!this._shouldLog(LogLevel.WARN)) return;
    console.warn(
      `[${sanitize(tag)}] ${sanitize(message)}${formatContext(this._merge(context))}`,
    );
  }

  error(tag: string, message: string, context?: Record<string, unknown>): void {
    if (!this._shouldLog(LogLevel.ERROR)) return;
    console.error(
      `[${sanitize(tag)}] ${sanitize(message)}${formatContext(this._merge(context))}`,
    );
  }

  /** @inheritdoc */
  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      minLevel: this.minLevel,
      enabled: this.enabled,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  // ---- internal ----

  /**
   * Returns `true` when `level` meets the configured threshold AND the
   * logger is not disabled.  Uses `>=` so the comparison reads naturally
   * (higher severity = higher number).
   */
  private _shouldLog(level: LogLevel): boolean {
    return this.enabled && level >= this.minLevel;
  }

  /**
   * Merge child bindings with per-call context. Per-call keys win.
   * Always returns a fresh object to avoid leaking references.
   */
  private _merge(context?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (Object.keys(this.bindings).length === 0) {
      return context ? { ...context } : undefined;
    }
    if (!context) return { ...this.bindings };
    return { ...this.bindings, ...context };
  }
}

// ---------------------------------------------------------------------------
// SilentLogger
// ---------------------------------------------------------------------------

/**
 * Logger that discards all messages. Use in tests or when you want to
 * suppress all framework output.
 */
export class SilentLogger implements Logger {
  debug(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  info(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  warn(_tag: string, _message: string, _context?: Record<string, unknown>): void {}
  error(_tag: string, _message: string, _context?: Record<string, unknown>): void {}

  /** Returns `this` — all instances are equivalent no-ops. */
  child(_bindings: Record<string, unknown>): Logger {
    return this;
  }
}
