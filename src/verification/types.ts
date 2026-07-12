/**
 * Structured output from the VerifyAgent fork.
 */
export interface VerificationResult {
  /** Whether the answer meets the quality threshold. */
  valid: boolean;
  /** Quality score 0-100 (100 = flawless). */
  score: number;
  /** Specific issues found (empty if valid). */
  issues: string[];
  /** Brief assessment summary. */
  assessment: string;
}

/**
 * Input provided to the VerifyAgent for review.
 */
export interface VerificationInput {
  /** The original user query. */
  userQuery: string;
  /** The final answer to verify. */
  answer: string;
}
