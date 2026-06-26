import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pre-import to break circular dependency (same pattern as fusion-agent tests)
import "../../src/core/react-agent";
import "../../src/core/plan-solve-agent";
import "../../src/core/fusion-agent";

import { OrchestratorAgent } from "../../src/orchestrator/orchestrator-agent";
import type { OrchestratorAgentConfig } from "../../src/orchestrator/orchestrator-agent";
import { ContextManager } from "../../src/context/context-manager";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { mockAnswerLLM, mockSequenceLLM } from "../mocks/mock-llm-provider";
import { LLMNetworkError } from "../../src/llm/errors";
import type { LLMProvider } from "../../src/llm/interface";
import type { Tool } from "../../src/tools/types";

// ─── Test tools (for sub-agents) ──────────────────────────────────────────

const echoTool: Tool = {
  name: "echo",
  description: "Echoes the input message.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  execute: async (args: Record<string, unknown>) =>
    `ECHO: ${args.message ?? ""}`,
};

// ─── JSON helpers for orchestrator LLM responses ──────────────────────────

function decomposeJSON(nodes: Array<{
  id: string;
  description: string;
  subAgentName: string;
  input: string;
  dependsOn?: string[];
}>, thought = "Decomposition strategy."): string {
  return JSON.stringify({
    thought,
    taskGraph: { nodes },
  });
}

function synthesizeCompleteJSON(
  finalAnswer: string,
  thought = "All results are sufficient.",
): string {
  return JSON.stringify({ thought, isComplete: true, finalAnswer });
}

function synthesizeIncompleteJSON(
  gaps: string[],
  thought = "More work needed.",
): string {
  return JSON.stringify({ thought, isComplete: false, gaps });
}

function adaptJSON(
  newNodes: Array<{
    id: string;
    description: string;
    subAgentName: string;
    input: string;
    dependsOn?: string[];
  }>,
  thought = "Generated new tasks.",
  stuck = false,
): string {
  return JSON.stringify({ thought, newNodes, stuck });
}

function adaptStuckJSON(thought = "Cannot fill these gaps."): string {
  return JSON.stringify({ thought, newNodes: [], stuck: true });
}

// Generic force-synthesize response
function forceAnswerJSON(answer: string, thought = "Best-effort answer."): string {
  return JSON.stringify({ thought, answer });
}

// ─── Temp dir helper ─────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-orch-test-"));
}

/** Write an AGENT.md file for a sub-agent definition. */
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

/** Create a temp directory with worker sub-agent definitions. */
function setupSubAgentDir(): string {
  const dir = tempDir();
  writeAgentMd(
    dir,
    "worker",
    `name: worker\ndescription: General-purpose worker sub-agent.\ntools:\n  - echo\nskills: []`,
  );
  writeAgentMd(
    dir,
    "researcher",
    `name: researcher\ndescription: Research-focused sub-agent.\ntools:\n  - echo\nskills: []`,
  );
  writeAgentMd(
    dir,
    "analyst",
    `name: analyst\ndescription: Analysis-focused sub-agent.\ntools:\n  - echo\nskills: []`,
  );
  return dir;
}

/** Create a ToolRegistry with the echo tool (used by sub-agents). */
function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

// ─── Convenience helpers ──────────────────────────────────────────────────

/**
 * Create an OrchestratorAgent pre-configured for testing.
 *
 * The orchestrator's main LLM is a sequence mock — it controls the
 * Decompose / Synthesize / Adapt / Force-Synthesize phases.
 *
 * Sub-agents use mockAnswerLLM so they complete instantly.
 */
function createOrchestrator(
  mainLLM: LLMProvider,
  config: Partial<OrchestratorAgentConfig> = {},
): OrchestratorAgent {
  const subAgentDir = setupSubAgentDir();
  const toolRegistry = createToolRegistry();

  return new OrchestratorAgent({
    llm: mainLLM,
    toolRegistry,
    subAgentsDir: subAgentDir,
    subAgentLLM: mockAnswerLLM("Sub-agent completed successfully."),
    logger: new SilentLogger(),
    maxRounds: config.maxRounds ?? 3,
    maxParallelNodes: config.maxParallelNodes ?? 5,
    maxTotalNodes: config.maxTotalNodes ?? 20,
    ...config,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("OrchestratorAgent", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    tempDirs = [];
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Decompose
  // ════════════════════════════════════════════════════════════════════════

  describe("decompose phase", () => {
    it("decomposes user request into a task graph and dispatches it", async () => {
      const llm = mockSequenceLLM([
        // Decompose: 2 parallel worker nodes
        [decomposeJSON([
          { id: "task_a", description: "Do task A", subAgentName: "worker", input: "Do A" },
          { id: "task_b", description: "Do task B", subAgentName: "worker", input: "Do B" },
        ])],
        // Synthesize: complete
        [synthesizeCompleteJSON("Both tasks completed successfully.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("do two things in parallel");

      expect(result).toContain("Both tasks completed successfully.");
    });

    it("decomposes with dependencies (DAG topology)", async () => {
      const llm = mockSequenceLLM([
        // 2 parallel research tasks → 1 dependent synthesis task
        [decomposeJSON([
          { id: "research_1", description: "Research topic 1", subAgentName: "researcher", input: "Research topic 1" },
          { id: "research_2", description: "Research topic 2", subAgentName: "researcher", input: "Research topic 2" },
          { id: "synthesis", description: "Synthesize findings", subAgentName: "analyst", input: "Synthesize", dependsOn: ["research_1", "research_2"] },
        ])],
        [synthesizeCompleteJSON("Synthesis complete.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("research two topics and synthesize");

      expect(result).toContain("Synthesis complete.");
    });

    it("returns fallback when task graph has no nodes", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([], "No sub-agents needed.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("simple question");

      expect(result).toContain("unable to decompose");
    });

    it("filters out dependencies that reference unknown node IDs", async () => {
      // dependsOn references "ghost" which doesn't exist
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "only_task", description: "The only task", subAgentName: "worker", input: "Work", dependsOn: ["ghost"] },
        ])],
        [synthesizeCompleteJSON("Task done despite bad dep.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("task with bad dep");

      // Should still complete — bad dep is filtered, node becomes ready immediately
      expect(result).toContain("Task done despite bad dep.");
    });

    it("emits onThought during decompose", async () => {
      const thoughts: string[] = [];

      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "step1", description: "Step 1", subAgentName: "worker", input: "Step 1" },
        ], "I will break this into one task.")],
        [synthesizeCompleteJSON("Done.")],
      ]);

      const agent = createOrchestrator(llm, {
        hooks: [{ onThought: (t: string) => thoughts.push(t) }],
      });

      await agent.run("do one thing");
      expect(thoughts.length).toBeGreaterThanOrEqual(1);
      expect(thoughts[0]).toContain("break this into one task");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Synthesize
  // ════════════════════════════════════════════════════════════════════════

  describe("synthesize phase", () => {
    it("returns final answer when synthesis reports complete", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "work", description: "Do work", subAgentName: "worker", input: "Work" },
        ])],
        [synthesizeCompleteJSON("Here is the comprehensive answer.", "Reviewed all results.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("complete this task");

      expect(result).toContain("Here is the comprehensive answer.");
    });

    it("reports gaps when synthesis reports incomplete", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "partial", description: "Partial work", subAgentName: "worker", input: "Partial work" },
        ])],
        // Synthesize: incomplete with gaps
        [synthesizeIncompleteJSON(
          ["Need more info on topic X", "Topic Y is missing"],
          "Results are insufficient.",
        )],
        // Adapt: generate new nodes
        [adaptJSON([
          { id: "topic_x", description: "Research X", subAgentName: "researcher", input: "Research X" },
          { id: "topic_y", description: "Research Y", subAgentName: "researcher", input: "Research Y" },
        ])],
        // Second synthesize: now complete
        [synthesizeCompleteJSON("Comprehensive answer after second round.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("research task needing multiple rounds");

      expect(result).toContain("Comprehensive answer after second round.");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 4: Adapt
  // ════════════════════════════════════════════════════════════════════════

  describe("adapt phase", () => {
    it("generates new nodes from gaps", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "initial", description: "Initial research", subAgentName: "researcher", input: "Initial" },
        ])],
        [synthesizeIncompleteJSON(["Missing data on subject Z"])],
        [adaptJSON([
          { id: "follow_up", description: "Follow up on Z", subAgentName: "researcher", input: "Research Z" },
        ])],
        [synthesizeCompleteJSON("Complete after follow-up.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("investigate subject Z");

      expect(result).toContain("Complete after follow-up.");
    });

    it("forces synthesis when adapt reports stuck", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "attempt", description: "Attempt task", subAgentName: "worker", input: "Attempt" },
        ])],
        [synthesizeIncompleteJSON(["Need impossible info"])],
        // Adapt: stuck — no sub-agent can fill these gaps
        [adaptStuckJSON("No available sub-agent can help.")],
        // Force synthesize
        [forceAnswerJSON("Best answer with available data. Some info is missing.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("impossible task");

      expect(result).toContain("Best answer with available data");
    });

    it("deduplicates node IDs that clash with existing nodes", async () => {
      // Adapt generates a node with the same ID as an existing node
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "existing", description: "Existing task", subAgentName: "worker", input: "Existing" },
        ])],
        [synthesizeIncompleteJSON(["Need another pass"])],
        [adaptJSON([
          { id: "existing", description: "Duplicate ID task", subAgentName: "worker", input: "Duplicate" },
        ])],
        [synthesizeCompleteJSON("Done after dedup.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("task with id clash");

      // The duplicate ID should be renamed, and execution continues
      expect(result).toContain("Done after dedup.");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Full Flow: Multi-Round Orchestration
  // ════════════════════════════════════════════════════════════════════════

  describe("multi-round orchestration", () => {
    it("completes in two rounds: decompose → dispatch → synthesize(no) → adapt → dispatch → synthesize(yes)", async () => {
      const llm = mockSequenceLLM([
        // Round 1 — Decompose
        [decomposeJSON([
          { id: "r1_task1", description: "Round 1 task 1", subAgentName: "worker", input: "R1T1" },
          { id: "r1_task2", description: "Round 1 task 2", subAgentName: "worker", input: "R1T2" },
        ])],
        // Round 1 — Synthesize: incomplete
        [synthesizeIncompleteJSON(
          ["Need additional perspective on topic P"],
          "Round 1 results insufficient.",
        )],
        // Round 1 — Adapt
        [adaptJSON([
          { id: "r2_task1", description: "Round 2 perspective", subAgentName: "researcher", input: "Investigate P" },
        ])],
        // Round 2 — Synthesize: complete
        [synthesizeCompleteJSON("Final comprehensive answer across 2 rounds.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("complex multi-round investigation");

      expect(result).toContain("Final comprehensive answer across 2 rounds.");
      expect((agent as any).completedRounds).toBe(2);
    });

    it("handles three rounds of orchestration", async () => {
      const llm = mockSequenceLLM([
        // Round 1
        [decomposeJSON([
          { id: "r1", description: "Round 1", subAgentName: "worker", input: "R1" },
        ])],
        [synthesizeIncompleteJSON(["Gap after round 1"])],
        [adaptJSON([
          { id: "r2", description: "Round 2", subAgentName: "worker", input: "R2" },
        ])],
        // Round 2
        [synthesizeIncompleteJSON(["Gap after round 2"])],
        [adaptJSON([
          { id: "r3", description: "Round 3", subAgentName: "worker", input: "R3" },
        ])],
        // Round 3
        [synthesizeCompleteJSON("Three-round answer.")],
      ]);

      const agent = createOrchestrator(llm, { maxRounds: 5 });
      const result = await agent.run("deep investigation");

      expect(result).toContain("Three-round answer.");
      expect((agent as any).completedRounds).toBe(3);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Edge Cases
  // ════════════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("forces synthesis when maxRounds is reached", async () => {
      const llm = mockSequenceLLM([
        // Round 1
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        // Always respond incomplete + gaps (keeps looping)
        [synthesizeIncompleteJSON(["Gap 1"])],
        [adaptJSON([
          { id: "task2", description: "Task 2", subAgentName: "worker", input: "Task 2" },
        ])],
        [synthesizeIncompleteJSON(["Gap 2"])],
        [adaptJSON([
          { id: "task3", description: "Task 3", subAgentName: "worker", input: "Task 3" },
        ])],
        // Round 3 (maxRounds=3): final round — forces synthesize
        [synthesizeIncompleteJSON(["Gap 3"])],
        // Force synthesize because maxRounds hit
        [forceAnswerJSON("Forced answer after max rounds.")],
      ]);

      const agent = createOrchestrator(llm, { maxRounds: 3 });
      const result = await agent.run("endless task");

      expect(result).toContain("Forced answer after max rounds.");
    });

    it("forces synthesis when maxTotalNodes is reached", async () => {
      // Set maxTotalNodes to 2 — after decompose creates 2 nodes, adapt's
      // new node would exceed the limit
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "a", description: "Task A", subAgentName: "worker", input: "A" },
          { id: "b", description: "Task B", subAgentName: "worker", input: "B" },
        ])],
        [synthesizeIncompleteJSON(["Need more"])],
        // Don't reach adapt — maxTotalNodes hit (2 nodes already exist)
        [forceAnswerJSON("Capped at node limit. Here is the best answer.")],
      ]);

      const agent = createOrchestrator(llm, { maxTotalNodes: 2 });
      const result = await agent.run("task hitting node limit");

      expect(result).toContain("Capped at node limit");
    });

    it("cancels mid-run", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        [synthesizeCompleteJSON("Will not be reached.")],
      ]);

      const agent = createOrchestrator(llm);
      agent.cancel();

      const result = await agent.run("anything");
      expect(result).toContain("Execution cancelled");
    });

    it("rejects oversized input", async () => {
      const cm = new ContextManager({ maxTokens: 50 }, new SilentLogger());

      const subAgentDir = setupSubAgentDir();
      tempDirs.push(subAgentDir);

      const agent = new OrchestratorAgent({
        llm: mockAnswerLLM("should not be called"),
        contextManager: cm,
        toolRegistry: createToolRegistry(),
        logger: new SilentLogger(),
        subAgentsDir: subAgentDir,
        subAgentLLM: mockAnswerLLM("sub result"),
        maxRounds: 3,
      });

      const hugeInput = "word ".repeat(200);
      const result = await agent.run(hugeInput);

      expect(result).toContain("input is too large");
    });

    it("forces synthesis when synthesis incomplete but no gaps listed", async () => {
      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        // Incomplete but empty gaps array
        [synthesizeIncompleteJSON([], "Not complete but no specific gaps.")],
        // Force synthesize because no gaps to adapt from
        [forceAnswerJSON("Best answer despite no gaps specified.")],
      ]);

      const agent = createOrchestrator(llm);
      const result = await agent.run("ambiguous task");

      expect(result).toContain("Best answer despite no gaps specified.");
    });

    it("handles network error during synthesize with graceful recovery", async () => {
      const subAgentDir = setupSubAgentDir();
      tempDirs.push(subAgentDir);

      let callCount = 0;
      const fullLLM: LLMProvider = {
        model: "mock",
        chat: async (_messages, _tools, _signal) => {
          callCount++;
          if (callCount === 1) {
            // Decompose succeeds
            return { content: decomposeJSON([
              { id: "task1", description: "Task 1", subAgentName: "worker", input: "Do work" },
            ]) };
          }
          if (callCount === 2) {
            // Synthesize fails with network error → caught and returns
            // incomplete result with a retry gap
            throw new LLMNetworkError("Connection reset during synthesis.", "connection_reset");
          }
          if (callCount === 3) {
            // Adapt: generate new node from the retry gap
            return { content: adaptJSON([
              { id: "retry_synth", description: "Retry synthesis", subAgentName: "worker", input: "Retry" },
            ], "Adding retry node.") };
          }
          // callCount 4: Second synthesize succeeds
          return { content: synthesizeCompleteJSON("Recovered after network error.") };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const agent = new OrchestratorAgent({
        llm: fullLLM,
        toolRegistry: createToolRegistry(),
        logger: new SilentLogger(),
        subAgentsDir: subAgentDir,
        subAgentLLM: mockAnswerLLM("sub result"),
        maxRounds: 5,
      });

      const result = await agent.run("test network error");
      // The orchestrator recovers: synthesize error → adapt → dispatch → synthesize succeeds
      expect(result).toContain("Recovered after network error.");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Hooks
  // ════════════════════════════════════════════════════════════════════════

  describe("hooks", () => {
    it("emits onFinish with the final answer", async () => {
      let finalAnswer = "";

      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        [synthesizeCompleteJSON("Target final answer.")],
      ]);

      const agent = createOrchestrator(llm, {
        hooks: [{ onFinish: (a: string) => { finalAnswer = a; } }],
      });

      await agent.run("hello");
      expect(finalAnswer).toContain("Target final answer.");
    });

    it("emits onLLMStart and onLLMEnd during decompose / synthesize / adapt", async () => {
      const llmCalls: string[] = [];
      const llmEnds: string[] = [];

      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        [synthesizeCompleteJSON("Hook test answer.")],
      ]);

      const agent = createOrchestrator(llm, {
        hooks: [{
          onLLMStart: (msgs) => {
            const sys = msgs.find((m: any) => m.role === "system");
            if (sys?.content?.includes("task orchestrator")) llmCalls.push("decompose");
            else if (sys?.content?.includes("synthesiser")) llmCalls.push("synthesize");
          },
          onLLMEnd: () => llmEnds.push("end"),
        }],
      });

      await agent.run("hook test");

      // Should have at least decompose and synthesize
      expect(llmCalls.length).toBeGreaterThanOrEqual(2);
      expect(llmEnds.length).toBeGreaterThanOrEqual(2);
    });

    it("emits onFinish with cancellation message", async () => {
      let finalAnswer = "";

      const llm = mockSequenceLLM([
        [decomposeJSON([
          { id: "task", description: "Task", subAgentName: "worker", input: "Task" },
        ])],
        [synthesizeCompleteJSON("Not reached.")],
      ]);

      const agent = createOrchestrator(llm, {
        hooks: [{ onFinish: (a: string) => { finalAnswer = a; } }],
      });
      agent.cancel();

      await agent.run("cancelled");
      expect(finalAnswer).toContain("Execution cancelled");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Session Persistence
  // ════════════════════════════════════════════════════════════════════════

  describe("session persistence", () => {
    let sessionDir: string;

    beforeEach(() => {
      sessionDir = tempDir();
    });

    afterEach(() => {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    });

    it("saves and resumes a session with full orchestrator state", async () => {
      const subAgentDir = setupSubAgentDir();
      tempDirs.push(subAgentDir);

      const toolRegistry = createToolRegistry();

      // ── First run: complete one round ────────────────────────────────
      const llm1 = mockSequenceLLM([
        [decomposeJSON([
          { id: "initial_task", description: "Initial task", subAgentName: "worker", input: "Do initial work" },
        ])],
        [synthesizeIncompleteJSON(
          ["Need follow-up on detail D"],
          "First round done, need more.",
        )],
        [adaptJSON([
          { id: "follow_up", description: "Follow up on D", subAgentName: "researcher", input: "Research D" },
        ])],
        [synthesizeCompleteJSON("Will be interrupted.")],
      ]);

      const agent = new OrchestratorAgent({
        llm: llm1,
        toolRegistry,
        subAgentsDir: subAgentDir,
        subAgentLLM: mockAnswerLLM("Sub-agent result."),
        logger: new SilentLogger(),
        sessionDir,
        enableCheckpointing: true,
        maxRounds: 5,
      });

      const result1 = await agent.run("multi-round investigation");
      expect(result1).toContain("Will be interrupted.");

      const sid = (agent as any).sessionManager.getSessionId();
      expect((agent as any).completedRounds).toBeGreaterThanOrEqual(1);

      // ── Resume with new LLM ──────────────────────────────────────────
      // On resume, decompose is skipped (task graph is loaded from session).
      // The orchestrator enters the dispatch→synthesize loop directly.
      // In the restored graph, "follow_up" and "initial_task" are both
      // already completed, so dispatchReadyNodes has nothing to do and
      // synthesize runs immediately with all results.
      const llm2 = mockSequenceLLM([
        [synthesizeCompleteJSON("Resumed orchestration output.")],
      ]);
      (agent as any).llm = llm2;

      const result2 = await agent.resume(sid, "continue please");
      expect(result2).toContain("Resumed orchestration output.");
    });

    it("getAgentType returns 'orchestrator'", () => {
      const subAgentDir = setupSubAgentDir();
      tempDirs.push(subAgentDir);

      const agent = new OrchestratorAgent({
        llm: mockAnswerLLM("test"),
        toolRegistry: createToolRegistry(),
        logger: new SilentLogger(),
        subAgentsDir: subAgentDir,
        subAgentLLM: mockAnswerLLM("sub result"),
        maxRounds: 3,
      });

      expect((agent as any).getAgentType()).toBe("orchestrator");
    });
  });
});
