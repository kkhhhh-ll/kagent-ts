import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/llm/retry";
import type { RetryCallbacks } from "../../src/llm/retry";
import type { RetryConfig } from "../../src/llm/errors";
import { LLMNetworkError } from "../../src/llm/errors";

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 2,
  baseDelayMs: 10,
  maxDelayMs: 100,
};

const ALWAYS_RETRY: RetryCallbacks = {
  isRetryable: () => true,
  classifyError: () => "unknown_network",
};

describe("withRetry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, DEFAULT_CONFIG, ALWAYS_RETRY);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, DEFAULT_CONFIG, ALWAYS_RETRY);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("throws LLMNetworkError after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));

    await expect(
      withRetry(fn, DEFAULT_CONFIG, ALWAYS_RETRY),
    ).rejects.toThrow(LLMNetworkError);

    // maxRetries=2 → up to 3 total attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("propagates non-retryable errors immediately", async () => {
    const callbacks: RetryCallbacks = {
      isRetryable: () => false,
      classifyError: () => "unknown_network",
    };
    const fn = vi.fn().mockRejectedValue(new Error("bad request"));

    await expect(
      withRetry(fn, DEFAULT_CONFIG, callbacks),
    ).rejects.toThrow("bad request");

    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it("uses exponential backoff", async () => {
    // Base 10ms, maxRetries 2 → delays: 10*1*(0.5..1), 10*2*(0.5..1)
    // Both ≤ 40ms total. Use a generous timeout.
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");

    const start = Date.now();
    const result = await withRetry(fn, DEFAULT_CONFIG, ALWAYS_RETRY);
    const elapsed = Date.now() - start;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // With baseDelayMs=10, two backoffs should take at least ~10ms
    // (delay grows: ~10ms + ~20ms = ~30ms minimum)
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  it("caps delay at maxDelayMs", async () => {
    const config: Required<RetryConfig> = {
      maxRetries: 1,
      baseDelayMs: 1000,
      maxDelayMs: 5, // tiny cap
    };
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue("ok");

    const start = Date.now();
    await withRetry(fn, config, ALWAYS_RETRY);
    const elapsed = Date.now() - start;

    // Capped at 5ms, should complete very fast
    expect(elapsed).toBeLessThan(500);
  });
});
