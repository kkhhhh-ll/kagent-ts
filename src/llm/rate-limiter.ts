import { LLMProvider, LLMResponse, LLMStreamEvent } from "./interface";
import { MessageData } from "../messages/types";
import { Tool } from "../tools/types";

/**
 * Simple sliding-window rate limiter.
 *
 * Tracks call timestamps and delays requests when the configured
 * maximum calls-per-minute would be exceeded.
 */
class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  /**
   * Wait until a slot is available in the current window.
   * Returns immediately if under the limit.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Drop timestamps outside the 1-minute window
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length < this.maxPerMinute) {
      this.timestamps.push(now);
      return;
    }

    // Wait until the oldest call exits the window
    const oldest = this.timestamps[0];
    const waitMs = oldest - windowStart + 10; // small buffer
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // Re-check after waiting
    return this.acquire();
  }

  /** Number of calls in the current window. */
  get currentCount(): number {
    const windowStart = Date.now() - 60_000;
    return this.timestamps.filter((t) => t > windowStart).length;
  }

  reset(): void {
    this.timestamps = [];
  }
}

/**
 * Configuration for the RateLimitedProvider.
 */
export interface RateLimitedProviderConfig {
  /** The underlying LLM provider to wrap. */
  provider: LLMProvider;
  /** Maximum LLM calls per minute. */
  maxCallsPerMinute: number;
}

/**
 * LLMProvider wrapper that enforces a maximum call rate.
 *
 * Calls that would exceed the limit are delayed until a slot opens in
 * the 1-minute sliding window. This prevents the agent from hitting
 * provider rate limits (HTTP 429) during high-throughput scenarios.
 *
 * Usage:
 * ```ts
 * const provider = new RateLimitedProvider({
 *   provider: new OpenAIProvider({ ... }),
 *   maxCallsPerMinute: 500,
 * });
 * ```
 */
export class RateLimitedProvider implements LLMProvider {
  private provider: LLMProvider;
  private limiter: SlidingWindowLimiter;

  constructor(config: RateLimitedProviderConfig) {
    this.provider = config.provider;
    this.limiter = new SlidingWindowLimiter(config.maxCallsPerMinute);
  }

  get model(): string {
    return this.provider.model;
  }

  async chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse> {
    await this.limiter.acquire();
    return this.provider.chat(messages, tools, signal);
  }

  async *chatStream(
    messages: MessageData[],
    tools?: Tool[],
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent> {
    await this.limiter.acquire();
    yield* this.provider.chatStream(messages, tools, signal);
  }

  getTokenCount(text: string, model?: string): number {
    return this.provider.getTokenCount(text, model);
  }

  /** Number of calls in the current 1-minute window. */
  get currentRateCount(): number {
    return this.limiter.currentCount;
  }

  /** Reset rate limiter counters. */
  resetRateLimiter(): void {
    this.limiter.reset();
  }
}
