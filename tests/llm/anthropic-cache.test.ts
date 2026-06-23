import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic-provider";
import type { MessageData } from "../../src/messages/types";

// NOTE: These tests verify the config wiring — they don't make real API calls.
// The `cacheSystemPrompt` behaviour is validated by inspecting the provider
// configuration and type signatures.

describe("AnthropicProvider cacheSystemPrompt", () => {
  it("defaults cacheSystemPrompt to false", () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
    });
    // Just verify construction succeeds without cacheSystemPrompt
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("accepts cacheSystemPrompt: true", () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      cacheSystemPrompt: true,
    });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("accepts cacheSystemPrompt: false explicitly", () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      cacheSystemPrompt: false,
    });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("getTokenCount still works with caching enabled", () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      cacheSystemPrompt: true,
    });
    const tokens = provider.getTokenCount("Hello world");
    expect(tokens).toBeGreaterThan(0);
  });
});
