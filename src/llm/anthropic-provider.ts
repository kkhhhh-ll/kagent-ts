import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/resources/messages/messages";
import { LLMProvider, LLMResponse, LLMStreamEvent, LLMResponseErrorCode } from "./interface";
import { MessageData, Role } from "../messages/types";
import { Tool } from "../tools/types";
import { countTokens } from "../utils/token-counter";
import { LLMNetworkError, NetworkErrorCause, RetryConfig } from "./errors";
import { withRetry, RetryCallbacks } from "./retry";

// ─── Anthropic-specific network error helpers ────────────────────────────────

/**
 * Check whether an error is network-related and thus retryable.
 * Anthropic-provider specific: checks `Anthropic.APIError` status codes.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "LLMNetworkError") return true;

  if (error instanceof Anthropic.APIError) {
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
      msg.includes("econnaborted") ||
      msg.includes("enotfound") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket hang up")
    );
  }

  return false;
}

/**
 * Map a raw error to its NetworkErrorCause category.
 * Anthropic-provider specific: checks `Anthropic.APIError` status codes.
 */
function classifyError(error: unknown): NetworkErrorCause {
  if (error instanceof Anthropic.APIError) {
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

// ─── AnthropicConfig ─────────────────────────────────────────────────────────

/**
 * Maximum output tokens for Anthropic models.
 * Claude 4.x models support up to 16384. Default is 8192 to balance
 * output capacity with token cost.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Configuration options for the Anthropic LLM provider.
 */
export interface AnthropicConfig {
  /** Anthropic API key. */
  apiKey: string;
  /** Model identifier (e.g. "claude-sonnet-4-6", "claude-opus-4-8"). */
  model: string;
  /** Sampling temperature (default: 0.7). */
  temperature?: number;
  /** Maximum output tokens (default: 8192). */
  maxTokens?: number;
  /** Custom base URL for proxies or alternative Anthropic-compatible endpoints. */
  baseURL?: string;
  /** Retry configuration for network resilience. */
  retry?: RetryConfig;
  /** Request timeout in ms (default: none). */
  timeout?: number;

  /**
   * Enable Anthropic prompt caching on the system prompt.
   *
   * When `true`, the system prompt is sent as a content block with
   * `cache_control: { type: "ephemeral" }`. Cached tokens are billed at
   * 10 % of the normal input price, and the cache TTL is 5 minutes
   * (refreshed on each hit).
   *
   * Best for agents with a **static** system prompt (e.g. ReActAgent).
   * For PlanSolveAgent the plan-progress section changes each iteration
   * which breaks cache hits — only enable if you accept cache misses.
   *
   * Minimum 1 024 tokens for caching to activate (Anthropic API requirement).
   * Default: `false`.
   */
  cacheSystemPrompt?: boolean;
}

/** Retry callbacks shared by all AnthropicProvider instances. */
const anthropicRetryCallbacks: RetryCallbacks = {
  isRetryable: isNetworkError,
  classifyError,
};

// ─── AnthropicProvider ───────────────────────────────────────────────────────

/**
 * Anthropic implementation of the LLMProvider interface.
 * Uses the official `@anthropic-ai/sdk` npm package.
 *
 * Features:
 * - Tool/function calling support
 * - Network error retry with exponential backoff (chat only)
 * - Configurable timeout
 * - Token counting via tiktoken (with model-aware encoding, falls back for Claude models)
 *
 * Message format conversion:
 * The internal `MessageData[]` format (OpenAI-compatible) is converted to
 * Anthropic's native format transparently:
 * - System messages are extracted and passed as the top-level `system` parameter.
 * - Tool messages (role "tool") become user messages with `tool_result` content blocks.
 * - Assistant messages with tool_calls become content-block arrays with `tool_use` blocks.
 */
export class AnthropicProvider implements LLMProvider {
  public readonly model: string;
  private client: Anthropic;
  private temperature: number;
  private maxTokens: number;
  private retryConfig: Required<RetryConfig>;
  private timeout: number | undefined;
  private cacheSystemPrompt: boolean;

  constructor(config: AnthropicConfig) {
    if (!config.model) {
      throw new Error(
        "AnthropicProvider: `model` is required. " +
        "Provide a model name (e.g. \"claude-sonnet-4-6\", \"claude-opus-4-8\") " +
        "when constructing the provider."
      );
    }

    this.model = config.model;

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout,
      maxRetries: 0, // We handle retries ourselves via withRetry
    });
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeout = config.timeout;
    this.cacheSystemPrompt = config.cacheSystemPrompt ?? false;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
      maxDelayMs: config.retry?.maxDelayMs ?? 30000,
    };
  }

  // ─── LLMProvider Implementation ─────────────────────────────────────────

  /**
   * Build the `system` parameter for the Anthropic API.
   * When `cacheSystemPrompt` is enabled and the system prompt is non-empty,
   * wraps it in a content block with `cache_control` so Anthropic caches it.
   */
  private buildSystemParam(
    systemPrompt: string | undefined,
  ): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined {
    if (!systemPrompt) return undefined;
    if (!this.cacheSystemPrompt) return systemPrompt;

    return [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ] as Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  }

  async chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse> {
    const { systemPrompt, formattedMessages } = AnthropicProvider.convertMessages(messages);
    const anthropicTools = tools?.length ? AnthropicProvider.convertTools(tools) : undefined;

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          system: this.buildSystemParam(systemPrompt),
          messages: formattedMessages,
          tools: anthropicTools,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }, { signal }),
      this.retryConfig,
      anthropicRetryCallbacks,
    );

    return AnthropicProvider.convertResponse(response, this.model);
  }

  async *chatStream(
    messages: MessageData[],
    tools?: Tool[],
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    const { systemPrompt, formattedMessages } = AnthropicProvider.convertMessages(messages);
    const anthropicTools = tools?.length ? AnthropicProvider.convertTools(tools) : undefined;

    // The Anthropic SDK's stream() is synchronous — it returns a MessageStream
    // without initiating a network request. The actual connection happens on
    // first iteration. We retry the initial stream setup only (which may fail
    // for auth/config errors), but NOT mid-stream drops — those are handled
    // by the agent's outer loop, same as the OpenAI provider.
    const stream: MessageStream = await withRetry(
      async () =>
        this.client.messages.stream({
          model: this.model,
          system: this.buildSystemParam(systemPrompt),
          messages: formattedMessages,
          tools: anthropicTools,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }, { signal }),
      this.retryConfig,
      anthropicRetryCallbacks,
    );

    let emittedDone = false;

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            yield {
              type: "chunk",
              tool_calls: [
                {
                  index: event.index,
                  id: event.content_block.id,
                  function: { name: event.content_block.name },
                },
              ],
            };
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "chunk", content: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            yield {
              type: "chunk",
              tool_calls: [
                {
                  index: event.index,
                  function: { arguments: event.delta.partial_json },
                },
              ],
            };
          }
          break;
      }
    }

    // Retrieve usage from the final message. If the stream was aborted or
    // the network dropped, finalMessage() throws — we catch and still emit
    // a terminal "done" event so consumers don't hang.
    try {
      const finalMessage = await stream.finalMessage();
      if (finalMessage.usage) {
        emittedDone = true;
        yield {
          type: "done",
          usage: {
            prompt_tokens: finalMessage.usage.input_tokens,
            completion_tokens: finalMessage.usage.output_tokens,
            total_tokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
          },
        };
      }
    } catch (err) {
      // Stream terminated abnormally — usage stats unavailable.
      console.warn(
        "[AnthropicProvider] failed to retrieve final message stats:",
        err instanceof Error ? err.message : err,
      );
    }

    if (!emittedDone) {
      yield { type: "done" };
    }
  }

  /**
   * Count tokens using tiktoken (with model-aware encoding) when available.
   * Falls back to character-based estimation if tiktoken is not installed.
   *
   * Note: Claude models are not recognized by tiktoken's `encoding_for_model()`,
   * so it falls through to the generic `o200k_base` encoding, which is a
   * reasonable approximation for Claude's tokenizer.
   *
   * @param text  The text to tokenize.
   * @param model Optional model override. Defaults to this provider's model.
   */
  getTokenCount(text: string, model?: string): number {
    return countTokens(text, model ?? this.model);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  // ─── Static Converters ──────────────────────────────────────────────────

  /**
   * Validate and convert internal Tool definitions to Anthropic tool format.
   *
   * Internal format: `{ name, description, parameters }` (JSON Schema)
   * Anthropic format: `{ name, description, input_schema }`
   *
   * If `parameters` is missing the required `type` field, we wrap it in
   * an object schema as a best-effort fallback.
   */
  /**
   * Build a valid Anthropic `input_schema` from a tool's raw parameters.
   *
   * Anthropic requires `{type: "object", properties: {...}}` at the top
   * level. If the tool's parameters already provide this shape (i.e. it
   * has `type: "object"`), we use `satisfies` to verify compatibility at
   * compile time without runtime casting. Otherwise we wrap the params in
   * an object schema.
   */
  private static buildInputSchema(
    params: Record<string, unknown> | undefined,
  ): Anthropic.Tool.InputSchema {
    if (
      params &&
      params.type === "object" &&
      params.properties &&
      typeof params.properties === "object"
    ) {
      return {
        type: "object",
        properties: params.properties as Record<string, unknown>,
        ...(params.required
          ? { required: params.required as string[] }
          : {}),
      } satisfies Anthropic.Tool.InputSchema;
    }

    // Wrap in a minimal object schema.
    return {
      type: "object",
      properties: params && Object.keys(params).length > 0 ? params : {},
    } satisfies Anthropic.Tool.InputSchema;
  }

  private static convertTools(tools: Tool[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: AnthropicProvider.buildInputSchema(t.parameters as Record<string, unknown> | undefined),
    }));
  }

  /**
   * Convert an Anthropic API response to the internal `LLMResponse` format.
   *
   * - Text blocks → `content`
   * - Tool use blocks → `tool_calls` with `JSON.stringify(input)`
   * - Thinking blocks → merged into `content` (Claude extended thinking)
   * - Usage → mapped from Anthropic's input_tokens/output_tokens
   * - Stop reason → preserved for agents to detect truncation / tool-use
   */
  private static convertResponse(response: Anthropic.Messages.Message, model: string): LLMResponse {
    const textBlocks = response.content.filter(
      (b) => b.type === "text",
    ) as Array<{ type: "text"; text: string }>;

    const toolUseBlocks = response.content.filter(
      (b) => b.type === "tool_use",
    ) as Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;

    // Claude extended thinking returns `type: "thinking"` blocks. These
    // contain the model's internal reasoning and should be included in the
    // content so the agent has full context.
    const thinkingBlocks = response.content.filter(
      (b) => b.type === "thinking",
    ) as Array<{ type: "thinking"; thinking: string }>;

    // Build content from text + thinking blocks.
    const parts: string[] = [];
    parts.push(textBlocks.map((b) => b.text).join(""));
    if (thinkingBlocks.length > 0) {
      parts.push(thinkingBlocks.map((b) => b.thinking).join(""));
    }
    const content = parts.filter((p) => p.length > 0).join("");

    const result: LLMResponse = {
      content,
      tool_calls: toolUseBlocks.length > 0
        ? toolUseBlocks.map((b) => ({
            id: b.id,
            type: "function" as const,
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }))
        : undefined,
      usage: response.usage
        ? {
            prompt_tokens: response.usage.input_tokens,
            completion_tokens: response.usage.output_tokens,
            total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined,
      stop_reason: response.stop_reason ?? undefined,
      providerMeta: {
        model,
        isFallback: false,
      },
    };

    // Flag response-level quality issues
    if (response.stop_reason === "max_tokens") {
      result.responseError = {
        code: LLMResponseErrorCode.MAX_TOKENS,
        message:
          "Response truncated: max_tokens reached. " +
          "Content or tool call arguments may be incomplete.",
      };
    }

    return result;
  }

  /**
   * Convert the internal `MessageData[]` format (OpenAI-compatible) to
   * Anthropic's native message format.
   *
   * Conversion rules:
   * 1. `role: "system"` messages are extracted, concatenated, and returned as
   *    the top-level `systemPrompt`.
   * 2. `role: "user"` → `{ role: "user", content: string }`
   * 3. `role: "assistant"` without tool_calls → `{ role: "assistant", content: string }`
   * 4. `role: "assistant"` with tool_calls → content-block array with text + tool_use blocks
   * 5. `role: "tool"` → `{ role: "user", content: [{ type: "tool_result", ... }] }`
   * 6. Consecutive same-role messages are merged with synthetic separators
   *    to satisfy Anthropic's user/assistant alternation requirement.
   * 7. If no non-system messages remain, a placeholder user message is inserted
   *    to satisfy Anthropic's requirement of at least one user/assistant message.
   */
  private static convertMessages(messages: MessageData[]): {
    systemPrompt: string | undefined;
    formattedMessages: Anthropic.MessageParam[];
  } {
    // Extract system messages
    const systemMessages = messages.filter((m) => m.role === Role.System);
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join("\n")
        : undefined;

    // Convert non-system messages
    const nonSystem = messages.filter((m) => m.role !== Role.System);

    const formattedMessages: Anthropic.MessageParam[] = [];

    for (const msg of nonSystem) {
      const converted = AnthropicProvider.convertSingleMessage(msg);

      // An empty result means the message was skipped (e.g. empty content).
      if (!converted) continue;

      // Merge tool-result messages into the immediately-preceding user
      // message.  Anthropic requires ALL tool_result blocks for a given
      // assistant message's tool_use blocks to appear in the IMMEDIATELY
      // next message after that assistant.  Without merging, two things
      // can break this pairing:
      //
      // 1. Consecutive Role.Tool messages → separate "user" messages →
      //    the alternation logic inserts synthetic "(continued)" messages
      //    between them, pushing later tool_results further away.
      //
      // 2. A non-tool user message (e.g. a "Continue…" truncation hint)
      //    that sits between the assistant and its tool_results — again
      //    the tool_results end up in a later message.
      //
      // By always merging a Role.Tool message into the last user message
      // we guarantee the tool_result blocks are in the first user message
      // after the assistant.
      if (msg.role === Role.Tool && formattedMessages.length > 0) {
        const last = formattedMessages[formattedMessages.length - 1];
        if (last.role === "user") {
          const newBlocks =
            converted.content as Anthropic.ToolResultBlockParam[];

          if (typeof last.content === "string") {
            // Convert plain-text user message to a content-block array
            // so we can append tool_result blocks alongside the text.
            last.content = [
              { type: "text", text: last.content },
              ...newBlocks,
            ] as unknown as Anthropic.MessageParam["content"];
          } else if (Array.isArray(last.content)) {
            // Append tool_result blocks to the existing content array.
            const lastBlocks =
              last.content as Anthropic.ToolResultBlockParam[];
            last.content = [
              ...lastBlocks,
              ...newBlocks,
            ] as unknown as Anthropic.MessageParam["content"];
          }
          continue;
        }
      }

      // Ensure user/assistant alternation.
      // If the converted message has the same role as the last one in the array,
      // insert a synthetic message to break the consecutive sequence.
      if (formattedMessages.length > 0) {
        const lastRole = formattedMessages[formattedMessages.length - 1].role;
        if (lastRole === converted.role) {
          formattedMessages.push({
            role: lastRole === "user" ? "assistant" : "user",
            content: "(continued)",
          } as Anthropic.MessageParam);
        }
      }

      formattedMessages.push(converted);
    }

    // Anthropic requires at least one user or assistant message.
    // If all messages were system-level, insert a placeholder.
    if (formattedMessages.length === 0) {
      formattedMessages.push({
        role: "user",
        content: "(start)",
      });
    }

    // ── Post-process: repair broken tool_use / tool_result pairs ──────
    // In complex multi-round conversations (e.g. batch review with
    // sub-agents, compression, and truncation interplay), the merge
    // logic above can occasionally leave tool_use blocks without
    // corresponding tool_result blocks in the immediately-next message.
    // Anthropic rejects such requests with a hard 400 error, so we
    // defensively strip any unpaired tool_use blocks.
    AnthropicProvider.repairToolPairing(formattedMessages);

    return { systemPrompt, formattedMessages };
  }

  /**
   * Scan `formattedMessages` and synthesize tool_result blocks for any
   * tool_use blocks that lack a matching tool_result in the immediately-
   * next message.
   *
   * This is a safety net — the main conversion logic should never produce
   * broken pairs, but when it does (due to edge cases in compression /
   * sub-agent injection / truncation interplay), this prevents a hard
   * 400 error from the Anthropic API.
   *
   * Instead of silently deleting the unpaired tool_use (which would lose
   * context), we inject a synthetic tool_result explaining that the tool
   * was skipped due to an internal error.  The LLM can then decide to
   * retry or work around it.
   */
  private static repairToolPairing(
    messages: Anthropic.MessageParam[],
  ): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      const content = msg.content;
      if (typeof content === "string" || !Array.isArray(content)) continue;

      const toolUses = content.filter(
        (b: any) => b.type === "tool_use",
      ) as Array<{ type: "tool_use"; id: string; name?: string }>;
      if (toolUses.length === 0) continue;

      const next = messages[i + 1];
      const nextBlocks = next && Array.isArray(next.content)
        ? (next.content as any[])
        : [];
      const resultIds = new Set(
        nextBlocks
          .filter((b: any) => b.type === "tool_result")
          .map((b: any) => b.tool_use_id),
      );

      const missing = toolUses.filter((tu) => !resultIds.has(tu.id));
      if (missing.length === 0) continue;

      // Synthesize tool_result blocks for each unpaired tool_use.
      const syntheticResults = missing.map((tu) => ({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        is_error: true,
        content: `[Tool "${tu.name ?? "unknown"}" was skipped due to an internal message-ordering error and was not executed. ` +
          `Please retry the tool call or use an alternative approach.]`,
      }));

      if (next && next.role === "user" && Array.isArray(next.content)) {
        // Append synthetic results to the existing next user message.
        (next.content as any[]).push(...syntheticResults);
      } else if (next && next.role === "user" && typeof next.content === "string") {
        // Convert plain-text user message to content-block array so we
        // can append tool_result blocks alongside the text.
        next.content = [
          { type: "text", text: next.content as string },
          ...syntheticResults,
        ] as unknown as Anthropic.MessageParam["content"];
      } else {
        // No next message or next is not a user message — insert a new
        // user message containing only the synthetic tool_results.
        messages.splice(i + 1, 0, {
          role: "user",
          content: syntheticResults,
        } as unknown as Anthropic.MessageParam);
      }
    }
  }

  /** Counter for generating unique synthetic tool_use_ids. */
  private static toolUseIdCounter = 0;

  /**
   * Convert a single internal `MessageData` to an Anthropic `MessageParam`.
   * Returns `null` if the message should be skipped.
   */
  private static convertSingleMessage(
    msg: MessageData,
  ): Anthropic.MessageParam | null {
    switch (msg.role) {
      case Role.User:
        return {
          role: "user",
          content: msg.content || "(empty)",
        };

      case Role.Assistant: {
        const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

        if (!hasToolCalls) {
          return {
            role: "assistant",
            content: msg.content || "(empty)",
          };
        }

        // Assistant message with tool calls → content-block array.
        const contentBlocks = [] as Array<{
          type: "text" | "tool_use";
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;

        // Add text block if there's non-empty content.
        if (msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        }

        // Add tool_use blocks for each tool call.
        for (const tc of msg.tool_calls!) {
          let input: Record<string, unknown> = {};
          if (tc.function.arguments) {
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              // Unparseable arguments — use empty object as fallback.
              input = {};
            }
          }

          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }

        return {
          role: "assistant",
          content: contentBlocks as unknown as Anthropic.MessageParam["content"],
        };
      }

      case Role.Tool: {
        // Tool messages become user messages with tool_result content blocks.
        // Generate a unique fallback ID when tool_call_id is missing to avoid
        // collisions (Anthropic requires unique tool_use_ids across the conversation).
        let toolUseId = msg.tool_call_id;
        if (!toolUseId) {
          AnthropicProvider.toolUseIdCounter++;
          toolUseId = msg.name
            ? `${msg.name}_${AnthropicProvider.toolUseIdCounter}`
            : `tool_${AnthropicProvider.toolUseIdCounter}`;
        }

        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: msg.content || "",
            } as Anthropic.ToolResultBlockParam,
          ] as unknown as Anthropic.MessageParam["content"],
        };
      }

      default:
        // Unknown roles are treated as user messages.
        return {
          role: "user",
          content: msg.content || "(empty)",
        };
    }
  }
}
