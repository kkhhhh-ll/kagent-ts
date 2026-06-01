import { MessageData } from "../messages/types";
import { CompressionStrategy, CompressionResult } from "./interface";
import { CompressionConfig } from "./types";

/**
 * Sliding window compression strategy.
 *
 * Preserves:
 * 1. The system message (if present and configured to keep it)
 * 2. The last N messages (most recent conversation turns)
 *
 * Everything in between is discarded.
 */
export class SlidingWindowCompression implements CompressionStrategy {
  private config: CompressionConfig;

  /**
   * Default config: keep the last 20 messages, preserve system messages.
   */
  constructor(config?: Partial<CompressionConfig>) {
    this.config = {
      strategy: "sliding_window",
      keepLastN: config?.keepLastN ?? 20,
      keepSystemMessages: config?.keepSystemMessages ?? true,
    };
  }

  compress(
    messages: MessageData[],
    systemMessage?: MessageData
  ): CompressionResult {
    const originalLength = messages.length;
    const preserved: MessageData[] = [];

    // 1. Preserve the explicit system message if provided
    if (systemMessage && this.config.keepSystemMessages) {
      preserved.push(systemMessage);
    }

    // 2. Take the last N messages
    const recent = messages.slice(-this.config.keepLastN);
    preserved.push(...recent);

    // 3. De-duplicate system message if it appears both in messages and param
    if (systemMessage && this.config.keepSystemMessages) {
      // If the system message from the param also appeared in the recent slice,
      // remove the duplicate from the recent slice
      const systemIndex = preserved.findIndex(
        (m, i) =>
          i > 0 && m.role === "system" && m.content === systemMessage.content
      );
      if (systemIndex > 0) {
        // The system message from the param is at index 0.
        // Remove the duplicate entry later in the list.
        preserved.splice(systemIndex, 1);
      }
    }

    const removed = originalLength + (systemMessage ? 1 : 0) - preserved.length;

    return {
      messages: preserved,
      removedCount: Math.max(0, removed),
      applied: removed > 0,
    };
  }
}
