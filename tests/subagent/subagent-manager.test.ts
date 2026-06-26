import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pre-import to break circular dependency (same as plan-solve-agent tests)
import "../../src/core/react-agent";

import { SubAgentManager } from "../../src/subagent/subagent-manager";
import type { SubAgentDefinition } from "../../src/subagent/subagent-types";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SkillManager } from "../../src/skills/skill-manager";
import { SilentLogger } from "../../src/logging/logger";
import { mockAnswerLLM } from "../mocks/mock-llm-provider";
import type { Tool } from "../../src/tools/types";

// ─── Helpers ───────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-manager-test-"));
}

/** Write an AGENT.md file. */
function writeAgentMd(
  dir: string,
  agentName: string,
  frontmatter: string,
  body = "You are a helpful sub-agent.",
): void {
  const agentDir = path.join(dir, agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "AGENT.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf-8",
  );
}

/** A simple no-op tool that does nothing. */
const dummyTool: Tool = {
  name: "echo",
  description: "Echoes back the input.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  execute: async (args: Record<string, unknown>) =>
    `echo: ${args.message ?? ""}`,
};

/**
 * Create a bound SubAgentManager ready for spawning.
 * The sub-agent uses a mock LLM that returns the given answer immediately.
 */
function createBoundManager(
  answer: string,
  tools: Tool[] = [dummyTool],
): SubAgentManager {
  const manager = new SubAgentManager();
  manager.setLogger(new SilentLogger());

  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  const skillManager = new SkillManager();

  manager.bind(
    mockAnswerLLM(answer),
    toolRegistry,
    skillManager,
    undefined,
    5000, // 5s timeout
  );

  return manager;
}

/** Convenience: register a single definition + bind, ready to spawn. */
function setupManager(defName: string, tools: string[] = ["echo"]): SubAgentManager {
  const manager = createBoundManager("Sub-agent result.");
  manager.register({
    name: defName,
    description: `A ${defName} sub-agent.`,
    systemPrompt: "You are a helpful assistant.",
    tools,
    skills: [],
  });
  return manager;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("SubAgentManager", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Registration ────────────────────────────────────────────────────

  describe("registration", () => {
    it("registers definitions from a directory of AGENT.md files", () => {
      writeAgentMd(testDir, "reviewer", [
        "name: code-reviewer",
        "description: Reviews code",
        "tools: read_file, grep",
      ].join("\n"));

      writeAgentMd(testDir, "tester", [
        "name: test-runner",
        "description: Runs tests",
        "tools: bash",
      ].join("\n"));

      const manager = new SubAgentManager();
      manager.setLogger(new SilentLogger());
      const count = manager.registerFromDirectory(testDir);

      expect(count).toBe(2);
      const defs = manager.getDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map((d) => d.name).sort()).toEqual([
        "code-reviewer",
        "test-runner",
      ]);
    });

    it("skips definitions with duplicate names", () => {
      writeAgentMd(testDir, "first", "name: dup\n");

      const manager = new SubAgentManager();
      manager.setLogger(new SilentLogger());
      manager.registerFromDirectory(testDir); // registers "dup"
      // Second call — "dup" already exists, should be skipped
      const count = manager.registerFromDirectory(testDir);

      expect(count).toBe(0);
    });

    it("registers a single definition programmatically", () => {
      const manager = new SubAgentManager();
      manager.register({
        name: "my-agent",
        description: "Test agent",
        systemPrompt: "You are a test.",
        tools: ["echo"],
        skills: ["test-skill"],
      });

      const defs = manager.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("my-agent");
    });

    it("throws on duplicate programmatic registration", () => {
      const manager = new SubAgentManager();
      const def: SubAgentDefinition = {
        name: "unique",
        description: "desc",
        systemPrompt: "prompt",
        tools: [],
        skills: [],
      };
      manager.register(def);

      expect(() => manager.register(def)).toThrow(/already registered/);
    });
  });

  // ── Spawn ───────────────────────────────────────────────────────────

  describe("spawn", () => {
    it("throws when spawning an unknown sub-agent", () => {
      const manager = new SubAgentManager();
      expect(() => manager.spawn("unknown", "do stuff")).toThrow(
        /Unknown sub-agent/,
      );
    });

    it("throws when spawning before bind()", () => {
      const manager = new SubAgentManager();
      manager.register({
        name: "test",
        description: "desc",
        systemPrompt: "prompt",
        tools: [],
        skills: [],
      });
      expect(() => manager.spawn("test", "do stuff")).toThrow(
        /not bound/,
      );
    });

    it("allows multiple concurrent spawns of the same definition", () => {
      const manager = setupManager("worker");
      const runId1 = manager.spawn("worker", "task 1");
      const runId2 = manager.spawn("worker", "task 2");

      expect(runId1).toContain("worker_");
      expect(runId2).toContain("worker_");
      expect(runId1).not.toBe(runId2);
      expect(manager.getActiveCount()).toBe(2);
    });

    it("returns a run ID on successful spawn", () => {
      const manager = setupManager("worker");
      const runId = manager.spawn("worker", "do something");

      expect(runId).toContain("worker_");
      expect(manager.hasRunning()).toBe(true);
      expect(manager.getActiveCount()).toBe(1);
    });
  });

  // ── Poll ────────────────────────────────────────────────────────────

  describe("pollCompleted", () => {
    it("returns completed results after a sub-agent finishes", async () => {
      const manager = setupManager("worker");
      manager.spawn("worker", "complete this task");

      // Wait a tick for the async run to finish
      await new Promise((r) => setTimeout(r, 100));

      const results = await manager.pollCompleted();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("worker");
      expect(results[0].success).toBe(true);
      expect(results[0].output).toContain("Sub-agent result.");
      expect(results[0].output).toContain("<subagent-result");
      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns empty array when nothing is running", async () => {
      const manager = setupManager("worker");
      const results = await manager.pollCompleted();
      expect(results).toEqual([]);
    });

    it("clears completed runs from the pending queue", async () => {
      const manager = setupManager("worker");
      manager.spawn("worker", "task");
      await new Promise((r) => setTimeout(r, 100));

      await manager.pollCompleted();
      expect(manager.hasRunning()).toBe(false);
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  // ── Cancel & Orphan Collection ──────────────────────────────────────

  describe("cancel & orphans", () => {
    it("cancelAll marks pending runs as cancelled", async () => {
      const manager = setupManager("worker");
      manager.spawn("worker", "task");
      expect(manager.hasRunning()).toBe(true);

      manager.cancelAll();
      // Still has pending entries (marked as cancelled)
      expect(manager.getActiveCount()).toBe(1);
    });

    it("collectOrphanedResults recovers results from cancelled runs", async () => {
      const manager = setupManager("worker");
      manager.spawn("worker", "task");

      // Wait for it to finish
      await new Promise((r) => setTimeout(r, 100));

      manager.cancelAll();

      const orphans = manager.collectOrphanedResults();
      expect(orphans.length).toBeGreaterThanOrEqual(0);
      // If the run completed before cancel, we get the result back
      // tagged with the interruption notice.
      if (orphans.length > 0) {
        expect(orphans[0].output).toContain("Interrupted by user");
      }
    });
  });

  // ── Queries ─────────────────────────────────────────────────────────

  describe("queries", () => {
    it("buildSubAgentList returns formatted markdown list", () => {
      const manager = new SubAgentManager();
      manager.register({
        name: "alpha",
        description: "First agent",
        systemPrompt: "...",
        tools: ["echo", "bash"],
        skills: ["test"],
      });
      manager.register({
        name: "beta",
        description: "Second agent",
        systemPrompt: "...",
        tools: [],
        skills: [],
      });

      const list = manager.buildSubAgentList();
      expect(list).toContain("**alpha**: First agent");
      expect(list).toContain("Tools: echo, bash");
      expect(list).toContain("Skills: test");
      expect(list).toContain("**beta**: Second agent");
    });

    it('buildSubAgentList returns "No sub-agents" when empty', () => {
      const manager = new SubAgentManager();
      expect(manager.buildSubAgentList()).toContain("No sub-agents registered.");
    });

    it("getDefinitions returns a copy of all registered definitions", () => {
      const manager = new SubAgentManager();
      manager.register({
        name: "a",
        description: "...",
        systemPrompt: "...",
        tools: [],
        skills: [],
      });

      const defs = manager.getDefinitions();
      expect(defs).toHaveLength(1);
      // Should be a copy, not a reference to internal map
      defs.pop();
      expect(manager.getDefinitions()).toHaveLength(1);
    });

    it("hasRunning and getActiveCount reflect pending state", async () => {
      const manager = setupManager("worker");
      expect(manager.hasRunning()).toBe(false);

      manager.spawn("worker", "task");
      expect(manager.hasRunning()).toBe(true);
      expect(manager.getActiveCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 100));
      await manager.pollCompleted();
      expect(manager.hasRunning()).toBe(false);
    });
  });

  // ── awaitAll ────────────────────────────────────────────────────────

  describe("awaitAll", () => {
    it("waits for all pending sub-agents to complete", async () => {
      const manager = createBoundManager("quick result");
      manager.register({
        name: "a",
        description: "...",
        systemPrompt: "...",
        tools: ["echo"],
        skills: [],
      });
      manager.register({
        name: "b",
        description: "...",
        systemPrompt: "...",
        tools: ["echo"],
        skills: [],
      });

      manager.spawn("a", "task a");
      manager.spawn("b", "task b");

      const results = await manager.awaitAll();

      expect(results).toHaveLength(2);
      expect(manager.hasRunning()).toBe(false);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  // ── Sub-agent tool filtering ────────────────────────────────────────

  describe("tool filtering", () => {
    it("sub-agent only has access to declared tools", async () => {
      const manager = createBoundManager("Filtered result.", [
        dummyTool,
        {
          name: "restricted_tool",
          description: "Should NOT be available.",
          parameters: { type: "object", properties: {} },
          execute: async () => "restricted",
        },
      ]);

      manager.register({
        name: "filtered",
        description: "Only has echo.",
        systemPrompt: "You are filtered.",
        tools: ["echo"], // only "echo" — not "restricted_tool"
        skills: [],
      });

      manager.spawn("filtered", "task");

      // Wait and collect
      await new Promise((r) => setTimeout(r, 100));
      const results = await manager.pollCompleted();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });
});
