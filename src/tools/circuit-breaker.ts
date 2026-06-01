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
 * - CLOSED: Normal operation — executions are allowed.
 * - OPEN:   All retries exhausted — subsequent calls are blocked
 *           without attempting execution.
 *
 * Flow:
 *   1st failure → 2 retries remaining → LLM should analyze the error and retry
 *   2nd failure → 1 retry remaining
 *   3rd failure → circuit OPENS → LLM must try a different approach
 *   Success → failure count resets to zero
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
   * Whether the circuit is closed and the tool can be called.
   */
  get isAvailable(): boolean {
    return this._state === BreakerState.CLOSED;
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
   * Record a successful tool execution — resets failure count
   * and closes the circuit if it was open.
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this._state = BreakerState.CLOSED;
  }

  /**
   * Record a failed tool execution.
   * If all retries are exhausted, the circuit opens.
   *
   * @returns The updated number of retries remaining (0 means the circuit opened).
   */
  recordFailure(): number {
    this.failureCount++;
    if (this.failureCount > this.retryCount) {
      this._state = BreakerState.OPEN;
      return 0;
    }
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
