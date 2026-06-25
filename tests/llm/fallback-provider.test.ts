import { describe, it, expect, vi } from "vitest";
import { FallbackProvider } from "../../src/llm/fallback-provider";
import { LLMNetworkError } from "../../src/llm/errors";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import { SilentLogger } from "../../src/logging/logger";
import { Role } from "../../src/messages/types";

function makeProvider(model: string, fail: boolean = false): LLMProvider {
  return {
    model,
    chat: fail
      ? async () => { throw new LLMNetworkError("timeout", "timeout"); }
      : async (): Promise<LLMResponse> => ({
          content: JSON.stringify({ thought: "ok", answer: `Response from ${model}` }),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    chatStream: async function* () { yield { type: "done" }; },
    getTokenCount: () => 10,
  };
}

describe("FallbackProvider", () => {
  it("returns primary provider response on success", async () => {
    const provider = new FallbackProvider({
      primary: makeProvider("gpt-4o"),
      fallbacks: [makeProvider("claude")],
      logger: new SilentLogger(),
    });

    const result = await provider.chat([{ role: Role.User, content: "hi" }]);
    expect(result.content).toContain("Response from gpt-4o");
  });

  it("falls back when primary fails with network error", async () => {
    const provider = new FallbackProvider({
      primary: makeProvider("gpt-4o", true), // fails
      fallbacks: [makeProvider("claude")],
      logger: new SilentLogger(),
    });

    const result = await provider.chat([{ role: Role.User, content: "hi" }]);
    expect(result.content).toContain("Response from claude");
  });

  it("tries multiple fallbacks in order", async () => {
    const provider = new FallbackProvider({
      primary: makeProvider("p1", true),
      fallbacks: [makeProvider("p2", true), makeProvider("p3")],
      logger: new SilentLogger(),
    });

    const result = await provider.chat([{ role: Role.User, content: "hi" }]);
    expect(result.content).toContain("Response from p3");
  });

  it("propagates non-network errors immediately", async () => {
    const nonNetworkError = new Error("Invalid API key");
    const provider = new FallbackProvider({
      primary: {
        model: "bad",
        chat: async () => { throw nonNetworkError; },
        chatStream: async function* () { yield { type: "done" }; },
        getTokenCount: () => 10,
      },
      fallbacks: [makeProvider("claude")],
      logger: new SilentLogger(),
    });

    await expect(
      provider.chat([{ role: Role.User, content: "hi" }]),
    ).rejects.toThrow("Invalid API key");
  });

  it("throws last error when all providers fail", async () => {
    const provider = new FallbackProvider({
      primary: makeProvider("p1", true),
      fallbacks: [makeProvider("p2", true)],
      logger: new SilentLogger(),
    });

    await expect(
      provider.chat([{ role: Role.User, content: "hi" }]),
    ).rejects.toThrow(LLMNetworkError);
  });

  it("model returns primary model name", () => {
    const provider = new FallbackProvider({
      primary: makeProvider("gpt-4o"),
      fallbacks: [makeProvider("claude")],
    });
    expect(provider.model).toBe("gpt-4o");
  });

  it("delegates getTokenCount to primary", () => {
    const provider = new FallbackProvider({
      primary: makeProvider("gpt-4o"),
      fallbacks: [makeProvider("claude")],
    });
    expect(provider.getTokenCount("hello")).toBe(10);
  });
});
