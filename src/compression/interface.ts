import { MessageData } from "../messages/types";

/**
 * Structured details about which compression steps were applied and what
 * they removed.  Used by tracers / loggers to render a human-readable
 * summary of the compression pass.
 */
export interface CompressionDetails {
  /** Which steps were applied, in order (e.g. ["step1", "step2", "step4"]). */
  stepsApplied: string[];

  /** Step 2: number of full turns that were archived. */
  turnsArchived?: number;
  /** Step 2: number of user requests preserved in the archive marker. */
  archivedRequests?: number;

  /** Step 3: number of tool results whose content was replaced with a
   *  "removed" placeholder. */
  staleToolsRemoved?: number;

  /** Step 4: number of turns that were summarised by the LLM. */
  summaryTurns?: number;
  /** Step 4: first ~200 chars of the LLM-generated summary (for preview). */
  summaryPreview?: string;
}

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
  /** Per-step details for trace / log rendering. */
  details: CompressionDetails;
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
