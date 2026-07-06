import { LLMProvider, LLMResponse, LLMStreamEvent } from "./interface";
import { LLMNetworkError } from "./errors";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";
import { Logger, ConsoleLogger } from "../logging/logger";

/**
 * Configuration for the FallbackProvider.
 */
export interface FallbackProviderConfig {
  /** Primary provider (tried first). */
  primary: LLMProvider;
  /** Fallback providers (tried in order if the primary fails with a network error). */
  fallbacks: LLMProvider[];
  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

/**
 * LLMProvider that automatically falls back to a backup model when the
 * primary fails with a network error.
 *
 * Flow:
 * 1. Try `primary.chat()`.
 * 2. If it succeeds → return the response.
 * 3. If it throws `LLMNetworkError` → log warning, try `fallbacks[0].chat()`.
 * 4. Repeat until a provider succeeds or all are exhausted.
 * 5. Non-network errors (auth, bad request) propagate immediately.
 *
 * Usage:
 * ```ts
 * const provider = new FallbackProvider({
 *   primary: new OpenAIProvider({ apiKey, model: "gpt-4o" }),
 *   fallbacks: [
 *     new AnthropicProvider({ apiKey, model: "claude-haiku-4-5-20251001" }),
 *   ],
 * });
 * const agent = new ReActAgent({ llm: provider });
 * ```
 */
export class FallbackProvider implements LLMProvider {
  private providers: LLMProvider[];
  private logger: Logger;

  constructor(config: FallbackProviderConfig) {
    this.providers = [config.primary, ...config.fallbacks];
    this.logger = config.logger ?? new ConsoleLogger();
  }

  /**
   * Returns the primary provider's model name.
   *
   * NOTE: This always reflects the primary, even when a fallback provider
   * handled the most recent request.  The fallback provider is transparent
   * resilience — consumers should treat `model` as the "intended" model.
   */
  get model(): string {
    return this.providers[0].model;
  }

  async chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse> {
    let lastError: LLMNetworkError | undefined;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      try {
        const response = await provider.chat(messages, tools, signal);

        // Tag response with provider metadata so downstream consumers
        // (e.g. Orchestrator synthesis) can account for model degradation.
        response.providerMeta = {
          model: provider.model,
          isFallback: i > 0,
        };

        if (i > 0) {
          this.logger.info(
            "Fallback",
            `Recovered via fallback provider "${provider.model}" (attempt ${i + 1}/${this.providers.length}).`,
          );
        }
        return response;
      } catch (err: unknown) {
        // Non-network errors propagate immediately
        if (!(err instanceof LLMNetworkError)) throw err;

        lastError = err;
        this.logger.warn(
          "Fallback",
          `Provider "${provider.model}" failed: ${err.message}. ` +
          (i < this.providers.length - 1
            ? `Trying next provider...`
            : `All providers exhausted.`),
        );
      }
    }

    // All providers exhausted
    throw lastError!;
  }

  async *chatStream(
    messages: MessageData[],
    tools?: Tool[],
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    let lastError: LLMNetworkError | undefined;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      let yieldedItems = false;

      try {
        const stream = provider.chatStream(messages, tools, signal);
        if (i > 0) {
          this.logger.info(
            "Fallback",
            `Stream recovered via fallback provider "${provider.model}".`,
          );
        }

        for await (const event of stream) {
          yieldedItems = true;
          yield event;
        }
        return;
      } catch (err: unknown) {
        if (!(err instanceof LLMNetworkError)) throw err;

        // If the stream already yielded partial data, don't fall back —
        // the consumer has already received incomplete output and retrying
        // from scratch would produce duplicate / semantically broken results.
        if (yieldedItems) throw err;

        lastError = err;
        this.logger.warn(
          "Fallback",
          `Stream from "${provider.model}" failed before yielding data: ${err.message}. ` +
          (i < this.providers.length - 1
            ? `Trying next provider...`
            : `All providers exhausted.`),
        );
      }
    }

    throw lastError!;
  }

  getTokenCount(text: string, model?: string): number {
    return this.providers[0].getTokenCount(text, model);
  }
}
