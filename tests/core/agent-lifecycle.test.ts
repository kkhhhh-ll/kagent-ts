import { describe, it, expect } from "vitest";
import { ReActAgent } from "../../src/core/react-agent";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { mockAnswerLLM } from "../mocks/mock-llm-provider";

function createAgent(answer = "Hello!") {
  return new ReActAgent({
    llm: mockAnswerLLM(answer),
    toolRegistry: new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: 3,
  });
}

describe("Agent Lifecycle", () => {
  it("chat() returns the agent response", async () => {
    const agent = createAgent("Hi there!");
    const result = await agent.chat("hello");
    expect(result).toContain("Hi there!");
  });

  it("chat() preserves conversation across calls", async () => {
    const agent = createAgent("Response 2");
    await agent.chat("Question 1");
    expect(agent.conversationLength).toBeGreaterThan(0);

    await agent.chat("Question 2");
    // Messages should accumulate
    expect(agent.conversationLength).toBeGreaterThan(2);
  });

  it("newTopic() clears conversation before running", async () => {
    const agent = createAgent("Fresh response");
    await agent.chat("Question 1");
    expect(agent.conversationLength).toBeGreaterThan(0);

    await agent.newTopic("New topic");
    // After newTopic, only the new message + response should be in context
    expect(agent.conversationLength).toBeLessThan(5);
  });

  it("clearConversation() resets message count", () => {
    const agent = createAgent();
    agent.clearConversation();
    expect(agent.conversationLength).toBe(0);
  });

  it("conversationLength reflects message count", async () => {
    const agent = createAgent("Answer");
    expect(agent.conversationLength).toBe(0);
    await agent.chat("hello");
    expect(agent.conversationLength).toBeGreaterThan(0);
  });

  it("run() still works as before", async () => {
    const agent = createAgent("Legacy OK");
    const result = await agent.run("test");
    expect(result).toContain("Legacy OK");
  });
});
