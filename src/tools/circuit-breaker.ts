import { BreakerState, BreakerStatus } from "./types";

/**
 * Configuration for a circuit breaker instance.
 */
export interface CircuitBreakerConfig {
  /** Tool name this breaker protects. */
  toolName: string;

  /**
   * Number of retries allowed after the first failure.
   * The effective maximum attempts = retryCount + 1.
   * Default: 2 (3 total attempts before the circuit opens).
   */
  retryCount?: number;
}

/**
 * Circuit breaker that tracks consecutive failures for a single tool.
 *
 * States:
 * - CLOSED:    Normal operation — no failures, executions are allowed.
 * - HALF_OPEN: Degraded operation — failures have occurred but retries
 *              remain. Tool calls are still allowed, but the caller
 *              should proceed with caution.
 * - OPEN:      All retries exhausted — subsequent calls are blocked
 *              without attempting execution.
 *
 * Flow (with retryCount = 2):
 *   1st failure → HALF_OPEN, 1 retry remaining → LLM should analyze and retry
 *   2nd failure → HALF_OPEN, 0 retries remaining → last chance
 *   3rd failure → circuit OPENS → LLM must try a different approach
 *   Success     → circuit returns to CLOSED, failure count resets
 */
export class CircuitBreaker {
  private toolName: string;
  private retryCount: number;
  private failureCount = 0;
  private _state: BreakerState = BreakerState.CLOSED;

  constructor(config: CircuitBreakerConfig) {
    this.toolName = config.toolName;
    this.retryCount = config.retryCount ?? 2;
  }

  /**
   * Whether the tool can be called.
   * Returns true in CLOSED (normal) and HALF_OPEN (degraded) states.
   * Only returns false when the circuit is fully OPEN.
   */
  get isAvailable(): boolean {
    return this._state === BreakerState.CLOSED || this._state === BreakerState.HALF_OPEN;
  }

  /**
   * Current breaker state.
   */
  get state(): BreakerState {
    return this._state;
  }

  /**
   * Current consecutive failure count.
   */
  get currentFailureCount(): number {
    return this.failureCount;
  }

  /**
   * How many retries remain before the circuit opens.
   * When this reaches 0 and another failure occurs, the circuit opens.
   */
  get retriesRemaining(): number {
    return Math.max(0, this.retryCount - this.failureCount);
  }

  /**
   * The total number of consecutive failures that would open the circuit.
   */
  get effectiveThreshold(): number {
    return this.retryCount + 1;
  }

  /**
   * Record a successful tool execution.
   *
   * - From CLOSED or HALF_OPEN: resets failure count and closes the circuit.
   * - From OPEN: transitions to HALF_OPEN (recovery probe). The next call
   *   will determine whether recovery is confirmed (→ CLOSED) or failed
   *   (→ back to OPEN).
   */
  recordSuccess(): void {
    if (this._state === BreakerState.OPEN) {
      // Recovery probe — enter HALF_OPEN to give the tool one chance
      this.failureCount = 0;
      this._state = BreakerState.HALF_OPEN;
    } else {
      // CLOSED or HALF_OPEN — full recovery
      this.failureCount = 0;
      this._state = BreakerState.CLOSED;
    }
  }

  /**
   * Record a failed tool execution.
   *
   * State transitions:
   * - CLOSED    → HALF_OPEN (first failure, retries remain)
   * - HALF_OPEN → HALF_OPEN (still have retries) or OPEN (retries exhausted)
   * - OPEN      → stays OPEN (should not normally be called in this state)
   *
   * @returns The updated number of retries remaining (0 means the circuit opened).
   */
  recordFailure(): number {
    this.failureCount++;
    if (this.failureCount > this.retryCount) {
      this._state = BreakerState.OPEN;
      return 0;
    }
    // First failure or still within retry budget — enter/remain HALF_OPEN
    this._state = BreakerState.HALF_OPEN;
    return this.retriesRemaining;
  }

  /**
   * Manually reset the breaker back to CLOSED.
   */
  reset(): void {
    this.failureCount = 0;
    this._state = BreakerState.CLOSED;
  }

  /**
   * Get a snapshot of the current breaker status.
   */
  getStatus(): BreakerStatus {
    return {
      toolName: this.toolName,
      state: this._state,
      failureCount: this.failureCount,
      failureThreshold: this.effectiveThreshold,
      available: this.isAvailable,
    };
  }
}
