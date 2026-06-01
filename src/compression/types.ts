/**
 * Configuration for the compression module.
 */
export interface CompressionConfig {
  /** The compression strategy to use. */
  strategy: "sliding_window";

  /** Number of messages to preserve when compression is triggered. */
  keepLastN: number;

  /** Whether to always keep system messages. */
  keepSystemMessages: boolean;
}
