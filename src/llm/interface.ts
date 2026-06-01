import { Tool } from "../tools/types";
import { MessageData } from "../messages/types";

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
