import { LLMProvider, LLMResponse, LLMStreamEvent } from "./interface";
import { LLMNetworkError } from "./errors";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";
import { Logger, ConsoleLogger } from "../logging/logger";

/**
 * Task categories for model routing.
 *
 * Each category maps to a model provider. When a category has no explicit
 * provider configured, it falls back to `main`.
 */
export type ModelRoute =
  | "main"
  | "subAgent"
  | "reflection"
  | "lightweight"
  | "precipitation"
  | "memory"
  | "verification";

/**
 * Configuration for the ModelRouter.
 */
export interface ModelRouterConfig {
  /** Primary model for the main reasoning loop (required). */
  main: LLMProvider;

  /**
   * Model for sub-agents spawned by the main agent.
   * Default: `main`.
   */
  subAgent?: LLMProvider;

  /**
   * Model for post-execution reflection / QA.
   * Default: `main`.
   * Using a different model here provides an independent review perspective.
   */
  reflection?: LLMProvider;

  /**
   * Model for lightweight tasks (memory operations, error listing, etc.).
   * Default: `main`.
   */
  lightweight?: LLMProvider;

  /**
   * Model for post-execution skill precipitation.
   * Default: `main`.
   * Precipitation reviews completed sessions to extract reusable skills —
   * using a cheaper model here saves cost on non-user-facing work.
   */
  precipitation?: LLMProvider;

  /**
   * Model for memory extraction (user preferences, project decisions, etc.).
   * Default: `main`.
   * Memory extraction reviews sessions to find lasting facts worth
   * persisting — independent of error reflection so the two can use
   * different models.
   */
  memory?: LLMProvider;

  /**
   * Model for answer verification (correctness / completeness check).
   * Default: `main`.
   * Using an independent model here provides an unbiased review perspective.
   */
  verification?: LLMProvider;

  /**
   * Shared fallback providers tried in order when the primary for
   * any route fails with a network error.
   *
   * Each route wraps its primary + these fallbacks. Non-network errors
   * (auth, bad request) propagate immediately.
   *
   * Default: none (network error = immediate failure).
   */
  fallbacks?: LLMProvider[];

  /** Logger instance (defaults to ConsoleLogger). */
  logger?: Logger;
}

/**
 * ModelRouter — routes LLM calls to different providers based on task type.
 *
 * Implements `LLMProvider` so it drops in anywhere a plain provider is
 * expected. The default route is `main` — call `.forSubAgent()`,
 * `.forReflection()`, or `.forLightweight()` to get a task-specific
 * provider handle.
 *
 * Each route automatically wraps its model in a fallback chain when
 * `fallbacks` are configured.
 *
 * Usage:
 * ```ts
 * const router = new ModelRouter({
 *   main: new OpenAIProvider({ model: "gpt-4o" }),
 *   subAgent: new OpenAIProvider({ model: "gpt-4o-mini" }),
 *   reflection: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
 *   fallbacks: [new AnthropicProvider({ model: "claude-sonnet-4-6" })],
 * });
 *
 * const agent = new ReActAgent({ llm: router, subAgentsDir: "./subagents" });
 * // Main loop uses gpt-4o; sub-agents use gpt-4o-mini.
 *
 * ```
 */
export class ModelRouter implements LLMProvider {
  private config: ModelRouterConfig;
  private logger: Logger;

  constructor(config: ModelRouterConfig) {
    if (!config.main) {
      throw new Error("ModelRouter: `main` provider is required.");
    }
    this.config = config;
    this.logger = config.logger ?? new ConsoleLogger();
  }

  // ─── LLMProvider Implementation (delegates to main) ──────────────────

  /** The main model identifier. */
  get model(): string {
    return this.config.main.model;
  }

  async chat(
    messages: MessageData[],
    tools?: Tool[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    return this.route("main").chat(messages, tools, signal);
  }

  async *chatStream(
    messages: MessageData[],
    tools?: Tool[],
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    yield* this.route("main").chatStream(messages, tools, signal);
  }

  getTokenCount(text: string, model?: string): number {
    return this.config.main.getTokenCount(text, model);
  }

  // ─── Route Accessors ─────────────────────────────────────────────────

  /**
   * Get the LLM provider for sub-agents.
   *
   * Delegates to `subAgent` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forSubAgent(): LLMProvider {
    return this.route("subAgent");
  }

  /**
   * Get the LLM provider for post-execution reflection / QA.
   *
   * Delegates to `reflection` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forReflection(): LLMProvider {
    return this.route("reflection");
  }

  /**
   * Get the LLM provider for lightweight tasks.
   *
   * Delegates to `lightweight` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forLightweight(): LLMProvider {
    return this.route("lightweight");
  }

  /**
   * Get the LLM provider for post-execution skill precipitation.
   *
   * Delegates to `precipitation` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forPrecipitation(): LLMProvider {
    return this.route("precipitation");
  }

  /**
   * Get the LLM provider for memory extraction.
   *
   * Delegates to `memory` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forMemory(): LLMProvider {
    return this.route("memory");
  }

  /**
   * Get the LLM provider for answer verification.
   *
   * Delegates to `verification` when configured, otherwise falls back to `main`.
   * Wraps the provider with any shared fallback chain.
   */
  forVerification(): LLMProvider {
    return this.route("verification");
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /**
   * Resolve a route to its effective provider.
   *
   * Priority: route-specific provider → main.
   * If fallbacks are configured, the provider is wrapped in a fallback chain.
   */
  private route(route: ModelRoute): LLMProvider {
    const primary = this.resolveRoute(route);

    // If no fallbacks configured, return the primary directly (hot path).
    if (!this.config.fallbacks || this.config.fallbacks.length === 0) {
      return primary;
    }

    // Wrap in a lightweight fallback chain specific to this route.
    return this.createFallbackWrapper(primary, route);
  }

  /**
   * Resolve the primary provider for a route.
   */
  private resolveRoute(route: ModelRoute): LLMProvider {
    switch (route) {
      case "main":
        return this.config.main;
      case "subAgent":
        return this.config.subAgent ?? this.config.main;
      case "reflection":
        return this.config.reflection ?? this.config.main;
      case "lightweight":
        return this.config.lightweight ?? this.config.main;
      case "precipitation":
        return this.config.precipitation ?? this.config.main;
      case "memory":
        return this.config.memory ?? this.config.main;
      case "verification":
        return this.config.verification ?? this.config.main;
    }
  }

  /**
   * Create a lightweight inline fallback wrapper around a primary provider.
   *
   * This avoids importing FallbackProvider to keep the dependency graph
   * clean. The inline wrapper behaves identically.
   */
  private createFallbackWrapper(
    primary: LLMProvider,
    route: ModelRoute,
  ): LLMProvider {
    const chain = [primary, ...this.config.fallbacks!];
    const logger = this.logger; // capture for closure

    return {
      get model(): string {
        return primary.model;
      },

      async chat(
        messages: MessageData[],
        tools?: Tool[],
        signal?: AbortSignal,
      ): Promise<LLMResponse> {
        let lastError: LLMNetworkError | undefined;

        for (let i = 0; i < chain.length; i++) {
          try {
            const response = await chain[i].chat(messages, tools, signal);
            if (i > 0) {
              logger.info(
                "ModelRouter",
                `Route "${route}" recovered via fallback "${chain[i].model}" (attempt ${i + 1}).`,
              );
            }
            return response;
          } catch (err: unknown) {
            if (!(err instanceof LLMNetworkError)) throw err;
            lastError = err;
            logger.warn(
              "ModelRouter",
              `Route "${route}": "${chain[i].model}" failed — ${err.message}. ` +
                (i < chain.length - 1 ? "Trying next..." : "Exhausted."),
            );
          }
        }

        throw lastError!;
      },

      async *chatStream(
        messages: MessageData[],
        tools?: Tool[],
        signal?: AbortSignal,
      ): AsyncIterable<LLMStreamEvent> {
        let lastError: LLMNetworkError | undefined;

        for (let i = 0; i < chain.length; i++) {
          try {
            const stream = chain[i].chatStream(messages, tools, signal);
            if (i > 0) {
              logger.info(
                "ModelRouter",
                `Route "${route}" stream recovered via "${chain[i].model}".`,
              );
            }
            yield* stream;
            return;
          } catch (err: unknown) {
            if (!(err instanceof LLMNetworkError)) throw err;
            lastError = err;
          }
        }

        throw lastError!;
      },

      getTokenCount(text: string, model?: string): number {
        return primary.getTokenCount(text, model);
      },
    };
  }
}
