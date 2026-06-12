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
   * When the remaining free tokens drop below this value, compression triggers.
   * Default: 20000 (trigger at ~16% remaining).
   *
   * Trigger condition: `currentTokens >= maxTokens - compressionThreshold`
   */
  compressionThreshold: number;

  /**
   * Number of conversation turns to preserve in Step 2 of compression.
   * Default: 40.
   */
  keepTurns: number;

  /**
   * Number of turns to keep unsummarized in Step 4 (LLM summarization).
   * Default: 10.
   */
  summaryKeepTurns: number;

  /**
   * Tool results older than this (ms) are candidates for removal in Step 3.
   * Default: 3600000 (60 minutes).
   */
  toolResultMaxAgeMs: number;

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
