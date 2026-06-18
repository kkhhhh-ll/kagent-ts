// ─── Shared LLM Error Types ─────────────────────────────────────────────────

/**
 * Categories of network-related LLM failures.
 * Used by both OpenAI and Anthropic providers.
 */
export type NetworkErrorCause =
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "dns_error"
  | "rate_limit"
  | "server_error"
  | "aborted"
  | "unknown_network";

/**
 * Thrown by an LLM provider when all retry attempts for a network-related
 * failure have been exhausted. The agent catches this to save a checkpoint
 * and guide the user to resume their session.
 */
export class LLMNetworkError extends Error {
  public readonly cause: NetworkErrorCause;

  constructor(message: string, cause: NetworkErrorCause) {
    super(message);
    this.name = "LLMNetworkError";
    this.cause = cause;
  }
}

// ─── RetryConfig ────────────────────────────────────────────────────────────

/**
 * Retry configuration shared by all LLM providers.
 */
export interface RetryConfig {
  /** Max retry attempts for network errors (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default: 1000). */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30000). */
  maxDelayMs?: number;
}
