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
  /** Execute the tool with the given arguments and return a result string. */
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Current state of a circuit breaker for a specific tool.
 */
export enum BreakerState {
  /** Normal operation — tool calls are allowed. */
  CLOSED = "closed",
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
  type: "failure" | "retry" | "recovery" | "circuit_open" | "analysis";
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
