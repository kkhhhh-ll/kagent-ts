import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ReActAgent } from "../../src/core/react-agent";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { mockAnswerLLM } from "../mocks/mock-llm-provider";
import { SUB_AGENT_DELEGATION } from "../../src/core/system-prompts";

function createAgent(answer = "Hello!") {
  return new ReActAgent({
    llm: mockAnswerLLM(answer),
    toolRegistry: new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: 3,
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-lifecycle-test-"));
}

function writeAgentMd(dir: string, agentName: string, frontmatter: string): void {
  const agentDir = path.join(dir, agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "AGENT.md"),
    `---\n${frontmatter}\n---\nYou are a helpful sub-agent.`,
    "utf-8",
  );
}

describe("Agent Lifecycle", () => {
  // ── Basic lifecycle ──────────────────────────────────────────────────

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

  // ── Sub-Agent delegation in system prompt ────────────────────────────

  describe("sub-agent delegation", () => {
    it("hasSubAgents returns false when no sub-agents are configured", () => {
      const agent = createAgent();
      // Before init(), subAgentManager is undefined → hasSubAgents is false
      expect((agent as any).hasSubAgents()).toBe(false);
    });

    it("buildSystemPrompt excludes SUB_AGENT_DELEGATION when no sub-agents are configured", () => {
      const agent = createAgent();
      const prompt = (agent as any).buildSystemPrompt();
      expect(prompt).not.toContain(SUB_AGENT_DELEGATION.trim());
    });

    it("hasSubAgents returns true when sub-agents are registered", async () => {
      const dir = tempDir();
      try {
        writeAgentMd(
          dir,
          "helper",
          "name: helper\ndescription: A helper sub-agent.\ntools: []\nskills: []",
        );

        const agent = new ReActAgent({
          llm: mockAnswerLLM("OK"),
          toolRegistry: new ToolRegistry(),
          logger: new SilentLogger(),
          maxIterations: 1,
          subAgentsDir: dir,
        });

        // init() is called by run()/chat() — run briefly to trigger setup
        await agent.run("test");
        expect((agent as any).hasSubAgents()).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("buildSystemPrompt includes SUB_AGENT_DELEGATION when sub-agents are configured", async () => {
      const dir = tempDir();
      try {
        writeAgentMd(
          dir,
          "helper",
          "name: helper\ndescription: A helper sub-agent.\ntools: []\nskills: []",
        );

        const agent = new ReActAgent({
          llm: mockAnswerLLM("OK"),
          toolRegistry: new ToolRegistry(),
          logger: new SilentLogger(),
          maxIterations: 1,
          subAgentsDir: dir,
        });

        await agent.run("test");
        const prompt = (agent as any).buildSystemPrompt();
        expect(prompt).toContain("Sub-Agent Delegation");
        expect(prompt).toContain("list_subagents");
        expect(prompt).toContain("spawn_subagent");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
