import { CompressionConfig } from "../compression/types";

/**
 * Configuration for the context manager.
 */
export interface ContextConfig {
  /**
   * Maximum total tokens the context window can hold.
   * Default: 128000 (GPT-4o context length).
   */
  maxTokens: number;

  /**
   * Free tokens to reserve when compression fires.
   *
   * Two modes (auto-detected by value):
   * - **Absolute** (`>= 1`):  reserve this many tokens. Default 20000.
   * - **Ratio**   (`< 1`):   reserve this fraction of maxTokens.
   *   Must be ≤ 0.25 so the trigger point is ≥ 75 % of the window.
   *
   * Trigger condition: `currentTokens >= maxTokens - reserve` where
   * `reserve = threshold (< 1 ? maxTokens * threshold : threshold)`.
   */
  compressionThreshold: number;

  /**
   * Number of conversation turns to preserve in Step 2 of compression.
   * Default: 40.
   */
  keepTurns: number;

  /**
   * Tool results older than this (ms) are candidates for removal in Step 3.
   * Default: 3600000 (60 minutes).
   */
  toolResultMaxAgeMs: number;

  /**
   * Number of recent turns to keep verbatim in Step 4 (LLM summarization).
   * Turns older than this are compressed into a summary; turns within this
   * window are preserved in full. Default: 10.
   */
  summaryKeepTurns: number;

  /**
   * Compression strategy configuration.
   */
  compression?: Partial<CompressionConfig>;
}

/**
 * Current state of the context window.
 */
export interface ContextState {
  /** Total token count of all messages in the window. */
  currentTokens: number;
  /** Number of messages in the window. */
  messageCount: number;
  /** Whether compression has been applied. */
  isCompressed: boolean;
  /** The max token limit. */
  maxTokens: number;
}
