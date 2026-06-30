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
   * Tokens reserved per call for the LLM's output.
   *
   * `checkBeforeCall()` adds this to the estimated input so the circuit breaker
   * accounts for the output that the call will produce.  Without a reserve the
   * budget can be exceeded when the LLM returns many completion tokens.
   *
   * Default: 0 (backward-compatible — budget is enforced after the fact via
   * `recordUsage()`).
   */
  reservedOutputTokens?: number;

  /**
   * Warn via the logger when usage exceeds this fraction of the budget.
   * Default: 0.8 (80 %).
   */
  warnThreshold?: number;

  /**
   * Pricing model for cost estimation.
   * Prices are per 1,000 tokens (standard LLM pricing unit).
   *
   * @example
   * ```ts
   * // GPT-4o
   * pricing: { inputPricePer1K: 0.0025, outputPricePer1K: 0.01 }
   * ```
   */
  pricing?: {
    inputPricePer1K: number;
    outputPricePer1K: number;
  };
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

/** Cumulative cost breakdown for the current session. */
export interface TokenBudgetCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

// ─── TokenBudget ─────────────────────────────────────────────────────────────

export class TokenBudget {
  private maxTotalTokens: number;
  private reservedOutputTokens: number;
  private warnThreshold: number;
  private pricing?: { inputPricePer1K: number; outputPricePer1K: number };
  private totalTokensUsed = 0;
  private inputTokensUsed = 0;
  private outputTokensUsed = 0;
  private callCount = 0;
  private warned = false;

  constructor(config: TokenBudgetConfig) {
    this.maxTotalTokens = config.maxTotalTokens;
    this.reservedOutputTokens = config.reservedOutputTokens ?? 0;
    this.warnThreshold = config.warnThreshold ?? 0.8;
    this.pricing = config.pricing;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Record token usage from a completed LLM call.
   * Called after the LLM response is received.
   */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this.totalTokensUsed += promptTokens + completionTokens;
    this.inputTokensUsed += promptTokens;
    this.outputTokensUsed += completionTokens;
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
    const projected = this.totalTokensUsed + estimatedInputTokens + this.reservedOutputTokens;
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
   * Get the cumulative cost of the current session.
   * Returns all zeros if no pricing model was configured.
   */
  getSessionCost(): TokenBudgetCost {
    const inputCost = this.pricing
      ? Math.round(this.inputTokensUsed / 1000 * this.pricing.inputPricePer1K * 10000) / 10000
      : 0;
    const outputCost = this.pricing
      ? Math.round(this.outputTokensUsed / 1000 * this.pricing.outputPricePer1K * 10000) / 10000
      : 0;

    return {
      inputTokens: this.inputTokensUsed,
      outputTokens: this.outputTokensUsed,
      totalTokens: this.totalTokensUsed,
      inputCost,
      outputCost,
      totalCost: Math.round((inputCost + outputCost) * 10000) / 10000,
    };
  }

  /**
   * Reset the budget for a new conversation.
   */
  reset(): void {
    this.totalTokensUsed = 0;
    this.inputTokensUsed = 0;
    this.outputTokensUsed = 0;
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
