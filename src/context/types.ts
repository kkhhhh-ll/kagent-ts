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
   * Token count threshold at which compression triggers (as a fraction of maxTokens).
   * When `currentTokens >= maxTokens * compressionThresholdRatio`, compression fires.
   * Default: 0.75 (compression fires at ~75% of context).
   */
  compressionThresholdRatio: number;

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
