// ─── Tool Error Codes ────────────────────────────────────────────────────────

/**
 * Standardised tool error codes for programmatic handling.
 *
 * Every `ToolResult` carries an error code so that agent code and LLM
 * guidance can react precisely — no string-matching heuristics needed.
 */
export enum ToolErrorCode {
  /** Tool executed successfully. */
  SUCCESS = "success",
  /** The tool name is not registered. */
  UNKNOWN_TOOL = "unknown_tool",
  /** The circuit breaker is open — the tool is disabled for this session. */
  CIRCUIT_OPEN = "circuit_open",
  /** The tool threw an exception during execution. */
  EXECUTION_FAILURE = "execution_failure",
  /** The arguments JSON could not be parsed (malformed or truncated). */
  ARGUMENTS_PARSE_ERROR = "arguments_parse_error",
  /** The tool's output was truncated due to size limits. */
  TRUNCATED_OUTPUT = "truncated_output",
  /** An internal error occurred in the tool registry / infrastructure. */
  INTERNAL_ERROR = "internal_error",
  /** Tool execution was denied by the user (human-in-the-loop approval). */
  APPROVAL_DENIED = "approval_denied",
  /** Arguments failed JSON Schema validation against the tool's parameters. */
  VALIDATION_ERROR = "validation_error",
}

/**
 * Structured result returned by a tool execution.
 *
 * Every tool call produces a `ToolResult` with a machine-readable
 * `errorCode` and a human-readable `content` string destined for
 * the LLM conversation context.
 */
export interface ToolResult {
  /** Whether the tool executed successfully. */
  success: boolean;
  /** Human-readable content — injected into the LLM context as-is. */
  content: string;
  /**
   * Severity level (convenience derived from `errorCode`).
   * - `"success"`   → tool completed normally.
   * - `"retryable"` → the LLM can retry with corrected parameters.
   * - `"fatal"`     → the tool is gone; the LLM must pivot.
   */
  severity: "success" | "retryable" | "fatal";
  /**
   * Machine-readable error code.
   * `ToolErrorCode.SUCCESS` when the tool completed without error.
   */
  errorCode: ToolErrorCode;
}

// ─── ToolResult helpers ──────────────────────────────────────────────────────

/**
 * Build a successful ToolResult in one call.
 */
export function toolSuccess(content: string): ToolResult {
  return { success: true, content, severity: "success", errorCode: ToolErrorCode.SUCCESS };
}

/**
 * Build a failing ToolResult in one call.
 */
export function toolError(
  errorCode: ToolErrorCode,
  content: string,
  severity: "retryable" | "fatal" = "retryable",
): ToolResult {
  return { success: false, content, severity, errorCode };
}

/**
 * A tool that an agent can invoke.
 */
export interface Tool {
  /** Unique name of the tool. */
  name: string;
  /** Description of what the tool does (used by the LLM to decide when to call it). */
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
  /** Execute the tool with the given arguments and return a raw result string. */
  execute(args: Record<string, unknown>): Promise<string>;
  /**
   * Whether this tool requires human approval before execution.
   * When `true`, the agent calls `onToolApproval` before executing.
   * Defaults to `false` (tools execute immediately).
   */
  requireApproval?: boolean;
  /**
   * Whether this tool must be executed serially (not in parallel with
   * other tools from the same LLM response). Set to `true` for tools
   * with side effects that could conflict with concurrent operations
   * (e.g., file writes that a subsequent tool reads).
   *
   * When any tool in a batch is marked `sequential`, the entire batch
   * falls back to serial execution.
   *
   * Defaults to `false` (safe to execute in parallel).
   */
  sequential?: boolean;
}

/**
 * Current state of a circuit breaker for a specific tool.
 */
export enum BreakerState {
  /** Normal operation — no failures, tool calls are allowed. */
  CLOSED = "closed",
  /**
   * Degraded operation — failures have occurred but the circuit is not yet
   * fully open. Tool calls are still allowed, but the caller should proceed
   * with caution: one more failure may open the circuit.
   */
  HALF_OPEN = "half_open",
  /** Failure threshold reached — tool calls are blocked. */
  OPEN = "open",
}

/**
 * Status snapshot of a circuit breaker.
 */
export interface BreakerStatus {
  /** Tool name. */
  toolName: string;
  /** Current circuit breaker state. */
  state: BreakerState;
  /** Current consecutive failure count. */
  failureCount: number;
  /** Max failures before the breaker opens. */
  failureThreshold: number;
  /** Whether the tool is available for calling. */
  available: boolean;
}

// ─── Error Trace Types ────────────────────────────────────────────────────

/**
 * A single event within an error trace chain.
 */
export interface TraceEvent {
  /** Event type. */
  type: "failure" | "retry" | "recovery" | "circuit_half_open" | "circuit_open" | "analysis";
  /** When the event occurred. */
  timestamp: string;
  /** The error message (for failure/retry events). */
  error?: string;
  /** The attempt number (1-based). */
  attemptNumber?: number;
  /** How many retries remain after this attempt. */
  retriesRemaining?: number;
  /** LLM's analysis of the error (captured from agent). */
  analysis?: string;
  /** Resolution description (for recovery events). */
  resolution?: string;
  /** Arguments used in this attempt (for comparison). */
  arguments?: Record<string, unknown>;
}

/**
 * Full trace of a tool error chain — from first failure through retries
 * to either resolution or circuit-open.
 */
export interface ToolErrorTrace {
  /** Unique trace identifier. */
  traceId: string;
  /** Name of the tool that failed. */
  toolName: string;
  /** Session identifier (if available). */
  sessionId?: string;
  /** When the trace was created (first failure). */
  createdAt: string;
  /** When the trace was last updated. */
  updatedAt: string;
  /** Whether the tool eventually recovered. */
  resolved: boolean;
  /** Original arguments that caused the first failure. */
  originalArguments: Record<string, unknown>;
  /** All events in this trace, in chronological order. */
  events: TraceEvent[];
  /** Eventual resolution description (if resolved). */
  resolution?: string;
}

// ─── Error Rules ──────────────────────────────────────────────────────────

/**
 * A learned rule distilled from a resolved tool-error trace.
 * Injected into the system prompt to prevent the same mistake.
 */
export interface ErrorRule {
  /** Tool name this rule applies to. */
  toolName: string;
  /** Human-readable pattern: "when does this error happen?" */
  pattern: string;
  /** Root cause: "why does it happen?" */
  cause: string;
  /** Fix: "how was it resolved?" */
  fix: string;
  /** When the rule was created. */
  createdAt: string;
  /** Incremented when the pattern is confirmed again. */
  version: number;
}

/**
 * Lightweight summary of a trace for listing/indexing.
 */
export interface ErrorTraceSummary {
  traceId: string;
  toolName: string;
  createdAt: string;
  resolved: boolean;
  errorCount: number;
  firstError: string;
  resolution?: string;
}
