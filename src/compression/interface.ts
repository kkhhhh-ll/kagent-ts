import { MessageData } from "../messages/types";

/**
 * Result of performing compression on a message list.
 */
export interface CompressionResult {
  /** The compressed/conserved messages. */
  messages: MessageData[];
  /** Estimated tokens saved by compression (0 if not applied). */
  tokensSaved: number;
  /** Whether compression was actually applied. */
  applied: boolean;
}

/**
 * Strategy interface for context compression.
 * Implementations define how to reduce the message window when
 * the token limit is exceeded.
 */
export interface CompressionStrategy {
  /**
   * Compress the given messages to fit within the context window.
   * @param messages      The full list of messages.
   * @param systemMessage An optional system message to preserve.
   */
  compress(
    messages: MessageData[],
    systemMessage?: MessageData
  ): CompressionResult;
}
