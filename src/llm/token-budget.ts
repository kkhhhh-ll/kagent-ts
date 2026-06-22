/**
 * Token Budget — session-level circuit breaker that stops LLM calls when
 * a cumulative token limit is exceeded.
 *
 * The check runs in the agent loop BEFORE each LLM call (with an estimated
 * input size) and usage is recorded AFTER each successful response (using
 * the actual token counts from the LLM provider).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenBudgetConfig {
  /** Maximum total tokens allowed across all LLM calls in a session (input + output). */
  maxTotalTokens: number;

  /**
   * Warn via the logger when usage exceeds this fraction of the budget.
   * Default: 0.8 (80 %).
   */
  warnThreshold?: number;
}

export interface TokenBudgetStatus {
  /** Total tokens consumed so far (input + output). */
  totalTokensUsed: number;
  /** Budget ceiling. */
  maxTotalTokens: number;
  /** Tokens remaining before exhaustion. */
  remainingTokens: number;
  /** Whether the budget has been fully exhausted. */
  isExhausted: boolean;
  /** Number of LLM calls tracked. */
  callCount: number;
}

// ─── TokenBudget ─────────────────────────────────────────────────────────────

export class TokenBudget {
  private maxTotalTokens: number;
  private warnThreshold: number;
  private totalTokensUsed = 0;
  private callCount = 0;
  private warned = false;

  constructor(config: TokenBudgetConfig) {
    this.maxTotalTokens = config.maxTotalTokens;
    this.warnThreshold = config.warnThreshold ?? 0.8;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Record token usage from a completed LLM call.
   * Called after the LLM response is received.
   */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this.totalTokensUsed += promptTokens + completionTokens;
    this.callCount++;
  }

  /**
   * Check whether the budget allows another LLM call.
   *
   * @param estimatedInputTokens  Estimated tokens in the upcoming request
   *                              (system prompt + context messages).
   * @returns Status snapshot. Callers should check `isExhausted` before
   *          making the LLM call.
   */
  checkBeforeCall(estimatedInputTokens: number): TokenBudgetStatus {
    const projected = this.totalTokensUsed + estimatedInputTokens;
    return {
      totalTokensUsed: this.totalTokensUsed,
      maxTotalTokens: this.maxTotalTokens,
      remainingTokens: Math.max(0, this.maxTotalTokens - projected),
      isExhausted: projected >= this.maxTotalTokens,
      callCount: this.callCount,
    };
  }

  /**
   * Whether the budget has been warned about (passed `warnThreshold`).
   * Returns true exactly once per threshold crossing — the flag resets
   * after this call so the warning fires only once.
   */
  shouldWarn(): boolean {
    if (this.warned) return false;
    const ratio = this.totalTokensUsed / this.maxTotalTokens;
    if (ratio >= this.warnThreshold) {
      this.warned = true;
      return true;
    }
    return false;
  }

  /**
   * Reset the budget for a new conversation.
   */
  reset(): void {
    this.totalTokensUsed = 0;
    this.callCount = 0;
    this.warned = false;
  }

  /**
   * Get a read-only snapshot of the current budget.
   */
  getStatus(): TokenBudgetStatus {
    return {
      totalTokensUsed: this.totalTokensUsed,
      maxTotalTokens: this.maxTotalTokens,
      remainingTokens: Math.max(0, this.maxTotalTokens - this.totalTokensUsed),
      isExhausted: this.totalTokensUsed >= this.maxTotalTokens,
      callCount: this.callCount,
    };
  }
}
