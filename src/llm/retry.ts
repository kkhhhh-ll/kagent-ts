import { LLMNetworkError, NetworkErrorCause, RetryConfig } from "./errors";

// ─── RetryCallbacks ─────────────────────────────────────────────────────────

/**
 * Provider-specific callbacks that the generic retry wrapper delegates to
 * when deciding whether an error is retryable and how to classify it.
 */
export interface RetryCallbacks {
  /** Return true if the error is network-related and thus retryable. */
  isRetryable: (error: unknown) => boolean;
  /** Classify a retryable error into a NetworkErrorCause category. */
  classifyError: (error: unknown) => NetworkErrorCause;
}

// ─── withRetry ──────────────────────────────────────────────────────────────

/**
 * Wrap an async operation with network-error retry logic.
 *
 * Retry strategy:
 * - The `callbacks.isRetryable` predicate decides which errors are retried.
 * - Uses exponential backoff with full jitter: delay = base * 2^attempt * random(0.5, 1.0).
 * - Non-retryable errors propagate immediately.
 * - After all retries are exhausted, throws an `LLMNetworkError`.
 *
 * @param fn        The async operation to retry.
 * @param config    Retry configuration (maxRetries, baseDelayMs, maxDelayMs).
 * @param callbacks Provider-specific error classification callbacks.
 */
export async function withRetry<T>(
  fn: () => Promise<T> | PromiseLike<T>,
  config: Required<RetryConfig>,
  callbacks: RetryCallbacks,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = config;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Non-network errors propagate immediately (e.g., invalid API key, bad request)
      if (!callbacks.isRetryable(error)) throw error;

      if (attempt >= maxRetries) break; // all retries exhausted

      // Exponential backoff with full jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
        maxDelayMs,
      );

      // eslint-disable-next-line @typescript-eslint/no-loop-func
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted — wrap the final error
  const cause = callbacks.classifyError(lastError);
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new LLMNetworkError(message, cause);
}
