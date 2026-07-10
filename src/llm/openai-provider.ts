import OpenAI from "openai";
import { Stream } from "openai/streaming";
import { LLMProvider, LLMResponse, LLMStreamEvent, LLMResponseErrorCode } from "./interface";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";
import { countTokens } from "../utils/token-counter";

// ─── Shared error types (re-exported for backward compatibility) ─────────────

export { LLMNetworkError, type NetworkErrorCause, type RetryConfig } from "./errors";

// ─── OpenAIRetryConfig (deprecated alias) ────────────────────────────────────

/**
 * @deprecated Use `RetryConfig` from `"./errors"` instead.
 */
export type { RetryConfig as OpenAIRetryConfig } from "./errors";

// ─── OpenAI-specific network error helpers ───────────────────────────────────

/**
 * Check whether an error is network-related and thus retryable.
 * OpenAI-provider specific: checks `OpenAI.APIError` status codes.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "LLMNetworkError") return true;

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
      msg.includes("econnaborted")
    );
  }

  return false;
}

/**
 * Map a raw error to its NetworkErrorCause category.
 * OpenAI-provider specific: checks `OpenAI.APIError` status codes.
 */
function classifyError(error: unknown): import("./errors").NetworkErrorCause {
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

// ─── Imports for shared retry ────────────────────────────────────────────────

import { type RetryConfig } from "./errors";
import { withRetry } from "./retry";

// ─── OpenAIConfig ────────────────────────────────────────────────────────────

/**
 * Configuration options for the OpenAI LLM provider.
 */
export interface OpenAIConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
  /** Retry configuration for network resilience. */
  retry?: RetryConfig;
  /** Request timeout in ms (default: none — SDK default ~10 min). */
  timeout?: number;
}

// ─── OpenAIProvider ──────────────────────────────────────────────────────────

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
  private retryConfig: Required<RetryConfig>;
  private timeout: number | undefined;

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    if (!config.model) {
      throw new Error(
        "OpenAIProvider: `model` is required. " +
        "Provide a model name (e.g. \"gpt-4o\", \"gpt-4o-mini\", \"claude-sonnet-4-6\") " +
        "when constructing the provider."
      );
    }
    this.model = config.model;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeout = config.timeout;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
      maxDelayMs: config.retry?.maxDelayMs ?? 30000,
    };
  }

  async chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse> {
    // Convert internal Tool definitions to OpenAI tool format
    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    const response = await withRetry<OpenAI.Chat.ChatCompletion>(
      () =>
        this.client.chat.completions.create(
          {
            model: this.model,
            messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            tools: openaiTools,
          },
          {
            signal,
            ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
          },
        ),
      this.retryConfig,
      { isRetryable: isNetworkError, classifyError },
    );

    const choice = response.choices[0];
    const message = choice.message;

    const result: LLMResponse = {
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
      stop_reason: choice.finish_reason ?? undefined,
      providerMeta: {
        model: this.model,
        isFallback: false,
      },
    };

    // Flag response-level quality issues
    if (choice.finish_reason === "length") {
      result.responseError = {
        code: LLMResponseErrorCode.MAX_TOKENS,
        message: "Response truncated: max_tokens reached. Content or tool call arguments may be incomplete.",
      };
    }

    return result;
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
    signal?: AbortSignal,
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
    const stream = await withRetry<Stream<OpenAI.Chat.ChatCompletionChunk>>(
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
          {
            signal,
            ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
          },
        )) as unknown as Stream<OpenAI.Chat.ChatCompletionChunk>
      ,
      this.retryConfig,
      { isRetryable: isNetworkError, classifyError },
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
        const finishReason = chunk.choices?.[0]?.finish_reason ?? undefined;
        yield {
          type: "done",
          usage: {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          },
          stop_reason: finishReason === "stop" ? undefined : (finishReason || undefined),
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
}
