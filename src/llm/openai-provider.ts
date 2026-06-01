import OpenAI from "openai";
import { Stream } from "openai/streaming";
import { LLMProvider, LLMResponse, LLMStreamEvent } from "./interface";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";
import { countTokens } from "../utils/token-counter";

// ─── Error Types ───────────────────────────────────────────────────────────

/**
 * Categories of network-related LLM failures.
 */
export type NetworkErrorCause =
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "dns_error"
  | "rate_limit"
  | "server_error"
  | "aborted"
  | "unknown_network";

/**
 * Thrown by the LLM provider when all retry attempts for a network-related
 * failure have been exhausted. The agent catches this to save a checkpoint
 * and guide the user to resume their session.
 */
export class LLMNetworkError extends Error {
  public readonly cause: NetworkErrorCause;

  constructor(message: string, cause: NetworkErrorCause) {
    super(message);
    this.name = "LLMNetworkError";
    this.cause = cause;
  }
}

/**
 * Check whether an error is network-related and thus retryable.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof LLMNetworkError) return true;

  if (error instanceof OpenAI.APIError) {
    // 429 (rate-limit) and 5xx (server) are retryable
    if (error.status === 429) return true;
    if (error.status !== undefined && error.status >= 500 && error.status < 600) return true;
    return false;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket hang up") ||
      msg.includes("econnaborted") ||
      msg.includes("abort")
    );
  }

  return false;
}

/**
 * Map a raw error to its NetworkErrorCause category.
 */
function classifyError(error: unknown): NetworkErrorCause {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return "rate_limit";
    if (error.status !== undefined && error.status >= 500) return "server_error";
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("abort")) return "aborted";
    if (msg.includes("timeout")) return "timeout";
    if (msg.includes("econnrefused")) return "connection_refused";
    if (msg.includes("econnreset")) return "connection_reset";
    if (msg.includes("enotfound") || msg.includes("dns")) return "dns_error";
  }
  return "unknown_network";
}

// ─── OpenAIRetryConfig ─────────────────────────────────────────────────────

export interface OpenAIRetryConfig {
  /** Max retry attempts for network errors (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default: 1000). */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30000). */
  maxDelayMs?: number;
}

// ─── OpenAIConfig ──────────────────────────────────────────────────────────

/**
 * Configuration options for the OpenAI LLM provider.
 */
export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
  /** Retry configuration for network resilience. */
  retry?: OpenAIRetryConfig;
  /** Request timeout in ms (default: none — SDK default ~10 min). */
  timeout?: number;
}

// ─── OpenAIProvider ────────────────────────────────────────────────────────

/**
 * OpenAI implementation of the LLMProvider interface.
 * Uses the official `openai` npm package.
 *
 * Features:
 * - Tool/function calling support
 * - Network error retry with exponential backoff
 * - Configurable timeout
 * - Token counting via tiktoken (with model-aware encoding)
 */
export class OpenAIProvider implements LLMProvider {
  public readonly model: string;
  private client: OpenAI;
  private temperature: number;
  private maxTokens: number;
  private retryConfig: Required<OpenAIRetryConfig>;
  private timeout: number | undefined;

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model ?? "gpt-4o";
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeout = config.timeout;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
      maxDelayMs: config.retry?.maxDelayMs ?? 30000,
    };
  }

  async chat(messages: MessageData[], tools?: Tool[]): Promise<LLMResponse> {
    // Convert internal Tool definitions to OpenAI tool format
    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    const response = await this.withRetry<OpenAI.Chat.ChatCompletion>(() =>
      this.client.chat.completions.create(
        {
          model: this.model,
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          tools: openaiTools,
        },
        { timeout: this.timeout }
      )
    );

    const choice = response.choices[0];
    const message = choice.message;

    return {
      content: message.content ?? "",
      tool_calls: message.tool_calls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Streaming chat completion.
   *
   * Yields content and tool call deltas as they arrive from the API,
   * then emits a single `"done"` event with usage statistics (when available).
   *
   * Note: The retry logic only covers the initial connection. If the stream
   * drops mid-response, the consumer sees an incomplete stream and the
   * agent's outer loop handles the error on the next LLM call.
   */
  async *chatStream(
    messages: MessageData[],
    tools?: Tool[],
  ): AsyncIterable<LLMStreamEvent> {
    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    // Retry only the initial stream creation — not mid-stream drops.
    // Use async wrapper so TypeScript treats APIPromise → Promise correctly.
    const stream = await this.withRetry<Stream<OpenAI.Chat.ChatCompletionChunk>>(
      async () =>
        (await this.client.chat.completions.create(
          {
            model: this.model,
            messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            tools: openaiTools,
            stream: true,
            stream_options: { include_usage: true },
          },
          { timeout: this.timeout }
        )) as unknown as Stream<OpenAI.Chat.ChatCompletionChunk>
    );

    let emittedDone = false;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        yield { type: "chunk", content: delta.content };
      }

      if (delta?.tool_calls) {
        yield {
          type: "chunk",
          tool_calls: delta.tool_calls.map((tc) => ({
            index: tc.index,
            id: tc.id,
            function: tc.function
              ? { name: tc.function.name, arguments: tc.function.arguments }
              : undefined,
          })),
        };
      }

      // The final chunk may carry usage when stream_options.include_usage is set.
      if (chunk.usage) {
        emittedDone = true;
        yield {
          type: "done",
          usage: {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          },
        };
      }
    }

    // Always yield a done event — providers that don't support usage still need
    // a terminal signal so consumers know the stream is complete.
    if (!emittedDone) {
      yield { type: "done" };
    }
  }

  /**
   * Count tokens using tiktoken (with model-aware encoding) when available.
   * Falls back to character-based estimation if tiktoken is not installed.
   *
   * @param text  The text to tokenize.
   * @param model Optional model override. Defaults to this provider's model.
   */
  getTokenCount(text: string, model?: string): number {
    return countTokens(text, model ?? this.model);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Wrap an async operation with network-error retry logic.
   *
   * Retry strategy:
   * - Only network-related errors (timeout, connection reset, 429, 5xx) are retried.
   * - Uses exponential backoff with full jitter: delay = base * 2^attempt * random(0.5, 1.0).
   * - Non-retryable errors (401, 400, abort) propagate immediately.
   * - After all retries are exhausted, throws `LLMNetworkError`.
   */
  private async withRetry<T>(fn: () => Promise<T> | PromiseLike<T>): Promise<T> {
    const { maxRetries, baseDelayMs, maxDelayMs } = this.retryConfig;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;

        // Non-network errors propagate immediately (e.g. invalid API key)
        if (!isNetworkError(error)) throw error;

        if (attempt >= maxRetries) break; // all retries exhausted

        // Exponential backoff with full jitter
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
          maxDelayMs,
        );

        // eslint-disable-next-line @typescript-eslint/no-loop-func
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted — wrap the final error
    const cause = classifyError(lastError);
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMNetworkError(message, cause);
  }
}
