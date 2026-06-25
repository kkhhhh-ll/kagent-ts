import { describe, it, expect } from "vitest";
import { RateLimitedProvider } from "../../src/llm/rate-limiter";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import { Role } from "../../src/messages/types";

function makeProvider(): LLMProvider {
  return {
    model: "test-model",
    chat: async (): Promise<LLMResponse> => ({
      content: JSON.stringify({ thought: "ok", answer: "done" }),
    }),
    chatStream: async function* () { yield { type: "done" }; },
    getTokenCount: () => 10,
  };
}

describe("RateLimitedProvider", () => {
  it("allows calls within the limit", async () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });

    const result = await provider.chat([{ role: Role.User, content: "hi" }]);
    expect(result.content).toContain("done");
  });

  it("tracks call count in the current window", async () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });

    expect(provider.currentRateCount).toBe(0);
    await provider.chat([{ role: Role.User, content: "hi" }]);
    expect(provider.currentRateCount).toBe(1);
  });

  it("returns correct call count", async () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });

    await provider.chat([{ role: Role.User, content: "1" }]);
    await provider.chat([{ role: Role.User, content: "2" }]);
    expect(provider.currentRateCount).toBe(2);
    await provider.chat([{ role: Role.User, content: "3" }]);
    expect(provider.currentRateCount).toBe(3);
  });

  it("completes all calls when under the limit", async () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 1000,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        provider.chat([{ role: Role.User, content: String(i) }]),
      ),
    );

    expect(results).toHaveLength(10);
    expect(provider.currentRateCount).toBe(10);
  });

  it("resetRateLimiter clears the window", async () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });

    await provider.chat([{ role: Role.User, content: "1" }]);
    await provider.chat([{ role: Role.User, content: "2" }]);
    expect(provider.currentRateCount).toBe(2);

    provider.resetRateLimiter();
    expect(provider.currentRateCount).toBe(0);
  });

  it("delegates getTokenCount to inner provider", () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });
    expect(provider.getTokenCount("hello")).toBe(10);
  });

  it("model returns inner provider model", () => {
    const provider = new RateLimitedProvider({
      provider: makeProvider(),
      maxCallsPerMinute: 100,
    });
    expect(provider.model).toBe("test-model");
  });
});
