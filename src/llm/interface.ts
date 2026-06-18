import { Tool } from "../tools/types";
import { MessageData } from "../messages/types";

// ─── LLM Response Error Codes ────────────────────────────────────────────────

/**
 * Standardised error / quality codes for LLM responses.
 *
 * Unlike `LLMNetworkError` (thrown when the API call itself fails),
 * these codes describe issues with a successfully-received response
 * that may affect agent behaviour — truncated content, missing output, etc.
 */
export enum LLMResponseErrorCode {
  /** No issues detected. */
  OK = "ok",
  /**
   * The response was truncated because `max_tokens` was reached.
   * Tool call arguments or final answer may be incomplete.
   */
  MAX_TOKENS = "max_tokens",
  /**
   * The response content is empty (no text, no tool calls).
   * Typically indicates a model-side issue or extreme truncation.
   */
  EMPTY = "empty",
  /**
   * The structured JSON in the response content could not be parsed.
   * This is set by the agent after attempting to parse the LLM output.
   */
  INVALID_JSON = "invalid_json",
  /**
   * A non-specific quality issue — `stop_reason` is unusual or
   * the response otherwise looks degraded.
   */
  UNKNOWN = "unknown",
}

// ─── LLMResponse ─────────────────────────────────────────────────────────────

/**
 * Response returned by an LLM provider after a chat call.
 */
export interface LLMResponse {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /**
   * The reason the model stopped generating.
   * Examples: "end_turn", "tool_use", "max_tokens", "stop", "length".
   * Useful for detecting truncated output or tool-use signalling.
   */
  stop_reason?: string;
  /**
   * Response-level error / quality flag.
   * Set by the LLM provider when the response shows signs of degradation
   * (e.g., max_tokens truncation). Agents should check this before acting
   * on tool calls or final answers.
   */
  responseError?: {
    code: LLMResponseErrorCode;
    message: string;
  };
}

/**
 * A streaming chunk from the LLM, containing partial content or tool call data.
 */
export interface LLMStreamChunk {
  type: "chunk";
  /** Partial text content delta (may be empty string). */
  content?: string;
  /** Partial tool call deltas, identified by index. */
  tool_calls?: Array<{
    /** Index of the tool call in the overall list (used to correlate deltas). */
    index: number;
    /** Tool call id (typically appears only in the first delta for a given index). */
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * Terminal event emitted after all streaming chunks have been consumed.
 */
export interface LLMStreamDone {
  type: "done";
  /** Usage statistics, if available from the provider. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Union of all possible stream event types. */
export type LLMStreamEvent = LLMStreamChunk | LLMStreamDone;

/**
 * Abstract interface for LLM providers.
 * Concrete implementations (e.g., OpenAI, Anthropic) implement this.
 */
export interface LLMProvider {
  /** The model identifier (e.g. "gpt-4o", "gpt-4o-mini"). */
  readonly model: string;

  /**
   * Send a chat completion request (non-streaming).
   * @param messages  The conversation messages so far.
   * @param tools     Optional tool definitions for function calling.
   */
  chat(messages: MessageData[], tools?: Tool[]): Promise<LLMResponse>;

  /**
   * Send a chat completion request and yield events as they arrive.
   *
   * Yields {@link LLMStreamChunk} events for each delta, followed by a
   * single {@link LLMStreamDone} event when the stream completes.
   *
   * @param messages  The conversation messages so far.
   * @param tools     Optional tool definitions for function calling.
   */
  chatStream(messages: MessageData[], tools?: Tool[]): AsyncIterable<LLMStreamEvent>;

  /**
   * Count tokens in a text string.
   * Uses tiktoken (by model name) when available, falling back to heuristic estimation.
   *
   * @param text The text to tokenize.
   * @param model Optional model override. Defaults to the provider's own model.
   */
  getTokenCount(text: string, model?: string): number;
}
